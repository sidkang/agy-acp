# `pi-agy-acp` (fdkevin0/pi-agy-acp)

- Checkout: `https://github.com/fdkevin0/pi-agy-acp`, shallow clone, commit
  `19f4c26b09d78266f94fbd85740a6edc5ca3df00`, package `pi-agy-acp@0.1.3` (`package.json:2-4`).
  Read 2026-11-14.
- Citations are relative to the repository root. Size: 5,893 lines of TypeScript, `index.ts`
  (267) plus `src/*.ts` (5,626), excluding tests; `src/runtime.ts` 1,541, `src/conversation.ts`
  744, `src/history.ts` 357, `src/catalog.ts` 265, `src/quota.ts` 188.
- Read-only: nothing executed, no tests run, no token files accessed. Upstream observations are
  the project's own (section 9). Comparison with this plugin: [`comparison.md`](comparison.md).

## 1. Host and upstream

- A pi Coding Agent extension, "Google Antigravity ACP provider extension for Pi Coding Agent"
  (`package.json:6`): `pi.extensions -> ./index.ts` (`package.json:15-19`), peer dependencies
  `@earendil-works/pi-ai|pi-coding-agent|pi-tui` at `*` (`package.json:32-36`), dev-pinned
  `~1.5.0` (`package.json:41-47`). Targets pi 1.5.x and Node >= 22.19.0
  (`package.json:29-30`, `docs/reference.md:165-168`); README targets pi 1.5.x and
  `agy` >= 1.4.12 (`README.md:11-16`).
- Registers provider `antigravity-acp` with `api: 'antigravity-acp'`, a fake
  `baseUrl: 'acp://local'`, placeholder `apiKey: 'local-agy'`, and `streamSimple` as the only
  model entry point (`index.ts:27-45,75-98`). No HTTP endpoint is exposed to the host.
- Drives the official `agy` binary in ACP mode:
  `agy acp --gemini-dir <home> --app-data-dir agy --agent pi-bridge --process-per-session --disable-telemetry --log-file <home>/acp.log`
  (`src/runtime.ts:648-681`). Credentials are the CLI's own (`src/preflight.ts:1-9`); a
  network/import search of `src` and `index.ts` finds only the loopback MCP server, no Google API
  transport.
- Binary resolution: `PI_AGY_COMMAND` (must be absolute), else `~/.local/bin/agy`, else a `PATH`
  scan (`src/preflight.ts:85-125`); on Windows `agy.exe`, `LOCALAPPDATA` and semicolon `PATH`
  (`src/preflight.ts:64-118`). Minimum `agy` 1.4.12, enforced by a semver preflight that accepts
  non-semver or unknown version output (`src/preflight.ts:29-30,128-154`).
- Protocol: ACP v1 as newline-delimited JSON-RPC 2.0 on the child's stdio; `initialize` sends
  `protocolVersion: 1`, empty `clientCapabilities`, and
  `clientInfo {name: 'pi-agy-acp', version: <package version>}`
  (`src/acp-process.ts:178-201`; `src/jsonrpc.ts:1-7,104-156,186-192`; `src/host.ts:5-9`).
- Authentication stays with `agy`. The extension copies the newest non-empty
  `~/.gemini/antigravity-cli|antigravity/antigravity-oauth-token` into the isolated home's
  `agy/antigravity-oauth-token` unless the destination is at least as new, best-effort chmod 0600
  (`src/preflight.ts:175-213`), and re-syncs it on every session open (`src/runtime.ts:754`);
  refresh stays `agy`'s responsibility (`docs/reference.md:124-126`). The isolation is of
  configuration, not of credentials.
- Isolated home: startup lays out an Antigravity home so the user's global rules, skills and MCP
  servers stay out of pi sessions, and installs a `pi-bridge` agent that "removes every built-in
  tool so the agent acts only through Pi tools" (`src/preflight.ts:1-9`). The agent declares
  `tools: []`, `excludeDefaultComponents: true`, `mainAgent: true`, with an empty workspace
  (`src/preflight.ts:262-314`); the home's `settings.json` sets
  `toolPermission: 'request-review'`, `agentMode: ''`. Startup deletes earlier conversation DBs,
  brain artifacts and rotated `acp.log.N` (`src/preflight.ts:216-255,261-315`). Cleanup assumes
  exclusive use, so concurrent pi instances need distinct `PI_AGY_HOME`; shared homes are
  unsupported (`src/preflight.ts:285-288`; `docs/reference.md:113-122`).
- Provenance: an adaptation of `dsh-llm-antigravity-acp` at snapshot `f049913`, MIT, keeping its
  ACP runtime, JSON-RPC transport, MCP bridge, history projection, catalog, preflight and quota
  reader (`NOTICE:1-10`).

## 2. Transport and processes

- One long-lived front `agy acp` child per runtime, spawned lazily on the first request or catalog
  probe (`src/runtime.ts:313-327,648-685`); `--process-per-session` makes `agy` fork per-session
  workers behind that front (`src/acp-process.ts:1-8,178-181`). Pi-side process count per turn is
  one, plus at most one short-lived quota process.
- Ownership: `src/runtime.ts` owns lifecycle, quota, tier discovery and status
  (`src/runtime.ts:134-159,180-185,193-214,237-306,392-416`); turns and history projection live
  in `src/conversation.ts` (`:141-178,451-632`) and `src/history.ts` (`:132-169,226-255`).
- One ACP session per pi `sessionId`, at most `maxLiveSessions: 16`. When full it evicts the
  oldest idle conversation, otherwise fails fast with `RATE_LIMIT` / `CAPACITY_EXCEEDED` rather
  than queueing, because a waiting subagent and its parent share one provider route and would
  deadlock (`src/config.ts:56`; `src/runtime.ts:456-458,570-619`). Per-conversation keyed locks
  let different sessions run concurrently.
- Idle sessions close after 30 minutes via a 60 s sweeper; `anon-*` conversations close after
  every step; a failed open releases its capacity slot
  (`src/config.ts:57`; `src/runtime.ts:315-317,1362-1378,1477-1490`).
- Extra processes: `agy --version` (30 s) at preflight (`src/preflight.ts:323-336`) and
  `agy -p /usage --output-format json` (45 s) per quota read (`src/quota.ts:156-166`).
- Session reuse: the ACP session owns conversation history. Reuse requires an unchanged
  system-prompt digest and the previous message-id list as an exact prefix; otherwise the session
  is closed and pi's history is replayed into a new one (`src/runtime.ts:1015-1079`,
  `src/history.ts:1-9`). Resuming a parked turn also requires unchanged model and effort
  (`src/runtime.ts:483-515`); model and effort are tracked per conversation
  (`src/runtime.ts:153-157,972-996`). Pi-side compaction and tree events close conversation
  sessions but keep the process (`index.ts:127-132`; `src/runtime.ts:371-389`); a rewritten
  prefix forces a rebuild (`src/runtime.ts:486-497,1041-1051`).
- No cross-process ACP session restore: startup deletes isolated conversation, brain and summary
  artifacts, and closing a session removes its DB/WAL/SHM and brain files with path and symlink
  guards (`src/preflight.ts:217-255,285-303`; `src/runtime.ts:1091-1099`).
- Timeouts: `initialize` 120 s (`src/runtime.ts:681`), `session/new` 120 s
  (`src/runtime.ts:814`), `session/set_config_option` 60 s (`src/acp-process.ts:250`),
  `session/close` 15 s (`src/acp-process.ts:288`), SIGTERM -> SIGKILL escalation 5 s
  (`src/host.ts:28-36`), abort-drain wait 5 s (`src/runtime.ts:1233-1245`), MCP
  `headersTimeout` 10 s / `requestTimeout` 30 s (`src/mcp-bridge.ts:127-131`), SSE keepalive 15 s
  (`src/config.ts:59`), parallel-call grouping window 250 ms (`src/config.ts:58`).
- `session/prompt` carries no timeout (`src/acp-process.ts:261-269`) and there is no turn
  watchdog: a silent stall ends only by user abort or process death. Stall cover is indirect
  (keepalives and progress on parked tool calls, `src/mcp-bridge.ts:367-392`, and `agy`'s own
  notices).
- No retry, backoff, re-request or respawn loop. On child exit the runtime records
  `state: 'error'` and fails in-flight turns with `TRANSPORT` (`src/runtime.ts:727-745`); the next
  request restarts from scratch. Recovery is pi-side: up to 3 automatic continuations on
  `max_tokens` (`src/config.ts:61`; `src/conversation.ts:544-557`; `src/runtime.ts:1188-1193`),
  and dropping `agy`'s retry notices while counting them (section 5).
- Only `session/update` notifications are routed, keyed by session id; consumed sub-kinds are
  `agent_message_chunk`, `agent_thought_chunk`, `tool_call` / `tool_call_update` and
  `config_option_update` (`src/acp-process.ts:317-322`; `src/conversation.ts:251-263,701-710`;
  `src/runtime.ts:790-809`).
- Wire robustness: malformed frames are dropped without killing the link
  (`src/jsonrpc.ts:205-220`); unknown `session/update` kinds are ignored; disposal is idempotent
  with owner and epoch guards on every async callback (`src/runtime.ts:392-436`).
- Process death surfaces as `agy acp exited (code=... signal=...): <last 5 stderr lines>`, with a
  64 KiB stderr tail (`src/acp-process.ts:181-190`; `src/host.ts:10-13`).

## 3. Tool channel

- A loopback Streamable-HTTP MCP server, one runtime-owned listener on an ephemeral
  `127.0.0.1` port (`src/mcp-bridge.ts:119-161`), path `/mcp/<tenantKey>`, MCP protocol string
  `2025-06-18`. The tenant-less root returns 401; non-POST returns 405 with
  `allow: POST, DELETE` (`src/mcp-bridge.ts:93,96-166,220-241`). Body cap 1 MiB, including
  chunked uploads (`src/mcp-bridge.ts:91,450-462`). The request handler performs no Host or
  Origin validation (`src/mcp-bridge.ts:204-278`).
- Registration per `session/new`:
  `mcpServers[0] = {type: 'http', name: 'pi', url, headers: [{Authorization: 'Bearer <secret>'}]}`
  (`src/runtime.ts:765-775`). Each session open mints a 16-byte random hex tenant key and an
  independent 24-byte random hex secret; the secret is compared with `timingSafeEqual` after a
  length guard (`src/runtime.ts:763-764,844-859`), and a missing tenant or wrong token gets 401
  before any JSON parsing (`src/mcp-bridge.ts:220-243`).
- Routing trusts the registered tenant identity; optional ACP conversation metadata must match
  the tenant's session (`src/runtime.ts:1387-1406`).
- Lifetime: a tenant lives as long as its ACP session. `openSession` registers it;
  `releaseTenant` (called from `clearSession`) deletes it and forgets its MCP handshake evidence
  (`src/runtime.ts:861-866,1113-1123`; `src/mcp-bridge.ts:188-195`); a new open mints new
  credentials. The HTTP listener lives for the runtime and closes in `dispose`
  (`src/runtime.ts:371-416`). An authenticated DELETE returns 200 without revoking the tenant or
  closing the listener (`src/mcp-bridge.ts:235-237`). A runtime reset closes sessions but keeps
  the front and listener; process exit clears affected sessions and tenants without closing the
  listener (`src/runtime.ts:727-744`). Bridge close destroys open SSE responses, clears handshake
  records and closes all connections (`src/mcp-bridge.ts:168-180`).
- Inventory comes from pi's live step state, `getCurrentTools(context.messages)`, so the
  advertised set can change between steps; changes are reconciled each request
  (`src/pi-stream.ts:132-136`; `src/mcp-bridge.ts:484-523`).
- `tools/list` returns the session's tools plus `pi_call_tool` and `pi_await_result`
  (`src/runtime.ts:1380-1385`). Agent-visible names are `mcp_pi_<name>` (`AGENT_TOOL_PREFIX`,
  `CALL_TOOL_NAME`, `src/history.ts:17-22,146-150`). The adapter mints its own call ids
  `agy_<turnTag>_<n>` rather than trusting agent ids (`src/conversation.ts:174-195`).
  `tools/call` passes a permission gate, then parks (`src/runtime.ts:868-950,1387-1439`).
- JSON-RPC message rules: `tools/call` must be the only id-bearing request in a message; a
  singleton array or notification siblings pass (`src/mcp-bridge.ts:256-277,320`). Several
  requests send `tools/call` to `-32600`; genuinely unknown methods get `-32601`
  (`src/mcp-bridge.ts:316-329`); `initialize`, `ping` and list methods succeed, notifications
  get 202 (`src/mcp-bridge.ts:264-267,289-315`); `resources` and `prompts` list empty
  (`src/mcp-bridge.ts:310-315`).
- Reaching the host: a parked call is emitted as `block-start` / `tool-call-delta` / `block-end`
  plus `finish(tool-calls)` for that pi step (`src/conversation.ts:502-543`). Pi runs the tool
  through its own permission and execution pipeline and returns results on the next request,
  which resolves the deferred and resumes the same ACP turn; if the agent ended its prompt
  meanwhile, a continuation prompt carries the results as transcript text
  (`src/runtime.ts:1250-1309`). Results are normalized to text and image items, `(no output)`
  when empty (`src/runtime.ts:1316-1338`). Tool-router exceptions become MCP `isError: true`
  content (`src/mcp-bridge.ts:394-419`).
- Response shape: a server-sent-event stream. The source states: "Calls answer with a
  server-sent-event stream so response headers leave immediately; the agent's HTTP client
  otherwise abandons a request after 60 seconds without headers. Comment frames and MCP progress
  notifications keep long Pi tool runs (approvals, subagents, builds) visibly alive."
  (`src/mcp-bridge.ts:1-9`). Headers flush before execution is awaited; every 15 s by default a
  `: keepalive` comment is written (`src/config.ts:59`; `src/mcp-bridge.ts:85,371`), plus
  `notifications/progress` when the request carries a string or number `_meta.progressToken`.
  The progress counter counts timer ticks, not work (`src/mcp-bridge.ts:343-392`). The result is
  one SSE `event: message` / `data: {jsonrpc, id, result}`, then EOF
  (`src/mcp-bridge.ts:344-355,417-426,473-475`). Writes do not wait for backpressure or drain
  (`src/mcp-bridge.ts:367-392,473-475`). The repository's test checks Node parser deadlines and
  stream frames, not `agy`'s timeout (`tests/mcp-bridge.test.mjs:118-154`).
- Disconnects: a disconnected call aborts its waiter (`src/mcp-bridge.ts:359-364`;
  `src/runtime.ts:1454-1473`) but neither cancels pi's execution nor resolves the parked call;
  turn abandonment settles calls separately (`src/conversation.ts:304-342`).
- Relay timer: after 85 s by default with no result or disconnect, the parked call answers with a
  textual "still running, call `mcp_pi_pi_await_result` with this call_id" result; later awaits
  reuse the same result promise and timer race (`src/config.ts:42-43,60`;
  `src/runtime.ts:1407-1416,1441-1475`; `src/conversation.ts:639-648`). The rationale in the
  source is that `agy` abandons a `tools/call` at about 180 seconds (`src/config.ts:42`;
  `src/mcp-bridge.ts:6-9`). While calls are relayed, text and thought output is buffered up to
  65,536 characters, excess dropped, and flushed when every relay id has been re-awaited
  (`src/conversation.ts:137-138,207-253`). If the agent ends before retrieving relayed results,
  the host gets an error, not a fabricated answer (`src/conversation.ts:564-572`).
- Permissions: decisions use only agent-reported structured metadata (`mcpServerName`,
  `mcpToolName`, `_meta`), never `title` or `rawInput`, and require a matching session, a live
  turn and a structured tool-call identity reported through `session/update`; contradictory
  repeats and unknown identities are refused. Only an empty, identity-less loading probe may rely
  on a completed authenticated MCP `initialize` handshake, and only `allow_once` is ever chosen,
  never `allow_always` (`src/runtime.ts:868-950`; `src/conversation.ts:669-744`). Refusals are
  logged and answered `reject_once` / `cancelled`; they never become turn errors
  (`src/runtime.ts:884-889`). Non-permission agent-to-client requests get `-32601`
  (`src/acp-process.ts:324-338`).
- Schemas: tool descriptions are compacted toward 1,350 bytes, with full prose moved to the
  appended system prompt (`src/mcp-bridge.ts:498-587`; `src/history.ts:111-120`;
  `src/runtime.ts:756-784`), so tool definitions also reach the model as prompt text; execution
  still routes through MCP. The final compaction step is not size-checked and cannot shrink a
  large structural schema (`src/mcp-bridge.ts:574-585`). Changed or added tools are pushed as
  `<harness_tool_update>` prompt deltas, and dynamic additions use `pi_call_tool`
  (`src/mcp-bridge.ts:484-523`).

## 4. Thinking and reasoning

- `agent_thought_chunk` -> internal `thought` event -> pi `thinking` block with
  `thinking_start` / `thinking_delta` / `thinking_end` and `partial` snapshots
  (`src/conversation.ts:251-263,494-497`; `src/pi-stream.ts:224-247,287-291`).
- Blocks are `{type: 'thinking', thinking: string}` only. No `signature` appears in `src` or
  `index.ts`, and the protocol types carry none (`src/protocol.ts:2-6,36-58`); no redaction
  handle, no provider attestation.
- Historical reasoning is not replayed: `renderTranscript` drops `reasoning` and `tool-call`
  blocks from assistant text and re-adds only tool calls (`src/history.ts:139-153`), and ACP
  prompt blocks are text and image only (`src/history.ts:44-47`). `requestMessages` builds an
  internal `{type: 'reasoning', text}` (`src/pi-stream.ts:47-53`) for live-session increments,
  not for the `<pi_history>` transcript.
- Host declarations: `reasoning: efforts.length > 0` and a `thinkingLevelMap` with `off`,
  `minimal`, `xhigh`, `max` all `null` (`index.ts:50-73`). Request mapping: `minimal -> low`,
  `xhigh -> high`, `max -> high`, `off -> undefined` (`src/pi-stream.ts:139-147`); default effort
  `high` (`src/config.ts:55`), clamped to the nearest offered effort (`src/catalog.ts:53-65`;
  `src/runtime.ts:229-233`). `thought_level` is written only for families with selectable
  efforts, because fixed variants reject it (`src/runtime.ts:982-996`).
- Token accounting: `thoughtTokens` is clamped to `outputTokens` (`src/conversation.ts:387-390`);
  input and cache buckets are divided by the model-call count for multi-step turns, explicitly an
  approximation (`src/conversation.ts:358-403`). Usage exists only on the `session/prompt`
  result, so parked steps report nothing separately (`docs/reference.md:149-154`).

## 5. Errors

- `mapError` (`src/runtime.ts:1500-1541`) is one regex ladder over the message text, first match
  wins: an existing `LlmError` passes through unchanged; `JsonRpcClosedError` -> `TRANSPORT`;
  `/authentication required|not logged in|unauthenticated|sign in/i` -> `AUTH`, telling the user
  to run `agy` once in a terminal (`src/runtime.ts:1515-1525`); `/timeout|timed out|deadline/`
  -> `TIMEOUT`; context-window wording, including broad `too long`, `token limit`,
  `maximum.*tokens` -> `CONTEXT_WINDOW_EXCEEDED`;
  `/rate.?limit|429|too many requests|overloaded|capacity/` -> `RATE_LIMIT`
  (`src/runtime.ts:1535`); `/quota|resource.?exhausted|limit reached|exceeded your/` -> `QUOTA`
  (`src/runtime.ts:1537`); other `JsonRpcRemoteError` -> `SERVER`; everything else ->
  `TRANSPORT`.
- Consequences of the order: the rate-limit test runs before the quota test, and the two
  overlap. `RESOURCE_EXHAUSTED (code 429) ... check quota` and `rate limit reached` match both and
  land on `RATE_LIMIT`; there is no quota override (`src/runtime.ts:1528-1537`).
  `resource_exhausted` with no earlier match lands on `QUOTA`. Message text is tested before the
  remote-error branch, so an ACP error whose text matches is classified away from `SERVER`.
- Wire errors become `JsonRpcRemoteError` with message `method: rpc.message`, numeric code and
  data kept separately (`src/jsonrpc.ts:19-32,251-259`). `mapError` reads only the message, so
  remote classification depends on words, not on a structured upstream status;
  `rpc.data` is never mapped to delay or retry metadata.
- Process exit installs `TRANSPORT` even when the stderr-derived message names quota or auth
  (`src/runtime.ts:727-743`; `src/acp-process.ts:182-190`). A JSON-RPC deadline produces
  `no response within Nms` (`src/jsonrpc.ts:142-149`), which by itself misses the timeout regex
  and falls back to `TRANSPORT` (inference from code, not run).
- Pi boundary: two literal markers are injected so pi's own classifiers fire,
  `context_length_exceeded: ...` for `CONTEXT_WINDOW_EXCEEDED` and `quota exceeded: ...` for
  `QUOTA`, unless recognizable wording is already present (`src/pi-stream.ts:83-99`). Finish
  failures and thrown errors both take that path (`src/pi-stream.ts:295-325`); the final pi
  message carries `errorMessage` / `stopReason`, no separate code field. Tests assert
  `isContextOverflow()` true for the overflow case and `isRetryableAssistantError()` false for
  the quota case (`tests/pi-stream.test.mjs:254-303`).
- Stop reasons (`src/conversation.ts:544-623`): `end_turn` -> `stop`; `max_tokens` -> `length`
  after the continuations; `cancelled` -> `aborted` / `ABORTED`; `refusal` -> `REFUSAL`; anything
  else -> `PROVIDER_ERROR`. `end_turn` with no visible output throws `EMPTY_RESPONSE`; ending with
  unretrieved relayed results throws `PROVIDER_ERROR`.
- Codes the adapter can emit: `TRANSPORT`, `AUTH`, `TIMEOUT`, `CONTEXT_WINDOW_EXCEEDED`,
  `RATE_LIMIT` (including `CAPACITY_EXCEEDED`), `QUOTA`, `SERVER`, `ABORTED`, `REFUSAL`,
  `EMPTY_RESPONSE`, `PROVIDER_ERROR`, `UNKNOWN_MODEL`, `INVALID_PAYLOAD`
  (`src/runtime.ts:607-611,967-970,1506-1541`; `src/conversation.ts:569-620`;
  `src/pi-stream.ts:159-185`). Seven of them come from `mapError`.
- No retry hints: ACP carries no HTTP status or headers, and a synthetic
  `onResponse({status: 200, headers: {}})` is reported before the first non-initial-abort chunk
  (`src/pi-stream.ts:200-209`).
- `onPayload` may replace model, messages or tools before dispatch, but the harness-owned
  `sessionId` and `signal` are re-imposed and the replacement is shape-validated
  (`INVALID_PAYLOAD`) (`src/pi-stream.ts:149-195`).

### Streamed notices it recognizes

- The transport retry notice, `/^\s*⚠\s*API error \(attempt \d+\)/` (`src/conversation.ts:26-27`):
  a matching chunk is dropped and counted (`src/conversation.ts:269-282`).
- The output-cap continuation notice ("your previous response was cut off because it exceeded
  the output token limit ... please continue from where you left off", with an optional
  `retries remaining: N`), classified `drop | hold | emit` after collapsing the warning sign,
  `Error:` and whitespace, so a held prefix is recognized across chunk boundaries
  (`src/conversation.ts:28-75,269-298`). The hold buffer (`noticeHold`) has no length cap
  (`src/conversation.ts:169-170,269-281`).
- Neither notice is diagnosed as a quota failure. None of `agy`'s terminal notices (the generic
  "Agent execution terminated" line, the dead-connection line, the spent-credit line) appears
  anywhere in the tree.

## 6. Prompt handling

- System prompt: `options.system` plus leading system messages are joined
  (`src/history.ts:60-74`) and sent as `session/new` `_meta.antigravity.systemPrompt.append`
  behind a bridge preamble and a `<harness_tool_instructions>` block
  (`src/runtime.ts:781-787`; `src/history.ts:96-125`). Mid-conversation system messages travel
  in-band as `<system_update>` (`src/history.ts:160-163`; `src/runtime.ts:1069-1072`).
- History is replayed only on rebuild, newest first, into a 160,000-byte budget chosen to stay
  under a `64,000 x 3 = 192,000`-byte `USER_INPUT` truncation the source alleges
  (`src/history.ts:24-34`). An omitted prefix is announced with a 128-byte reserve; an oversized
  newest tool result is head-truncated with a marker; empty trailing input becomes "Continue the
  task from the latest tool results above." (`src/history.ts:24-42,226-337`). Non-user input
  (system notices, reused tool results) is rendered as transcript blocks, and an empty prompt
  falls back to `Continue.` (`src/history.ts:344-357`). This is lossy reconstruction, not native
  session restore.
- Content rendering lives in `src/history.ts` (`:132-186,226-255`); `src/format.ts:21-67`
  formats the account and quota UI.
- Compaction: none in the adapter. Automatic prompt-cache warming is vetoed (`index.ts:139`).
- Images: live user images pass through as ACP `image` blocks (`data` + `mimeType`)
  (`src/history.ts:194-209`); historical images become literal `[image]` text
  (`src/history.ts:172-187`). Models declare `input: ['text', 'image']` (`index.ts:56`).
- Limits: `maxTokens: 65536` hard-coded, not derived from the model or ACP (`index.ts:72`);
  declared context 256,000 (131,072 for gpt-oss) (`src/preflight.ts:32-34`;
  `src/runtime.ts:216-220`). Sampling parameters, output limits, forced `toolChoice` and
  provider-scoped environment overrides are deliberately not mapped
  (`docs/reference.md:170-172`).

## 7. Accounts, quota, models

- One signed-in account: one configured home, one process, one `QuotaReader`
  (`src/runtime.ts:193-214,648-681`). No registry, rotation, switching or per-account routing.
- The account email is scraped from the last 64 KiB of `agy` logs (`applyAuthResult: email=` /
  `OAuth: authenticated successfully as`) (`src/quota.ts:19-40`); the default home also reads
  `~/.gemini/antigravity-cli/cli.log` (`src/runtime.ts:269-279`). Plan/tier comes from
  `session/new` `_meta.antigravity.tier` and is persisted in `catalog.json`
  (`src/catalog.ts:91-94,131-141`), discovered once per runtime (`src/runtime.ts:281-306`).
- Quota (`src/quota.ts:107-188`): `agy -p /usage --output-format json`, no model prompt, parsing
  `command.data.groups[].buckets[].remaining_fraction` / `reset_time`. A 120 s TTL applies to
  failures too, in-flight reads coalesce, stale groups are kept on error, and snapshots are
  memory-only (`src/quota.ts:107-110,143-187`; `src/config.ts:62`; `src/runtime.ts:209-213`).
  The quota command runs without the isolated-home flags the ACP launch uses
  (`src/quota.ts:159-162`), so for a custom home the two are not guaranteed to see the same
  identity.
- Surfaces: a status snapshot and quota pill (`src/runtime.ts:103,236-239`;
  `index.ts:107-119,144-158`), and the `/agy-acp [status|quota [used|remaining]|reset]` command
  with notifications and the TUI loader as the only operator surface (`index.ts:187-266`).
  Warnings fire at 20 % and 5 % remaining, deduplicated by group + bucket + reset + threshold
  (`index.ts:167-181`; `docs/reference.md:56-64`).
- Models come from the `model` select config option plus `models.availableModels`; per-family
  efforts are derived from `${id}-${effort}` entries, and an empty set marks a fixed-variant id
  such as `gpt-oss-120b-medium` (`src/catalog.ts:67-89,118-121,131-207`). Five fallback families
  ship in code (`src/catalog.ts:27-33`); the list is disk-cached and loading it never starts
  `agy` (`index.ts:84-97`).
- Preferences: `<home>/settings.json` (`quotaDisplay`) and `<home>/catalog.json` (models,
  efforts, tier), written by temp-write and rename, best-effort (`src/config.ts:92-125`;
  `src/catalog.ts:209-263`; `src/runtime.ts:196-197`); `PI_AGY_QUOTA_DISPLAY` overrides the
  display mode at startup only (`index.ts:46-49`).
- Prices default to zero, with pi overrides honored through `calculateCost`
  (`index.ts:70`; `src/pi-stream.ts:220`).

## 8. Packaging and CI

- Ships MIT ESM TypeScript source with extension entry `index.ts`, no runtime `dependencies`,
  wildcard pi peers (`package.json:4-5,15-46`).
- CI declares Ubuntu only, Node 22.19.0 and 24, typecheck, tests and pack dry-run
  (`.github/workflows/ci.yml:16-40`); npm publishing is configured with provenance
  (`.github/workflows/release.yml:96-111`). Tests exercise a scripted fake `agy` only
  (`docs/development.md:101-107`).

## 9. Reported or unverified

Every `agy` behavior the design leans on is asserted in comments or a scripted fake, not
confirmed against the real binary:

- The 60 s headerless-request abandonment (`src/mcp-bridge.ts:6-9`) and the 180 s MCP call
  deadline (`src/config.ts:42`).
- The ~1,500 B lazy tool-schema cutoff (`src/mcp-bridge.ts:525`).
- The 192,000-byte `USER_INPUT` truncation (`src/history.ts:25-28`).
- The retry and output-cap notice texts (`src/conversation.ts:26-33`).
- The `thought_level` / `availableModels` shapes and the stop-reason vocabulary
  (`tests/fake-agy.mjs:45-79,410-435`).
- The 1.4.12 minimum (`src/preflight.ts:29-30`).
- Vendor enforcement of the tool-free agent definition was not exercised.
