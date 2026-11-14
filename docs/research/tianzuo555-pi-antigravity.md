# `@tian.zuo/pi-antigravity` (TianZuo555/pi-extensions, `packages/pi-antigravity`)

- Checkout: `https://github.com/TianZuo555/pi-extensions`, shallow clone, commit
  `7b88eb36e34534c79adf587a4623c2233d9dbd04`, package `@tian.zuo/pi-antigravity@0.12.1`
  (`package.json:2-5`). Read 2026-11-14.
- Citations are relative to `packages/pi-antigravity/`. Read-only: nothing executed, no tests
  run, no login state touched. Repository dates are repo-supplied, not calendar-verified.
- Upstream observations below are the project's own reports unless stated otherwise; see
  section 9. Comparison with this plugin: [`comparison.md`](comparison.md).

## 1. Host and upstream

- A pi extension that registers a `pi-ai` provider; it never speaks Anthropic HTTP. Host is pi's
  extension API (`@earendil-works/pi-coding-agent` + `pi-ai` peers, wildcard versions,
  `package.json:44-47`); entry `antigravityExtension(pi: ExtensionAPI)` (`index.ts:214`, wired
  by `package.json:32-37`).
- Registration: provider `antigravity`, `api: "antigravity-stream-json"`,
  `baseUrl: "agy://local-stream-json"`, `apiKey: "agy-local-session"`. All are placeholders;
  nothing listens there, and pi treats it as one more API family (`index.ts:735-759`). The
  transport is `streamSimple` (`src/provider.ts:228-265`).
- Upstream is the local `agy` CLI as a child process only. README: "This extension never talks
  to Google's servers itself. Authentication, tokens, and all API access stay inside the
  official first-party `agy` CLI" (`README.md:139`). The inspected execution paths spawn the
  selected `agy` and contain no Google API client (`lib/agy-client.ts:163-182`;
  `lib/agy-driver.ts:367-382,416-453`). The only HTTP server is its own loopback bridge
  (`lib/bridge.ts:227-245`).
- No OAuth code and no OAuth credential storage. Auth is whatever login the CLI holds; `apiKey`
  is a literal placeholder (`index.ts:738-739`), and an auth failure can only surface as the
  text of `AgySpawnError` (`lib/agy-client.ts:158-162`). The package does store its own loopback
  bridge token, in a private MCP config and, in Pi-tools mode, in agent frontmatter
  (`lib/mcp-config.ts:17-33`; `lib/pi-tools-agent.ts:24-51`).
- CLI-side artifacts read: existence of `~/.gemini/antigravity-cli/conversations/<id>.db`
  (`lib/conversation-state.ts:35-58`) and the transcript JSONL (`lib/tasks.ts:414-427`).
- Protocol: print-mode stream-json NDJSON, not ACP (`src/provider.ts:1-9`, `PLAN.md:47`):
  `--input-format stream-json --output-format stream-json` (`lib/agy-client.ts:134-153`), one
  `{"event":"user","message":{"role":"user","content":...}}` line per turn
  (`lib/agy-driver.ts:497-499`), parsing `init` / `step_update` / `result`
  (`lib/events.ts:106-152`). This matches the documented surface, including "`text` is the only
  supported stream-input block type" (`antigravity.google/docs/cli/headless/`).
- Binary resolution: `AGY_BINARY` (strict) -> `PATH` -> `~/.gemini/bin/agy`; the newest
  compatible stable version wins (`lib/agy-diagnostics.ts:15-22,178-207,354-378`). Minimum
  `MIN_AGY_VERSION = "1.1.22"`, enforced on `agy --version` with a 5 s cap per candidate (run in
  parallel) and a classified failure (`lib/agy-diagnostics.ts:10-12,265-305,319-331`);
  prerelease, dev and HEAD builds bypass the gate (`:145-157,294,355-363`).
- The checker classifies the binary, not runtime failures:
  `not-found | permission-denied | timeout | spawn-failed | invalid-version | unsupported-version`
  (`lib/agy-diagnostics.ts:14-22`), failing with the candidate list in the message.
- Binary cache: the cache identity covers environment, platform and every candidate's
  `size:mtimeMs:ctimeMs` stat signature; the returned `revision` hashes only the selected
  binary's path/size/mtime/ctime signature (`lib/agy-diagnostics.ts:102-137,409-423`).
- Version assumptions encoded in code: event shapes from 1.1.17 (`lib/events.ts:1-5`), fallback
  models from 1.1.25 (`lib/models.ts:91`), terminal status `SUCCESS` from 1.1.22 versus older
  `OK` (`lib/events.ts:80-93`, `lib/reducer.ts:229-233`), `run_command` process-group semantics
  from 1.2.0 (`lib/tasks.ts:17`).

## 2. Transport and processes

- One long-lived `agy` child per pi session, detached into its own process group, reused across
  user turns and tool-loop re-entries (`lib/agy-driver.ts:221-241,447-452,1119-1121`);
  submissions serialize on a promise queue (`:315-329`).
- The runtime delegates the child to `AgyDriverSession`, whose start marks it ready immediately
  after installing handlers, with no readiness handshake or singleton start promise
  (`src/runtime.ts:162-180`; `lib/agy-driver.ts:315-329,416-475`); `PLAN.md:82` describes a
  singleton start promise and a bounded readiness wait.
- Cardinality: successive pi provider requests can re-attach to one active or buffered logical
  turn, and one logical turn can make several executor attempts on stalls
  (`src/runtime.ts:269-276,441-526`; `lib/turn.ts:1-8`). The adapter translates the reduced
  outcome into pi `AssistantMessageEvent`s (`src/provider.ts:1-19`).
- The child is recycled only on a fingerprint change (binary / version / revision, cwd, MCP
  directory, model, effort, agent, mode, bridge or catalog revision, conversation id), with a
  named cause counted for `/agy-doctor` (`lib/agy-driver.ts:63-71,170-194,367-382`). Stale
  callbacks are fenced by generation and abort (`src/runtime.ts:189-194,389-410,535-554`).
- Per-session extra processes: a disposable runtime with its own `agy` child for pi compaction
  and branch summaries (`src/provider.ts:287-303,326-339`); `agy --version`, stat-cache-keyed so
  roughly once per session (`lib/agy-diagnostics.ts:96-137,366-370`); `agy models`, 15 s cap
  (`index.ts:114,171-177`); `agy --print /usage`, 30 s cap (`lib/usage.ts:1-13`).
- Per turn: async `ps`/`lsof` task-origin snapshots coalesced off the line handler
  (`lib/agy-driver.ts:927-944`, `lib/tasks.ts:149-178,465`) and transcript tail reads
  (`lib/tasks.ts:311-341`).
- Conversation state is `agy`'s server-side conversation, resumed with `--conversation <id>`
  (`lib/agy-client.ts:105-113`). The id is persisted into pi session entries
  (`lib/conversation-state.ts:8-24`, `index.ts:287-320`) and restored only when the model
  matches and the db still exists (`index.ts:823-865`). `agy` pins a conversation to its
  workspace, so a cwd change drops the id (`src/runtime.ts:279-291`).
- The turn controller survives `toolUse` handoffs, preserving usage claims, emitted-text
  deduplication and incomplete tools (`lib/turn.ts:16-37,49-76,84-134`).
- Durability and branching: pi custom entries store session, cwd, model, conversation, tool mode,
  bridge identity, counters and usage; restore rejects wrong ownership, later context changes,
  resets, and Pi-tools mode (`index.ts:287-319`; `lib/conversation-state.ts:146-170`). Forks and
  a changed private bridge identity rebuild bounded pi history instead of reusing mutable
  history (`index.ts:823-865`; `src/provider.ts:115-154`). Branch moves and provider switches
  invalidate continuity; an explicit reset disables next-history replay
  (`index.ts:879-915`; `src/runtime.ts:581-592`).
- Turn deadline: pi-owned `AGY_TURN_TIMEOUT_MS`, default 600 s and configurable, enforced by a
  pi-side abort (`src/runtime.ts:330-346`) and the driver's per-turn timer
  (`lib/agy-driver.ts:551-561`). Retries and the missing-conversation fallback share that one
  logical deadline and get only the remaining budget (`src/runtime.ts:423-526`).
- `agy`'s own `--print-timeout` is pinned to `2147484s` so its default wait cannot end a live
  turn (`lib/agy-client.ts:134-153`). The code asserts that default is five minutes
  (`lib/agy-client.ts:134-153`); the official CLI reference documents `0s` as unlimited
  (`antigravity.google/docs/cli/headless/`).
- Stall ladder (persistent mode), byte-level rather than event-level: any stdout or stderr chunk
  re-arms (`lib/agy-driver.ts:819-851`); 120 s base budget, 300 s while a tool is active
  (`:617-643`, `src/runtime.ts:384-387`); positive evidence (a live group-leading child) buys a
  full extra budget, up to 12 consecutive graces, reset when the ACTIVE set drains
  (`lib/agy-driver.ts:241-247,736-787,897-900`); a hard ceiling still kills in-process tools.
- Parked-answer verdict: a 5 s `AGY_PARKED_WATCH_MS` transcript poll detects `agy` withholding a
  finished answer behind background work and ends the turn as OK with `AGY_PARKED_TURN_ERROR`,
  producing a synthetic OK result when the parked grace expires
  (`lib/agy-driver.ts:148,650-712,798-817`, `lib/prompt.ts:42-43`).
- One-shot mode: `PI_ANTIGRAVITY_DRIVER=0` runs one `agy --print` per turn under a pure
  inactivity watchdog that kills on expiry (`lib/agy-driver.ts:1072-1121`;
  `lib/agy-client.ts:225-247`).
- Retry: only `AgyStallError`, at most 2, `AGY_STALL_RETRY_BACKOFF_MS` = 3000, then a
  continuation prompt on the same conversation id (`src/runtime.ts:49,511-527`,
  `lib/prompt.ts:193-200`), rendered as a collapsed thinking line (`src/provider.ts:657-680`).
  "Not found / failed to resume" gets one silent fresh rebuild with history
  (`src/runtime.ts:51-61,495-510`); spawn and auth failures never retry (`:420-422`).
- Kill and shutdown: stdin end -> 250 ms -> SIGTERM -> 500 ms -> SIGKILL on the group
  (`lib/agy-driver.ts:133-134,331-365`), with bounded stderr/line buffering
  (`lib/agy-driver.ts:130-134,819-850`; `lib/agy-client.ts:313-320`). Turns with an ACTIVE tool
  recycle and reap task groups (`lib/agy-driver.ts:602-615,995-1030`). Aborting a parked turn
  leaves detached work alive on purpose: abort skips command-group reaping when the turn was
  positively classified as parked background work (`:582-614`). Shutdown sweeps groups and
  identity-checked orphans (`index.ts:923-1010`).
- Cancellation channel: the README reports that `agy` "offers no usable stop channel for a task
  started from pi", that `/tasks` is interactive-only, and that `manage_task` only kills from the
  owning process (`README.md:32`), so task sweeps are signal-based (`lib/agy-driver.ts:582-614`).
- Task ownership: the orphan registry is process-global (`Symbol.for`) across extension copies
  and records parent, leader and member start identities; a failed process scan neither verifies
  nor prunes records, and surviving groups need a matching recorded identity
  (`lib/agy-children.ts:119-134,237-295`). Per-task stop targets only proven log-holder PIDs,
  never advisory or ambiguous associations (`lib/tasks.ts:780-820`). A background-task
  filesystem/process dashboard exists (`lib/tasks.ts:176-183`; `src/tasks-ui.ts:119-120`;
  `index.ts:923-940`), separate from foreground turn abort.

## 3. Tool channel

- `agy` runs its own tools; pi executes nothing `agy` asked for. Native read-only steps
  `view_file` / `list_dir` / `grep_search` / `find_by_name` map to pi builtins `read` / `ls` /
  `grep` / `find`, only for narrowly recognized argument sets (others stay on the wrapper), and
  are re-executed only after DONE, so a failed `agy` read replays its error instead of re-running
  as a success (`lib/native-tools.ts:38-42,58-107`; `src/provider.ts:490-535`).
- Display-only steps start a pending card on ACTIVE and end the pi message with
  `stopReason: "toolUse"` after completion (`src/provider.ts:11-18,438-469,730-749`). They are a
  `toolCall` to the display-only wrapper tool `antigravity` with `{tool, input}`, whose
  "execution" reads a provider-written replay record instead of re-running the work
  (`lib/prompt.ts:20-34`, `lib/replay.ts:1-29`, `lib/native-tools.ts:1-10`, `index.ts:683-704`);
  wrapper output is clipped to 16,000 characters (`index.ts:691-702`). The provider header
  comment calls the wrapper `agy` (`src/provider.ts:1-19`); the constant is `antigravity`
  (`lib/prompt.ts:20-31`).
- Pi runs the wrapper and re-invokes the adapter, which re-attaches by prompt equality and drains
  a buffered queue (`src/runtime.ts:271-277`, `lib/turn.ts:1-63`).
- Bridged mode is a real round trip over a loopback MCP Streamable-HTTP server exposing pi tools
  as `pi__<name>` plus a pending-call store (`lib/bridge.ts:1-21,283-393`): the handler enqueues
  a pending call and pushes a synthetic `bridge_call` (`lib/bridge.ts:416-441`,
  `src/runtime.ts:575-579`); the provider emits the real pi tool and ends the message
  (`src/provider.ts:341-349,750-773`); pi runs it with its own hooks, permissions and abort; the
  next `streamAntigravity` request re-attaches and the `toolResult`, matched by `toolCallId`,
  resolves the HTTP response (`lib/bridge.ts:446-467`). Tool result arrays preserve text and
  images.
- Ordinary pending calls fail closed (`isError`) on the 480 s per-call cap, with no active turn,
  or on shutdown (`lib/bridge.ts:29-30,247-260,416-440`). The comment at `lib/bridge.ts:29` says
  the cap "must stay below agy's 600s turn timeout so agy can still report the failure"; the
  600 s is the pi-side `AGY_TURN_TIMEOUT_MS` default above, and the relationship is not enforced
  against a lowered value.
- Dynamic tools, including `activate_skill`, execute in-process and bypass the parked-call
  timeout path (`lib/bridge.ts:400-413`; `index.ts:473-493`; `lib/skills.ts:122-159`).
- Names: tool prefix `pi__`; `pi-bridge` is only the default constructor name, production passes
  a per-instance `pi-<12 hex>` server name (`lib/bridge.ts:25-28,148-150`;
  `lib/mcp-config.ts:7-11`; `index.ts:345-349`).
- Isolation: loopback ephemeral listener and an `x-pi-bridge-token` secret header
  (`lib/bridge.ts:152-155,227-243,283-288`; `index.ts:345-350`); private
  `.agents/mcp_config.json`, mode 0600 under a 0700 directory, passed with `--add-dir`
  (`lib/mcp-config.ts:7-39`; `lib/agy-client.ts:105-107`).
- Wire: POST JSON-RPC, not an SSE stream. Notifications get 202, replies are JSON with a
  module-wide session id, and cancellation notifications are acknowledged without cancelling
  calls (`lib/bridge.ts:289-321,333-348,444`).
- Lifetime: the canonical tool-catalog digest and registration generation combine into a process
  revision; preparation is single-flight with partial-config cleanup
  (`lib/bridge.ts:80-83,192-212,247-260,400-440,446-464`; `lib/bridge-lifecycle.ts:61-109`).
- Tool modes: the native default bridges only active `builtin:mcp` tools; Pi mode bridges active
  builtins, extensions and MCP tools, excluding hidden tools and the replay wrapper
  (`lib/bridge.ts:59-77`). Pi mode uses a generated agent with `tools: []`,
  `inheritCustomizations: false` and one `mcpServers` entry, its authenticated bridge
  (`lib/pi-tools-agent.ts:24-52`), and refuses an unprepared bridge/agent or a conflicting
  custom-agent configuration (`index.ts:365-413`).
- Both CLI argument builders unconditionally skip `agy` permissions
  (`lib/agy-client.ts:116-152`); native replay cards cannot prevent operations `agy` already ran.
- Cards: raw `call_mcp_tool` cards that target this bridge are suppressed to avoid duplicates;
  pending display cards close as "running" before a bridge handoff; still-ACTIVE tools replay as
  incomplete-tool cards pointing at `/agy-tasks` (`src/provider.ts:211-225,538-594,722-772,796-800`;
  `lib/prompt.ts:46-71`).

## 4. Thinking and reasoning

- The adapter states that print-mode stream-json exposes no thought text: only
  `thinking_tokens` counts and step duration (`src/provider.ts:5-9`; `lib/reducer.ts:15-21,196-221`;
  `lib/events.ts:17-23,60-78`). Visible text arrives only as `text_delta` continuation chunks on
  `agent_response` steps (`src/provider.ts:5-7`; `lib/reducer.ts:196-220`).
- Synthesized thinking: a slot is reserved before the text block
  (`output.content.push({ type: "thinking", thinking: "" })`, `src/provider.ts:608`) so
  delta-only consumers stay append-only (`src/provider.ts:382-417,606-612`), and filled with
  synthetic `Thought for <n>s, <k> tokens` text plus ordinary `thinking_start` / `_delta` /
  `_end` events when a thought activity arrives (`src/provider.ts:596-649`).
- The reducer emits a thought activity only for DONE response steps with at least 64 thinking
  tokens (`lib/reducer.ts:15-21,208-220`); at most one summary per logical turn
  (`lib/turn.ts:112-117`). The elapsed seconds describe the response step, not a measured
  reasoning interval (`src/provider.ts:614-648`). Retry and stall notices reuse the same slot
  (`src/provider.ts:651-680`), so the channel is partly diagnostics.
- An announced slot that never gets a count is closed as an empty block
  (`src/provider.ts:403-416`); the package's comment and test say pi's renderer trims it
  (`test/provider.test.ts:1066-1087`); the renderer itself was not inspected.
- `thinking_tokens` maps to pi usage `reasoning` (`reasoning: u?.thinking_tokens`,
  `src/provider.ts:157-168`).
- No signature exists: blocks are literally `{type: "thinking", thinking}`
  (`src/provider.ts:608,634-635`); no `signature`, redacted or encrypted-reasoning field is
  produced or parsed in `index.ts`, `lib` or `src`. The only `signature` hits are binary-cache
  hashes (`lib/agy-diagnostics.ts:108-137`).
- Levels: every model is registered `reasoning: true` and text-only (`index.ts:143-154`). The
  pi level maps to `--effort` as `minimal|low -> low`, `medium -> medium`,
  `high|xhigh|max -> high` (`src/provider.ts:194-200`), validated against discovered supported
  efforts (`lib/models.ts:82-89`), so `xhigh` and `max` silently downgrade; an unsupported
  requested effort falls back, and a model with no effort metadata gets no `--effort`
  (`src/provider.ts:352-353`; `lib/models.ts:24-34,38-63,81-88`). There is no Anthropic
  `thinking.type` object; pi asks for a level.

## 5. Errors

- Two channels: rejected promises typed `AgySpawnError` (stderr tail) and `AgyStallError`
  (`stalledMs`, `toolActive`) (`lib/agy-client.ts:74-103`); and the in-band result status, where
  only `SUCCESS` / `OK` succeed and absent, unknown, cancelled or timeout statuses fail closed
  (`lib/reducer.ts:225-244`).
- Classification is runtime-side: preflight -> `AgyCompatibilityError`
  (`lib/agy-diagnostics.ts:62-70`, `lib/agy-driver.ts:368-373`); missing conversation ->
  invisible rebuild; stall -> bounded retry; otherwise `controller.fail`
  (`src/runtime.ts:495-513,550-555`) -> provider `catch` -> `fail()` (`src/provider.ts:878-880`).
- Host-visible shape: `stopReason: "error"`, or `"aborted"` when pi's signal fired, plus a
  free-text `errorMessage` (`src/provider.ts:306-315`). No numeric codes, no taxonomy field, no
  retry hint, no account-routing status map.
- Shaping: overflow text is prefixed `context_length_exceeded: ` so pi's overflow path fires
  (`src/provider.ts:184,861-867`); caught permission-check errors get an allow-rule hint, while
  terminal-result errors do not pass through it (`src/provider.ts:306-314,861-867`); `agy`'s own
  "stream was interrupted" ERROR becomes a normal stop only when response text exists and that
  exact phrase matches (`src/provider.ts:186-192,851-871`; `test/provider.test.ts:1138-1159`);
  a driver death with no stderr emits canned advice, otherwise the last 3 stderr lines
  (`lib/agy-driver.ts:956-971`, `lib/agy-client.ts:346-353`).
- Caps: stderr 8 KiB (`lib/agy-driver.ts:130,847-851`); tool-error text takes the top-level
  error, then nested `tool_info.error`, collapses whitespace and truncates to 160 characters
  (`lib/reducer.ts:184-195`); an unterminated stdout line over 8 MiB aborts the turn
  (`lib/agy-driver.ts:130-131,830-844`).
- Upstream 429s are not modeled; they surface only as tool-error text (`lib/reducer.ts:184-195`).

## 6. Prompt handling

- No system-prompt channel exists in the argument builders (`lib/agy-client.ts:105-153`).
  Relayed instructions ride as a labelled user block, sent on a fresh conversation and on change
  only (`lib/prompt.ts:162-173`, `README.md:102`, `src/runtime.ts:322-329,372-375`); emptying
  them sends an explicit "stop applying" notice (`src/runtime.ts:359-361`,
  `lib/prompt.ts:169-170`); tool-loop re-entry re-sends nothing (`src/runtime.ts:271-277`). Only
  Pi-tools mode writes a separate, fixed agent definition (`lib/pi-tools-agent.ts:24-51`).
- Native mode relays only pi's documentation paths, rebuilt from the installed package
  (`index.ts:433-441`, `lib/prompt.ts:149-160`). Pi-tools mode relays pi's full rendered
  instructions (`index.ts:434-436`, `src/provider.ts:354-366`), stripping its
  "Available tools:" block only under three guards (`lib/prompt.ts:93-126`).
- History: the branch before the latest user batch, as text plus `[tool call: ...]` and
  `tool <name>` labels, capped at `MAX_RESTORED_HISTORY_CHARS` = 240,000 characters with an
  `[Earlier history omitted]` marker, sent only for a fresh conversation
  (`src/provider.ts:111-155`, `lib/prompt.ts:176-186`, `src/runtime.ts:318-321`). The tail drop
  can cut mid-message and flattens tool arguments to one JSON line, with no token accounting.
- Images are dropped and replaced by `"(N image(s) omitted — the agy print interface is text-only)"`
  (`src/provider.ts:69-103`; `lib/prompt.ts:73-75`); models register `input: ["text"]`
  (`index.ts:143-150`).
- pi's own compaction and branch-summary calls are detected by a `<conversation>\n` prefix and
  run in disposable runtimes that suppress normal tool UI, report zero usage, and close without
  touching the user's native conversation
  (`src/provider.ts:172-182,290-303,324-339,432-435,722-743`).
- `agy`'s internal compaction is inferred, because "stream-json has no compaction event": the
  input + cache-read footprint must be at least 120,000 tokens before, drop by at least 50,000,
  and end at no more than 65 % remaining, thresholds chosen so cache churn is not mistaken for compaction (`lib/agy-compaction.ts:3-41`); it is rendered as a pi
  entry (`index.ts:640-660`). Per-response usage is reported instead of `agy`'s cumulative
  counters specifically so pi does not auto-compact (`src/provider.ts:802-810`).

## 7. Accounts, quota, models

- Accounts: none. One ambient `agy` identity, no switching, no credential store, no isolated home; launches use the inherited environment and the
  selected binary with no account argument or override (`lib/agy-client.ts:105-152,175-182`;
  `lib/agy-driver.ts:427-452`).
- Quota: `/agy-usage` runs `agy --print /usage --output-format json` and displays group/bucket
  records with `remaining_fraction` and reset time; 30 s cap, token-free, display-only
  (`lib/usage.ts:1-33,72-120,196-200,279-305`; `src/usage-ui.ts:53-84`; `README.md:76-88`).
- Token usage: per-response step usage is preferred over the cumulative result; the controller
  subtracts already-claimed cumulative usage and treats a counter reset as new usage
  (`src/provider.ts:157-168,802-810`; `lib/turn.ts:119-135,188-215`).
- Models: `agy models` is tab-parsed; effort-suffixed ids (`-low` / `-medium` / `-high`) collapse
  into one pi model that keeps its supported and default efforts (`lib/models.ts:15-89`);
  baked-in fallback catalog (`:92-133`); `model-list.json` cache with 24 h live / 5 min fallback
  TTL (`lib/models.ts:201-214`, `index.ts:113,195-212`).
- Cost and window: hard-coded list prices for display only, unknown models zero
  (`lib/models.ts:155-177`); the registered context window is a deliberate 1,000,000-token pi
  scheduling value against `agy`'s working window of about 185k (repo-asserted)
  (`lib/models.ts:179-199`, `src/provider.ts:111-114`).

## 8. Packaging and platforms

- MIT, ESM, TypeScript extension loaded from `./index.ts`; the publish allowlist contains
  source, index, lib and CHANGELOG, no tests and no compiled dist. Dependencies: Effect 4.1.1,
  proper-lockfile 4.1.2, semver ^7.8.5, which ^7.0.0; wildcard pi peers
  (`package.json:5,16,26-49`). Typecheck and test commands are declared (`package.json:37-40`).
- The managed binary name becomes `agy.exe` on Windows and lookup honors `PATHEXT`
  (`lib/agy-diagnostics.ts:168-170,196-200`). Windows kills use `taskkill /F /T /PID`; POSIX
  uses negative-PID process-group signals. Process-table probing and the extra command-group
  abort sweep are disabled on Windows; artifact opening uses `open` on macOS and `xdg-open`
  elsewhere, with no Windows branch (`lib/agy-children.ts:72-85,141-164,179-205`;
  `lib/agy-driver.ts:602-614`; `src/artifacts-ui.ts:109-114`).

## 9. Reported or unverified

Not established from the code alone:

- `agy` internals behind the parked verdict: the transcript JSONL path and step semantics
  (`lib/tasks.ts:311-341,402-427`) and the "withholds the result until background tasks exit"
  claim (`lib/agy-driver.ts:789-817`).
- The working window of about 185k, and the `--print-timeout` default (section 2).
- The per-version `SUCCESS` / `OK` split (`lib/events.ts:80-93`) and the 1.2.0 `run_command`
  group behavior (`lib/tasks.ts:17`).
- The `/tasks` and `manage_task` limitations (`README.md:32`).
- That print-mode stream-json exposes no thought text (`src/provider.ts:5-9`).
- The February-2026 suspension-sweep narrative (`README.md:139-143`).
- The flag and NDJSON surface is documented upstream; model ids, version chronology and pricing
  are repo-asserted only.
