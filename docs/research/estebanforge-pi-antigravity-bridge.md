# `@estebanforge/pi-antigravity-bridge` (EstebanForge/pi-extensions, `packages/pi-antigravity-bridge`)

- Checkout: `https://github.com/EstebanForge/pi-extensions`, shallow clone, commit
  `d3ca5cc66947a3299e2ef18b8986c7dc86e9373b` (commit date 2026-11-13), package
  `@estebanforge/pi-antigravity-bridge@1.10.6` (`package.json:1-3`). Read 2026-11-14.
- Citations are relative to `packages/pi-antigravity-bridge/`. Inspected `src/*.ts`,
  `src/acp/*.ts`, `extensions/index.ts`, `docs/{ARCHITECTURE,ENGINES,PI-BRIDGE-GAPS,ACP-PROTOCOL-REFERENCE}.md`,
  `README.md`, `CHANGELOG.md`, and selected tests (read, not run). About 11.3k lines of `src`
  (count not tied to a recorded commit). Nothing executed; no credentials touched.
- Much of what this package records about `agy` comes from the authors' dated probes; raw RC01
  traffic is gitignored (`docs/ACP-PROTOCOL-REFERENCE.md:5-24`), so its provenance cannot be
  checked from the clone. Section 8 collects those observations with their versions.
  Comparison with this plugin: [`comparison.md`](comparison.md).

## 1. Host and upstream

- A pi extension. Optional peer `@earendil-works/pi-coding-agent ^1.5.1`
  (`package.json:47-50`); one extension entry, `extensions/` (`package.json:43-46`).
- Registers provider `antigravity` with a private api sentinel `agy-bridge`,
  `apiKey: "not-used"`, `baseUrl: "agy-bridge://antigravity"`, and `streamSimple` as the whole
  transport (`extensions/index.ts:610-627`; `src/models.ts:366-391`; `src/provider.ts:1786-1884`).
- Two turn engines behind one interface, `TurnDriver` (`src/driver-types.ts:1-20,155-168`): `acp`
  (default) and `stream-json`, chosen by `config.engine` / `AGY_ENGINE`
  (`src/config.ts:43-48,277-286`; `docs/ENGINES.md:3-8`). `AGY_ENGINE` overrides the saved
  engine; fresh installs default to ACP, but an existing config without `engine` keeps
  stream-json (`src/config.ts:277-286`). The choice is latched at extension load
  (`extensions/index.ts:143,357-362`); changing it in the picker needs a pi restart
  (`src/engine-picker.ts:3-5,64-68`). There is no per-turn fallback between engines. Of the four
  bridges studied, it is the only one with two engines.
- ACP engine: spawns `agy acp` (`extensions/index.ts:316-319`, `binArgs: ["acp"]`), not the
  historical standalone RC01 binary, speaking newline-delimited JSON-RPC 2.0 on stdio
  (`src/acp/jsonrpc.ts:1-17`). The handshake sends
  `{protocolVersion: 1, clientCapabilities: {fs: {readTextFile: false, writeTextFile: false}, terminal: false}}`,
  reads `agentInfo.version`, and refuses server-initiated `fs/*` and `terminal/*` requests
  (`src/acp/connection.ts:5,243-259,359-367`).
- stream-json engine: one child per profile,
  `agy --add-dir <cwd> [--gemini_dir <home>] [--add-dir <bridgeDir>] --model ... [--effort ...] --mode ... [--agent ...] [--dangerously-skip-permissions] [--conversation <id>] --input-format stream-json --output-format stream-json --disable-slash-commands`
  (`src/driver.ts:460-491`). Its stdout grammar is NDJSON `init` / `step_update` / `result`;
  unknown kinds degrade to `{kind: "unknown"}` (`src/stream-events.ts:1-99`).
- The private-home flag is spelled `--gemini_dir` on the stream-json run path and `--gemini-dir`
  on the `acp` subcommand, both "live-verified 2026-11-13 on agy 1.5.8"
  (`src/agy-version.ts:177-182`; `src/acp/connection.ts:168-172`).
- Authentication is delegated: the code never reads, stores or transmits a credential, and both
  engines use the cached Google credentials of the same `agy` install
  (`docs/ENGINES.md:5,16`; `src/driver.ts:461`). The staged home links the CLI's app data rather
  than creating another account (`src/acp/home.ts:40-89`): it isolates MCP configuration, not
  credentials or account state. A global stream-json fallback exists
  (`extensions/index.ts:281-288`).
- Only ACP surfaces auth failures: JSON-RPC `-32000` -> `AcpAuthError` telling the user to run
  `agy` and sign in (`src/acp/connection.ts:580-594`). `translateError` classifies every `-32000`
  passed to it as auth, which is broader than proving an auth cause.
- Version gates: stream-json floor 1.1.22 (`src/agy-version.ts:20`), ACP floor 1.5.3 (`:21`) with
  an installer offer (`docs/ENGINES.md:20-24`); `--gemini_dir` isolation reported verified up to
  1.5.8 (`src/agy-version.ts:22-28`), a verification ceiling rather than a guarantee; dev and
  HEAD builds are never gated (`src/agy-version.ts:67-79`).
- Live-observation claims carry their version: "verified live on agy 1.5.3"
  (`docs/ENGINES.md:7`), agy 1.5.8 (`CHANGELOG.md:5-9`), and older notes naming
  1.1.13+/1.1.18/1.2.10/1.2.12/1.5.4 inline (`src/stream-events.ts:35`, `src/usage.ts:1-10`,
  `src/acp/events.ts:56-63`, `CHANGELOG.md` entry 1.10.4).
- `docs/ENGINES.md:22-38` is a capability matrix, one row per capability and one column per
  engine, each cell reported as verified live. Among its rows: system prompt as an agent file
  (stream-json) or prepended to the first turn (ACP), with the digest as `embeddedContext`
  (`:35-36`); tools through direct `mcpServers` plus a sanitized private MCP home (`:33`); thought
  text on ACP only (`:24`); `session/cancel` with a teardown fallback (`:32`).

## 2. Transport and processes

- One persistent child per engine instance, not per turn: stream-json keeps `agy` alive
  (`src/driver.ts:1-15`), ACP keeps one `agy acp` (`src/acp/driver.ts:534-584`). Turns serialize
  through a promise-chain queue on both (`src/driver.ts:295-314`; `src/acp/driver.ts:217-233`).
- stream-json recycles (kill and respawn) on profile drift in cwd, model, effort, mode,
  effective permissions, agent or conversation (`src/driver.ts:825-838`). ACP does not recycle;
  it re-applies `model`, `thought_level` and `mode` per turn through `session/set_config_option`
  (`src/acp/driver.ts:5-12,327-341`). A model or thought-level selection failure fails the turn;
  a mode-setting failure only logs.
- A one-shot `agy -p` exists only behind the `AskAntigravity` delegation tool, never on the turn
  path (`src/ask-tool.ts:6,177-193`).
- Process lifecycle (stream-json): detached process group on POSIX, `windowsHide` on Windows, and
  the pid is kept after kill so late stragglers cannot write into a home being removed
  (`src/driver.ts:481-496,852-895`). ACP spawns similarly, but its home release follows its own
  exit path (`src/acp/connection.ts:175-180,539-554`).
- State carried across pi turns: `~/.pi/agent/antigravity-bridge/sessions.json`, keyed
  `sid:<piSessionId>[@acp]` or `cwd:<cwd>[@acp]`, holding
  `{conversationId, lastStepIdx, lastMessageCount}` (`src/provider.ts:346-359`;
  `src/sessions.ts:15-32`), written atomically with a per-key merge so two pi processes do not
  clobber each other (`src/sessions.ts:60-66`).
- Resume: stream-json passes `--conversation <id>` (`src/driver.ts:472`); ACP uses
  `session/load` (`src/acp/connection.ts:58`), and any failed load falls back to `session/new`
  (`src/acp/driver.ts:278-324`). ACP load replay is suppressed
  (`src/acp/connection.ts:157-162,276-291`).
- Turn cap: drivers default to 10 minutes (`src/driver.ts:408`; `src/acp/driver.ts:665-667`);
  the config default is TTY-aware, `0` interactive and `20` headless
  (`src/config.ts:199-215,224-226`); accepted range 1-1440 minutes (`src/config.ts:217-237`).
- Stall cap: 5 minutes, `0` disables (`src/driver.ts:410-415`;
  `src/acp/driver.ts:669-671,733-745`). Stall detection is silence-based: the idle timer
  refreshes on every stdout chunk or every `session/update` (`src/driver.ts:574`;
  `src/acp/driver.ts:417`).
- ACP request budgets: `initialize` 30 s, session operations 20 s, `session/prompt` deliberately
  untimed because the turn timers govern (`src/acp/connection.ts:75-81,302-304`); permission
  dialogs park up to 480 s (`src/acp/connection.ts:78-81`).
- Park accounting: every park (bridge call, escalated call, approval dialog) clears both timers;
  for the turn cap it stores the remaining budget and resumes it on unpark, never a fresh window
  (`src/driver.ts:150-167,257-277`; `src/acp/driver.ts:166-215,713-746`).
- On stall or deadline, stream-json kills the child first, then probes the conversation
  transcript tail (up to 512 KiB) for a clean, tool-free final model step written during the
  turn, and settles OK with that withheld answer if found (`src/driver.ts:777-810`;
  `src/parked-turn.ts:1-79`). A deadline failure is labelled with its real cause
  (`src/provider.ts:1681`). ACP's deadline and idle guards kill and fail
  (`src/acp/driver.ts:694-709,733-745`); parked human or tool time suspends them
  (`src/acp/driver.ts:184-213`).
- No retry and no backoff; failures go to pi. Recovery plumbing: a synthetic resume prompt when pi
  drops a failed attempt from the projected context (`src/provider.ts:150-151,1490-1498`); late
  results re-delivered as a new prompt in the same conversation
  (`src/provider.ts:1086-1098,1371-1398`), with a registry-wide sweep for escalated but unpolled
  results (`src/provider.ts:1400-1420,1696-1705`); the conversation binding is cleared when the
  turn signature proves the conversation dead (`src/provider.ts:1660-1695`).
- Frame guard: a 32 MiB per-frame ceiling (`src/frame-guard.ts:18`). A breach aborts pending
  RPCs, fails the turn and kills the transport (SIGKILL of the process group); it is not repaired
  (`src/driver.ts:558-569`; `src/acp/jsonrpc.ts:80-86,124-130`; `src/acp/connection.ts:202-219`).
  Only one known foreign stdout line (browser noise) is stripped and re-parsed; other malformed
  lines are dropped (`src/frame-guard.ts:20-38`; `src/acp/jsonrpc.ts:90-117`). The cap compares
  JS string length before splitting, not the UTF-8 byte length of each line.
- Cancellation (ACP): `session/cancel` is sent as a notification (`src/acp/connection.ts:346-349`)
  and the driver waits for the prompt to settle; after 10 s it tears down
  (`src/acp/driver.ts:586-627`). The POSIX fallback signals the group with TERM, then KILL after
  750 ms; on Windows the transport fallback calls `child.kill`, not the installer-style
  `taskkill` tree cleanup (`src/acp/connection.ts:175-180,514-535`; `src/agy-install.ts:55-63`).

## 3. Tool channel

- Model tool calls reach the host only through an MCP bridge: loopback Streamable-HTTP MCP on
  `127.0.0.1` (`src/mcp-server.ts:579`), a per-process UUID shared secret in `x-bridge-token`
  compared in constant time, 1 MB body cap (`src/mcp-server.ts:44-45,376-390`); the server
  answers its own HTTP errors, for example 403 and 413 (`src/mcp-server.ts:399-407`).
- pi's tool schemas never go on the `agy` wire: `tools/list` is served from pi's live active set
  on every request (`src/mcp-server.ts:296-300`; `src/bridge-catalog.ts:13-28`) and re-checked at
  `tools/call`, so a cached catalog is not authorization.
- stream-json registration: `.agents/mcp_config.json` in
  `~/.pi/agent/antigravity-bridge/agy-mcp-<pid>/`, passed as an extra `--add-dir`
  (`src/driver.ts:462-466`; `src/mcp-server.ts:191-199`); with a staged private home it routes
  through `--gemini_dir <home>` instead (`extensions/index.ts:248-262`). The legacy fallback
  registers a per-pid entry in the global `~/.gemini/config/mcp_config.json` plus a suppression
  marker (`extensions/index.ts:253-288,964-975`):
  `mcpServers[bridgeServerName(pid)] = {disabled, serverUrl, headers: {x-bridge-token}}`, with
  `disabled` derived from policy, not always false (`src/mcp-registration.ts:8-9,83-93,112-121`).
  The code calls the global registration a deliberate, previously audited trade
  (`src/mcp-registration.ts:70`); a crashed session can leave that entry behind.
- ACP registration:
  `mcpServers: [{name: "pi-bridge", type: "http", url: "http://127.0.0.1:<port>/mcp", headers: [{name: x-bridge-token, value}]}]`
  on both `session/new` and `session/load` (`extensions/index.ts:316-355`;
  `src/acp/connection.ts:261-291`); a header array, separate from stream-json's config-object
  headers. Per-pid bridges inherited into the private home are filtered out
  (`src/acp/home.ts:54-71`).
- Round trip, identical on both engines: `tools/call` -> `onToolCall` parks instead of executing
  (`src/provider.ts:909-955`); the park is injected as a `bridge_call` activity; the provider
  emits a complete `toolCall` block for the real pi tool and ends the pi assistant message with
  `stopReason: "toolUse"` (`src/provider.ts:1143-1161,1321-1327`); pi executes the tool in its own
  loop, and the `toolResult` in the next `streamSimple` context makes `resolve()` complete the
  parked HTTP response with text and/or image blocks (`src/provider.ts:968-1029,1354-1369`). Real
  MCP calls have forged marker fields stripped (`src/provider.ts:949-953`).
- Long calls: after 20 s the request settles with `STILL RUNNING` and a `callId`, and the model
  must poll `bridge_poll_result` (`src/provider.ts:448-493,612-659`). Delegation-shaped names
  (`/subagent|delegate|^agent(_|$)/i`) are held synchronously for 120 s first
  (`src/provider.ts:466-485`). Park TTL 480 s, escalated TTL 30 minutes, 64-entry bounded
  registry (`src/provider.ts:428,488,514-528`). The motivation is a reported `agy` abandonment of
  MCP `tools/call` at about 180 s (section 8).
- `agy`'s own native tools never execute in the host. On ACP they become display-only cards
  carrying the server-supplied diff or a git diff of the file on disk
  (`src/provider.ts:1196-1203,1222-1260`), with `[agy tool: <name>]` thinking labels as the
  fallback rendering (`src/provider.ts:15-16,1262-1319`). MCP `rawInput.arguments` is unwrapped,
  `_meta.mcp.tool` preferred, content and diffs preferred over display-like `rawOutput`, and the
  legacy "approved but never executed" echo is dropped (`src/acp/events.ts:64-107,118-140`).
  Under a deny policy with no human handler, it picks a reject option or returns `cancelled`
  (`src/acp/connection.ts:369-391`).
- On stream-json, read-only steps re-run as real pi builtins (`view_file` / `list_dir` /
  `grep_search` / `find_by_name` -> `read` / `ls` / `grep` / `find`) so pi's renderers run them;
  mutating and specialty tools replay recorded output through a display-only `antigravity` tool
  (`src/native-tools.ts:1-10,55-103`; `src/provider.ts:1279-1310`; `extensions/index.ts:663-676`).
- Approval gate with shadow tools: when active, pi's mutating builtins (`bash`, `write`, `edit`)
  are re-registered under the same name and schema plus internal `__agy*` marker fields; a marked
  call is an approval round trip for an `agy` native tool and is never executed locally
  (`src/approval-gate.ts:1-38,69-81`).
- Approval hook staging: `agy` discovers `.agents/hooks.json` in `--add-dir` directories, so the
  gate's hook file lives in a dedicated bridge directory given only to this session's `agy`;
  "standalone IDE/CLI sessions must never load our gate"
  (`src/approval-hook.ts:3-25`; `src/driver.ts:462-468`). The hook-discovery and timeout
  soft-pass statements are the authors' dated observations (`src/approval-hook.ts:3-12`).

## 4. Thinking and reasoning

- stream-json: token count only. `{type: "thought", tokens}` is emitted only when
  `thinking_tokens >= 64`; `thought_text` is declared and never read
  (`src/driver.ts:52,626-628`; `src/stream-events.ts:37-38`; `src/driver-types.ts:60-62`).
- ACP: actual thought text. `agent_thought_chunk` -> `{kind: "thought", delta}` -> pi
  `thinking_start` / `_delta` / `_end` (`src/acp/events.ts:49-55`; `src/acp/driver.ts:432-440`;
  `src/provider.ts:1186-1192,1920-1942`).
- Interleaving is close-on-switch: at most one block open, text and thinking closing each other
  (`src/provider.ts:1910-1942`).
- No signature: `thinking_signature?: string` is declared on the stream-json step type
  (`src/stream-events.ts:37-39`) and referenced nowhere else; there is no `signature_delta` or
  `redacted_thinking` handling, and constructed blocks carry only text
  (`src/provider.ts:1920-1941`).
- Thinking level is request-side only: pi reasoning level -> `--effort` on stream-json
  (`src/driver.ts:466-468`) or ACP `thought_level` (`src/acp/driver.ts:330-332`), clamped to the
  tiers the model offers (`src/models.ts:52-82`), with `off` / `minimal` hidden
  (`src/models.ts:355-361`). There is no Anthropic `thinking.type` input.

## 5. Errors

- Errors are strings on `AssistantMessage.errorMessage`: `finalize(..., "error", msg)` sets the
  stop reason and pushes pi's terminal `error` event; `"aborted"` is a separate reason
  (`src/provider.ts:1761-1763,1955-1972`). No `Retry-After`, no `x-should-retry`.
- `TurnOutcome.status` is `"OK" | "ERROR" | "UNKNOWN"` (`src/driver-types.ts:5-20,86-108`).
  Classification is post-hoc evidence (`sawResult`, `modelOutputSeen`, `deadline`) computed in
  `#settle` (`src/driver.ts:734-775`).
- stream-json status mapping: `OK` / `SUCCESS` -> OK, anything else -> ERROR with
  `result.error ?? "agy reported an error"` (`src/driver.ts:661-685`). Transport failures: exit
  without a result frame -> the redacted stderr tail or `agy exited with status <code|signal>`
  (`src/driver.ts:519-544`); spawn failure -> `agy spawn failed: ...` (`:545-551`); frame
  overflow -> `stdout frame overflow: ...` (`:558-567`); driver start throw ->
  `agy failed to start: ...` (`src/provider.ts:1589-1597`).
- Silent-drop class: `status OK` with `modelOutputSeen === false` -> "the prompt was silently
  dropped (agy discards prompts past ~25KB with no error)... retry with a smaller prompt", and the
  conversation binding is deleted (`src/provider.ts:1648-1695`). Model or tool steps, response
  text or token evidence prevent false positives (`src/driver.ts:756-767`); ACP leaves
  `modelOutputSeen` undefined (`src/driver-types.ts:94-103`). The size limit is enforced after
  the fact by this message; no cap is applied to the outgoing prompt.
- ACP stop reasons: `cancelled` -> OK + aborted, `max_tokens` -> OK + error text, `refusal` /
  `max_turn_requests` -> ERROR, unknown -> OK (`src/acp/events.ts:202-224`). The driver forwards
  that mapping (`src/acp/driver.ts:366-375`); the provider surfaces `outcome.error` only on
  ERROR, so `max_tokens` is not a distinct pi max-token terminal reason
  (`src/provider.ts:1761-1779`).
- ACP wrapped messages: `ACP session failed: ...`, `ACP model selection failed: ...`,
  `ACP prompt failed: ...` (`src/acp/driver.ts:317,334,383`). Guard messages:
  `ACP turn exceeded the <N>m deadline` (`:709`), `ACP stalled for <N>m with no output` (`:744`),
  and on silent death `Antigravity session exited unexpectedly (code|signal ...); it restarts on the next turn`
  (`:530-531`).
- JSON-RPC errors keep `.code` / `.data` for callers (`src/acp/jsonrpc.ts:221-230`;
  `src/acp/connection.ts:582-592`); prompt and load use raw requests
  (`src/acp/connection.ts:282-285,328-331`); request timeouts read
  `ACP request timed out after <ms>ms: <method>` (`src/acp/jsonrpc.ts:190-193`).
- No quota or rate-limit category in the turn error path; quota is read separately (section 7).
- Review-only safety: both engines refuse provider turns when `readOnly` or `mode === "plan"` is
  set (`src/provider.ts:1828-1857`), instead of relying on a permission mode to make execution
  read-only. The motivating report, that `agy` writes through plan mode, is a dated author probe
  on stream-json (`src/provider.ts:1828-1836`).
- Operator surface: warn-level events (stalls, timeouts, non-zero exits, round-trip failures)
  toast in the pi UI per event class; routine events stay off disk unless `AGY_DEBUG=1`
  (`extensions/index.ts:171-191`).

## 6. Prompt handling

- History is not replayed: only the last user message is extracted as prompt text
  (`src/provider.ts:104-116`); its image blocks ride separately (`src/provider.ts:122-128`).
- The system prompt (`getCurrentSystemPrompt(context.messages)`, `src/provider.ts:22,1530`) ships
  on the first prompt of a fresh conversation only, wrapped
  `[The following is the system prompt ...]` ... `[END SYSTEM PROMPT]`, plus a long
  tool-priority note telling the model pi bridge tools win over `agy`'s native interactive ones
  (`src/provider.ts:168-203,1529-1557`).
- stream-json delivers it off the prompt line as a staged agent file
  `~/.gemini/config/agents/pi-bridge-sys-<sha256[:12]>-<pid>-.../agent.md` with
  `mainAgent: true`, `model: inherit`, `subagent: false`, `agents: []` and an explicit `tools:`
  list, passed with `--agent` (`src/sysprompt-agent.ts:1-16,41-125`). This applies only for
  stream-json + fresh conversation + system prompt enabled + no explicit agent + successful
  staging; a staging failure or a user-agent conflict keeps the text inline
  (`src/provider.ts:1521-1556`).
- Carrier details: a SHA-256 body prefix caches write-once agent directories; a pid/time/random
  suffix avoids inter-process collisions; `.pid` and `agent.md` are 0600 in a 0700 directory
  (`src/sysprompt-agent.ts:84-123`); the stable carrier is reused after the fresh-turn gate closes
  (`src/provider.ts:1552-1556`); frontmatter quotes its colon-containing description
  (`src/sysprompt-agent.ts:51-75`). A missing `tools:` list had removed write, edit and command
  tools; that the agent's presence suppresses native subagents is a separately reported probe
  (`src/sysprompt-agent.ts:12-23`; `CHANGELOG.md:10`).
- Reason for the agent file: `agy` 1.2.14 over stream-json silently dropped a turn past about
  25 KB of input (probed 2026-09-30: `status SUCCESS`, empty response, zero usage, the
  conversation then unresponsive) (`src/sysprompt-agent.ts:1-10`; `CHANGELOG.md:247-248`).
- ACP has no per-turn agent slot, so it prepends the block inline
  (`src/provider.ts:1521-1544`; `src/driver-types.ts:21-24`); `/agy agent` refuses to set an agent
  while ACP is active (`extensions/index.ts:1599-1604`).
- Stream sanitization: Antigravity injects `<SYSTEM_MESSAGE>...</SYSTEM_MESSAGE>` background-task
  notifications that models echo; a stateful sanitizer strips blocks that start with the full
  fixed preamble `The following is a <SYSTEM_MESSAGE>` (not every bare tag pair) across deltas,
  and restores incomplete blocks on flush (`src/stream-sanitizer.ts:1-24,148-165`). How often
  models echo it is the authors' report (`src/stream-sanitizer.ts:2-10`). There is no identity
  cloaking; the prompt is transformed only by the preambles, tool-priority note and digest
  framing.
- Compaction: none here; pi compacts. The package reads compaction summaries into the optional
  digest and strips pi's `<summary>` wrappers (`src/provider.ts:219-226,256-271`).
- Digest (`config.digest`, off by default): a delta of the newest compaction summary plus
  post-watermark non-antigravity assistant turns, user messages and tool results, 8000-character
  soft cap with newest-first retention and a `[truncated]` marker
  (`src/provider.ts:228-329`; `src/config.ts:148-161`). Delivered inline on stream-json; on ACP as
  a native `embeddedContext` resource block with a per-turn `urn:pi-bridge:context-digest/<n>`
  (`src/provider.ts:1511-1520,1581-1586`; `src/acp/connection.ts:314-327`). Off by default
  because a prompt that changes per turn defeats `agy`'s server-side cache (about 25-30k tokens
  re-billed, `src/config.ts:148-155`).
- Images: ACP sends native `{type: "image", data, mimeType}` blocks before the text
  (`src/acp/connection.ts:304-330`). stream-json stages base64 into `/tmp/pi-bridge-img-*` with a
  prompt note pointing at the bridge read tool, sweeps after 24 h, and degrades to a "could not be
  delivered" note rather than silence (`src/prompt-images.ts:1-92`; `src/provider.ts:1421-1436`).
  Tool-result images ride both engines (`src/provider.ts:432-446`); models advertise
  `["text", "image"]` (`extensions/index.ts:148`).
- Size caps: `agy` prompt about 25 KB on stream-json (silent drop, `src/sysprompt-agent.ts:3-10`),
  frames 32 MiB (`src/frame-guard.ts:18`), MCP bodies 1 MB (`src/mcp-server.ts:45`),
  `agy models` stdout 1 MB (`src/models.ts:35`), digest 8000 characters
  (`src/provider.ts:232-234`), turn cap 1440 minutes (`src/config.ts:217-218`), transcript probe
  512 KiB (`src/parked-turn.ts:33`). No cap on the outgoing prompt itself.

## 7. Accounts, quota, models

- No account layer: one shared `agy` identity, no credential read or write, no multi-account, no
  failover (`docs/ENGINES.md:5`); "account" does not appear in `src/`.
- Quota is read-only telemetry: `agy --print /usage --output-format json --print-timeout 30s`
  with a 30 s watchdog and 1 MB cap (`src/usage.ts:1-131`). `parseAgyUsageJson` reads
  `groups[].buckets[]` with `window` (`"weekly" | "5h"`, tolerant of new tags),
  `remaining_fraction` (clamped) and `reset_time`, accepting snake and camel aliases
  (`src/usage.ts:6-7,24-27,53-65,79-129`), plus a `quotaBar` and a clock-style reset label
  (`src/usage.ts:136-153`). Subscription quota is separate from per-turn token usage.
- Model catalog: `agy models` (two columns, slug and label), 8 s watchdog, 1 MB cap, raw cache
  with 5 min TTL and background refresh, and a hard-coded fallback list so the picker is never
  empty (`src/models.ts:27,35,188-190,200-292,397-405`). `gemini-*` and `claude-*` slugs collapse
  to a base slug plus effort tiers (a bare base is invalid upstream, so `--effort` is always sent);
  `gpt-oss-*` is hidden; unknown families keep their exact slug with no toggle
  (`src/models.ts:98-110,302-333`). Catalog and engine picker are separate modules
  (`src/bridge-catalog.ts`, `src/engine-picker.ts`).
- `contextWindow: 1_000_000` and `maxTokens: 65_536` are hard-coded guesses, not reported by
  `agy` (`src/models.ts:386-390`).
- Cost is always zero (subscription quota): `zeroUsage()` and `toPiUsage` map tokens only
  (`src/provider.ts:88-99`; `src/stream-events.ts:105-122`).
- Usage: ACP prefers the exact `PromptResponse.usage` when the server sends it (`inputTokens`,
  `outputTokens`, `totalTokens`, optional `thoughtTokens`, `cachedReadTokens`)
  (`src/acp/connection.ts:328-343,558-578`); otherwise client-side estimates, which can be
  disabled. For pi's context gauge, billing fields are kept but `total_tokens` is replaced by
  occupancy or `input + output + ceil(cacheRead / (toolBatches + 1))` to stop pi over-compacting
  (`src/acp/driver.ts:802-857`; `CHANGELOG.md` entry 1.10.4); a client-derived gauge, not exact
  context usage. Cancellation and usage tests were read, not run
  (`tests/acp-driver.test.ts:387-403,828-859`).
- Terms of service: documentation only (official binaries spawned, Google endpoints never called
  directly); the metadata's "ToS safe" is the authors' assertion. The one code-level guard is the
  fail-closed `readOnly` / plan refusal (section 5).

## 8. `agy` observations recorded by this project

Each is a dated probe on a specific build, not a protocol guarantee, and none was re-probed on
`agy 1.5.8` by this repository:

- `session/cancel` answering `-32601`: the reference prints an id-bearing request and its error
  against `agy_acp_server_20260818_01_RC01`, Linux x86_64, 2026-09-03, with the in-flight prompt
  continuing (`docs/ACP-PROTOCOL-REFERENCE.md:5-7,269-283`). Line 3 of the same reference retires
  that guidance, and current code sends a notification (`src/acp/connection.ts:346-349`). The
  printed request does not establish how RC01 treats a notification.
- No usage fields in ACP: reported for RC01 with "re-check on future builds"
  (`docs/ACP-PROTOCOL-REFERENCE.md:260-267,416-418`); exact usage is reported from `agy 1.5.3`
  (`docs/ENGINES.md:7`).
- ACP error shapes: `-32602` carries `data.errors[].loc` naming the field (`methodId`, not
  `method`; `configId`, not `configOptionId`); `-32000` carries server-state messages
  (`Authentication required`, `Onboarding failed`); `-32601` marks an unimplemented method
  (`docs/ACP-PROTOCOL-REFERENCE.md:284-300`).
- Sparse thought chunks on flash-low models, RC01 (`docs/ACP-PROTOCOL-REFERENCE.md:428-434`).
- MCP `tools/call` abandoned by `agy` at about 180 s, observed twice at exactly 180.000 s on
  2026-09-05 (`docs/ACP-PROTOCOL-REFERENCE.md:355`).
- The ~25 KB silent prompt drop: `agy 1.2.14`, stream-json, 2026-09-30 (section 6). Whether ACP,
  or either transport on 1.5.8, has a size limit is unverified.

## 9. Packaging and platforms

- MIT, ESM pi extension shipped as source via `extensions/` and `src/`; the npm allowlist
  excludes `docs/`, tests and probe scripts. Runtime dependencies: ask-shared `^0.1.6`,
  tui-dialogs `^0.1.3`, MCP SDK `^1.31.0` (`package.json:21,35-60`).
- An optional, confirmed installer offer uses PowerShell on Windows and bash/curl elsewhere, then
  asks for a manual CLI sign-in (`src/agy-install.ts:9-23`; `src/agy-setup.ts:33-57`).
- PATH discovery targets `.exe` on Windows and accepts explicit separator-containing paths
  (`src/engine-picker.ts:88-132`); home staging uses directory junction links
  (`src/acp/home.ts:12-14,70-89`). These are implementation branches, not proof of platform
  parity.

## 10. Reported or unverified

- Every `agy`-side observation in section 8, and that `--gemini_dir` isolation is honored; they
  rest on dated probe notes and `scripts/probe-*.mjs`, which need a live authenticated `agy`.
- That `agy` does not enforce plan-mode writes (`src/provider.ts:1828-1836`).
- Per-version presence of thought text and `usage_update` (`src/acp/events.ts:56-63`).
- Whether the ACP engine reaches the same tool set as stream-json for every tool: the code
  documents only the `--agent` gap (`src/driver-types.ts:22-24`), `docs/ENGINES.md:22-38` lists
  more differences, and no cross-build parity check exists.
- Whether the `<SYSTEM_MESSAGE>` preamble is stable across Antigravity builds; the sanitizer
  matches fixed constants (`src/stream-sanitizer.ts:15-19`).
