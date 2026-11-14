# Error classification and multi-account routing

How `agy-acp` turns an `agy acp` failure into the HTTP status, `error.type`, headers and
wording that Magpie's router (`>= 0.1.3900`) acts on, and how it keeps every account routable.
Classification lives in `src/runtime/diagnostics.ts`; the turn-side handling in
`src/runtime/worker.ts` and `src/runtime/turn-context.ts`. Release history and the incidents
behind these rules are in [`CHANGELOG.md`](../CHANGELOG.md).

## 1. Verdicts and what Magpie does with each

The right-hand column is Magpie's own behavior (`internal/gateway/fallback.go`, `routing.go`),
not an intention of this plugin. A verdict whose status or words disagree with it makes the
router rest the wrong thing, or fail over nowhere.

| Verdict | Status | Words | What Magpie does |
|---|---|---|---|
| `context_budget` | `400` | "prompt is too long ... maximum context length ... reduce the length of the messages" | `overflowed` (its `tooLongRe` matches these words): asks a member with room, rests no account, tells the agent to compact |
| `vendor_restricted` | `403` | the vendor's own "disabled in this account for violation of Terms of Service" | plain `403`: retryable, next account asked, nobody rests. Not `googleSuspended`: that predicate needs the account's Agent to be `antigravity`/`gemini`, and Magpie builds plugin accounts with `Agent: "plugin"` (`internal/provider/plugins.go`, `pluginProviderServing`). The sentence is kept for the human reading it |
| `vendor_policy` | `403` | "policy or region restriction" | plain `403`: retryable, next account asked |
| `auth` | `401` + `SignInHeader: expired` (`409` when failover is off, header unchanged) | expired sign-in | account marked as needing a new sign-in; the header is read whatever the status |
| `quota` | `429` | "Account quota exhausted" | rests until the window it names renews (`quota_hours`/7-day) |
| `rate_limit` | `429` | no quota words | brief rate rest, next account asked |
| `model_unserved` | `404` | "model not found" | only that model rests on that account (`modelRefused`); its other models keep working |
| `upstream_busy` | `503` | "overloaded" | vendor busy (`vendorOverloaded`): 30-second rest, no failure counted on the account's ladder |
| `credit_exhausted` | `402` | "credit balance is too low" | out of credit (`failCredit`): `creditRest`, a guessed 30-minute rest that an early retry may shorten. A plugin account has a non-nil `Account`, so it does not climb `creditLadder`, which only a key without an account reaches. `agy 1.5.8` words this on its own, ending the turn with `⚠ Your AI credits balance is too low to continue.` |
| `invalid_request` | `400` | "Invalid request to agent" | shape refusal: one more candidate is asked, nobody rests |
| `internal` | `500` | generic | plain failure: counted on the ladder, next account asked |
| client cancel | `499` | (none) | the agent's cancellation, nobody rests |
| bridge at capacity | `503` | "overloaded: session workers busy" | 30-second rest, no failure counted: this bridge's own saturation is not the account's fault |
| worker closed | `502` | `Worker closed: <reason>`; the reason is in the message the agent sees | counted as a failure, next account asked |

Cross-cutting rules on the same responses:

- `model_unserved`, `vendor_*` and `context_budget` append the vendor's own words after the
  fixed sentence as `Upstream said: ...`, bounded to one line and redacted. The detail is dropped
  entirely when it carries limit wording, so an echoed 400/403 can never read as a spent window.
- Any `429`/`502`/`503`/`402` whose turn log names a wait carries `Retry-After: <seconds>` from
  the last wait named (the vendor's `retrying in 7s` / `resets in 2h`), clamped to 1 s ... 24 h
  (`retryAfterSecondsFrom`), so a direct client (OpenCode, pi) waits as long as the upstream asked.
- `400`/`401`/`404` carry `x-should-retry: false`: asking again as it stands cannot help. Magpie
  ignores the header; a direct client does not retry into the same wall.
- `error.type` follows the status the way Magpie derives it (`errorTypeFor`,
  `gateway.go:11011`): `503` and `402` carry `api_error`, not `overloaded_error` or
  `invalid_request_error`. Magpie keeps a plugin's type for a matching Anthropic shape
  (`kept_error.go:30-100`), so an invented type would reach the client. The "overloaded"
  wording stays, because that is what `vendorOverloaded` and a client's retry matcher read.

Kept deliberately: an `internal` `500` for anything unrecognized, with a fixed sanitized text
(`GENERIC_FAILURE_MESSAGE`, `Agent execution terminated due to error`) rather than an echoed
stderr tail; and this bridge's own saturation (`503`) resting the model on the account for
30 seconds. Magpie's official Claude bridge instead treats its own no-room as a provider-wide
"ask nobody else, rest nobody" event, which fits one shared CLI but not per-account workers,
where another account can genuinely answer.

## 1.1 A failed account stops at that account

Magpie's `retryable` (`internal/gateway/fallback.go:2039-2064`) is what turns one failure into
requests from more accounts: `401`, `402`, `403`, `404`, `408`, `429` and every `5xx` answer
"try another member", and `400`/`422` do too when their words read as a quota, a refusal or an
unserved model. **A `403` is retryable as well**, so a vendor's policy refusal does not stop the
router either, and no response header can veto a retry: Magpie reads none of them
(`x-should-retry` is advice for a direct client).

With `account_failover` off — the default — the verdicts that are about *this account* answer
`409` instead of `401`/`402`/`403`/`429`:

| Verdict | With failover | Default (`409`) |
|---|---|---|
| `vendor_restricted`, `vendor_policy` | `403` | `409` |
| `auth` | `401` | `409` |
| `credit_exhausted` | `402` | `409` |
| `quota`, `rate_limit` | `429` | `409` |

`error.type` does not change, so a direct client still reads `rate_limit_error` /
`authentication_error`. What changes is routing: `409` is not in `retryable`, so the error reaches
the agent and nothing is asked on its behalf.

Two wordings had to change with the status, because Magpie reads the body as well:

- **Credit.** `failure()` reads `creditWords` (`balance`, `credit`, `billing`, `payment`, ...) at
  *any* `4xx`, and `retryable` follows a `4xx` read as `failCredit` whatever its status. The
  detailed credit message therefore still walked the pool at `409`; the stopped branch says the
  same thing without a word of that list (`CREDIT_STOPPED_FAILURE_MESSAGE`).
- **A bare throttle.** Every `failRate` branch requires `status == 429`, so a `409` carrying the
  rate-limit wording is recorded as `failOther` rather than a brief rate rest. That is the
  intended trade: the turn is not failed over, so there is no rest to schedule. `quota` keeps its
  classification (`usedUpWords` is read below `500`), so a spent window still shows as one.

Two consequences worth stating:

- **Magpie no longer rests the account on that turn.** The rest happens on the failover branch
  (`gateway.go:5212-5223`), which the answer never enters. `/usage` polling still shows the spent
  window, so the account's state in Magpie is right; it is simply not held out of routing for the
  window's length.
- **Two non-account verdicts still walk the pool.** Every `5xx` is retryable and a plugin cannot
  change that, so an `upstream_busy` `503` or an `internal` `500` may be asked of another account;
  and `model_unserved` answers `404`, which `retryable` also follows, so a model this account is
  not served is asked of the next one. Both are about the vendor or the model rather than this
  account's quota, sign-in or policy, which is why they keep their status.

A group's own routing can stop the walk for every provider, plugin or not, without this option:
`AffinityStrict` keeps a conversation on the account that answered it, and a `Manual` group sends
only to the member the user picked (`internal/provider/group.go:54-90`). Neither is settable from a
plugin's manifest; the option here is the plugin's own answer.

### Magpie router behavior this mapping depends on

Read from Magpie source:

- `quotaWords` (`internal/gateway/fallback.go:1667`) matches `quota`, `insufficient`,
  `balance`, `credit`, `billing`, `budget`, `exceeded`, `overloaded`, `rate.?limit`,
  `usage.?limit`, `limit.?reached`, `too many requests`, and the Chinese words, but not a bare
  `limit`. A match is not by itself a rest: the class comes from `routing.go:570-635`
  (`usedUpWords`/`plannedWords` for a 429, `quotaCodes` for a 5xx, `creditWords` for
  402/`insufficient_quota`). A bare 429 carrying the vendor's `(e.g. check quota)` reads as
  `failQuota` (15-minute rest) purely because of that phrase; without it, `failRate`
  (a one-minute backoff).
- `tooLong` (`gateway.go:11104`) refuses the overflow reading when the body also contains
  `max_tokens`, `max_output_tokens`, `max_completion_tokens` or pace wording, so a detail
  appended to a 400 can veto the sentence that made it an overflow. The plugin leaves the
  detail off when it carries those words (`tooLongVetoed`).
- A `402` from a plugin account is `failCredit` with `creditRest` (30 minutes, guessed) and
  `askAt = fallbackCooldown`; `creditLadder` is reached only without an `Account`.
- Magpie reads the body it is sent and reads no negation. A fixed message is therefore not
  automatically safe: every explanation the plugin writes, including the prompt-refusal hint,
  carries none of the words Magpie treats as a spent window. `test/protocol.test.ts` pins every
  hint against that vocabulary.

Evidence for the wording: the suspended account's own answer, captured from the live CLI,

> `PERMISSION_DENIED (code 403): This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.`

`agy`'s gRPC status vocabulary read from its binary (`UNAVAILABLE`, `DEADLINE_EXCEEDED`,
`NOT_FOUND`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`, ...), and the refusal texts recorded in
Magpie's `usage.jsonl`.

## 2. Classification precedence and evidence filtering

`classifyAgentFailure()` applies, in order: `context_budget` (400) -> `vendor_restricted` /
`vendor_policy` (403) -> `auth` (401) -> `quota` (429, named window) -> `rate_limit` (429,
bare) -> `model_unserved` (404) -> `upstream_busy` (503) -> `invalid_request` (400) ->
`internal` (500). A zero-budget trajectory failure is therefore never reported as `429` or
`401`.

Log and stderr text passes through filters before any keyword is matched:

- `quotaProject=` metadata: routine OAuth/login records contain `quotaProject=<id>`.
  `isBenignEvidence()` treats such records as benign unless a real quota/429 signal
  accompanies them, and `normalizeRuntimeText()` strips `quotaProject=...` values.
- glog prefixes: `GLOG_PREFIX_RE`
  (`^([IWEF])(\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+.*?)\]\s?([\s\S]*)$`) strips severity,
  timestamp, PID and source line before matching, so a `429` substring in a PID, port or
  timestamp never triggers a `429`.
- Severity and wording gates (`extractErrorEvidence`):
  - `I` (info) records are discarded, with one anchored exception: `Run: attempt N failed`
    that also names a limit. `agy` logs its in-process retry at info severity, and that record
    is the only evidence a single-retry `429` termination carries; without it the turn reads as
    a generic `500`.
  - `W` (warning) records need an unambiguous signal (`STRONG_SIGNAL_RE` or `STATUS_429_RE`).
  - `STATUS_429_RE` requires HTTP/status/gRPC context (`HTTP/1.1 429`, `status: 429`,
    `code=429`, `(429)`, `429 Too Many Requests`), never a bare number.
  - Unprefixed prose must match `FAILURE_WORDING_RE` or `hasVerdictSignal()`; benign launcher
    messages (`failed to open browser`, `xdg-open`) are ignored.
- Auth chatter: healthy `agy` processes log `You are not logged into Antigravity.` during
  background startup polling. Logs are matched against `AUTH_RE`, which excludes that line;
  `RPC_AUTH_RE` applies only to the turn's own ACP RPC error text, after
  `normalizeRuntimeText()` has stripped any `AcpConnection.handleExit` `Stderr tail:` wrapper.

## 3. Spent quota versus transient limit

- `EXHAUSTED_QUOTA_RE` claims only wording that names a spent quota (`exhausted your quota`,
  `quota exceeded`, `insufficient quota`, and the forms below); everything else 429-shaped is
  `rate_limit`. `classifyAgentFailure` answers `quota` only for a named window, `rate_limit`
  for a bare 429. `exhausted your capacity` stays `quota`.
- The spent-window wording several sibling bridges parse is recognized too: `Usage Limit Reached`
  and `Your limit will reset in 2 hours, 30 minutes`, which also gives `Retry-After` a source
  that is not a guess. An absolute form (`reset on Sep 4, 2026 12:30 UTC`) is classified but
  yields no header (open: [plan](plan.md)).
- `rate_limit` answers with `TRANSIENT_LIMIT_FAILURE_MESSAGE`: a plain `429` whose text contains
  neither `quota` nor `rate limit`, so Magpie holds the account briefly and asks the next one
  instead of holding it for a window.
- `quota` is for a 429/403 whose own words say a quota is spent, which Magpie should hold
  until the window renews.

Antigravity's generic 429 is `RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).`
Google's boilerplate; on its own it names no window.

## 4. Upstream retry notices and retry storms

`agy` retries transient `502`/`503`/`504` and per-minute `429` failures in-process with
exponential backoff (its own changelog: they "automatically retry in-process with exponential
backoff"), streaming `⚠ API error (attempt N): ...` notices into the reply. Eight attempts
spanning about 8 minutes were observed on `agy 1.5.8`.

- The notices are stripped from the stream and counted (`splitAgentRetryNotices`,
  `TurnContext.absorbRetryNotices`), so they never reach the agent as model text. Only a
  newline-terminated line counts as a complete notice; a header whose body has not arrived is
  held with it, so a split after `(attempt 1):` cannot let the body through as answer text.
- Corroboration (`hasUpstreamRetryEvidence`): the same words reach the stream when a model
  quotes the incident ("explain this error"). Nothing is stripped, counted or cancelled unless
  the turn's own log shows `Run: attempt N failed`, the record `agy` writes when it really
  retries. A turn that merely talks about the notice delivers every line as answer text, and a
  chunk that also carries real output is delivered before the guard is consulted.
- A notice-shaped chunk that arrives before that record is readable is held (bounded to 4 KiB)
  rather than delivered, because delivering it would mark the turn as having produced work and
  disable the guard for the rest of the turn. The hold is released as answer text at turn end
  or when the buffer is exceeded.
- Trade-off, deliberate: if the turn's log lacks the record (an unwritable `--log-file`, or a
  read that lands before the write), the notices come through as text and the turn waits out
  `agy`'s ladder: noise, never a cancelled answer.
- Storm cut-off: when a turn has delivered nothing meaningful (no text, thought or tool call)
  and reaches `MAX_UPSTREAM_RETRY_NOTICES` (2, about 12 s of backoff), the turn's queue is
  detached, the turn is cancelled with `session/cancel`, and it finishes once the native cancel
  lands. This keeps the caller inside its own request timeout and lets failover happen.
  Detaching first matters: `agy` settles a cancelled prompt as an error whose only log evidence
  is the `I`-severity retry record, so a turn finished by that settlement would answer `500`
  and climb the caller's backoff instead of failing over.
- A storm keeps the class of the attempt that failed. The failure is diagnosed before
  `session/cancel` is sent (the cancel writes its own `context canceled` records, and the
  vendor's retry notice names the code), so an outage answers `503`, a named window answers
  `quota`, and only a bare throttle answers the transient `429`. The notice text is kept
  because an outage record sits at `I` severity, which the evidence filter drops.

## 5. Terminal notices and failures delivered as content

`agy 1.5.8` can end a turn with three terminal notices, all recognized
(`AGENT_TERMINAL_MARKERS`): the generic `Agent execution terminated due to error`, the
dead-connection `There was a network issue connecting to the server, please try again`, and
the spent-credit `Your AI credits balance is too low to continue`. A bridge that knows only the
first forwards the other two as if the model had written them, and answers `end_turn`.

Corroboration is spent where a wrong answer is expensive. A held terminal notice becomes the
turn's failure only when the turn's own log names the same failure, except the generic marker
and the dead-connection marker, which answer `500` and `503` (30-second model rest, no failure
counted) and are taken at their word. The spent-credit notice answers `402`, a half-hour rest,
so it needs the log. A model asked what an error means writes the notice back, and that must
stay answer text.

On `agy 1.5.9` a suspended account answers with the vendor's suspension sentence as the turn's
content and `stopReason: end_turn`. Nothing errors and no log line is written, so a bridge that
only reads the result answers `200` with that sentence and Magpie keeps choosing that account. The
sentence reports the state of an account rather than a single failed turn, which is why the class
must rotate the account instead of delivering it as an answer; nothing establishes that a
suspension is permanent, and appeals do restore accounts ([account safety](account-safety.md)).
Probe history: [`CHANGELOG.md`](../CHANGELOG.md), "a suspended account answers as content". The sentence is
a terminal marker (`AGENT_TERMINAL_MARKERS`), taken at its word only when it is the whole
answer: a model writing it after prose is quoting it.

## 6. Prompt refusals and cloaking

Trigger matching in `src/protocol/cloak.ts` reads past invisible characters and any run of
white space between words, like Google's own check: a trigger line broken up with zero-width
spaces, or wrapped after a comma, is still that line. Since 2026-11-14 the upstream also refuses
those broken-up copies, so the cloak rewords each line the way `agy-cli/cloak.mjs` does
(`based on` -> `built on`, `created by` -> `built by`, `keywords` -> `key words`, the Agent SDK
line -> "built on the Agent SDK by Anthropic", and Claude Code's billing line dropped).
Zero-width insertion is no defence and is not used. The same matcher feeds `refusalHint`, so a
prompt that still trips the refusal is reported as a prompt refusal, not as an account's quota.

## 7. Turn-scoped log inspection (`TurnLogWatch`)

`agy acp --worker --disable-telemetry` writes execution errors (for example
`agent executor error: generating and executing: serializing trajectory: maxMessageTokens must be positive, got 0`)
to a PID-suffixed `agy-acp.log.<PID>`, not to `agy-acp.log`; reading only the latter hides the
real failure behind a generic `500` (`Agent execution terminated due to error`). `TurnLogWatch`
(`src/runtime/diagnostics.ts`) watches both, with strict per-turn boundaries so a stale error
from an earlier turn never decides the current turn's status:

1. `markTurnStart` records inode and byte offset of up to 8 log files
   (`DEFAULT_MAX_LOG_FILES`): `agy-acp.log` when present plus the newest `agy-acp.log.<PID>`.
2. `readTurnEvidence` reads only bytes appended since the mark, falling back to a bounded tail
   read when a file is new, replaced (new inode) or truncated; capped at 64 KiB per file
   (`DEFAULT_MAX_BYTES_PER_LOG`) and 256 KiB total (`DEFAULT_MAX_TOTAL_LOG_BYTES`).
3. `stderrDelta` extracts only bytes appended to the worker's 16 KiB stderr ring since the turn
   started (longest suffix-prefix overlap if the ring wrapped), and `normalizeRuntimeText()`
   strips `Stderr tail:` wrappers before RPC error strings are classified, so startup chatter
   cannot leak into turn diagnostics.

## 8. `systemPrompt.append` serialization budget (`agy 1.5.8`)

Probes on isolated `agy 1.5.8` (`agy acp --worker --disable-telemetry`), a fresh session per
case, history injected through `_meta.antigravity.systemPrompt.append`, `gemini-4-carbon`
(`high` effort), user prompt `Reply with the single word OK.`:

| `append` payload | Result |
|---|---|
| 200,000 bytes (English) | pass (`inputTokens 46,518`) |
| 500,000 bytes (English) | pass (`inputTokens 113,188`) |
| 720,000 bytes (English) | pass (`inputTokens 162,071`) |
| 760,000 bytes (English) | fail: `serializing trajectory: no messages fit within the context token budget` |
| 780,000 / 786,000 / 790,000 / 1,000,000 / 1,200,000 bytes (English) | fail: `serializing trajectory: maxMessageTokens must be positive, got 0` |
| 720,000 bytes (CJK, 240,000 characters) | pass (`inputTokens 137,721`) |
| 760,002 bytes (CJK, 253,334 characters) | fail |

- Independent of effort, timeout and process model: reproduces without tools (ruling out MCP
  timeouts) and identically under `--process-per-session` and `--worker`.
- The threshold tracks serialized bytes, not tokens: 720,000 bytes of CJK (137,721 tokens)
  passes while 760,002 bytes of CJK (about 145,000 tokens) fails, and 720,000 bytes of English
  (162,071 tokens) passes.
- A single `session/prompt` user message is silently truncated around 178 KB (a
  1,800,000-character probe reported only 44,603 input tokens); `systemPrompt.append` is not
  truncated and fails hard once exceeded.
- Warm sessions are unaffected: a follow-up turn hit the prompt cache (`cache 199,732 + new 3,573`);
  only a cold replay re-injects full history.
- `1,048,576 - 262,144 = 786,432` is numerically close to the observed 780,000-byte boundary;
  that is an unverified coincidence, not a known formula.
- Mitigation (`src/sessions/prompt-render.ts`): cold-replay `<prior_conversation_history>`
  appends are capped at 512 KiB by default (64 KiB for GPT-OSS models, overridable with
  `AGY_BRIDGE_MAX_SYSTEM_HISTORY_BYTES`), with the actual system prompt bytes deducted, so a
  cold replay stays well below the threshold.

`classifyAgentFailure()` maps both native phrasings to `context_budget` (`400`) before any
quota or auth pattern, with the fixed `CONTEXT_BUDGET_FAILURE_MESSAGE`:

> `Prompt is too long for Antigravity to serialize: the conversation exceeds the model's maximum context length. Start a new conversation or reduce the length of the messages.`

Status and wording are chosen for Magpie's `overflowed`, which needs a `400`/`413`/`422` whose
words match `tooLongRe` (`prompt is too long`, `maximum context length`, `reduce the length of
the messages`). The same conversation is too long on every account of this plugin, so failing
over would only repeat the refusal. The message avoids `quota` and `rate limit`, even negated,
because `quotaWords` would otherwise park a healthy account.

## 9. Model catalog and `unlisted` accounts

Magpie filters candidate accounts per model using each account's reported catalog; an account
missing a requested model is marked `unlisted` and skipped during failover. When an account's
first `agy models` probe exceeds the fast-wait timeout, `src/usage/catalog.ts` returns
`STATIC_FALLBACK_MODELS`, which therefore lists all 22 known native model entries:

- Gemini 4 Carbon: `gemini-4-carbon-high`, `gemini-4-carbon-medium`, `gemini-4-carbon-low`
- Gemini 4 Hydrogen: `gemini-4-hydrogen-xhigh`, `gemini-4-hydrogen-high`, `gemini-4-hydrogen-medium`, `gemini-4-hydrogen-low`
- Orchestrator: `gemini-pro-orchestrator`, `gemini-pro-orchestrator-argon`
- Gemini 4 Argon: `gemini-4-argon-high`, `gemini-4-argon-medium`, `gemini-4-argon-low`
- Gemini 3.8 Flash: `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low`
- Claude Opus 5.5: `claude-opus-5-5-high`, `claude-opus-5-5-medium`, `claude-opus-5-5-low`
- Claude Sonnet 5.5: `claude-sonnet-5-5-high`, `claude-sonnet-5-5-medium`, `claude-sonnet-5-5-low`
- GPT-OSS 120B: `gpt-oss-120b-medium`

Successful real `agy models` lists are cached for 24 hours (at most 128 accounts), so a
transient probe timeout does not downgrade an account to a narrower catalog. The cache is
fenced by `getAgyBinaryFingerprint()` (the resolved binary's `mtimeMs` + `size`), so upgrading
the CLI refreshes the catalog on the next turn instead of after the TTL. Catalogs stay isolated
per account: the plugin never merges model lists across accounts or reads another account's
credentials to bypass Magpie's router.
