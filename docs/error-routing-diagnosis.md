# Error Classification, Turn Log Diagnostics & Multi-Account Routing

This document serves as a technical reference for `agy acp` failure classification, turn-scoped log inspection (`TurnLogWatch` in `src/runtime/diagnostics.ts`), empirical `systemPrompt.append` trajectory serialization budget limits on `agy 1.5.8`, strict HTTP `429` / `401` metadata filtering, and complete `STATIC_FALLBACK_MODELS` coverage (`src/usage/catalog.ts`) for multi-account failover in Magpie (`>= 0.1.3900`).

---

## 1. Turn-Scoped Log Inspection (`TurnLogWatch`)

### Why Base Log Reading Missed Upstream Failures

When `agy-acp` originally spawned `agy acp --process-per-session`, the frontend process wrote to `agy-acp.log`, while the spawned worker child wrote execution errors (`agent executor error: generating and executing: serializing trajectory: maxMessageTokens must be positive, got 0`) to a PID-suffixed file `agy-acp.log.<PID>`. Reading only `agy-acp.log` hid the real failure behind a generic HTTP `500` (`Agent execution terminated due to error`), causing retries on the same account.

> Since `0.1.3` (Phase 2), `agy-acp` spawns `agy acp --worker --disable-telemetry` directly as a single process (preserving `mcpCapabilities.http` while eliminating the frontend wrapper process). Because `--worker` still writes execution logs to `agy-acp.log.<PID>`, `TurnLogWatch` continues to watch both `agy-acp.log` and `agy-acp.log.<PID>`.

### Bounded Per-Turn Log & Stderr Isolation

`TurnLogWatch` (`src/runtime/diagnostics.ts`) enforces strict per-turn boundaries so stale errors from earlier turns never poison the current turn's HTTP status:

1. **Snapshot at Turn Start (`markTurnStart`)**: Records the inode and byte offset of up to `8` (`DEFAULT_MAX_LOG_FILES`) log files total (`agy-acp.log` when present plus the newest `agy-acp.log.<PID>` files).
2. **Bounded Delta Read (`readTurnEvidence`)**: Reads only bytes appended since the turn's mark (falling back to a bounded tail read when a file is new, rotated/replaced with a new inode, or truncated), capped at `64 KiB` per file (`DEFAULT_MAX_BYTES_PER_LOG`) and `256 KiB` total (`DEFAULT_MAX_TOTAL_LOG_BYTES`).
3. **Incremental Stderr Diffing (`stderrDelta`)**: Extracts only bytes appended to the worker's `16 KiB` stderr ring buffer since the turn started (matching the longest suffix-prefix overlap if the ring wrapped), and strips `AcpConnection.handleExit` `Stderr tail:` wrappers in `normalizeRuntimeText()` before classifying RPC error strings so startup chatter cannot leak into turn diagnostics.

---

## 2. Empirical `systemPrompt.append` Trajectory Serialization Budget (`agy 1.5.8`)

### Reproducible Probes

Tested with isolated `agy 1.5.8` (`agy acp --worker --disable-telemetry`), creating a fresh session per case, injecting conversation history via `_meta.antigravity.systemPrompt.append`, using `gemini-4-carbon` (`high` effort) and the fixed user prompt `Reply with the single word OK.`:

| Injected `append` Payload Size | Observed Result |
| --- | --- |
| 200,000 bytes (English) | Pass (`inputTokens 46,518`) |
| 500,000 bytes (English) | Pass (`inputTokens 113,188`) |
| 720,000 bytes (English) | Pass (`inputTokens 162,071`) |
| 760,000 bytes (English) | Fail: `serializing trajectory: no messages fit within the context token budget` |
| 780,000 / 786,000 / 790,000 / 1,000,000 / 1,200,000 bytes (English) | Fail: `serializing trajectory: maxMessageTokens must be positive, got 0` |
| 720,000 bytes (CJK, 240,000 characters) | Pass (`inputTokens 137,721`) |
| 760,002 bytes (CJK, 253,334 characters) | Fail |

### Observed Boundaries & Mitigations

- **Independent of Effort / Timeout / Process Model**: Reproduces without tools (ruling out MCP timeouts) and identically across both `--process-per-session` and `--worker`.
- **Byte-Tracked Boundary**: The failure threshold tracks serialized byte length rather than token count—720,000 bytes of CJK text (`137,721` tokens) succeeds while 760,002 bytes of CJK (~145,000 tokens) fails, whereas 720,000 bytes of English (`162,071` tokens) succeeds.
- **`session/prompt` vs `systemPrompt.append`**: A single `session/prompt` user message is silently truncated around ~178 KB (a `1,800,000`-character probe reported only `44,603` input tokens), whereas `systemPrompt.append` is not truncated and triggers a hard trajectory serialization error once exceeded.
- **Warm Sessions Unaffected**: Subsequent turns in an active session hit prompt cache (`cache 199,732 + new 3,573` measured in a follow-up turn); only cold replays re-inject full prior history.
- **Unpublished Native Formula**: While `1,048,576 - 262,144 = 786,432` is numerically close to the observed `780,000`-byte boundary, that correspondence is an unverified coincidence rather than a proven formula.
- **Bounded Bridge Mitigation (`src/sessions/prompt-render.ts`)**: `agy-acp` caps `<prior_conversation_history>` cold-replay appends at **`512 KiB`** by default (`64 KiB` for GPT-OSS models, overridable via `AGY_BRIDGE_MAX_SYSTEM_HISTORY_BYTES`), deducting the actual system prompt bytes so cold replays stay well below the failure threshold (replacing the original `2 MiB` ceiling that routinely hit this range).

### `context_budget` Classification (HTTP `400`)

`classifyAgentFailure()` maps both native phrasings (`maxMessageTokens must be positive, got 0` and `no messages fit within the context token budget`) to `"context_budget"` (HTTP `400`) before checking quota or auth patterns, returning the fixed `CONTEXT_BUDGET_FAILURE_MESSAGE`. The status and wording are chosen for Magpie's `overflowed`, which needs a `400`/`413`/`422` whose words match `tooLongRe` (`prompt is too long`, `maximum context length`, `reduce the length of the messages`) — Magpie then asks a member with room, rests no account, and tells the agent to compact, while the same conversation is too long on every account of this plugin, so failing over only repeated the refusal:

> `Prompt is too long for Antigravity to serialize: the conversation exceeds the model's maximum context length. Start a new conversation or reduce the length of the messages.`

This message intentionally avoids words like `quota` or `rate limit` (even negated), because Magpie's gateway `quotaWords` regex (`fallback.go`) scans error text and would wrongly park a healthy account if those words appeared. Unclassified internal failures similarly return the fixed `GENERIC_FAILURE_MESSAGE` (`Agent execution terminated due to error`) without interpolating raw stderr tails.

---

## 3. Strict `429` / `401` Metadata Stripping & Failure Precedence

Earlier log matching ran `/429|RESOURCE_EXHAUSTED|exhausted your quota|quota/i` across raw log and stderr tails, creating false positives:

- **`quotaProject=` Metadata**: Routine OAuth/login metadata contains `quotaProject=<id>`. `isBenignEvidence()` treats `quotaProject=` records as benign unless accompanied by a real quota/429 signal, and `normalizeRuntimeText()` strips `quotaProject=...` values.
- **glog Prefixes**: `GLOG_PREFIX_RE` (`^([IWEF])(\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+.*?)\]\s?([\s\S]*)$`) strips severity, timestamps, PIDs, and source line numbers before keyword matching so numeric `429` substrings in PIDs, ports, or timestamps never trigger `429` classification.
- **Severity & Wording Gates (`extractErrorEvidence`)**:
  - `I` (info) glog records are discarded unconditionally, with one anchored exception: `Run: attempt N failed` that also names a limit. `agy` logs its in-process retry at info severity, and that record is the only evidence a single-retry `429` termination carries; without it the turn read as a generic `500`.
  - `W` (warning) records require an unambiguous signal (`STRONG_SIGNAL_RE` or `STATUS_429_RE`).
  - `STATUS_429_RE` requires HTTP/status/gRPC context (e.g., `HTTP/1.1 429`, `status: 429`, `code=429`, `(429)`, `429 Too Many Requests`), never bare numbers.
  - Unprefixed prose must match `FAILURE_WORDING_RE` or `hasVerdictSignal()`, and benign launcher messages (`failed to open browser`, `xdg-open`) are ignored.
- **Auth Chatter Separation (`AUTH_RE` vs `RPC_AUTH_RE`)**: Healthy `agy` processes routinely log `You are not logged into Antigravity.` during background startup quirk polling. Logs are matched against `AUTH_RE` (which excludes that ambient chatter), while `RPC_AUTH_RE` applies only to the turn's own ACP RPC error text (`normalizeRuntimeText` having stripped any `Stderr tail:`).
- **Classification Precedence**: `context_budget` (400) -> `vendor_restricted`/`vendor_policy` (403) -> `auth` (401) -> `quota` (429, named) -> `rate_limit` (429, bare) -> `model_unserved` (404) -> `upstream_busy` (503) -> `invalid_request` (400) -> `internal` (500). A zero-budget trajectory failure is never misreported as `429` or `401`. See §6 for what each one makes Magpie do.

---

## 4. Complete `STATIC_FALLBACK_MODELS` Coverage for Multi-Account Routing

Magpie filters candidate accounts per model using each account's reported model catalog; an account missing a requested model is marked `unlisted` and skipped rather than tried during failover.

Previously, `STATIC_FALLBACK_MODELS` in `src/usage/catalog.ts` omitted Carbon, Hydrogen, and Orchestrator entries. When an account's initial `agy models` probe exceeded the fast-wait timeout and returned the static fallback catalog, Magpie excluded that account from routing for those models instead of failing over to `Account B`.

`STATIC_FALLBACK_MODELS` now includes all **22 known native model entries** so fresh or slow-probing accounts keep consistent family and effort routing across all accounts:

- **Gemini 4 Carbon**: `gemini-4-carbon-high`, `gemini-4-carbon-medium`, `gemini-4-carbon-low`
- **Gemini 4 Hydrogen**: `gemini-4-hydrogen-xhigh`, `gemini-4-hydrogen-high`, `gemini-4-hydrogen-medium`, `gemini-4-hydrogen-low`
- **Orchestrator**: `gemini-pro-orchestrator`, `gemini-pro-orchestrator-argon`
- **Gemini 4 Argon**: `gemini-4-argon-high`, `gemini-4-argon-medium`, `gemini-4-argon-low`
- **Gemini 3.8 Flash**: `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low`
- **Claude Opus 5.5**: `claude-opus-5-5-high`, `claude-opus-5-5-medium`, `claude-opus-5-5-low`
- **Claude Sonnet 5.5**: `claude-sonnet-5-5-high`, `claude-sonnet-5-5-medium`, `claude-sonnet-5-5-low`
- **GPT-OSS 120B**: `gpt-oss-120b-medium`

In addition, `catalog.ts` caches successful real `agy models` lists for 24 hours (capped at 128 accounts: the cache is fenced by `getAgyBinaryFingerprint()` — the resolved `agy` binary's `mtimeMs` + `size` — so upgrading the CLI refreshes the catalog on the next turn instead of after the TTL) so transient probe timeouts do not downgrade an account to a narrower catalog. Account catalogs remain strictly isolated per account—the plugin never merges model lists across accounts or reads another account's credentials to bypass Magpie's router.

---

## 5. Transient Limits vs. Account Quota (Observed Incident, `v0.1.8`)

### What went wrong

A `gemini-4-carbon` turn through Magpie → `agy-acp` → `agy 1.5.8` failed as follows:

1. Antigravity answered the request with `RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).`, which is Google's generic 429 boilerplate.
2. `agy` retried it **in-process with exponential backoff** — its own changelog states that transient `502`/`503`/`504` and *per-minute* `429` failures "automatically retry in-process with exponential backoff". Eight observed attempts spanned ~8 minutes, streaming `⚠ API error (attempt N): …` notices into the reply.
3. The plugin classified `resource_exhausted` as `quota` and answered `429 {"error":{"message":"Account quota exhausted"}}`.
4. Magpie's `quotaWords` regex (`fallback.go`) matched that text, and the sole downstream relay (CLIProxyAPI) cooled its only key for the provider: every later attempt was answered `503 auth_unavailable: no auth available (providers=…; last upstream error: api_error: Account quota exhausted)` — the error the user actually saw.

Measured while that account was failing: `Gemini · 5 hours` had `58.4%` left and `Gemini · 7 days` `84.6%` left, and live probes (small, `reasoning_effort: high`, 8 concurrent, 3.3 MB body) all answered `200`. The 429 was a per-minute limit, not a spent window.

### The fix

- **Split the verdicts** (`src/runtime/diagnostics.ts`): `EXHAUSTED_QUOTA_RE` claims only wording that names a spent quota (`exhausted your quota`, `quota exceeded`, `insufficient quota`); everything else 429-shaped is `rate_limit`. `classifyAgentFailure` therefore answers `quota` only for a named window, and `rate_limit` for a bare 429.
- **Say nothing of quota** (`TRANSIENT_LIMIT_FAILURE_MESSAGE`): the `rate_limit` answer is a plain `429` whose text contains neither `quota` nor `rate limit`, so Magpie holds the account briefly and asks the next one instead of holding it for a window.
- **Stop the storm** (`src/runtime/worker.ts`, `src/runtime/turn-context.ts`): `agy` retry notices are stripped from the stream and counted (`splitAgentRetryNotices`, `TurnContext.absorbRetryNotices`), so they never reach the agent as model text. Only a newline-terminated line counts as a complete notice — a header whose body is still to come is held with it, so a split after `(attempt 1):` cannot let the body through as answer text. When a turn has delivered nothing meaningful (no text, thought or tool call) and reaches `MAX_UPSTREAM_RETRY_NOTICES` (2, ≈12s of backoff), the turn's queue is detached, the turn is cancelled via `session/cancel`, and it is finished as `rate_limit` once the native cancel lands, which keeps the caller inside its own request timeout and lets failover happen. Detaching first matters: `agy` settles a cancelled prompt as an error whose only log evidence is the `I`-severity retry record, so a turn finished by that settlement would answer `500` and climb the caller's backoff instead of failing over.
- **Corroborate before believing the text** (`hasUpstreamRetryEvidence`): the same words reach the stream when a model *quotes* the incident ("explain this error"), so nothing is stripped, counted or cancelled unless the turn's own log shows `Run: attempt N failed` — the record `agy` writes when it really retries. A turn that merely talks about the notice delivers every line as answer text, and a chunk that also carried real output is delivered before the guard is consulted. A notice-shaped chunk that arrives before that record is readable is *held* (bounded to 4 KiB) rather than delivered, because delivering it would mark the turn as having produced work and disable the guard for the rest of the turn; the hold is released as answer text at turn end or when the buffer is exceeded. The trade-off is deliberate: if a turn's log is missing the record (an unwritable `--log-file`, or a read that lands before the write), the notices come through as text and the turn waits out `agy`'s ladder, exactly as it did before `v0.1.8` — noise, never a cancelled answer.

`quota` remains for the case it describes: a 429/403 whose own words say a quota is spent, which is what Magpie should hold until the window renews.

---

## 6. Status Alignment with Magpie's Router (`v0.1.9`)

Every failure the plugin can answer, and what Magpie does with it. The right-hand column is Magpie's own behavior (`internal/gateway/fallback.go`, `routing.go`), not an intention of ours; a class whose status or words disagree with it makes the router rest the wrong thing or fail over nowhere.

| Verdict | Status | Words | What Magpie does |
| --- | --- | --- | --- |
| `context_budget` | `400` | "prompt is too long … maximum context length … reduce the length of the messages" | `overflowed` (its `tooLongRe` matches these words): asks a member with room, rests no account, tells the agent to compact |
| `vendor_restricted` | `403` | the vendor's own "disabled in this account for violation of Terms of Service" | plain `403`: retryable, next account asked, nobody rests. **Not** `googleSuspended`: that predicate needs the account's Agent to be `antigravity`/`gemini`, and Magpie builds plugin accounts with `Agent: "plugin"` (`internal/provider/plugins.go`, `pluginProviderServing`). The sentence is kept for the human reading it |
| `vendor_policy` | `403` | "policy or region restriction" | plain `403`: retryable, next account asked |
| `auth` | `401` + `SignInHeader: expired` | expired sign-in | account marked as needing a new sign-in |
| `quota` | `429` | "Account quota exhausted" | rests until the window it names renews (`quota_hours`/7-day) |
| `rate_limit` | `429` | no quota words | brief rate rest, next account asked |
| `model_unserved` | `404` | "model not found" | only that model rests on that account (`modelRefused`); its other models keep working |
| `upstream_busy` | `503` | "overloaded" | the vendor being busy (`vendorOverloaded`): 30-second rest, **no** failure counted on the account's ladder |
| `credit_exhausted` | `402` | "credit balance is too low" | out of credit (`failCredit`): `creditRest`, a guessed 30-minute rest that an early retry may shorten — a plugin account has a non-nil `Account`, so it does not climb `creditLadder`, which only a key without an account reaches — `agy 1.5.8` words this on its own, ending the turn with `⚠ Your AI credits balance is too low to continue.` |
| `model_unserved` / `vendor_*` / `context_budget` | as above | fixed sentence, then `Upstream said: …` | the vendor's own words follow the verdict, bounded to one line and redacted; they are dropped entirely when they carry limit wording, so an echoed 400/403 can never read as a spent window |
| any `429`/`502`/`503`/`402` that names a wait | as above | `Retry-After: <seconds>`, from the **last** wait the turn's log names | the vendor's own `retrying in 7s` / `resets in 2h` is clamped to 1s…24h and sent, so a direct client (OpenCode, pi) waits as long as the upstream asked |
| `400`/`401`/`404` | as above | `x-should-retry: false` | asking again as it stands cannot help; Magpie ignores it, a direct client does not retry into the same wall |
| `invalid_request` | `400` | "Invalid request to agent" | shape refusal: one more candidate is asked, nobody rests |
| `internal` | `500` | generic | plain failure: counted on the ladder, next account asked |
| client cancel | `499` | — | the agent's cancellation, nobody rests |
| bridge at capacity | `503` | "overloaded: session workers busy" | 30-second rest, no failure counted — our own saturation is not the account's fault |
| worker closed | `502` | `Worker closed: <reason>` — the reason is in the message the agent sees | counted as a failure, next account asked |

Evidence used for the wording: the suspended account's own answer, captured from the live CLI —

> `PERMISSION_DENIED (code 403): This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.`

— `agy`'s gRPC status vocabulary read from its binary (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, `NOT_FOUND`, `INVALID_ARGUMENT`, `PERMISSION_DENIED`, …), and the refusal texts already recorded in Magpie's `usage.jsonl`.

A fixed message is not automatically safe: Magpie reads the body it is sent, and it reads no negation. The prompt-refusal explanation therefore carries **none** of the words Magpie treats as a spent window — an earlier version said "not an account quota limit", which answers `failQuota` and rests a healthy account for its window. `test/protocol.test.ts` pins every hint against that vocabulary.

Corroboration is spent where a wrong answer is expensive. A held terminal notice becomes the turn's failure only when the turn's own log names the same failure — except the generic marker and the dead-connection one, which answer a `500` and a `503` (30-second model rest, no failure counted) and are taken at their word. The spent-credit notice answers a `402`, a half-hour rest, so it needs the log. A model that is asked what an error means writes the notice back, and that must stay answer text.

A spent window is recognized in the wording several sibling bridges parse too: `Usage Limit Reached` and `Your limit will reset in 2 hours, 30 minutes` (`EXHAUSTED_QUOTA_RE`), which also gives `Retry-After` a source that is not a guess. An absolute form (`reset on Sep 4, 2026 12:30 UTC`) is classified but yields no header yet.

A retry storm keeps the class of the attempt that failed: the failure is diagnosed before `session/cancel` is sent (the cancel writes its own `context canceled` records, and the vendor's retry notice names the code), so an outage answers `503`, a named window answers `quota`, and only a bare throttle answers the transient `429`. The notice text is kept because an outage record sits at `I` severity, which the evidence filter drops.

The three terminal notices `agy 1.5.8` can end a turn with are all recognized (`AGENT_TERMINAL_MARKERS`): the generic `Agent execution terminated due to error`, the dead-connection `There was a network issue connecting to the server, please try again`, and the spent-credit `Your AI credits balance is too low to continue`. A bridge that knows only the first forwards the other two as if the model had written them, and answers `end_turn`.

Trigger matching in `src/protocol/cloak.ts` reads past invisible characters and any run of white space between words, like Google's own check: a copy of a trigger line broken up with zero-width spaces, or wrapped after a comma, is still that line. Since 11-14 the upstream also turns those broken-up copies away, so the cloak **rewords** each line the way `agy-cli/cloak.mjs` does (`based on` -> `built on`, `created by` -> `built by`, `keywords` -> `key words`, the Agent SDK line -> "built on the Agent SDK by Anthropic", and Claude Code's billing line dropped); inserting zero-width characters is no defence and is no longer done. The same matcher feeds `refusalHint`, so a prompt that still trips the refusal is reported as a prompt refusal, not as an account's quota.

Kept deliberately as they are: an `internal` `500` for anything unrecognized (a fixed, sanitized text rather than echoing a stderr tail), and our own saturation (`503`) resting the model on the account for 30 seconds: the official Claude bridge instead treats its own no-room as a provider-wide "ask nobody else, rest nobody" event, which fits a single shared CLI but not this plugin's per-account workers, where another account genuinely can answer.

### What the router measured, and what it did not

Magpie's own words, read from source, correct three things this document once said loosely:

- `quotaWords` (`internal/gateway/fallback.go:1667`) matches `quota`, `insufficient`, `balance`, `credit`, `billing`, `budget`, `exceeded`, `overloaded`, `rate.?limit`, `usage.?limit`, `limit.?reached`, `too many requests`, and the Chinese words — but **not** a bare `limit`. A match is not by itself a rest: the class comes from `routing.go:570-635` (`usedUpWords`/`plannedWords` for a 429, `quotaCodes` for a 5xx, `creditWords` for 402/`insufficient_quota`). A bare 429 with the vendor's `(e.g. check quota)` reads as `failQuota` (15-minute rest) purely because of that phrase; without it, `failRate` (a one-minute backoff).
- `tooLong` (`gateway.go:11104`) refuses the overflow reading when the body also contains `max_tokens`, `max_output_tokens`, `max_completion_tokens` or pace wording, so a detail appended to a 400 can veto the sentence that made it an overflow. The plugin therefore leaves the detail off when it carries those words (`tooLongVetoed`).
- A `402` from a plugin account is `failCredit` with `creditRest` (30 minutes, guessed) and `askAt = fallbackCooldown`; `creditLadder` is reached only without an `Account`, which a plugin account never is.

The `error.type` follows the status as Magpie itself derives it (`errorTypeFor`, `gateway.go:11011`): `503` and `402` carry `api_error`, not `overloaded_error` or `invalid_request_error`. Magpie keeps a plugin's type for a matching Anthropic shape (`kept_error.go:30-100`), so a type of our own invention would reach the client; the "overloaded" wording stays, because that is what `vendorOverloaded` and a client's retry matcher read.

Thinking blocks carry a **UUID-shaped** signature, on by default. The shape is what matters:

- A client keeps and replays a thinking block only when it carries a signature. `pi` turns an unsigned one into ordinary history text (`anthropic-messages.ts:1716-1735`), which then goes upstream as assistant prose.
- A fabricated vendor prefix (`agy1.`, `agyb1.` — what this plugin and `agy-cli` both used) keeps the block, but Magpie reads it as a genuine foreign signature and forwards it to a Claude route, which answers `400 invalid signature in thinking block` once per new value. Magpie repairs that by dropping the block and retrying inside the same request (`refuseBoundThinking`), so it costs a round trip per turn and never a visible error.
- Magpie's preventive filter already drops a thinking block whose signature is empty **or a UUID** (`deepseekSignature`, `thinking_bound.go:265`), because that is the shape DeepSeek's endpoint issues. A UUID therefore gives the client a block to keep while no real Anthropic endpoint ever sees it — the same idea as Google's own `skip_thought_signature_validator` sentinel on the Gemini side.

`thinkingSignatureFor(sessionId, thinking)` is a SHA-256 of the pair folded into UUID shape (version 4 nibble, RFC 4122 variant), so no secret is involved and the same summary signs the same way. The block opens with an empty signature on purpose: a client adds each `signature_delta` to the value it has, so a value at the opening record would be concatenated into something that is no longer a UUID.
