# EstebanForge `pi-antigravity-bridge` — independent extraction pass (ds)

Source: `git clone --depth=1 https://github.com/EstebanForge/pi-extensions` @ `d3ca5cc66947a3299e2ef18b8986c7dc86e9373b` (2026-11-13), package `@estebanforge/pi-antigravity-bridge` v1.10.6 (`package.json:1-3`). All citations are relative to `packages/pi-antigravity-bridge/`.
Inspected: `src/*.ts`, `src/acp/*.ts`, `extensions/index.ts`, `docs/{ARCHITECTURE,ENGINES,PI-BRIDGE-GAPS,ACP-PROTOCOL-REFERENCE}.md`, `README.md`, `CHANGELOG.md`. Nothing was executed; `agy` was not run; no other `docs/research/` file was read.

## 1. Host and upstream

- Host is **pi** (`@earendil-works/pi-coding-agent`), peer floor `^1.5.1` (`package.json:47-50`); one extension entry (`package.json:43-46` → `extensions/`).
- It registers provider id `antigravity` with a private api sentinel `agy-bridge`, `apiKey: "not-used"`, `baseUrl: "agy-bridge://antigravity"`, and `streamSimple` as the whole transport (`extensions/index.ts:610-627`; `src/models.ts:366-391`; `src/provider.ts:1786-1884`).
- Two engines behind one interface, `TurnDriver` (`src/driver-types.ts:155-168`): **acp** default, **stream-json** fallback, chosen by `config.engine` / `AGY_ENGINE` (`src/config.ts:43-48`, `:284-286`; `docs/ENGINES.md:5-8`). The switch needs a pi restart; the engine is latched at load (`extensions/index.ts:143`).
- **acp** spawns `agy acp` (`extensions/index.ts:317-319` `binArgs: ["acp"]`) speaking JSON-RPC 2.0, newline-delimited, over stdio (`src/acp/jsonrpc.ts:1-17`).
- Its handshake sends `{protocolVersion:1, clientCapabilities:{fs:{readTextFile:false,writeTextFile:false}, terminal:false}}`, reads `agentInfo.version`, and refuses server-initiated `fs/*`/`terminal/*` requests (`src/acp/connection.ts:243-259`, `:359-367`).
- **stream-json** spawns `agy --add-dir <cwd> [--gemini_dir <home>] [--add-dir <bridgeDir>] --model … [--effort …] --mode … [--agent …] [--dangerously-skip-permissions] [--conversation <id>] --input-format stream-json --output-format stream-json --disable-slash-commands` (`src/driver.ts:460-491`).
- Its stdout grammar is NDJSON `init` / `step_update` / `result`, unknown kinds degrade to `{kind:"unknown"}` (`src/stream-events.ts:1-99`).
- The private-home flag is spelled differently per engine: `--gemini_dir` on the stream-json run path, `--gemini-dir` on the `acp` subcommand, both "live-verified 2026-11-13 on agy 1.5.8" (`src/agy-version.ts:177-182`; `src/acp/connection.ts:168-172`).
- **Authentication is fully delegated**: this code never reads, stores, or transmits a credential; both engines use the cached Google credentials of the same `agy` install (`docs/ENGINES.md:5`, `:16`).
- Only ACP surfaces auth failures: JSON-RPC `-32000` → `AcpAuthError` telling the user to run `agy` and sign in (`src/acp/connection.ts:580-587`).
- **Versions targeted**: stream-json floor `1.1.22` (`src/agy-version.ts:20`), ACP floor `1.5.3` (`:21`), `--gemini_dir` verified through `1.5.8` (`:22-28`); dev/HEAD builds are never gated (`:67-79`).
- Live-observation claims carry their version: "verified live on agy 1.5.3" (`docs/ENGINES.md:7`), "agy 1.5.8" (`CHANGELOG.md:5-9`), and older notes naming 1.1.13+/1.1.18/1.2.10/1.2.12/1.5.4 inline (`src/stream-events.ts:35`, `src/usage.ts:1-10`, `src/acp/events.ts:56-63`, `CHANGELOG.md` 1.10.4).

## 2. Transport and processes

- **One persistent child per engine instance**, not per turn: stream-json keeps `agy` alive (`src/driver.ts:1-15`), ACP keeps one `agy acp` (`src/acp/driver.ts:534-584`). Turns are serialized through a promise-chain queue on both (`src/driver.ts:295-314`; `src/acp/driver.ts:217-233`).
- Extra processes per turn: normally zero. stream-json recycles (kill + respawn) on profile drift in cwd/model/effort/mode/permissions/agent/conversation (`src/driver.ts:825-838`).
- ACP does **not** recycle on drift; it re-applies `model`, `thought_level`, `mode` per turn through `session/set_config_option` (`src/acp/driver.ts:5-12`, `:330-341`).
- A one-shot `agy -p` exists only behind the `AskAntigravity` delegation tool, never on the turn path (`src/ask-tool.ts:6`, `:177-193`).
- **State carried** across pi turns is `~/.pi/agent/antigravity-bridge/sessions.json`, keyed `sid:<piSessionId>[@acp]` or `cwd:<cwd>[@acp]`, holding `{conversationId, lastStepIdx, lastMessageCount}` (`src/provider.ts:346-359`; `src/sessions.ts:15-32`), written atomically with per-key merge so two pi processes do not clobber each other (`src/sessions.ts:60-66`).
- Resume: stream-json `--conversation <id>` (`src/driver.ts:472`); ACP `session/load`, falling back to `session/new` when the server no longer knows the id (`src/acp/driver.ts:278-324`). ACP history replay is suppressed (`src/acp/connection.ts:157-162`, `:276-291`).
- **Timeouts.** Overall per-turn cap: drivers default 10 min (`src/driver.ts:408`; `src/acp/driver.ts:665-667`), config default is TTY-aware (`0` interactive, `20` headless) (`src/config.ts:199-215`, `:224-226`), accepted range 1–1440 min (`:217-237`).
- Inactivity/stall cap: 5 min default, `0` disables (`src/driver.ts:410-415`; `src/acp/driver.ts:669-671`, `:733-745`).
- ACP request budgets: initialize 30 s, session ops 20 s, `session/prompt` deliberately untimed because the turn timers govern (`src/acp/connection.ts:75-81`, `:302-304`); permission dialogs park 480 s (`:78-81`).
- **Stall detection is silence-based**: the idle timer refreshes on every stdout chunk / every `session/update` (`src/driver.ts:574`; `src/acp/driver.ts:417`).
- Every park (bridge call, escalated call, approval dialog) clears both timers; for the overall cap it stores the *remaining* budget and resumes it on unpark, never a fresh window (`src/driver.ts:150-167`, `:257-277`; `src/acp/driver.ts:166-215`, `:713-746`).
- On stall/timeout, stream-json kills the child **first**, then probes the conversation transcript tail for a clean final model step written during the turn and settles OK with that withheld answer if found (`src/driver.ts:785-810`; `src/parked-turn.ts:1-26`).
- **Retry policy: none.** No backoff and no internal re-attempt; failures are handed to pi. What exists is recovery plumbing (next three lines).
- Synthetic resume prompt when pi drops a failed attempt from the projected context (`src/provider.ts:150-151`, `:1490-1498`).
- Late results are re-delivered as a new prompt in the same conversation (`src/provider.ts:1371-1398`, `:1086-1098`), with a registry-wide sweep for escalated-but-unpolled results (`:1400-1420`).
- Conversation binding is cleared when the turn signature proves the conversation dead (`src/provider.ts:1660-1695`).
- Hardening shared by both engines: 32 MiB per-frame ceiling (`src/frame-guard.ts:18`) whose breach fails the turn and SIGKILLs the process group (`src/driver.ts:558-569`; `src/acp/connection.ts:202-219`), plus filtering/repair of one known foreign stdout line (`src/frame-guard.ts:20-38`).

## 3. Tool channel

- Model tool calls reach the host **only** through an MCP bridge: loopback Streamable-HTTP MCP on `127.0.0.1` (`src/mcp-server.ts:579`), per-process UUID shared secret in `x-bridge-token` compared in constant time, 1 MB body cap (`:44-45`, `:376-390`).
- pi's tool schemas are never put on the agy wire: they are served as MCP `tools/list` from pi's live active set on every request (`src/mcp-server.ts:296-300`; `src/bridge-catalog.ts:13-28`) and re-checked at `tools/call`, so a cached catalog is not authorization.
- **stream-json registration**: `.agents/mcp_config.json` in `~/.pi/agent/antigravity-bridge/agy-mcp-<pid>/`, passed as an extra `--add-dir` (`src/driver.ts:462-466`; `src/mcp-server.ts:191-199`); with a staged private home it routes through `--gemini_dir <home>` instead (`extensions/index.ts:248-262`); the legacy fallback registers a per-pid entry in the global `~/.gemini/config/mcp_config.json` plus a suppression marker (`extensions/index.ts:969-975`; `src/mcp-registration.ts`).
- **ACP registration**: `mcpServers: [{name:"pi-bridge", type:"http", url:"http://127.0.0.1:<port>/mcp", headers:[{name:x-bridge-token, value}]}]` on both `session/new` and `session/load` (`extensions/index.ts:342-355`; `src/acp/connection.ts:261-291`).
- **Round-trip mechanics** (identical on both engines): `tools/call` → `onToolCall` parks instead of executing (`src/provider.ts:909-955`).
- The park is injected as a `bridge_call` activity; the provider emits a complete `toolCall` block for the *real* pi tool and ends the pi assistant message with `stopReason: "toolUse"` (`src/provider.ts:1143-1161`, `:1321-1327`).
- pi executes the tool in its own loop; the `toolResult` arrives in the next `streamSimple` context and `resolve()` completes the parked HTTP response with text and/or image blocks (`src/provider.ts:1354-1369`, `:968-1029`).
- Long calls dodge agy's ~180 s MCP `tools/call` abandonment (observed twice at exactly 180.000 s on 2026-09-05, `docs/ACP-PROTOCOL-REFERENCE.md:355`): after 20 s the request settles with `STILL RUNNING` + `callId`, and the model must poll `bridge_poll_result` (`src/provider.ts:460-493`, `:612-659`).
- Delegation-shaped names (`/subagent|delegate|^agent(_|$)/i`) hold 120 s synchronously first (`src/provider.ts:466-485`); park TTL 480 s, escalated TTL 30 min, 64-entry bounded registry (`:428`, `:488`, `:514-528`).
- agy's **own** native tools never execute in the host: on ACP they are display-only cards carrying the server-supplied diff or a git diff of the file on disk (`src/provider.ts:1222-1260`).
- On stream-json, read-only steps re-run as real pi builtins and everything else replays recorded output through a display-only `antigravity` tool (`src/provider.ts:1279-1310`; `src/native-tools.ts`; `extensions/index.ts:663-676`).

## 4. Thinking / reasoning surface

- **stream-json: token count only, no text.** `{type:"thought", tokens}` is emitted only when `thinking_tokens >= 64`; `thought_text` is declared and never read (`src/driver.ts:52`, `:626-628`; `src/stream-events.ts:37-38`).
- **acp: actual thought text.** `agent_thought_chunk` → `{kind:"thought", delta}` → pi `thinking_start/delta/end` (`src/acp/events.ts:52-53`; `src/acp/driver.ts:432-440`; `src/provider.ts:1186-1192`, `:1920-1942`).
- Both engines converge on pi's `thinking` content block; nothing else about reasoning is told to the host.
- **No signature exists.** `thinking_signature` is declared on the stream-json step type (`src/stream-events.ts:39`) and referenced nowhere else in `src/` — nothing is emitted, validated, stored, or replayed.
- Interleaving is handled by close-on-switch: at most one block open, text/thinking mutually closing (`src/provider.ts:1910-1942`).
- Thinking *level* is request-side only: pi reasoning level → agy `--effort` (stream-json, `src/driver.ts:468`) or ACP `thought_level` (`src/acp/driver.ts:332`), clamped to tiers the model offers (`src/models.ts:52-82`), with `off`/`minimal` hidden (`:355-361`).

## 5. Errors

- Errors are **strings on `AssistantMessage.errorMessage`**, not codes: `finalize(..., "error", msg)` sets stop reason and pushes pi's terminal `error` event; `"aborted"` is a separate reason (`src/provider.ts:1956-1972`, `:1761-1763`).
- stream-json status mapping: `OK`/`SUCCESS` → OK, anything else → ERROR with `result.error ?? "agy reported an error"` (`src/driver.ts:661-685`).
- stream-json transport failures: exit without a result frame → the **redacted** stderr tail or `agy exited with status <code|signal>` (`src/driver.ts:519-544`); spawn failure → `agy spawn failed: …` (`:545-551`); overflow → `stdout frame overflow: …` (`:558-567`); driver start throw → `agy failed to start: …` (`src/provider.ts:1589-1597`).
- The over-cap signature is a first-class class: `status OK + modelOutputSeen === false` → "the prompt was silently dropped (agy discards prompts past ~25KB with no error)… retry with a smaller prompt" **and** the conversation binding is deleted (`src/provider.ts:1648-1695`).
- ACP `stopReason` mapping: `cancelled` → OK+aborted, `max_tokens` → OK + error text, `refusal` / `max_turn_requests` → ERROR, unknown → OK (`src/acp/events.ts:205-224`).
- ACP wrapped messages: `ACP session failed: …`, `ACP model selection failed: …`, `ACP prompt failed: …` (`src/acp/driver.ts:317`, `:334`, `:383`).
- ACP guard messages: `ACP turn exceeded the <N>m deadline` (`src/acp/driver.ts:709`), `ACP stalled for <N>m with no output` (`:744`), silent death → `Antigravity session exited unexpectedly (code|signal …); it restarts on the next turn` (`:530-531`).
- JSON-RPC classification: `-32000` → `AcpAuthError` with sign-in remediation (`src/acp/connection.ts:583-587`); other `JsonRpcResponseError`s keep `.code`/`.data` for callers (`:582-592`); request timeouts → `ACP request timed out after <ms>ms: <method>` (`src/acp/jsonrpc.ts:190-193`).
- **No retry hints** anywhere: no `retryable`, no backoff, no structured error type crosses to the host — only prose. Classification is post-hoc evidence (`sawResult`, `modelOutputSeen`, `deadline`) computed in `#settle` (`src/driver.ts:734-775`; `src/driver-types.ts:86-108`).
- Operator surface: warn-level events toast in the pi UI per event class (stalls, timeouts, non-zero exits, round-trip failures); routine events stay off disk unless `AGY_DEBUG=1` (`extensions/index.ts:171-191`).

## 6. Prompt handling

- **History is not replayed**: only the last user message is extracted as prompt text (`src/provider.ts:104-116`); that message's image blocks ride separately (`:122-128`).
- **System prompt staging** (`getCurrentSystemPrompt(context.messages)`, `src/provider.ts:22`, `:1530`) ships on the first prompt of a fresh conversation only, wrapped `[The following is the system prompt …]` … `[END SYSTEM PROMPT]` plus a long tool-priority note telling the model pi bridge tools win over agy's native interactive ones (`src/provider.ts:168-203`, `:1529-1557`).
- stream-json delivers it **off the prompt line** as a staged agy agent file `~/.gemini/config/agents/pi-bridge-sys-<sha256[:12]>-<pid>-…/agent.md` with `mainAgent: true`, `model: inherit`, `subagent: false`, `agents: []` and an explicit `tools:` list, passed via `--agent` (`src/sysprompt-agent.ts:41-125`).
- Rationale for the agent file is agy's silent ~25 KB prompt drop and its poisoning of the conversation (`src/sysprompt-agent.ts:3-10`).
- ACP has no agent slot, so it prepends the block inline (`src/provider.ts:1533-1537`; `src/driver-types.ts:21-24`).
- **Compaction**: none implemented here — pi compacts; this package only reads compaction summaries into the optional digest and strips pi's `<summary>` wrappers (`src/provider.ts:219-226`, `:256-271`).
- **Digest** (`config.digest`, off by default): a delta of the newest compaction summary plus post-watermark non-antigravity assistant turns, user messages, and tool results, 8000-char soft cap with newest-first retention and a `[truncated]` marker (`src/provider.ts:228-329`; `src/config.ts:148-161`).
- Digest delivery: inline on stream-json; on ACP a native `embeddedContext` resource block with a per-turn `urn:pi-bridge:context-digest/<n>` (`src/provider.ts:1511-1520`, `:1581-1586`; `src/acp/connection.ts:314-327`). Off by default because a per-turn-changing prompt defeats agy's server-side cache (~25–30k tokens re-billed, `src/config.ts:148-155`).
- **Images**: ACP sends native `{type:"image", data, mimeType}` blocks before the text (`src/acp/connection.ts:314-316`); stream-json stages base64 into `/tmp/pi-bridge-img-*` with a prompt note pointing at the bridge read tool, 24 h sweep, and degrades to a "could not be delivered" note rather than silence (`src/prompt-images.ts:1-92`; `src/provider.ts:1421-1436`).
- Tool-result images ride both engines (`src/provider.ts:432-446`); models advertise `["text","image"]` (`extensions/index.ts:148`).
- **Size caps**: agy prompt ~25 KB (silent drop, `src/sysprompt-agent.ts:3-10`), bridge frames 32 MiB (`src/frame-guard.ts:18`), MCP bodies 1 MB (`src/mcp-server.ts:45`), `agy models` stdout 1 MB (`src/models.ts:35`), digest 8000 chars (`src/provider.ts:232-234`), turn cap 1440 min (`src/config.ts:217-218`), transcript probe 512 KiB (`src/parked-turn.ts:33`). No cap is applied to the outgoing prompt itself.

## 7. Accounts, quota, models

- **No account layer**: one shared `agy` identity, no credential read/write, no multi-account, no failover (`docs/ENGINES.md:5`). "account" is absent from `src/`.
- **Quota is read-only telemetry**: `agy --print /usage --output-format json --print-timeout 30s` with a 30 s watchdog and 1 MB cap, parsed into groups → buckets with `window: weekly|5h`, `remaining_fraction`, `reset_time` (`src/usage.ts:1-131`).
- **Model catalog**: `agy models` (two columns, slug + label), 8 s watchdog, 1 MB cap, raw cache with 5 min TTL and background refresh, hardcoded fallback list so the picker is never empty (`src/models.ts:27`, `:188-190`, `:200-292`, `:397-405`).
- `gemini-*` and `claude-*` slugs collapse to base slug + effort tiers (a bare base is invalid upstream, so `--effort` is always sent); `gpt-oss-*` is hidden; unknown families keep their exact slug with no toggle (`src/models.ts:98-110`, `:302-333`).
- `contextWindow: 1_000_000` and `maxTokens: 65_536` are hardcoded guesses, not reported by `agy` (`src/models.ts:386-390`).
- **Cost is always zero** (subscription quota): `zeroUsage()` and `toPiUsage` map tokens only (`src/provider.ts:88-99`; `src/stream-events.ts:105-122`).
- ACP prefers exact `PromptResponse.usage` when the server sends it (`src/acp/connection.ts:336-343`, `:560-578`); otherwise client-side estimates, with `total_tokens` rewritten to context occupancy `input+output+ceil(cacheRead/(toolBatches+1))` to stop pi over-compacting (`src/acp/driver.ts:802-857`; `CHANGELOG.md` 1.10.4).
- ToS risk is documentation only (official binaries spawned, Google endpoints never called directly); the one code-level guard is a fail-closed `readOnly`/plan refusal (`src/provider.ts:1836-1857`).

## 8. Five takeaways

- **Copy**: the park/round-trip contract — upstream `tools/call` parks, the host emits a real toolCall with `stopReason: "toolUse"`, and the toolResult completes the parked response on the next stream call, so host permissions/hooks/renderers engage with no privileged API (`src/provider.ts:909-1029`).
- **Copy**: remaining-budget park accounting (`src/driver.ts:150-167`; `src/acp/driver.ts:713-731`) and the 20 s → poll-handle escape from agy's ~180 s MCP wall (`src/provider.ts:460-493`) — a design we currently only partially mirror.
- **Avoid**: no reasoning signature at all (thinking text on ACP, a bare token count on stream-json, `src/stream-events.ts:39` dead) — fine for a self-contained provider, fatal for any Anthropic-shaped thinking replay; and prompt size is enforced post-mortem via an error message rather than a pre-send check (`src/provider.ts:1683-1693`).
- **Avoid**: the workaround sprawl forced by one shared `~/.gemini` identity — suppression markers, per-pid global registrations, staged MCP homes, hook staging, display-replay store (`src/mcp-registration.ts`, `src/acp/home.ts`, `src/approval-hook.ts`, `src/provider.ts:688-706`). Well documented, but a large surface to inherit; our per-account isolation removes the need.
- **Unverifiable from the code alone**: every agy-side observation — the ~25 KB prompt drop and its poisoning (`src/sysprompt-agent.ts:3-10`), the ~180 s MCP abandonment (`docs/ACP-PROTOCOL-REFERENCE.md:355`), ACP not enforcing plan-mode writes (`src/provider.ts:1828-1836`), per-version presence of thought text / `usage_update` (`src/acp/events.ts:56-63`), and `--gemini_dir` isolation actually being honored. They rest on dated probe notes and `scripts/probe-*.mjs`, which need a live authenticated `agy` and quota; no recorded fixture lets me re-derive them, so re-probe against our own `agy` build before relying on any of them.
