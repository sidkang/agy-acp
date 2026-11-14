# TianZuo555/pi-extensions — `packages/pi-antigravity` (independent pass)

Source: `git clone --depth=1 https://github.com/TianZuo555/pi-extensions` pinned at commit `7b88eb36e34534c79adf587a4623c2233d9dbd04`; package `@tian.zuo/pi-antigravity@0.12.1`
(`packages/pi-antigravity/package.json:2-3`). Citations are package-relative (`index.ts`, `lib/…`, `src/…`) unless prefixed with `packages/` or `/Users/…`. Read-only inspection; the package was not executed. Repo timestamps are 2026-dated (`README.md:139-143` cites 2026
events), so dates below are repo-supplied, not calendar-verified.

## 1. Host and upstream

- Host: pi's extension API (`@earendil-works/pi-coding-agent` + `pi-ai` peers, `package.json:44-47`); entry `antigravityExtension(pi: ExtensionAPI)` (`index.ts:214`, wired by
`package.json:33-37`).
- Registration: provider `antigravity`, `api: "antigravity-stream-json"`, `baseUrl: "agy://local-stream-json"`, `apiKey: "agy-local-session"` — all placeholders, nothing listens there
(`index.ts:735-759`); the transport is `streamSimple` (`src/provider.ts:228-265`).
- Upstream: the local `agy` CLI as a child process only. No Google HTTP call and no OAuth code in the package (`README.md:139-143`); the only HTTP server is its own loopback bridge
(`lib/bridge.ts:227-245`). **Auth is absent by construction** — it is whatever login the CLI already holds; `apiKey` is a literal placeholder (`index.ts:738-739`) and a failure can only surface as
the text of `AgySpawnError` (`lib/agy-client.ts:158-162`). Contrast our `src/accounts/auth.ts:1-30`.
- Only two CLI-side artifacts are read: `~/.gemini/antigravity-cli/conversations/<id>.db` existence (`lib/conversation-state.ts:35-58`) and the transcript JSONL (`lib/tasks.ts:414-427`).
- Protocol: print/stream-json NDJSON — `--input-format stream-json --output-format stream-json` (`lib/agy-client.ts:134-153`), one `{"event":"user","message":{"role":"user","content":…}}` line per
turn (`lib/agy-driver.ts:497-499`), parsing `init`/`step_update`/`result` (`lib/events.ts:106-152`). Matches the documented surface, incl. "`text` is the only supported stream-input block type"
(`antigravity.google/docs/cli/headless/`).
- Version target: `MIN_AGY_VERSION = "1.1.22"`, enforced on `agy --version` with a 5 s cap and a classified failure (`lib/agy-diagnostics.ts:10, 294-305, 319-331`); prerelease/dev builds bypass
the gate (`:294, 355-363`). Binary: `AGY_BINARY` (strict) → `PATH` → `~/.gemini/bin/agy`, newest stable wins (`:15-22, 354-378`).
- Encoded version assumptions: events from 1.1.17 (`lib/events.ts:1-5`), fallback models from 1.1.25 (`lib/models.ts:91`), `SUCCESS` (≥1.1.22) vs older `OK` (`lib/events.ts:80-93`,
`lib/reducer.ts:229-233`), ≥1.2.0 `run_command` process-group semantics (`lib/tasks.ts:17`).

## 2. Transport and processes

- One long-lived `agy` child per pi session, detached into its own process group, reused across user turns and tool-loop re-entries (`lib/agy-driver.ts:221-241, 447-452, 1119-1121`); turns
serialize on a promise queue (`:315-329`).
- Recycle only on fingerprint change — binary/version/revision, cwd, mcpDirectory, model, effort, agent, mode, bridgeRevision, conversation id — with a named cause counted for `/agy-doctor`
(`lib/agy-driver.ts:170-194, 63-71`).
- Per-session, not per-turn, extra processes: a disposable runtime with its own `agy` child for pi compaction/branch summaries (`src/provider.ts:287-303, 326-339`); `agy --version`,
stat-cache-keyed so roughly once per session (`lib/agy-diagnostics.ts:96-137, 366-370`); `agy models`, 15 s cap (`index.ts:114, 171-177`); `agy --print /usage`, 30 s cap (`lib/usage.ts:1-13`).
- Per turn: async `ps`/`lsof` task-origin snapshots coalesced off the line handler (`lib/agy-driver.ts:927-944`, `lib/tasks.ts:149-178, 465`) and transcript tail reads (`lib/tasks.ts:311-341`).
The MCP bridge is in-process on an ephemeral 127.0.0.1 port (`lib/bridge.ts:227-245`).
- State: agy's server-side conversation, resumed by `--conversation <id>` (`lib/agy-client.ts:105-113`); the id is persisted into pi session entries (`lib/conversation-state.ts:8-24`,
`index.ts:287-320`) and restored only when the model matches and the db still exists (`index.ts:827-862`). agy pins a conversation to its workspace, so a cwd change drops the id
(`src/runtime.ts:279-291`).
- Timeouts: pi-owned `AGY_TURN_TIMEOUT_MS` default 600 s (`src/runtime.ts:330`), enforced by a pi-side deadline abort (`:340-346`) and by the driver's per-turn timer (`lib/agy-driver.ts:551-561`);
retries get only the remaining budget (`src/runtime.ts:443-484`). agy's own `--print-timeout` is pinned to `2147484s` so its default wait cannot end a live turn (`lib/agy-client.ts:134-153`).
- Stall ladder: byte-level, not event-level — any stdout/stderr chunk re-arms (`lib/agy-driver.ts:819-851`), 120 s base / 300 s tool-active (`:617-643`, `src/runtime.ts:385-386`); positive
evidence (live group-leading child) buys a full extra budget up to 12 consecutive graces, reset when the ACTIVE set drains (`:247, 736-787, 897-900`).
- A 5 s `AGY_PARKED_WATCH_MS` transcript poll spots agy withholding a finished answer behind background work and ends the turn as OK with `AGY_PARKED_TURN_ERROR` (`lib/agy-driver.ts:148, 650-712,
798-817`, `lib/prompt.ts:42-43`).
- Retry: only `AgyStallError`, max 2, `AGY_STALL_RETRY_BACKOFF_MS`=3000, then a continuation prompt on the same conversation id (`src/runtime.ts:49, 511-527`, `lib/prompt.ts:193-200`), rendered as
a collapsed thinking line (`src/provider.ts:657-680`). "Not found / failed to resume" gets one silent fresh rebuild (`src/runtime.ts:51-61, 495-510`); spawn/auth failures never retry (`:420-422`).
- Kill/shutdown: stdin end → 250 ms → SIGTERM → 500 ms → SIGKILL on the group (`lib/agy-driver.ts:133-134, 331-365`); ACTIVE-tool turns recycle and reap task groups (`:995-1030, 602-615`);
aborting a *parked* turn leaves detached work alive on purpose (`:582-593`); shutdown sweeps groups and identity-checked orphans (`index.ts:923-1010`). `PI_ANTIGRAVITY_DRIVER=0` = one `agy --print` per turn, pure inactivity watchdog (`lib/agy-driver.ts:1072-1121`).

## 3. Tool channel

- agy runs its own tools; pi executes nothing agy asked for. `view_file`/`list_dir`/`grep_search`/`find_by_name` map to pi builtins `read`/`ls`/`grep`/`find`, re-executed **only after DONE** so a
failed agy read replays its error instead of re-running as a success (`lib/native-tools.ts:58-107`, `src/provider.ts:510-517`).
- Everything else is a `toolCall` to the display-only wrapper `antigravity` with `{tool,input}`, whose "execution" reads a provider-written replay record (`lib/prompt.ts:20-34`,
`lib/replay.ts:1-29`, `index.ts:683-704`; output clipped to 16 000 chars, `index.ts:701`).
- Each completed step ends the pi message with `stopReason: "toolUse"` (`src/provider.ts:438-444, 730-749`); pi runs the wrapper and re-invokes the adapter, which re-attaches by prompt equality
and drains a buffered queue (`src/runtime.ts:271-277`, `lib/turn.ts:1-63`).
- Bridged mode is a real round trip: agy calls `pi__<tool>` over loopback MCP (`lib/bridge.ts:283-393`), the handler enqueues a pending call and pushes a synthetic `bridge_call` (`:416-441`,
`src/runtime.ts:575-579`), the provider emits the **real** pi tool and ends the message (`src/provider.ts:750-773`), then the `toolResult` is matched by `toolCallId` and resolves the HTTP response
(`lib/bridge.ts:446-467`). 480 s per-call cap, fail-closed `isError` (`:29-30, 431-437`), `x-pi-bridge-token` secret (`:152-155, 284-288`, `index.ts:347-349`).
- Pi tools mode uses a generated agent (`tools: []`, one `mcpServers` entry, `lib/pi-tools-agent.ts:26-52`) plus private `--add-dir` discovery (`lib/mcp-config.ts:7-39`); pending display cards
close as "running" before a handoff, and still-ACTIVE tools replay as incomplete-tool cards pointing at `/agy-tasks` (`src/provider.ts:538-594`, `lib/prompt.ts:46-71`).

## 4. Thinking / reasoning surface

- What agy exposes: `thinking_tokens` counts plus step duration — no thought text, no reasoning blob (`lib/reducer.ts:15-21, 196-221`, `lib/events.ts:17-23`).
- What pi is told: a synthesized `thinking` block reading `"Thought for <n>s, <k> tokens"` (`src/provider.ts:596-649`), suppressed below 64 thinking tokens (`lib/reducer.ts:21, 208-220`), at most
one per logical turn (`lib/turn.ts:112-117`), emitted as ordinary `thinking_start`/`_delta`/`_end` at an index reserved *before* the text block so delta-only consumers stay append-only
(`src/provider.ts:382-417, 606-612`); stall retries reuse that slot (`:657-680`).
- **No signature exists.** Blocks are literally `{type:"thinking", thinking}` (`src/provider.ts:608, 634-635`); no `signature`/`redacted`/encrypted-reasoning field is produced or parsed anywhere
in `index.ts`/`lib`/`src` (the only `signature` hits are binary-cache hashes, `lib/agy-diagnostics.ts:108-137`). Our plugin instead fabricates a UUID-shaped signature so pi keeps the block
(`/Users/sid/Devs/antigravity-magpie/src/protocol/anthropic.ts:1002-1013`).
- Levels: model registered `reasoning: true` (`index.ts:143-154`); pi level → `--effort` is `minimal|low→low`, `medium`, `high|xhigh|max→high` (`src/provider.ts:194-200`), validated against
discovered supported efforts (`lib/models.ts:82-89`) — so `xhigh`/`max` silently downgrade.

## 5. Errors → host-visible

- Two channels: rejected promises typed `AgySpawnError` (stderr tail) / `AgyStallError` (`stalledMs`, `toolActive`) (`lib/agy-client.ts:74-103`), and in-band result status where only
`SUCCESS`/`OK` succeeds and any unrecognized status fails closed (`lib/reducer.ts:225-244`).
- Classification is runtime-side: preflight → `AgyCompatibilityError` (`lib/agy-diagnostics.ts:62-70`, `lib/agy-driver.ts:368-373`); missing conversation → invisible rebuild; stall → bounded
retry; else `controller.fail` (`src/runtime.ts:495-513, 550-555`) → provider `catch` → `fail()` (`src/provider.ts:878-880`).
- Host-visible shape: `stopReason: "error"` (or `"aborted"` if pi's signal fired) plus a free-text `errorMessage` (`src/provider.ts:306-315`). No numeric codes, no taxonomy field, no
machine-readable retry hint — prose only.
- Shaping: overflow text prefixed `context_length_exceeded: ` so pi's overflow path fires (`src/provider.ts:184, 861-867`); permission failures get an allow-rule hint (`:306-309`); agy's own
"stream was interrupted" ERROR is downgraded to a normal stop only when response text exists (`:186-192, 855-871`); a driver death with no stderr emits canned advice, else the last 3 stderr lines
(`lib/agy-driver.ts:956-971`, `lib/agy-client.ts:346-353`).
- Caps: stderr 8 KiB (`lib/agy-driver.ts:130, 847-851`), tool-error text 160 chars (`lib/reducer.ts:193`), unterminated stdout line >8 MiB aborts the turn (`:130-131, 830-844`). Upstream 429s are
not modeled, surfacing only as tool-error text (`lib/reducer.ts:184-195`).

## 6. Prompt handling

- No system-prompt channel exists (argv builders, `lib/agy-client.ts:105-153`), so pi instructions ride as a labelled **user** block (`lib/prompt.ts:162-173`, `README.md:102`). Native mode relays
only pi's documentation paths rebuilt from the installed package (`index.ts:434-441`, `lib/prompt.ts:149-160`); when pi's rendered prompt is relayed instead, its "Available tools:" block is
stripped under three guards (`lib/prompt.ts:93-126`). Pi tools mode relays pi's full rendered instructions (`index.ts:434-436`, `src/provider.ts:354-366`).
- Cadence: on a fresh conversation and on change only; emptying it sends an explicit "stop applying" notice (`src/runtime.ts:322-329, 359-361`, `lib/prompt.ts:169-170`); tool-loop re-entry
re-sends nothing (`:271-277`).
- History: the branch before the latest user batch, text plus `[tool call: …]` and `tool <name>` labels, capped at `MAX_RESTORED_HISTORY_CHARS` = 240 000 chars with an `[Earlier history omitted]`
marker, and only for a fresh conversation (`src/provider.ts:111-155`, `lib/prompt.ts:176-186`, `src/runtime.ts:318-321`).
- Images: dropped, replaced by `"(N image(s) omitted — the agy print interface is text-only)"` (`src/provider.ts:69-103`, `lib/prompt.ts:73-75`); model registered `input: ["text"]`
(`index.ts:148`).
- Compaction: pi's compaction/branch-summary calls are detected by a `<conversation>` prefix, run in a disposable agy conversation, and report zero usage (`src/provider.ts:172-182, 326-339,
432-435`). agy's internal compaction is only inferred (≥120 000 tokens dropping by ≥50 000 to ≤65 % remaining) and rendered as a pi entry (`lib/agy-compaction.ts:5-41`, `index.ts:640-660`).
Per-response usage is reported instead of agy's cumulative counters specifically so pi does not auto-compact (`src/provider.ts:802-810`).

## 7. Accounts, quota, models

- Accounts: none — one ambient `agy` identity, no switching, no credential store, no isolated home (§1).
- Quota: `/agy-usage` shells `agy --print /usage --output-format json` and parses group/bucket records with `remaining_fraction` and reset time; 30 s cap, token-free, display-only
(`lib/usage.ts:1-33, 72-120`, `README.md:76-88`).
- Models: `agy models` tab-parsed, effort-suffixed ids collapsed into one pi model retaining the effort set (`lib/models.ts:15-89`); baked-in fallback catalog (`:92-133`); `model-list.json` cache
with 24 h live / 5 min fallback TTL (`:201-214`, `index.ts:113, 195-212`).
- Cost/limits: hard-coded list prices for display only, unknown models stay zero (`lib/models.ts:155-177`); pi's scheduling window is pinned at 1 000 000 against agy's ~185k working window
(`:179-199`, `src/provider.ts:111-114`). Usage: per-response step usage preferred over the cumulative result, subtracted with a counter-reset guard (`lib/turn.ts:119-135, 188-215`).

## 8. Five bullets

- **Copy** the persistent session plus its reason-named recycle fingerprint and counters: a config change recycles instead of silently reusing a stale process, and `/agy-doctor` can explain every
spawn (`lib/agy-driver.ts:170-194, 63-71`). Our ACP connection has only a stderr ring, no fingerprint/cause ledger (`/Users/sid/Devs/antigravity-magpie/src/runtime/acp-connection.ts:1-40`).
- **Copy** the stall ladder — bytes → longer tool-active budget → positive process evidence → bounded graces → off-stream parked-answer verdict, with a hard ceiling so in-process tools still die
(`lib/agy-driver.ts:736-787, 650-712`). Highest-value idea here; our closest analogue is a single 30-minute generation watchdog (`/Users/sid/Devs/antigravity-magpie/src/runtime/worker.ts:1494`), no byte-inactivity or tool-active grace ladder.
- **Copy** the "read-only re-execute, everything else replay" split, including waiting for DONE before choosing native execution so a vendor-side failure is replayed as an error, never re-run as a
success (`lib/native-tools.ts:58-61`, `src/provider.ts:510-517`). Cheap, no protocol extension needed.
- **Avoid** three things: the 240 000-char tail-drop history restore, which truncates mid-message and flattens tool arguments to one JSON line with no token accounting (`src/provider.ts:113-155`);
the unsigned synthesized thinking block, display-only and non-portable to any consumer that round-trips reasoning (our fabricated signature, `src/protocol/anthropic.ts:1002-1013`, is the worse
failure mode of the same compromise); the hard-coded 1 000 000 context window, which hides agy's real ~185k limit so pi never compacts before agy must (`lib/models.ts:179-199`).
- **Unverifiable from the code alone**: agy's internals — the transcript JSONL path/step semantics behind the parked verdict (`lib/tasks.ts:311-341, 402-427`), the "withholds the result until
background tasks exit" claim (`lib/agy-driver.ts:789-817`), the ~185k window, the `--print-timeout` default (code asserts five minutes and pins `2147484s`, `lib/agy-client.ts:134-153`, while the
official CLI reference documents `0s` = unlimited — harmless conflict, unresolvable here), the per-version `SUCCESS`/`OK` split (`lib/events.ts:80-93`), the ≥1.2.0 `run_command` group behavior
(`lib/tasks.ts:17`), and the February-2026 suspension-sweep narrative (`README.md:139-143`). The flag/NDJSON surface itself is documented upstream; model ids, version chronology, and pricing are
repo-asserted only.
