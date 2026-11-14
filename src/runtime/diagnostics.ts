import fs from "node:fs";
import path from "node:path";

/**
 * Turn-scoped diagnostics for `agy acp` failures.
 *
 * Both `agy acp --worker` (single-process session worker) and legacy
 * `--process-per-session` write execution records (`E1113 ... agent executor
 * error: ...`) into a PID-suffixed `agy-acp.log.<pid>` file rather than the
 * base `agy-acp.log` path passed to `--log-file`. Reading only the base log
 * masked upstream failures as a generic `500 Agent execution terminated due to
 * error`.
 *
 * Two rules keep the verdict honest: only a turn's own bytes are evidence, and
 * only error records are evidence. Without them a stale failure, a glog
 * timestamp/pid, or `I... quotaProject=` metadata fabricated a `429` / `401`.
 */

const BASE_LOG_NAME = "agy-acp.log";
const WORKER_LOG_RE = /^agy-acp\.log\.\d+$/;

const DEFAULT_MAX_LOG_FILES = 8;
const DEFAULT_MAX_BYTES_PER_LOG = 64 * 1024;
const DEFAULT_MAX_TOTAL_LOG_BYTES = 256 * 1024;

/**
 * Public message for `agy`'s trajectory-serialization refusals.
 *
 * Two phrasings have been observed on `agy 1.5.8`, both from the same native
 * budget check:
 *   - `serializing trajectory: maxMessageTokens must be positive, got 0`
 *   - `serializing trajectory: no messages fit within the context token budget`
 *
 * Fixed and deliberately neutral: it states only the observed failure and what
 * the user can do about it.
 *
 * It must contain neither `quota` nor `rate limit`, not even negated. Magpie's
 * gateway scans response text with its `quotaWords` regex (`fallback.go`) and
 * parks the account when it matches, so a well-meant "this is not a quota
 * problem" would still rest the account. It also does not assert a root cause:
 * the measured trigger is a large `_meta.antigravity.systemPrompt.append`
 * block, but the native budget formula is unpublished.
 */
export const CONTEXT_BUDGET_FAILURE_MESSAGE =
  "Antigravity CLI could not serialize this conversation within its context limits. Try a shorter conversation or another model/effort setting.";

/**
 * Public text for an unclassified `agy` failure.
 *
 * Fixed and sanitized on purpose: it must never interpolate the raw ACP error,
 * which for a process exit carries the whole stderr tail — text that can include
 * `quotaProject=`, which Magpie's `quotaWords` would read as account exhaustion
 * and rest a healthy account.
 */
export const GENERIC_FAILURE_MESSAGE =
  "Agent execution terminated due to error";

/**
 * Public text for a `429`-shaped refusal that names no spent quota window.
 *
 * It must state nothing of quota: Magpie scans error text with `quotaWords`
 * (`fallback.go`) and holds an account for its whole window on a match, while a
 * plain `429` holds it briefly and lets the next account answer. That is why
 * neither "quota" nor "rate limit" appears here.
 */
export const TRANSIENT_LIMIT_FAILURE_MESSAGE =
  "Antigravity upstream temporarily limited this turn (transient 429) before any answer was produced. Retry shortly; another signed-in account can answer it now.";

/**
 * `agy`'s own in-process retry notice for a transient upstream failure:
 *
 *   `⚠ API error (attempt 2): RESOURCE_EXHAUSTED (code 429): Resource has been
 *    exhausted (e.g. check quota).`
 *
 * It is diagnostic text, not model output, so it is kept out of the answer and
 * counted instead: a storm of them means the turn is only spinning through
 * `agy`'s exponential backoff (observed 8 attempts over ~8 minutes).
 */
const RETRY_NOTICE_PREFIXES: ReadonlyArray<string> = [
  "API error (attempt",
  "⚠ API error (attempt",
  "⚠️ API error (attempt",
];

const RETRY_NOTICE_LINE_RE = /^\s*(?:⚠\ufe0f?\s*)?API error \(attempt \d+\):/i;

/**
 * Independent evidence that `agy` itself retried upstream during this turn.
 *
 * The same words also reach the stream when a model *quotes* the incident, so a
 * notice-shaped line is only treated as diagnostic — stripped, counted, or able
 * to end a turn — when the turn's own log says `agy` really retried. Without this
 * the very troubleshooting task that motivates the guard ("explain this error")
 * would cancel the answer to it.
 */
const UPSTREAM_RETRY_EVIDENCE_RE = /Run: attempt \d+ failed|API error \(attempt \d+\)/i;

/**
 * `agy` logs its in-process retry at info severity:
 *   `I1114 16:08:30.490505 370 run.go:315] Run: attempt 1 failed (RESOURCE_EXHAUSTED (code 429): …)`
 * Info records are normally noise (and `I… quotaProject=` forged a 429 once), so
 * this exact phrasing is the one exception: an anchored retry record that also
 * names a limit is the only evidence a single-retry `429` termination has.
 */
const INFO_RETRY_EVIDENCE_RE = /^[Rr]un: attempt \d+ failed\b/;

export function hasUpstreamRetryEvidence(rawLog: string): boolean {
  if (!rawLog) return false;
  return UPSTREAM_RETRY_EVIDENCE_RE.test(rawLog);
}

/**
 * Shortest fragment worth holding back for the next chunk. A real split of a
 * notice always carries a recognizable run of it; without a floor the ordinary
 * end of an answer (" A", "API") looked like the start of a notice and was held
 * instead of delivered.
 */
const RETRY_NOTICE_HOLD_MIN = 6;

export interface RetryNoticeScan {
  /** The chunk with every complete notice line removed. */
  text: string;
  /** Complete, newline-terminated notices found in this chunk. */
  count: number;
  /** A trailing partial notice, to be prepended to the next chunk. */
  hold: string;
}

/**
 * True when a line is a notice that has begun (header only, body still to come)
 * or a fragment that could become one. Used only for the last, unterminated line
 * of a chunk and for text waiting on log corroboration.
 */
function isNoticeFragment(line: string): boolean {
  const candidate = line.replace(/^[ \t]+/, "");
  if (candidate.length === 0) return false;
  return RETRY_NOTICE_PREFIXES.some(
    (prefix) =>
      prefix.startsWith(candidate) ||
      (candidate.length >= RETRY_NOTICE_HOLD_MIN &&
        candidate.startsWith(prefix)),
  );
}

/**
 * True when the text carries a notice that has begun — a complete line or a
 * header whose body has not arrived yet. The worker uses it to hold a
 * notice-shaped chunk while it waits for the log to corroborate the retry,
 * instead of forwarding it and blinding the storm guard.
 */
export function looksLikeAgentRetryNotice(text: string): boolean {
  if (!text) return false;
  const lines = text.split("\n");
  return lines.some(
    (line) => RETRY_NOTICE_LINE_RE.test(line) || isNoticeFragment(line),
  );
}

/**
 * Splits `agy` retry notices out of a streamed text chunk.
 *
 * Only a newline-terminated line is a complete notice. A header whose body is
 * still to come (`⚠ API error (attempt 1):` at the end of a chunk) must not be
 * consumed, or its body would arrive as model text and the guard would read that
 * text as delivered work. Such a line, and any fragment that could begin a
 * notice, is held back (`hold`) for the next chunk; the caller flushes whatever
 * is still held when the turn ends.
 */
export function splitAgentRetryNotices(text: string): RetryNoticeScan {
  if (!text) return { text: "", count: 0, hold: "" };
  const segments = text.split("\n");
  const unterminated = segments.pop() ?? "";

  let count = 0;
  const kept: string[] = [];
  for (const line of segments) {
    if (RETRY_NOTICE_LINE_RE.test(line)) {
      count += 1;
      continue;
    }
    kept.push(line);
  }

  let hold = "";
  if (isNoticeFragment(unterminated)) {
    // The separator belongs to the held segment: releasing it later must
    // reproduce the original bytes (`"hello\nAPI"` -> `"hello"` + `"\nAPI"`).
    hold = text.includes("\n") ? `\n${unterminated}` : unterminated;
  } else {
    // Restores the trailing newline of a chunk that ended with one.
    kept.push(unterminated);
  }

  let out = kept.join("\n");
  // Whitespace around a stripped notice is that notice's own padding, not a
  // whitespace-only answer the model meant to send.
  if (count > 0 && out.trim() === "") out = "";
  return { text: out, count, hold };
}

type AgentFailureKind =
  | "auth"
  | "quota"
  | "rate_limit"
  | "invalid_request"
  | "context_budget"
  | "internal";

interface TurnLogWatchOptions {
  maxFiles?: number;
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
}

interface LogFileEntry {
  file: string;
  ino: number;
  size: number;
  mtimeMs: number;
}

interface LogMark {
  ino: number;
  size: number;
}

/**
 * glog/klog record prefix:
 *   `E1113 20:12:05.437065     391 errorreport.go:273] message`
 * Severity is the first character; everything up to the first `]` is metadata
 * (timestamp, pid, file:line, optional trace id) and must never be matched
 * against failure keywords. The metadata group is lazy so the first `]` always
 * ends it, even when the message itself contains brackets.
 */
const GLOG_PREFIX_RE =
  /^([IWEF])(\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+.*?)\]\s?([\s\S]*)$/;

/**
 * Benign records we cause ourselves (`BROWSER=/usr/bin/false`) and must not
 * report as agent failures.
 */
const BENIGN_PATTERNS: ReadonlyArray<RegExp> = [
  /failed to (?:open|launch|start) (?:the )?browser/i,
  /\bxdg-open\b/i,
];

/** A record with no glog prefix (stderr prose / RPC text) is judged by wording. */
const FAILURE_WORDING_RE =
  /error|fail(?:ed|ure)?|denied|refus|exhaust|quota|throttl|rate.?limit|unauth|expired|invalid|panic|timeout|unsupported|must be positive|maxmessagetokens/i;

/** Both observed native trajectory-budget refusals (see the public message). */
const CONTEXT_BUDGET_RE =
  /maxmessagetokens must be positive|no messages fit within the context token budget/i;

/** An HTTP/status/gRPC `429`, never a bare number such as a port or a pid. */
const STATUS_429_RE =
  /\bhttp(?:\/\d(?:\.\d)?)?\s+429\b|\bstatus(?:\s*code)?\s*[:=]?\s*429\b|\bcode\s*[:=]\s*429\b|\bgrpc[- ]?code\s*[:=]?\s*429\b|\(429\)|\b429\s+too\s+many\s+requests\b/i;

/**
 * A sign-in instruction or an auth status code.
 *
 * Ambient `You are not logged into Antigravity.` chatter is deliberately *not*
 * an auth signal: a healthy `agy` emits hundreds of those records from
 * background quirk polling while its token source warms up, so matching that
 * wording fabricated a `401` on turns that had failed for other reasons.
 */
const AUTH_RE =
  /please sign in|sign[- ]in (?:again|required)|authentication expired|login required|unauthenticated|invalid_grant|token (?:has )?expired|reauthenticate|invalid credentials?|missing credentials?/i;

/**
 * Auth wording that is only trustworthy when `agy` itself returned it for this
 * turn (the ACP error text). In a log, `You are not logged into Antigravity.` is
 * background quirk-polling chatter emitted hundreds of times by a healthy
 * process, so logs are matched against `AUTH_RE` alone.
 */
const RPC_AUTH_RE =
  /please (?:sign|log) in|not (?:logged|signed)[ -]?in(?:to)?\b|sign[- ]in (?:again|required)|authentication expired|login required|unauthenticated|invalid_grant|token (?:has )?expired|reauthenticate|invalid credentials?|missing credentials?/i;

/**
 * Quota wording that names exhaustion itself, in any vendor's phrasing seen so
 * far: `You have exhausted your quota for this model.`, `quota exceeded`.
 *
 * Google's generic `429` boilerplate is deliberately *not* here even though it
 * ends with `(e.g. check quota)`: it is what every throttled request returns,
 * including the per-minute limits `agy` retries in-process, so reading it as
 * account exhaustion rests a healthy account for its whole window.
 */
const EXHAUSTED_QUOTA_RE =
  /exhausted (?:your|the|its|this) (?:quota|capacity)|quota (?:exceeded|exhausted|limit reached|will reset)|insufficient quota|out of quota/i;

/**
 * A `429`-shaped refusal: `agy`'s `RESOURCE_EXHAUSTED (code 429): Resource has
 * been exhausted (e.g. check quota).`, a per-minute rate limit, a vendor
 * throttle. None of it states that a plan window is spent.
 */
const LIMIT_SIGNAL_RE =
  /resource_exhausted|resource has been exhausted|rate[ _-]?limit(?:ed|_exceeded)?|too many requests|throttl(?:ed|ing)|check quota/i;

const QUOTA_RE = new RegExp(
  `${EXHAUSTED_QUOTA_RE.source}|${LIMIT_SIGNAL_RE.source}`,
  "i",
);

const INVALID_REQUEST_RE =
  /invalid_request|invalid argument|invalid_argument|bad request|failed_precondition|400 bad request/i;

/** A glog `W` record needs an unambiguous signal; it also carries log noise. */
const STRONG_SIGNAL_RE =
  /resource_exhausted|rate[ _-]?limit(?:ed|_exceeded)?|too many requests|exhausted (?:your|the|its|this) quota|quota (?:exceeded|exhausted)|unauthenticated|invalid_grant|please sign in/i;

/**
 * True when a record is start-up or bookkeeping noise rather than a failure.
 * Checked before any keyword match so metadata cannot fake a verdict.
 */
function isBenignEvidence(body: string): boolean {
  for (const re of BENIGN_PATTERNS) {
    if (re.test(body)) return true;
  }
  // `quotaProject=` is an auth-result field, not a quota failure. It is only
  // benign while no real exhaustion marker shares the record.
  if (
    /quotaproject\s*=/i.test(body) &&
    !QUOTA_RE.test(body) &&
    !STATUS_429_RE.test(body)
  ) {
    return true;
  }
  return false;
}

function isQuotaSignal(text: string): boolean {
  return QUOTA_RE.test(text) || STATUS_429_RE.test(text);
}

/** True only when the text itself says a quota is spent, not merely throttled. */
function isExhaustedQuotaSignal(text: string): boolean {
  return EXHAUSTED_QUOTA_RE.test(text);
}

/**
 * A record that already states a verdict. `extractErrorEvidence` runs both on
 * raw blobs and on its own output (the worker extracts per file, then classifies
 * the merged evidence), so a record that carries a recognized verdict must
 * survive a second pass even when it holds no generic failure wording —
 * `HTTP 429` and `Please sign in` have none.
 */
function hasVerdictSignal(text: string): boolean {
  return (
    CONTEXT_BUDGET_RE.test(text) ||
    AUTH_RE.test(text) ||
    isQuotaSignal(text) ||
    INVALID_REQUEST_RE.test(text)
  );
}

/**
 * Strips ambient material out of an ACP error message before it is matched.
 *
 * `AcpConnection.handleExit` wraps a process death as
 * `ACP request 'session/prompt' (id: N) aborted: ACP process exited (...).
 * Stderr tail:\n<entire stderr ring buffer>`. That buffer starts at spawn, so it
 * holds start-up `You are not logged into Antigravity.` and quota chatter from
 * long before this turn; treating the wrapper as authoritative would fabricate
 * a `401`/`429` for a turn that actually failed for another reason. The tail is
 * dropped here and the turn-scoped `stderrDelta` evidence is used instead.
 */
function normalizeRuntimeText(text: string): string {
  return (
    text
      .replace(/\n?\s*Stderr tail:[\s\S]*$/i, "")
      // `quotaProject=` is an auth-result field, not a quota failure.
      .replace(/quotaproject\s*=\s*[^\s,;)"']*/gi, "quotaProject")
  );
}

/**
 * Keeps only error-bearing records, with the severity/timestamp/pid prefix
 * stripped, so keywords cannot match metadata. glog `I` records are dropped,
 * `W` needs a strong signal, and unprefixed prose needs failure wording.
 */
export function extractErrorEvidence(raw: string): string {
  if (!raw) return "";
  const kept: string[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const glog = GLOG_PREFIX_RE.exec(line);
    if (glog) {
      const gbody = (glog[3] ?? "").trim();
      if (glog[1] === "I") {
        // Only `agy`'s own retry record survives, and only when it also names a
        // limit; everything else at info severity stays noise.
        if (
          !INFO_RETRY_EVIDENCE_RE.test(gbody) ||
          (!STRONG_SIGNAL_RE.test(gbody) && !STATUS_429_RE.test(gbody))
        ) {
          continue;
        }
        kept.push(gbody);
        continue;
      }
      const body = gbody;
      if (!body || isBenignEvidence(body)) continue;
      if (
        glog[1] === "W" &&
        !STRONG_SIGNAL_RE.test(body) &&
        !STATUS_429_RE.test(body)
      ) {
        continue;
      }
      kept.push(body);
      continue;
    }

    // Severity-prefixed records this regex could not fully parse.
    if (/^[IWF]\d{4}\s/.test(line)) continue;

    if (isBenignEvidence(line)) continue;
    if (!FAILURE_WORDING_RE.test(line) && !hasVerdictSignal(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

/**
 * Classifies evidence, most-specific first: `context_budget` -> `auth` ->
 * `quota` (a named exhausted quota) -> `rate_limit` (a `429`-shaped refusal that
 * names no spent window) -> `invalid_request` -> `internal`.
 *
 * `quota` and `rate_limit` are separate on purpose. `agy` retries a per-minute
 * `429` in-process with exponential backoff, so an upstream `resource_exhausted`
 * is the common case of a busy minute, not a spent plan window: reporting it as
 * `quota` made Magpie rest the account for its whole window and CPA cool the
 * only key, turning a short throttle into a dead session.
 */
export function classifyAgentFailure(
  evidence: string,
  rpcErrorText?: string,
): AgentFailureKind {
  const text = extractErrorEvidence(evidence);
  // The agent's own error text for this turn is authoritative, so it may state
  // auth in wording that a log must not trust.
  const rpc =
    typeof rpcErrorText === "string" && rpcErrorText.trim()
      ? normalizeRuntimeText(rpcErrorText)
      : "";
  if (!text.trim() && !rpc) return "internal";
  if (CONTEXT_BUDGET_RE.test(text) || CONTEXT_BUDGET_RE.test(rpc)) {
    return "context_budget";
  }
  if (AUTH_RE.test(text) || RPC_AUTH_RE.test(rpc)) return "auth";
  if (isExhaustedQuotaSignal(text) || isExhaustedQuotaSignal(rpc)) {
    return "quota";
  }
  if (isQuotaSignal(text) || isQuotaSignal(rpc)) return "rate_limit";
  if (INVALID_REQUEST_RE.test(text) || INVALID_REQUEST_RE.test(rpc)) {
    return "invalid_request";
  }
  return "internal";
}

/**
 * Bytes appended to an stderr ring buffer since a per-turn baseline. The buffer
 * keeps only its last 16 KiB, so once it has wrapped the newest bytes are found
 * by the longest snapshot suffix that is also a prefix of the current content.
 */
export function stderrDelta(baseline: string, current: string): string {
  if (!current) return "";
  if (!baseline) return current;
  if (current === baseline) return "";
  // Still growing: everything past the snapshot is this turn's output.
  if (current.length > baseline.length && current.startsWith(baseline)) {
    return current.slice(baseline.length);
  }
  const limit = Math.min(baseline.length, current.length);
  for (let overlap = limit; overlap > 0; overlap -= 1) {
    if (baseline.endsWith(current.slice(0, overlap))) {
      return current.slice(overlap);
    }
  }
  return current;
}

/**
 * Bounded, turn-scoped reader over a workspace's `agy acp` logs.
 * `markTurnStart()` records the offset and inode of every log present now;
 * `readTurnEvidence()` returns only bytes written since, tail-reading any file
 * that is new, replaced or truncated.
 */
export class TurnLogWatch {
  private readonly dir: string;
  private readonly maxFiles: number;
  private readonly maxBytesPerFile: number;
  private readonly maxTotalBytes: number;
  private readonly marks = new Map<string, LogMark>();

  constructor(dir: string, options?: TurnLogWatchOptions) {
    this.dir = dir;
    this.maxFiles = options?.maxFiles ?? DEFAULT_MAX_LOG_FILES;
    this.maxBytesPerFile = options?.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_LOG;
    this.maxTotalBytes = options?.maxTotalBytes ?? DEFAULT_MAX_TOTAL_LOG_BYTES;
  }

  /** Byte offsets of the logs as they are right now. Call at turn start. */
  markTurnStart(): void {
    this.marks.clear();
    for (const entry of this.listLogFiles()) {
      if (this.marks.size >= this.maxFiles) break;
      this.marks.set(entry.file, { ino: entry.ino, size: entry.size });
    }
  }

  /** Current-turn bytes across the front log and every worker log. */
  readTurnEvidence(): string {
    const parts: string[] = [];
    let budget = this.maxTotalBytes;

    for (const entry of this.listLogFiles()) {
      if (budget <= 0) break;
      const mark = this.marks.get(entry.file);
      const unchanged =
        mark !== undefined && mark.ino === entry.ino && entry.size >= mark.size;
      // New, replaced (new inode) and truncated (smaller) files have no usable
      // offset, so fall back to a bounded tail read of their current content.
      const from = unchanged
        ? mark.size
        : Math.max(0, entry.size - this.maxBytesPerFile);
      const length = entry.size - from;
      if (length <= 0) continue;

      const cap = Math.min(length, this.maxBytesPerFile, budget);
      const text = this.readSlice(entry.file, entry.size - cap, cap);
      budget -= cap;
      if (text.trim()) {
        parts.push(`# ${path.basename(entry.file)}\n${text}`);
      }
    }

    return parts.join("\n");
  }

  private listLogFiles(): LogFileEntry[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }

    const entries: LogFileEntry[] = [];
    for (const name of names) {
      if (name !== BASE_LOG_NAME && !WORKER_LOG_RE.test(name)) continue;
      const file = path.join(this.dir, name);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        entries.push({
          file,
          ino: Number(stat.ino ?? 0),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        });
      } catch {
        // Vanished or unreadable; nothing to report.
      }
    }

    // The front log is ours; worker logs are ordered newest-first so a bounded
    // cap keeps the sessions that actually wrote during this turn.
    entries.sort((a, b) => {
      const aBase = path.basename(a.file) === BASE_LOG_NAME ? 0 : 1;
      const bBase = path.basename(b.file) === BASE_LOG_NAME ? 0 : 1;
      if (aBase !== bBase) return aBase - bBase;
      if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
      return a.file.localeCompare(b.file);
    });

    return entries.slice(0, this.maxFiles);
  }

  private readSlice(file: string, offset: number, length: number): string {
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, "r");
      const buf = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const read = fs.readSync(fd, buf, filled, length - filled, offset + filled);
        if (read <= 0) break;
        filled += read;
      }
      return buf.subarray(0, filled).toString("utf-8");
    } catch {
      return "";
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
  }
}
