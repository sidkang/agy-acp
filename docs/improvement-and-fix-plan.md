# `agy-acp` Architecture Review, Parity Comparison & Improvement Plan

This document serves as the architectural roadmap and completion record for `agy-acp`, synthesizing:
1. **Baseline stabilization** items from the initial release series;
2. **Runtime and storage comparison** between `agy 1.5.8` and Magpie's official Claude Code bridge (`yetone/magpie/internal/gateway/claude_*.go`);
3. **Full-codebase defect and modularity audit** across `src/` and the Magpie plugin host contract (`internal/plugin/host.js`), tracked through Phase 1, Phase 2, and Phase 3 completion.

---

## 0. Baseline Stabilization (Completed)

- [x] **Bounded Cold-Replay History (`112 KiB` prompt + `512 KiB` append)**: `session/prompt` retains the most recent `112 KiB` of transcript, overflowing older turns into `_meta.antigravity.systemPrompt.append` (`<prior_conversation_history>`). Starting in `0.1.4`, the append cap was lowered from `2 MiB` to `512 KiB` (`64 KiB` for GPT-OSS) based on `agy 1.5.8` probe measurements showing `no messages fit within the context token budget` at `760,000` bytes and `maxMessageTokens must be positive, got 0` at `>= 780,000` bytes; overflowing messages are dropped oldest-first with `[... omitted N earlier messages ...]`.
- [x] **Cross-Restart `session/resume` Index**: `$AGY_ACP_DATA_DIR/parked-sessions.json` (`0600`, SHA-256 content digests plus routing metadata; zero plaintext messages, tool arguments/outputs, or system prompts; invalidated before advancing turns).
- [x] **First-Turn Session ID Drift Adoption & Pool Expansion**: `adoptAwaitingToolWorker` rebinds `AWAITING_TOOL_RESULTS` workers across synthetic session ID stabilization via pending 96-bit `toolu_*` IDs; default `package.json` `magpie.options` configured for `maxPerAccountWorkers: 18` and `maxGlobalWorkers: 36`.
- [x] **Dual Session Header Support**: Reads `x-agy-session-id` with fallback to `x-magpie-session` (`ALT_SESSION_ID_HEADER`).
- [x] **Code Assist Plan Badges**: Queries `v1internal:loadCodeAssist` with a 1-hour cache to surface subscription tiers (`Google AI Ultra`, `Google AI Pro`) and multiplier badges (`5x`, `20x`).
- [x] **Initial 48h Storage GC, Sandbox Guarantees & CI**: Added 48h isolated-account storage GC (`$AGY_ACP_DATA_DIR/accounts/<uuid>/.gemini/antigravity-cli`, leaving adopted host `~/.gemini` logins untouched), explicit prohibition on writing to `<appDataDir>/brain` on the bridge host, SQLite WAL `3×25ms` read backoff, thinking-only non-streaming JSON fallback, parity documentation, and GitHub Actions CI.

### Carried Items Folded Into Phase 3
- [ ] **[CARRY-1] Multimodal PDF (`type: "document"`, `application/pdf`) End-to-End Verification**: Although `agy 1.5.8` `initialize` advertises `promptCapabilities.embeddedContext: true`, native upstream handling of `resource` (`blob` + `mimeType: "application/pdf"`) remains unverified. `src/protocol/anthropic.ts` intentionally continues to reject binary `application/pdf` document blocks with HTTP `400` until verified upstream (kept opt-in/future verification).
- [x] **[CARRY-2] Release & Packaging Gate Workflow**: Implemented in Phase 3 via `.github/workflows/release.yml` and `scripts/check-release.mjs`.

---

## 1. `agy` vs Magpie `claude_subscription`: Runtime & Storage Comparison

| Dimension | `agy` Native Storage + `agy-acp` (Pre-Phase 2 -> Current) | Claude Code + Magpie `claude_subscription` | Outcome |
| --- | --- | --- | --- |
| **Process Model & Per-Session RAM** | Originally spawned `agy acp --process-per-session` (2 Go processes per session: ~138 MiB frontend + ~210–250 MiB `--worker` = **350–388 MiB RSS**). Switched to single-process `agy acp --worker --disable-telemetry` (**0 child processes**, ~212 MiB active / ~175 MiB resumed). Note: dropping `--process-per-session` without `--worker` omits `mcpCapabilities.http` and silently drops `mcpServers`. | 1 `claude` process per session (~86–112 MiB anonymous RSS), with `claude_rss.go` recycling processes above threshold (`1/8` host RAM, floor `1 GiB`) after turns. | **Resolved in Phase 2**: `--worker --disable-telemetry` + post-turn `1 GiB` RSS parking & recycling (`src/runtime/rss.ts`). |
| **Saturation Scheduling** | Originally failed fast with `503 overloaded_error` when no idle worker could be evicted. | `claudeRoom` (`claude_room.go`) provides a bounded FIFO wait queue (up to `2m`, tied to request context). | **Resolved in Phase 2**: Bounded FIFO Wait-for-Room (`waitTimeoutMs: 60s`, `maxWaiters: 128`, non-blocking across accounts). |
| **Native Disk Storage & GC** | `agy` writes to `<account>/.gemini/antigravity-cli/`: `conversations/<id>.db` (WAL SQLite), `conversation_summaries.db` (with FTS5 index), `brain/<id>/`, `implicit/*.pb`, `annotations/*.pbtxt`, `log/*.log`, `crashes/`, and root `cli.log`. | `-p` uses `--no-session-persistence`; shelved state is written to `<sid>.jsonl` and removed after resume or `1h`. | **Resolved in Phase 2**: Hourly 48h GC across isolated account artifact directories (`accounts/<uuid>/.gemini/antigravity-cli`), `32 MiB` `log/` cap, and `conversation_summaries.db` orphan FTS5/summary pruning. |
| **Cross-Restart Shelf (`parked-sessions.json`)** | In-memory `parkedSessions` (6h TTL) + `0600` SHA-256 content-digest `parked-sessions.json` (with routing metadata, zero message/prompt/tool plaintext). | In-memory `b.shelf` + `claude-shelf.json` (deleted after load). | **Resolved in Phase 1 & Phase 3**: Discriminated `memory` vs `persisted` claim (`HIGH-3`), file-locked incremental transactions (`MED-10`), and secondary content-hash lookup (`ShelfStore`). |
| **Media Stripping & Image Sizing** | Originally required exact byte equality on historical images and forwarded oversized inline base64 images verbatim. | `claude_lost_media.go` tolerates stripped historical images; `claude_images.go` scales images `>2000px` or `>5 MiB`. | **Resolved in Phase 3**: `lostMedia` prefix matcher (`src/sessions/ledger.ts`) + zero-dependency image probing/downscaling (`src/protocol/images.ts`). |
| **Structured Output & Text Tool Calls** | Prompt-level JSON Schema / JSON object constraint injection. | `claude_tui_schema.go` virtual `StructuredOutput` MCP retry loop + `claude_text_calls.go` streaming `<tool_call>` interception. | **Optional Future Enhancement**: Current prompt-level `output_config.format` / `response_format` remains in place; virtual MCP retry loop and `<tool_call>` interception remain optional future work. |

---

## 2. Phase 1: Correctness & Lifecycle Hardening (Complete)

All high- and medium-severity correctness defects identified in the audit were fixed with targeted regression tests:

- [x] **[HIGH-1] Unconsumed SSE Body Cancellation**: Bound `PeekedTurnSource` ownership directly to the finalized `Response` so calling `body.cancel()` or aborting `signal` before the first `pull()` still closes `source` and executes the coordinator `finally` block (preventing `sessionLocks` deadlocks and permanently pinned workers).
- [x] **[HIGH-2] Error-Event Early Exit Bypassing Worker Retirement**: Moved `sawError` / incomplete-turn cleanup into the `finally` blocks of all three stateful coordinator execution paths (`Fresh`, `Warm`, `AwaitingTools`) so `iterator.return()` on `{ type: "error" }` always closes and retires unhealthy workers.
- [x] **[HIGH-3] Conflicting `memory` vs `persisted` Resume Binding**: Replaced split lookups with a single discriminated union (`memory` vs `persisted`), actively pruning stale incompatible in-memory `parked` entries so a persisted resume never binds a stale ledger or `systemHistorySeed` from an unrelated memory entry.
- [x] **[MED-5] `withAccountProvisionLock` Deadlock (`src/accounts/auth.ts`)**: Moved `acquireAccountFileLock(accountRef)` inside `try/finally` so file-lock timeouts or errors always release the in-memory account lock.
- [x] **[MED-6] `steer` Commit Barrier Timeout (`src/runtime/worker.ts`)**: Replaced silent `catch {}` after `waitForActiveToolCallsCommit(5_000)` timeout with `throw new SteerReplayNeededError(...)`, routing cleanly into the coordinator's transparent replay path.
- [x] **[MED-7] `disable_parallel_tool_use: true` Serial Release (`src/mcp/broker.ts`)**: Updated `deliverToolResults` to `shift()` only one item at a time from `queuedUnexposed` when parallel tool use is disabled, preserving strict one-by-one tool delivery.
- [x] **[MED-8 & MED-9] `workDir` & `tool.description` Equality Checks**: Included normalized `X-Magpie-Work-Dir` and `tool.description ?? ""` in warm session reuse checks and persisted/memory shelf digests (`src/sessions/ledger.ts`, `src/sessions/coordinator.ts`).
- [x] **[MED-11] Terminal OAuth Login Cleanup (`src/accounts/auth.ts`)**: Extended lifecycle management across the entire `agy acp --login` flow (including waiting for user authorization input) so cancellations and timeouts always kill the child process and remove temporary workspaces.
- [x] **[LOW-12] Outer `AbortSignal` Listener Cleanup (`src/index.ts`)**: Detached the request-level `init.signal` forwarding listener unconditionally when JSON or SSE responses complete or cancel.

---

## 3. Phase 2: Process Footprint, Bounded Wait-for-Room & Storage Governance (Complete)

- [x] **Single-Process Worker Mode (`src/runtime/worker.ts`)**: Replaced `--process-per-session` with `--worker --disable-telemetry` (0 child processes, ~212 MiB active / ~175 MiB resumed vs 350–388 MiB across two processes), retaining `mcpCapabilities.http`, `--add-dir`, `_meta.antigravity.systemPrompt.append`, and `session/resume`, while `TurnLogWatch` continues reading both `agy-acp.log` and `agy-acp.log.<PID>`.
- [x] **Bounded FIFO Wait-for-Room & Post-Turn RSS Recycling**:
  - `GlobalScheduler` (`src/runtime/scheduler.ts`): Added FIFO capacity waiting (`waitTimeoutMs` default `60s`, `0` restores immediate `503`; `maxWaiters` default `128`), waking waiters on slot release, `IDLE` transitions, `unpin()`, `unregisterWorker()`, or reaper ticks without holding locks across waits (`Account A` saturation never blocks `Account B`).
  - `src/runtime/rss.ts`: Added cross-platform process-tree RSS sampling (Linux `/proc` traversal with `statm` fallback; single `ps` snapshot with 10s caching on macOS/other Unix). After a clean turn, `SessionCoordinator` parks and recycles `IDLE` workers exceeding `maxWorkerRssBytes` (default `1 GiB`, overridable via `AGY_BRIDGE_MAX_WORKER_RSS_MB`, `0` disables), provided a resume checkpoint can be preserved.
- [x] **[MED-4] Bounded `AsyncEventQueue` & Backpressure-Aware SSE Heartbeats**: Enforced a `16 MiB` (`DEFAULT_MAX_TURN_QUEUE_BYTES`) per-turn buffer ceiling in `src/runtime/turn-context.ts` (overflow drains the queue, fails the turn with HTTP `502`, and closes the worker) and restricted SSE keepalive writes to when `desiredSize > 0` or pull credit remains.
- [x] **Comprehensive Storage GC & Bounded Memory Caches**:
  - Extended `sweepStaleAccountStorage` (`src/accounts/env.ts`, scoped to isolated `$AGY_ACP_DATA_DIR/accounts/<uuid>/.gemini/antigravity-cli` directories) to cover `annotations/*.pbtxt`, `implicit/*.pb`, `crashes/*`, root `cli.log`, a `32 MiB` cap on `log/`, and orphan row/FTS5 pruning in `conversation_summaries.db` (using `busy_timeout=50` and `BEGIN IMMEDIATE`, without ever creating the DB if absent).
  - Bounded `quota.ts` and `catalog.ts` caches at `128` entries with lazy TTL cleanup (`24h` retention for verified real model catalogs so transient probe timeouts do not drop models and mark accounts `unlisted`).

---

## 4. Phase 3: Modularization, Multimodal/Cache Enhancements & Release Pipeline (Complete)

- [x] **[ARCH-1] Coordinator Decomposition (`src/sessions/`)**: Extracted three focused modules from `src/sessions/coordinator.ts`:
  - `src/sessions/ledger.ts`: Canonical message normalization, `isPrefixMatch` / `matchPersistedPrefix` (with `lostMedia` tolerance), tool/workDir compatibility checks, and unified SHA-256 digest generation.
  - `src/sessions/prompt-render.ts`: Cold/warm prompt rendering, `112 KiB` prompt clipping, and `<prior_conversation_history>` (`512 KiB` / `64 KiB` GPT-OSS) overflow planning.
  - `src/sessions/shelf-store.ts` (+ **[MED-10]**): Unified in-memory warm shelf and file-locked incremental `parked-sessions.json` persistence behind `park() / invalidate() / claimResume()`, running `claimResume()` synchronously after scheduler admission so racing conversation forks cannot claim the same `nativeSessionId`.
- [x] **[ARCH-2] Worker Turn & Usage Extraction**: Extracted `src/runtime/turn-context.ts` (`TurnContext`, `AsyncEventQueue`) and `src/usage/tracker.ts` (`StepUsageTracker`), replaced `(scheduler as any)` overrides with explicit eviction hooks (`beforeEvictIdleHooks`), and replaced raw `worker.pinned` flags with idempotent `pin(): () => void` leases.
- [x] **[ARCH-3] Single-Mode Async SSE Encoder (`src/protocol/anthropic.ts`)**: Unified `encodeAnthropicSseResponse` around `PeekedTurnSource` ownership and `peekRacingAbort`, guaranteeing deterministic single `source.close()` teardown across unconsumed cancellations, mid-peek aborts, and stream errors.
- [x] **[ARCH-4] Unified Auth Lifecycle (`src/accounts/auth.ts`)**: Consolidated browser OAuth and terminal `agy acp --login` cancellation/timeout handling via `combineSignals()` and idempotent `createLoginSessionDisposer()`.
- [x] **`lostMedia` Tolerance & Secondary Content-Hash Lookup**: Implemented `lostMedia` historical image/file stripping tolerance (`src/sessions/ledger.ts`) and secondary content-hash lookup across parked `memory` and `persisted` shelf entries (`src/sessions/shelf-store.ts`) for clients that omit or rotate session headers.
- [x] **Zero-Dependency Inline Image Fitting (`src/protocol/images.ts`)**: Implemented PNG, JPEG, GIF, and WebP dimension probing and area-average downscaling + PNG/JPEG re-encoding for images `>2000px` (`MAX_INLINE_IMAGE_SIDE`) or `>5 MiB` base64 (`MAX_INLINE_IMAGE_BASE64_BYTES`), guarded by `MAX_DECODE_HOLD_BYTES` (`256 MiB`) and memoized in a bounded cache.
- [x] **[CARRY-2] Release Gate & CI Workflows**: Added `scripts/check-release.mjs`, `.github/workflows/ci.yml`, and `.github/workflows/release.yml` (enforcing `tsc --noEmit`, `bun test`, `package.json`/manifest validation, OpenCode 1.x/2.x entrypoint smoke checks, `npm pack --dry-run` tarball verification, tag-version alignment, GitHub Release tarball publishing, and npm OIDC Trusted Publishing / `NPM_TOKEN` fallback).
- [ ] **Remaining Opt-In / Future Work**:
  - **[CARRY-1]** `application/pdf` document `embeddedContext` passthrough remains intentionally rejected with HTTP `400` in `src/protocol/anthropic.ts` until native upstream `agy` PDF handling is verified end-to-end.
  - Virtual `StructuredOutput` MCP retry validation and streaming `<tool_call>` text interception remain optional future enhancements.

---

## 5. Phase 4: `v0.1.8` — Default Quota Routing, Probe Governance, WebP & Truthful `429`s (Complete)

| Item | Change | Where |
| --- | --- | --- |
| **Quota routing on by default** | `quota_routing` defaults to `true`, so Magpie sees each account's 5-hour/weekly buckets and fails over before an exhausted account is asked. | `src/options.ts`, both READMEs |
| **Specific-first quota attribution** | Per-model groups (`Gemini 4 Argon`, …) claim their own catalog models before broad vendor pools (`Gemini`), versioned pool names are preserved instead of collapsing into `Gemini`, and `Claude`/`GPT` stay separate so a host alias can never broaden model membership. Empty or fully disabled specific groups no longer steal models from a valid broad pool. | `src/usage/quota.ts` (`parseUsageReport`) |
| **Probe concurrency governance** | Short-lived `agy` probes (`agy models`, `agy -p /usage`) run through a bounded FIFO pool with queue-inclusive deadlines and single-release accounting, so importing 15–30 accounts cannot spawn dozens of Go processes at once. | `src/usage/catalog.ts`, `src/usage/quota.ts` |
| **Parallel, ordered account import** | Batch import runs 4-wide with source-order results, abort-aware per-email ownership, and rollback error reporting (a failed batch no longer leaves a half-imported slot reported as success). | `src/accounts/auth.ts` |
| **Single-flight cancellation isolation** | A cancelled caller no longer kills a shared `agy` probe other callers are waiting on: waits are reference counted and the background catalog refresh keeps its own timeout. | `src/usage/catalog.ts`, `src/usage/quota.ts` |
| **WebP inline support** | Zero-dependency still WebP decode (`VP8L`, `VP8 `, `VP8X` + `ALPH`) under a `DecodeBudget`, so oversized WebP screenshots and web images downscale like PNG/JPEG instead of being forwarded verbatim; animated WebP passes through untouched. Verified pixel-exact against `libwebp` `dwebp` across 22 `cwebp`/`dwebp` cases (`maxAbsDiff = 0`). | `src/protocol/webp.ts`, `webp-vp8.ts`, `webp-vp8l.ts`, `images.ts` |
| **`agy` upgrade awareness** | Catalog cache entries are fenced by `getAgyBinaryFingerprint()` (`mtimeMs` + `size` of the resolved binary), so upgrading the CLI exposes new models on the next turn instead of after the 24-hour retention. | `src/accounts/env.ts`, `src/usage/catalog.ts` |
| **Truthful `429` classification & retry-storm guard** | A bare `429`/`RESOURCE_EXHAUSTED` is reported as a transient limit (plain `429`, no quota wording) instead of `Account quota exhausted`; `agy`'s own retry notices are stripped from the answer and counted, and a turn that has delivered nothing is ended after 2 notices (~12s) rather than waiting out `agy`'s ~8-minute backoff ladder. Notices are only believed when the turn's log shows `Run: attempt N failed`, so a model *quoting* the incident is delivered verbatim. | `src/runtime/diagnostics.ts`, `worker.ts`, `turn-context.ts`; rationale in [error-routing-diagnosis.md](error-routing-diagnosis.md#5-transient-limits-vs-account-quota-observed-incident-v018) |

### Verification

- `bun test`: **343 pass, 0 fail**, including new cases for the quota/`rate_limit` split (`exhausted your capacity` stays `quota`), notice stripping for splits inside the header and after it, a notice burst whose log record lands one chunk late, an answer whose last characters look like a notice start, a quoted incident without corroborating log evidence, and the retry-storm turn ending as `rate_limit` without leaking notices as text — including when `agy` settles the cancelled prompt as an RPC error and keeps streaming into the cancelled turn.
- `bun x tsc --noEmit`: clean.
- `bun scripts/check-release.mjs`: `magpie-agy-acp@0.1.8` releasable (packaging, manifest, entrypoints, English-only scan).

### Review outcome

The adversarial pass flagged two items that were checked rather than applied:

- **“Zero base filter level must not disable segment filtering”** — rejected. `libwebp` `src/dec/vp8_dec.c:285` sets `dec->filter_type = (hdr->level == 0) ? 0 : hdr->simple ? 1 : 2;`, i.e. a zero frame filter level disables the loop filter regardless of segment overrides, and `libvpx` skips the pass the same way. `src/protocol/webp-vp8.ts` matches `dwebp`.
- **VP8L Huffman-group budget, truncated-partition tolerance, empty specific quota groups, and import rollback bookkeeping** — confirmed and fixed before this record was written.

Still open by choice: **[CARRY-1]** PDF `embeddedContext` passthrough, and the optional virtual `StructuredOutput` / streaming `<tool_call>` work.

---

## 6. Phase 5: `v0.1.9` — Status Alignment with Magpie's Router (Complete)

A live audit of what the plugin answers versus what Magpie's router does with each status, and versus the statuses `agy` can actually produce (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, `NOT_FOUND`, `PERMISSION_DENIED`, … read from its binary and from a suspended account's real answer).

| Change | Before | Now | Why |
| --- | --- | --- | --- |
| Vendor-suspended account | `500 Agent execution terminated due to error` | `403` keeping the vendor's own sentence | Magpie recognizes the suspension (`googleToS`), the refusal is retryable, the next account answers and the provider isn't walled off |
| `PERMISSION_DENIED` that isn't the suspension | `500` | `403` policy/region text | it is the account's, not the prompt's: fail over instead of blaming the request |
| Model this account isn't served (`NOT_FOUND`, `Requested entity was not found.`) | `500` | `404` "model not found" | Magpie rests that model alone (`modelRefused`) and keeps asking the account for its other models |
| The vendor's own servers (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, 5xx "overloaded") | `500` | `503` "overloaded" | `vendorOverloaded`: 30-second rest, no failure counted on the account's ladder |
| Conversation agy cannot serialize (`maxMessageTokens must be positive, got 0`) | `500` | `400` "too long … shorten" | `overflowed`: asks a member with room, rests no account, tells the agent to compact — failing over between accounts only repeated it |
| This bridge at capacity | `503` with no status words | `503` saying "overloaded" | our own saturation no longer rests the account as a failure |

Tests: the classifier covers each verdict and the non-verdicts (`INVALID_ARGUMENT` stays `invalid_request`, a prompt-level refusal stays `internal`), and the worker table asserts the status, type and wording that reach Magpie for the `403`, `404`, `503` and `400` paths. **349 pass, 0 fail.**
