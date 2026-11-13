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

### `context_budget` Classification (HTTP `500`)

`classifyAgentFailure()` maps both native phrasings (`maxMessageTokens must be positive, got 0` and `no messages fit within the context token budget`) to `"context_budget"` (HTTP `500`) before checking quota or auth patterns, returning the fixed `CONTEXT_BUDGET_FAILURE_MESSAGE`:

> `Antigravity CLI could not serialize this conversation within its context limits. Try a shorter conversation or another model/effort setting.`

This message intentionally avoids words like `quota` or `rate limit` (even negated), because Magpie's gateway `quotaWords` regex (`fallback.go`) scans error text and would wrongly park a healthy account if those words appeared. Unclassified internal failures similarly return the fixed `GENERIC_FAILURE_MESSAGE` (`Agent execution terminated due to error`) without interpolating raw stderr tails.

---

## 3. Strict `429` / `401` Metadata Stripping & Failure Precedence

Earlier log matching ran `/429|RESOURCE_EXHAUSTED|exhausted your quota|quota/i` across raw log and stderr tails, creating false positives:

- **`quotaProject=` Metadata**: Routine OAuth/login metadata contains `quotaProject=<id>`. `isBenignEvidence()` treats `quotaProject=` records as benign unless accompanied by a real quota/429 signal, and `normalizeRuntimeText()` strips `quotaProject=...` values.
- **glog Prefixes**: `GLOG_PREFIX_RE` (`^([IWEF])(\d{4} \d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+.*?)\]\s?([\s\S]*)$`) strips severity, timestamps, PIDs, and source line numbers before keyword matching so numeric `429` substrings in PIDs, ports, or timestamps never trigger `429` classification.
- **Severity & Wording Gates (`extractErrorEvidence`)**:
  - `I` (info) glog records are discarded unconditionally.
  - `W` (warning) records require an unambiguous signal (`STRONG_SIGNAL_RE` or `STATUS_429_RE`).
  - `STATUS_429_RE` requires HTTP/status/gRPC context (e.g., `HTTP/1.1 429`, `status: 429`, `code=429`, `(429)`, `429 Too Many Requests`), never bare numbers.
  - Unprefixed prose must match `FAILURE_WORDING_RE` or `hasVerdictSignal()`, and benign launcher messages (`failed to open browser`, `xdg-open`) are ignored.
- **Auth Chatter Separation (`AUTH_RE` vs `RPC_AUTH_RE`)**: Healthy `agy` processes routinely log `You are not logged into Antigravity.` during background startup quirk polling. Logs are matched against `AUTH_RE` (which excludes that ambient chatter), while `RPC_AUTH_RE` applies only to the turn's own ACP RPC error text (`normalizeRuntimeText` having stripped any `Stderr tail:`).
- **Classification Precedence**: `context_budget` (500) -> `auth` (401) -> `quota` (429) -> `invalid_request` (400) -> `internal` (500). A zero-budget trajectory failure is never misreported as `429` or `401`.

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

In addition, `catalog.ts` caches successful real `agy models` lists for 24 hours (capped at 128 accounts) so transient probe timeouts do not downgrade an account to a narrower catalog. Account catalogs remain strictly isolated per account—the plugin never merges model lists across accounts or reads another account's credentials to bypass Magpie's router.
