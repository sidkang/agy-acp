# Parity Notes: Magpie Official Claude Code Bridge (`claude_subscription`)

This document records the design alignment, empirical measurements, and protocol boundaries between `agy-acp` and Magpie's built-in Claude Code CLI bridge (`yetone/magpie/internal/gateway/claude_subscription.go`, `claude_room.go`, `claude_rss.go`, `claude_lost_media.go`, and `claude_images.go`).

---

## 1. Dual System-Prompt Modes (`minimal_agent`)

| Dimension | Magpie `claude_subscription` | `agy-acp` Implementation |
| --- | --- | --- |
| **Option & Default** | `ClaudeLeanPrompt` (default **`false`**) | `minimal_agent` (default **`false`**) |
| **Preserve Native Prompt (Default)** | Keeps Claude Code's built-in system prompt (~1.1K tokens) so upstream requests match interactive user sessions. | Sets `excludeDefaultComponents: false` on the isolated bridge agent, preserving native `agy` components (~1,991 system prompt tokens measured; 86%–96% prompt-cache hit rate from step 2 onward) and native request fingerprint. |
| **Minimal / Stripped Prompt (`true`)** | Passes `--system-prompt-file` to replace the built-in system prompt, keeping only a minimal identity header and caller prompt. | Sets `excludeDefaultComponents: true`, stripping built-in `agy` components so only bridge tool instructions and the caller's prompt remain (~389 system prompt tokens measured, saving ~1.6K tokens). |
| **Mode-Switch Isolation** | Refuses to reuse an existing process when `run.lean != req.leanPrompt` and rebuilds the session immediately. | When `worker.minimalAgent !== requestedMinimalAgent`, immediately closes the active worker and skips incompatible shelf entries (`memory` and `persisted` both match `minimalAgent`) to rebuild under the new mode. |

---

## 2. System Prompt Injection & Normalization

When preserving `agy`'s built-in system prompt (default mode), the bridge must solve three problems simultaneously: **prompt-cache sharing**, **dual-directory environment disambiguation**, and **third-party harness sanitization**.

1. **Native System-Level Append (No First-User-Message Pollution)**:
   - `claude_subscription` uses `--append-system-prompt-file` so caller instructions sit after the native system prompt (embedding them inside the first user message breaks cross-session system-prompt caching).
   - `agy-acp` injects the processed system prompt via the ACP extension `_meta.antigravity.systemPrompt.append` on `session/new` and `session/resume`. Only when an older `agy` binary lacks `append` capability does it fall back to prepending `<external_system_instructions>...</external_system_instructions>` to the first user message.

2. **Workspace & Runtime Environment Disambiguation**:
   - The `agy` subprocess runs inside an isolated empty sandbox directory (`$TMPDIR/agy-magpie-ws-*`), whereas caller MCP tools execute in the caller's host workspace.
   - Matching `claude_subscription`'s `envElsewhereLeanNote`, whenever a request carries `X-Magpie-Work-Dir`, `agy-acp` appends a disambiguation note instructing the model that all tools execute in the caller-described workspace and environment without probing or verifying host paths locally.

3. **Volatile Noise Stripping & Prompt Cloaking (`src/protocol/cloak.ts`)**:
   - Strips rotating `x-anthropic-billing-header` (`cch=...`) lines and dynamic clock lines inside `<system-reminder>` blocks so warm sessions are not misclassified as prompt mutations.
   - Rewords third-party harness phrases (Claude Code / Claude Agent SDK, Codex, Hermes, and oh-my-pi RFC 2119 lines) that otherwise trigger synthetic upstream `429` refusals when `cloak_prompts` is enabled (default `true`). Rewording, not zero-width insertion: since 11-14 the upstream reads past invisible characters and turns the broken-up copy away as the line itself.
   - Rewrites the DeepSeek Harness `@`-path paragraph into equivalent prose so affected models do not skip reasoning.
   - Converts mid-conversation `role: "system"` / `"developer"` messages into `<system-reminder>` user blocks so multi-turn warm sessions stay contiguous.

---

## 3. Idle TTL, Bounded Wait-for-Room Scheduling, Single-Process RSS, Queue Caps, Storage GC & Orphan Cleanup

| Mechanism | Magpie `claude_subscription` | `agy-acp` Implementation |
| --- | --- | --- |
| **Idle Worker TTL** | `1h` (`idleLongest = time.Hour`), keeping warm processes alive across the prompt-cache window. | `idleTimeoutMs: 3600000` (`1h`); `awaitingToolTimeoutMs: 600000` (`10m`); reaper runs every `60s`. |
| **Pool Sizing & Bounded Wait-for-Room** | `claudeRoom` (`claude_room.go`) queues saturated requests up to `2m` (respecting request cancellation) and wakes waiters in FIFO order when any slot opens. | `GlobalScheduler` (`src/runtime/scheduler.ts`) defaults to `16` global / `6` per-account (configured in `package.json` `magpie.options` as `maxGlobalWorkers: 36`, `maxPerAccountWorkers: 18`), with bounded FIFO Wait-for-Room (`waitTimeoutMs: 60s`, `maxWaiters: 128`; `0` restores immediate `503`). Locks are never held while waiting, so saturation on `Account A` never blocks `Account B`. |
| **Single-Process Model & Memory** | One `claude` process per session (~86–112 MiB anonymous RSS). | Uses single-process `agy acp --worker --disable-telemetry` instead of `--process-per-session` (`agy 1.5.8` measured: 0 child processes, ~212 MiB RSS during turns, ~175 MiB after `session/resume`, down from 350–388 MiB across 2 processes under `--process-per-session`). Plain `--stdio` without `--worker` cannot be used because it omits `mcpCapabilities.http` and silently drops `session/new` HTTP `mcpServers`. |
| **Post-Turn RSS Parking & Recycling** | `claude_rss.go` checks process-tree RSS after turns (1/8 host RAM, floor `1 GiB`) and parks/replaces oversized processes. | `src/runtime/rss.ts` samples process-tree RSS (Linux `/proc`, single `ps` snapshot on macOS/other Unix with 10s caching). After a clean turn, if an `IDLE` worker exceeds `maxWorkerRssBytes` (default `1 GiB` / `1073741824` bytes, `AGY_BRIDGE_MAX_WORKER_RSS_MB` override, `0` disables), `SessionCoordinator` parks it via `shelf.park()` and closes the process so the next turn resumes via `session/resume`. Workers that cannot preserve a resume checkpoint are never recycled prematurely. |
| **Per-Turn Event Queue Cap & SSE Backpressure** | Bounded streaming pipes with backpressure. | `AsyncEventQueue` (`src/runtime/turn-context.ts`) enforces a `16 MiB` (`DEFAULT_MAX_TURN_QUEUE_BYTES`) per-turn buffer cap on undelivered events; slow consumers overflow and fail that turn cleanly with HTTP `502` and worker teardown instead of growing unboundedly. SSE keepalive frames (`: keepalive\n\n`) only emit when `desiredSize > 0` or pull credit remains. |
| **Disk Storage GC (48h TTL)** | `-p` defaults to `--no-session-persistence`; shelved state is deleted after resume or expiry. | `sweepStaleAccountStorage` (`src/accounts/env.ts`) runs hourly across isolated account directories (`$AGY_ACP_DATA_DIR/accounts/<uuid>/.gemini/antigravity-cli`, leaving any adopted host `agy` login's `~/.gemini` untouched) and removes unreferenced/inactive items older than `48h`: `conversations/*.db*`, `brain/*`, `log/*.log`, `annotations/*.pbtxt`, `implicit/*.pb`, `crashes/*`, and root `cli.log` (plus a `32 MiB` cap on `log/`). Also prunes orphaned summary, FTS5, and parent rows in `conversation_summaries.db` whose `conversations/<id>.db` no longer exists (and never creates `conversation_summaries.db` if absent). |
| **Orphan Process Cleanup** | Process-group / context termination on shutdown. | Registers `SIGINT`, `SIGTERM`, and `exit` handlers in `GlobalScheduler` to terminate all active `agy` workers and remove `$TMPDIR/agy-magpie-ws-*` sandboxes, plus sweeping stale leftover workspaces on startup. |

---

## 4. Tool Isolation & Sandbox Security

Every turn guarantees that `agy` only invokes tools declared by the caller and never executes local built-in file or shell operations on the bridge host:

1. **Isolated Agent Manifest (`src/runtime/worker.ts`)**: Generates `.agents/agents/magpie-bridge/agent.md` inside an empty `0700` temporary workspace with:
   - `tools: []` to disable all built-in `agy` tools (`read_file`, `write_file`, `edit`, `run_shell_command`, `grep`, `glob`, `web_fetch`, `google_web_search`, `save_memory`, etc.), exposing caller tools strictly via session-scoped `mcpServers: [{ name: "magpie", type: "http", url }]`;
   - `subagent: false` to block built-in subagent spawning;
   - `inheritMcp: false` and `inheritCustomizations: false` to isolate from host-level MCP servers, skills, and hooks.
2. **ACP Client Capabilities Disabled**: `initialize` explicitly declares `fs: { readTextFile: false, writeTextFile: false }, terminal: false`.
3. **Structured Permission Verification (`src/runtime/worker.ts`, `src/runtime/acp-connection.ts`)**: `session/request_permission` requests are auto-approved (`allow_once`) only when structured fields confirm the target belongs to the bridge's `magpie` MCP server; any built-in tool, terminal, or unknown permission request is automatically rejected (`reject`/`deny`, or `cancelled` when no reject option is offered).
4. **Physical Sandbox & Brain Write Prohibition**: `agy` always spawns with `cwd` locked to `$TMPDIR/agy-magpie-ws-*`, and both the agent manifest and workspace disambiguation note prohibit writing artifacts or scratch files to `<appDataDir>/brain` on the bridge host.

---

## 5. Protocol & Session Capabilities

- **`tool_choice` Cache Stability**: Matches `claude_subscription` (`TestClaudeToolChoiceNoneKeepsTheTools`) by keeping the `tools/list` catalog unchanged for `tool_choice: none`, `tool`, and `any` to preserve the prompt-cache prefix while enforcing constraints in `SessionToolBroker`.
- **Workspace Forwarding (`X-Magpie-Work-Dir`)**: Percent-decodes (`decodeURIComponent`) `X-Magpie-Work-Dir`, passes `--add-dir` only for existing local absolute directories, appends the `envElsewhereLeanNote`-aligned workspace instruction, and checks normalized `workDir` equality before warm reuse or shelf resume.
- **Subagent Bucketing & `aside()` Side-Request Isolation**: Buckets `X-Magpie-Subagent` requests under separate session keys (`::sub:<id>`). When a tool-equipped primary worker already exists for the session, `tools: []` or `tool_choice: none` side requests (such as title generation or classifiers) run as stateless short turns without mutating or polluting the primary session ledger, and preferentially pin its warm worker whenever spare capacity or another eviction candidate exists (under strict single-slot saturation, an `IDLE` worker may still be parked and evicted to admit the turn).
- **`lostMedia` Image-Stripping Prefix Tolerance (`src/sessions/ledger.ts`)**: Ports Magpie's `claude_lost_media.go` logic so warm prefix matching (`isPrefixMatch` / `matchLedgerPrefix`) and persisted digest matching (`matchPersistedPrefix`) tolerate clients stripping historical base64 images or dropping image-only turns in prior messages, keeping the live or resumed native session intact instead of forcing an expensive cold replay.
- **Secondary Content-Hash Session Addressing & First-Turn Tool Adoption**: Supports callers that omit or rotate session headers via a secondary content-hash lookup across parked `memory` and `persisted` shelf entries (`src/sessions/shelf-store.ts`), and rebinds `AWAITING_TOOL_RESULTS` workers across first-turn synthetic session ID stabilization via 96-bit `toolu_*` ID matching (`adoptAwaitingToolWorker`).
- **Zero-Dependency Inline Image Probing & Downscaling (`src/protocol/images.ts`, `src/protocol/webp*.ts`)**: Probes and decodes PNG, JPEG, GIF, and still WebP (`VP8L` lossless, `VP8 ` lossy keyframe, and `VP8X` + `ALPH`) without external native dependencies; scales images exceeding `2000px` per side (`MAX_INLINE_IMAGE_SIDE`) or `5 MiB` base64 (`MAX_INLINE_IMAGE_BASE64_BYTES`) down to fit (preserving JPEG at quality 85 or encoding PNG, falling back to lower-quality JPEG at 75/60/40 if still over `5 MiB`). Enforces `MAX_DECODE_HOLD_BYTES` (`256 MiB` unified encoded + working + RGBA8 budget) to prevent decompression-bomb OOMs; already-compliant, animated WebP/GIF, or unparseable images pass through byte-for-byte untouched.
- **File-Locked Incremental Shelf Store & Deferred `claimResume` (`src/sessions/shelf-store.ts`)**: Stores SHA-256 digests of conversation, system-prompt, and tool content alongside session/account/workspace routing metadata (`0600`, zero plaintext messages, tool arguments/outputs, or system prompts) in `$AGY_ACP_DATA_DIR/parked-sessions.json` using short exclusive file locks for incremental read-modify-write transactions across concurrent hosts. `shelf.claimResume()` runs synchronously only after scheduler admission and reserves the `nativeSessionId` until turn completion so concurrent forks cannot double-claim the same underlying conversation.
- **Bounded Cold-Replay Budgets (`src/sessions/prompt-render.ts`)**: Keeps the newest `112 KiB` (`AGY_BRIDGE_MAX_PROMPT_BYTES`) in `session/prompt` (avoiding `agy`'s silent ~128 KiB prompt truncation) and overflows older turns into `_meta.antigravity.systemPrompt.append` (`<prior_conversation_history>`, capped at `512 KiB` by default, `64 KiB` for GPT-OSS models, overridable via `AGY_BRIDGE_MAX_SYSTEM_HISTORY_BYTES`), dropping whole oldest messages with `[... omitted N earlier messages ...]` markers when needed. Empirical `agy 1.5.8` probing showed 720,000-byte appends pass while 760,000 bytes fail (`no messages fit within the context token budget`) and >=780,000 bytes fail (`maxMessageTokens must be positive, got 0`).
- **Terminal-Only Ledger Commits & End-to-End Cancellation**: Commits `committedMessages` only on a clean `finish` event; stream errors or client aborts (including `ReadableStream.cancel()` on unconsumed SSE responses) trigger `AbortController` cancellation, retire the half-written worker, and enforce a 30-minute `session/prompt` watchdog timeout.
- **Pi / Claude Code Interaction Boundaries**: Supports mid-turn `steer` interruption (with `promptSeq` epoch isolation and `SteerReplayNeededError` fallback replay), `followUp` continuation, post-tool `/compact` reopening, and head+tail `<conversation>` clipping within the `112 KiB` prompt budget.
- **Structured Output**: Translates `output_config.format` and `response_format` (`json_schema` / `json_object`) into prompt constraints (compatible with Claude Code prompt hooks).
- **WAL SQLite Per-Step Usage & Cache Accounting (`src/usage/tracker.ts`, `src/usage/step-usage.ts`)**: Reads `gen_metadata` via read-only SQLite URI (`?immutable=1` for checkpointed WALs with `3×25ms` flush backoff) to report accurate per-step `input_tokens`, `output_tokens`, and `cache_read_input_tokens` on every `tool_use` and `end_turn` step.
- **Code Assist Plan Badges (`src/usage/quota.ts`)**: Queries `v1internal:loadCodeAssist` (1h TTL cache) to surface subscription plan labels (such as `Google AI Ultra`, `Google AI Pro`, and `5x` / `20x` multipliers) in Magpie Usage cards and `magpie quota`.
