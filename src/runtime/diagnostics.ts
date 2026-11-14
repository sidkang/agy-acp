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
 * Reported as a `400` whose words hit Magpie's `tooLongRe` ("prompt is too long",
 * "maximum context length", "reduce the length of the messages"), so `overflowed`
 * fires: it asks a member with room for it, rests no account, and tells the agent
 * to compact. The same conversation is too long on every account of this plugin,
 * so failing over between accounts only repeated the refusal.
 *
 * It must avoid `max_tokens`-style words and any pace or quota wording, or
 * Magpie reads it as a reply-length or rate refusal instead of the conversation.
 */
export const CONTEXT_BUDGET_FAILURE_MESSAGE =
  "Prompt is too long for Antigravity to serialize: the conversation exceeds the model's maximum context length. Start a new conversation or reduce the length of the messages.";

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
/**
 * Public text for an account the vendor disabled outright.
 *
 * Antigravity answers `PERMISSION_DENIED (code 403): This service has been
 * disabled in this account for violation of Terms of Service. Please submit an
 * appeal…` for the whole account, not for one prompt. It is reported as a `403`
 * (Magpie treats any 403 as retryable and asks the next account) with words that
 * name the cause and nothing of quota, because the account's `/usage` windows
 * still read healthy and would otherwise look like the best account to route to.
 */
export const VENDOR_DISABLED_FAILURE_MESSAGE =
  "Antigravity answered: This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product. Remove the account in Magpie if you are not appealing; other signed-in accounts can answer this turn.";

/**
 * Public text for a `PERMISSION_DENIED` that is not the Terms-of-Service
 * suspension: a region, project or policy refusal of the whole account.
 */
export const VENDOR_POLICY_FAILURE_MESSAGE =
  "Antigravity denied this account permission for the request (not the prompt). Another signed-in account can answer this turn.";

/**
 * Public text for a model this account is not served: the vendor's
 * `NOT_FOUND` / `Requested entity was not found.` The words must say the model
 * is not found, which is how Magpie rests that model alone on this account and
 * keeps asking it for the others.
 */
export const MODEL_UNSERVED_FAILURE_MESSAGE =
  "Antigravity does not serve the requested model for this account (model not found). Other models of the account are unaffected; another account may serve it.";

/**
 * Public text for the vendor's own servers being busy or unreachable
 * (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, a 5xx, "overloaded").
 *
 * `overloaded` is the word Magpie reads on a 5xx as the vendor being too busy
 * (`vendorOverloaded` -> a 30-second rest, no failure counted on the account's
 * ladder). It must not carry a quota *code* (`quotaCodes` would make it a spent
 * window instead), and it must not blame the account.
 */
export const UPSTREAM_BUSY_FAILURE_MESSAGE =
  "Antigravity upstream is overloaded or unreachable for this request (transient). Retry shortly; another signed-in account can answer it now.";

/**
 * Public text for a spent credit balance: `agy 1.5.8` ends the turn with
 * "Your AI credits balance is too low to continue." Magpie reads a `402` as out
 * of credit and holds the account on that ladder, which is what topping up
 * clears — a quota window it is not.
 */
export const CREDIT_EXHAUSTED_FAILURE_MESSAGE =
  "Antigravity says this account's credit balance is too low to continue. Top up or use another signed-in account.";

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
/**
 * The ways `agy` ends a turn with its own failure notice instead of an answer.
 * `1.5.8` words a dead connection and a spent credit balance separately from a
 * generic failure (#1136 upstream); a bridge that knows only the generic one
 * forwards the other two to the agent as if the model had written them.
 */
export const AGENT_TERMINAL_MARKERS: ReadonlyArray<string> = [
  "\n⚠ Agent execution terminated due to error.\n",
  "\n⚠ There was a network issue connecting to the server, please try again.\n",
  "\n⚠ Your AI credits balance is too low to continue.\n",
  // Measured on `agy 1.5.9`: a suspended account's turn answers with this
  // sentence as its whole content and `stopReason: end_turn`. Nothing fails, so a
  // bridge that only reads the result delivers it as a 200 answer and the dead
  // account keeps being chosen, one wasted turn at a time.
  "\n⚠ This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.\n",
];

/** agy's own "retry me" note, not a terminal failure: the turn goes on. */
export const AGENT_RETRY_NOTE_MARKERS: ReadonlyArray<string> = [
  "\n⚠ Model produced invalid output.\n",
];

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
  | "vendor_restricted"
  | "vendor_policy"
  | "model_unserved"
  | "upstream_busy"
  | "credit_exhausted"
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
  /exhausted (?:your|the|its|this) (?:quota|capacity)|quota (?:exceeded|exhausted|limit reached|will reset)|insufficient quota|out of quota|usage limit reached|reached (?:your|the|its) (?:current |weekly |daily )?(?:usage )?quota\b|(?:your|the|its) limit will reset (?:in|on)\b/i;

/**
 * A `429`-shaped refusal: `agy`'s `RESOURCE_EXHAUSTED (code 429): Resource has
 * been exhausted (e.g. check quota).`, a per-minute rate limit, a vendor
 * throttle. None of it states that a plan window is spent.
 */
const LIMIT_SIGNAL_RE =
  /resource_exhausted|resource has been exhausted|rate[ _-]?limit(?:ed|_exceeded)?|too many requests|throttl(?:ed|ing)|check quota|\bMODEL_CAPACITY_EXHAUSTED\b/i;

/**
 * The vendor disabling the whole account (Antigravity's Terms-of-Service
 * refusal). Distinct from a prompt-level refusal, which is about one request.
 */
const VENDOR_DISABLED_RE =
  /service has been disabled in this account|violation of terms of service|submit an appeal to continue|\bTOS_VIOLATION\b/i;

/** A `PERMISSION_DENIED` that is about the account (region, project, policy). */
const VENDOR_POLICY_RE =
  /permission_denied \(code \d+\)|permission denied|the caller does not have permission|\bVALIDATION_REQUIRED\b/i;

/** The vendor does not serve this model here (Code Assist `NOT_FOUND`). */
const MODEL_UNSERVED_RE =
  /requested entity was not found|model.{0,80}(not (?:supported|accessible|available|found|enabled|allowed)|unsupported|does ?n[o']t exist|unknown|invalid)|(?:no such|unknown|invalid|unsupported) model|model_not_found/i;

/** `agy`'s gRPC statuses for the backend itself being busy or unreachable. */
const UPSTREAM_BUSY_RE =
  /unavailable \(code \d+\)|deadline_exceeded \(code \d+\)|deadline exceeded|the model is overloaded|\boverloaded\b|server_is_overloaded|service unavailable|temporarily unavailable|network issue connecting to the server/i;

/** A spent credit balance, which `agy 1.5.8` words on its own (#1136). */
const CREDIT_EXHAUSTED_RE =
  /credits? balance is too low|\bQUOTA_EXHAUSTED\b.*credit|out of credits?|credit balance (?:is )?exhausted/i;

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
    VENDOR_DISABLED_RE.test(text) ||
    VENDOR_POLICY_RE.test(text) ||
    MODEL_UNSERVED_RE.test(text) ||
    UPSTREAM_BUSY_RE.test(text) ||
    // `extractErrorEvidence` runs on its own output: a spent-credit record names
    // no generic failure word, so without this its second pass lost the verdict
    // and the turn answered 500.
    CREDIT_EXHAUSTED_RE.test(text) ||
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
 * Classifies evidence, most-specific first: `context_budget` ->
 * `vendor_restricted` (the account was suspended) -> `vendor_policy` (a policy
 * or region refusal of the account) -> `auth` -> `quota` (a named exhausted
 * quota) -> `rate_limit` (a `429`-shaped refusal that names no spent window) ->
 * `model_unserved` (this account is not served the model) -> `upstream_busy`
 * (the vendor's own servers) -> `invalid_request` -> `internal`.
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
  if (VENDOR_DISABLED_RE.test(text) || VENDOR_DISABLED_RE.test(rpc)) {
    return "vendor_restricted";
  }
  if (VENDOR_POLICY_RE.test(text) || VENDOR_POLICY_RE.test(rpc)) {
    return "vendor_policy";
  }
  if (CREDIT_EXHAUSTED_RE.test(text) || CREDIT_EXHAUSTED_RE.test(rpc)) {
    return "credit_exhausted";
  }
  if (AUTH_RE.test(text) || RPC_AUTH_RE.test(rpc)) return "auth";
  if (isExhaustedQuotaSignal(text) || isExhaustedQuotaSignal(rpc)) {
    return "quota";
  }
  if (isQuotaSignal(text) || isQuotaSignal(rpc)) return "rate_limit";
  if (MODEL_UNSERVED_RE.test(text) || MODEL_UNSERVED_RE.test(rpc)) {
    return "model_unserved";
  }
  if (UPSTREAM_BUSY_RE.test(text) || UPSTREAM_BUSY_RE.test(rpc)) {
    return "upstream_busy";
  }
  if (INVALID_REQUEST_RE.test(text) || INVALID_REQUEST_RE.test(rpc)) {
    return "invalid_request";
  }
  return "internal";
}

/**
 * The vendor's own words, bounded to one line, for appending to a fixed message.
 *
 * Magpie reads the whole body, so a detail is only ever appended when the verdict
 * already stands on its fixed prefix; the detail is what a human needs to see.
 */
export function upstreamDetail(text: string, limit = 400): string {
  const one = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!one) return "";
  return one.length > limit ? `${one.slice(0, limit - 1)}…` : one;
}

/**
 * Google's 429 boilerplate `(e.g. check quota)` reads as "a window is spent" to
 * Magpie's `quotaWords`, which would hold a healthy account for its window. It is
 * dropped from a detail, and a detail still carrying limit wording after that is
 * not appended at all: the fixed sentence is the truthful one there, and Magpie
 * reads the appended bytes too.
 */
export function limitFreeDetail(text: string): string {
  const cleaned = String(text ?? "")
    .replace(/\s*\(\s*e\.g\.?\s*check quota\s*\)/gi, "")
    .replace(/\b(check|verify) (?:your )?quota\b/gi, "check usage");
  // Magpie's own vocabulary (`quotaWords` plus the credit words that share the
  // same effect), not a guess: `billing` alone makes `failure()` answer
  // failCredit, which rests the account for half an hour.
  if (
    /quota|insufficient|balance|credit|billing|budget|exceeded|overloaded|rate[ _-]?limit|usage[ _-]?limit|limit.?reached|too many requests|\u4f59\u989d|\u989d\u5ea6|\u6b20\u8d39|\u9650\u6d41|\u9891\u7387|\u9891\u7e41|\u901f\u7387|\u5957\u9910|\u7528\u91cf|\u4e0a\u9650/i.test(
      cleaned,
    )
  ) {
    return "";
  }
  return upstreamDetail(cleaned);
}

/**
 * Magpie refuses to read a 400 as an overflow when the body also names a token
 * ceiling or a paced limit (`tooLong` in gateway.go), so a detail carrying those
 * words would veto the sentence that makes the 400 an overflow.
 */
export function tooLongVetoed(text: string): boolean {
  return /max_(?:output_|completion_)?tokens|tokens?\s*(?:per|\/)\s*(?:minute|hour|day)|\b(?:tpm|rpm)\b/i.test(
    String(text ?? ""),
  );
}

/**
 * Local paths out of an error detail: the client is not always the person who
 * owns the filesystem the log names.
 */
export function withoutLocalPaths(text: string): string {
  return String(text ?? "")
    .replace(/(\/(?:Users|home)\/)[^\/\s"'`]+/g, "$1[user]")
    .replace(/([A-Za-z]:\\Users\\)[^\\\s"'`]+/g, "$1[user]");
}

/**
 * Seconds a vendor's refusal named, for a `Retry-After` header. Only the shapes
 * these CLIs write are read (`retrying in 4s`, `try again in 30 seconds`,
 * `resets in 2h`), clamped to 1s … 24h so a misread reset cannot bench a client.
 */
export function retryAfterSecondsFrom(text: string): number | undefined {
  const source = String(text ?? "");
  if (!source) return undefined;
  // The last wait, not the first: a turn that retried twice named two, and the
  // client must wait out the current one.
  const hints = [
    ...source.matchAll(
      /(?:retry(?:ing)?|try again|resets?|reset after|back)\D{0,24}?(\d+(?:\.\d+)?)\s*(s|sec(?:onds?)?|m|min(?:utes?)?|h|hours?)\b/gi,
    ),
  ];
  const hint = hints.at(-1);
  if (!hint) return undefined;
  const value = Number(hint[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = hint[2]!.toLowerCase();
  const seconds = unit.startsWith("h") ? value * 3600 : unit.startsWith("m") ? value * 60 : value;
  return Math.min(24 * 3600, Math.max(1, Math.round(seconds)));
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
