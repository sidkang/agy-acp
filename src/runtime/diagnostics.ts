import fs from "node:fs";
import path from "node:path";

/**
 * Turn-scoped diagnostics for `agy acp` failures.
 *
 * `agy acp --process-per-session` runs a *front* process plus one `--worker`
 * process per session. The front writes `agy-acp.log`; each session worker
 * writes its own `agy-acp.log.<pid>` sibling. The real failure text for a turn
 * (`E1113 ... agent executor error: ...`) lands in the numbered worker log,
 * while the front log usually only records `front: session/prompt`. Reading just
 * the front log masked every upstream failure as a generic
 * `500 Agent execution terminated due to error`.
 *
 * Two rules keep the verdict honest: only a turn's own bytes are evidence, and
 * only error records are evidence. Without them a stale failure, a glog
 * timestamp/pid, or `I... quotaProject=` metadata fabricated a `429` / `401`.
 */

const BASE_LOG_NAME = "agy-acp.log";
const WORKER_LOG_RE = /^agy-acp\.log\.\d+$/;

export const DEFAULT_MAX_LOG_FILES = 8;
export const DEFAULT_MAX_BYTES_PER_LOG = 64 * 1024;
export const DEFAULT_MAX_TOTAL_LOG_BYTES = 256 * 1024;

/**
 * Public message for `agy`'s `maxMessageTokens must be positive, got 0` refusal.
 *
 * Fixed and deliberately neutral: it states only the observed failure and what
 * the user can do about it.
 *
 * It must contain neither `quota` nor `rate limit`, not even negated. Magpie's
 * gateway scans response text with its `quotaWords` regex (`fallback.go`) and
 * parks the account when it matches, so a well-meant "this is not a quota
 * problem" would still rest the account. For the same reason it must not assert
 * a root cause: on the observed requests (~1.96 MB of history) the zero budget
 * may come from the input size rather than from the model/token configuration,
 * and that question is still open.
 */
export const CONTEXT_BUDGET_FAILURE_MESSAGE =
  "Antigravity CLI could not serialize this conversation: maxMessageTokens must be positive, got 0. Try a shorter conversation or another model/effort setting.";

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

export type AgentFailureKind =
  | "auth"
  | "quota"
  | "invalid_request"
  | "context_budget"
  | "internal";

export interface TurnLogWatchOptions {
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

const CONTEXT_BUDGET_RE = /maxmessagetokens must be positive/i;

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

const QUOTA_RE =
  /resource_exhausted|resource has been exhausted|exhausted (?:your|the|its|this) quota|quota (?:exceeded|exhausted)|insufficient quota|rate[ _-]?limit(?:ed|_exceeded)?|too many requests|throttl(?:ed|ing)/i;

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
export function normalizeRuntimeText(text: string): string {
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
      if (glog[1] === "I") continue;
      const body = (glog[3] ?? "").trim();
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
 * Classifies evidence, most-specific first so a zero-token-budget refusal can
 * never be reported as an exhausted quota. When nothing survives filtering the
 * answer is `"internal"`; the raw text is never consulted again, which is what
 * let benign metadata fake a verdict.
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
  if (isQuotaSignal(text) || isQuotaSignal(rpc)) return "quota";
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
