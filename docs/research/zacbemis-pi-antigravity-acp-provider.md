# `pi-antigravity-acp-provider` (zacbemis/pi-antigravity-acp-provider)

- Checkout: `https://github.com/zacbemis/pi-antigravity-acp-provider`, shallow clone, commit
  `1598d38ec396097e779bad77d1be1a57ab14514d` (2026-11-12, "chore(runtime): approve Antigravity
  ACP 1.5.0"), package version `0.1.19` (`package.json:3`). Read 2026-11-14.
- Citations are relative to the repository root. Size at this commit: 5,902 lines in `src`
  (including the non-TypeScript `src/acp/supervisor.mjs:1-101`, `src/mcp/schema.ts` is 223) and
  23 files in `docs/`; the repository's own `docs/` were read as documented intent only.
- Comparison with this plugin: [`comparison.md`](comparison.md).

## 1. Host and upstream

- A pi provider extension, not an HTTP proxy: `pi.extensions -> ./extensions/index.ts`
  (`package.json:33-40`), `pi.registerProvider` (`extensions/index.ts:56`), and a `Provider`
  object (`src/provider.ts:21-24,130-146`). Pi calls it in-process and receives its own
  `AssistantMessageEventStream` (`src/stream/pi-events.ts:26-37`). Peers
  `@earendil-works/pi-coding-agent` / `pi-ai` at `*`, dev dependency 1.5.0
  (`package.json:75-77`).
- There is no HTTP inference layer and no Anthropic wire shape. HTTP appears only in the MCP
  bridge (500 / 405 / 401, `src/mcp/bridge.ts:81-85,116-123`) and the OAuth relay
  (`src/acp/headless-oauth.ts:78-90`).
- Upstream is Google Antigravity's ACP server binary, `agy_acp_server.par` (Windows `.exe`) with
  a `localharness_external` companion, explicitly not `@google/gemini-cli` (`README.md:5`;
  `src/acp/process.ts:37-41`), and not the user's `agy` CLI. ACP goes through
  `@agentclientprotocol/sdk` 2.2.0 (`src/constants.ts:5`; `package.json:69`), an unstable import
  speaking protocol v1, over a custom NDJSON adapter
  (`src/acp/connection.ts:98-121,170-225`; `src/acp/process.ts:155-176`).
- Launch order: `AGY_ACP_BIN` (executable override) -> managed `~/.local/opt/agy-acp/current/`
  -> `~/.local/bin/agy_acp_server.par` -> `PATH` (`src/acp/antigravity.ts:13-41`). An external
  launch bypasses management (`src/acp/setup.ts:176-190,478-491,757-760`). Native Linux launch
  adds the required empty `--uid=` argument, and a file starting with `#!` is treated as a wrapper
  with no arguments (`src/acp/antigravity.ts:148-161`).
- Runtime catalog: `runtime-manifest.json`, with per-platform `archive`, `archiveSha256`,
  `archiveBytes`, `binaryBytes`, `harnessBytes` (`src/acp/runtime-manifest.ts:12-21`) and
  archives from `https://dl.google.com/agy-extensions/releases/...`
  (`runtime-manifest.json:4-40`). Line 6 names version 1.4.0 (`runtime-manifest.json:6`); entries
  for 1.5.0 sit at `runtime-manifest.json:282-347`, matching the commit subject.
- Artifact sizes: the 1.5.0 archives are 100,401,185-274,069,093 bytes and the binaries
  58,314,376-721,489,411 bytes, plus the companion harness (`runtime-manifest.json:282-347`). A
  range of 280-930 MB per platform read from `runtime-manifest.json:4-40` mixes payload with
  download sizes from older entries and omits Windows.
- Integrity chain: Ed25519 over canonical JSON, verified against a public key embedded in the
  package (`src/acp/runtime-manifest.ts:4-10,54-75`), so the signature is the package author's,
  not Google's -> archive URL must be under `https://dl.google.com/agy-extensions/releases/` with
  no query, userinfo or port, and a version-matching filename
  (`src/acp/runtime-manifest.ts:142-173`) -> streamed, size-capped SHA-256 compared twice
  (`src/acp/setup.ts:294-299,459-478`) -> the ZIP must hold exactly two whitelisted regular
  members, no separators, stored or deflate only, exact decoded sizes
  (`src/acp/setup.ts:388-412`) -> pre-activation identity check: protocol 1, name
  `antigravity-acp`, version `x.y.z` or `agy_acp_server_x.y.z` (`src/acp/setup.ts:414-448`).
  After install, launch checks are size, type and execute bit, not a re-hash of the executable.
- Install mechanics: hash-named immutable directories under `~/.local/opt/agy-acp`,
  `install-integrity.json` at 0600, an atomic `current` symlink, a cross-process directory lock
  with stale-PID recovery, musl rejected, macOS quarantine stripped
  (`src/acp/setup.ts:274-278,318-358,625-663,706-719`); executable repair before spawn
  (`src/acp/setup.ts:177`); setup flow `src/acp/setup.ts:104-191`. Concurrent installs dedupe on
  one in-flight promise (`src/acp/setup.ts:118-123`). Six platforms: macOS, Linux and Windows on
  arm64 and x64 (`src/acp/setup.ts:738-760`; `runtime-manifest.json:282-347`).
- Updates: automatic by default (`src/config.ts:44-58`), with a 24 h check cache. The catalog is
  refreshed from a raw GitHub `RUNTIME_MANIFEST_URL`, falling back to the cached or bundled copy
  on any failure (`src/acp/runtime-manifest.ts:8-9`; `src/acp/setup.ts:222-239`). The official
  ACP registry is consulted only to learn whether something newer exists; its latest version must
  be approved in the signed manifest, otherwise the latest approved one is used; a same-version
  archive-URL disagreement is fatal (`src/acp/setup.ts:26-30,176-237`). A working managed launch
  survives an update-resolution failure. A newer runtime needs a signed manifest entry, which is
  fetched separately, so no package republish is required.
- Authentication: Antigravity owns the tokens under `~/.gemini/antigravity-acp/` (honoring
  `GEMINI_HOME`), and an existing local OAuth login is reused (`src/acp/antigravity.ts:90-127`).
  Pi's OAuth login only stores a sentinel, `access`/`refresh` =
  `"pi-antigravity-acp:managed-by-antigravity"`, `expires = MAX_SAFE_INTEGER`, with a no-op
  `refresh` (`src/constants.ts:7`; `src/provider.ts:26-103`). Real auth is ACP `authenticate`
  against a discovered Google method (`src/runtime.ts:302-312`), skipped when the sentinel is
  present (`src/runtime.ts:1034-1040`); stored or environment API keys travel as
  `_meta: {"api-key": ...}` on `authenticate` (`src/runtime.ts:1041-1046`). The child's
  `HOME` / `GEMINI_HOME` decides which store is used, an API-key environment variable can bypass
  OAuth-file selection, and local token health is structural, not a network check
  (`src/acp/antigravity.ts:57-67,87-127,180-186`).
- Credential storage: any non-blank `AGY_ACP_FORCE_FILE_STORAGE` is respected as an override (not
  parsed as a boolean). Otherwise, only macOS with a structurally refreshable token file and a
  missing, locked or denied keychain entry gets `AGY_ACP_FORCE_FILE_STORAGE=1`, in the child only.
  The keychain probe is `/usr/bin/security find-generic-password -s gemini -a antigravity-acp`,
  without the secret-output flag, stdio ignored, 3 s timeout
  (`src/acp/credential-storage.ts:8-16,39-49,61-92`). The backend description in the code says
  "expected", not observed (`src/acp/credential-storage.ts:95-111`).
- Headless OAuth: replaces `BROWSER` / `xdg-open` with a temporary capture script, validates the
  Google authorization URL, and relays the loopback callback after checking scheme, host, port,
  path and state; manual capture is refused on Windows
  (`src/acp/headless-oauth.ts:15-46,101-109,112-172`).
- Child environment: proxy and credential-storage variables are applied per child, plus TLS CA
  defaults (`src/acp/process.ts:97-118,151-158`; `src/acp/proxy.ts:13-48`).
- User surface: one command namespace, `/antigravity-acp` (with a deprecated `/gemini-acp`
  alias), covering setup, doctor, status, quota, update, updates, logout, account, qualify and
  permissions, plus a native pi tool for permission prompts (`extensions/index.ts:75-236`).
- `ANTIGRAVITY_ACP_VERSION = "1.1.1"` is stale and unused outside `src/constants.ts:4`.

## 2. Transport and processes

- NDJSON through a custom bounded adapter: 32 MiB default frame cap (`DEFAULT_MAX_FRAME_BYTES`).
  One exact Chromium line, `"Opening in existing browser session."`, and blank lines are tolerated
  (the former counted); any other malformed frame fails the transport. Outbound frames over the
  cap throw, and an inbound over-long line without a newline fails the transport
  (`src/acp/bounded-stream.ts:3,16-28,38-85,118-147`). The connection closes on protocol failure
  (`src/acp/connection.ts:89-97`). Client capabilities advertise no fs and no terminal
  (`src/acp/connection.ts:122-137`).
- At least two OS processes per session binding: `node supervisor.mjs --command <agy_acp_server.par>`
  wrapping the agent (`src/acp/process.ts:132-145`). The supervisor proxies stdio, spawns the
  agent detached into its own group so a watchdog can kill the group, polls for parent death
  every 500 ms, and escalates TERM -> KILL on the agent tree at 750 ms
  (`src/acp/supervisor.mjs:20-50,68-97`). The Node side signals the group, then SIGKILLs after
  1500 ms, a grace chosen to be "longer than supervisor's 750 ms agent-tree escalation"
  (`src/acp/process.ts:12-14,201-236`); Windows uses `taskkill /T`. An explicit
  `options.command` bypasses the supervisor. A separate Node executable is required even under
  standalone pi; the resolver honors `NODE`, then `node` / `nodejs` on `PATH`
  (`src/acp/process.ts:43-68`).
- Ephemeral operations (model discovery, `/usage`, login, install validation) each start a fresh
  process pair (`src/runtime.ts:207,257-266,295-298,359,1016-1022`). The MCP bridge is an
  in-process HTTP server, not a process (`src/mcp/bridge.ts:81-91`).
- Wire: `initialize` (protocol 1 + `clientInfo`), `authenticate`,
  `session/new|load|resume` (each with `cwd` and `mcpServers`), `session/set_config_option`,
  `set_mode`, legacy `session/set_model`, `session/prompt`, and `session/cancel` as a notification
  (`src/acp/connection.ts:170-275,322-324`).
- Local state: a `Binding` per session (writer, instruction and history fingerprints, pending
  permission and tools, `contextUsed`, `inferences`) (`src/runtime.ts:76-105`), and a persisted
  record keyed by pi session id,
  `{piSessionId, acpSessionId, acpModelId, cwd, messageCount, historyFingerprint, expectedAssistantFingerprint, lastActive}`,
  capped at 256 records and 30 days (`src/acp/session-store.ts:6-25`). The cap sorts by
  `lastActive` on save; a read does not refresh recency, and age is filtered on read rather than
  purged on save. Records are written pid-temp + rename, directory 0700, file 0600
  (`src/acp/session-store.ts:27-68`).
- Store locking: save, remove and clear run the whole reload / mutate / rename under
  `proper-lockfile.lockSync` with `realpath: false`, retries via a 10 ms `Atomics.wait`, a 5 s
  acquisition deadline and a 30 s stale threshold, released in `finally`
  (`src/acp/store-lock.ts:4-23`; `src/acp/session-store.ts:33-47,60-68`). Reads are unlocked and
  treat corruption or I/O errors as empty. The lock protects this provider's metadata, not the
  runtime's native conversation DB, and is not a cross-process live-session lease.
- Turns are serialized through one promise queue per session key (`src/runtime.ts:572-578`).
- Warm restore: `session/resume` -> `session/load` -> `session/new` (`src/runtime.ts:801-826`).
  An identical `cwd` is required (`src/runtime.ts:806`); resume and load are capability-gated; a
  resume failure is swallowed, and a failed load removes the saved record. A dead process closes
  the binding, and the next turn rebuilds through the same chain (`src/runtime.ts:873-882`).
- Timeouts: operation 120 s, `initialize` 30 s, `authenticate` 180 s (10 minutes under the
  headless relay), prompt idle 10 minutes, work idle 60 minutes, permission 120 s, tool-batch
  flush 100 ms, quota prompt 30 s, install 45 minutes, validation 90 s
  (`src/acp/connection.ts:31,38-46,63-70,135,161`; `src/runtime.ts:56-59`;
  `src/acp/setup.ts:28-29`).
- Prompt watchdog (`src/acp/prompt-watchdog.ts:5-78`): progress-based, never a total-turn cap.
  Two inactivity budgets, 10 minutes idle and 60 minutes while work is outstanding, independently
  configurable and validated before spawn (`src/acp/connection.ts:38-46,63-70`). Work is
  outstanding while an explicit hold, an open permission, or a native `tool_call` in
  `pending` / `in_progress` exists; every session update re-arms, including unknown or
  status-only updates; a completed or failed tool removes its id
  (`src/acp/prompt-watchdog.ts:25-49`). Nested releases are idempotent; the timer is `unref()`ed,
  fires once, and `dispose` clears state (`src/acp/prompt-watchdog.ts:25-37,60-78`). Parked pi
  MCP calls hold the watchdog (`src/runtime.ts:917-929`); permission RPCs acquire and release
  around the handler (`src/acp/connection.ts:100-110`). A stall rejects with `timeout` and closes
  the connection and process (`src/acp/connection.ts:399-421`).
- No retry, backoff, reconnect or re-prompt: those words appear in `src/` only in two "retry the
  turn" messages (`src/runtime.ts:628,840`). Recovery is the rebuild chain above.
- Abort sends `session/cancel` as a notification, hard-closes the connection after 1500 ms, and
  rejects as `aborted`; the writer reports `stopReason: "aborted"` rather than an error
  (`src/acp/connection.ts:291-320`; `src/runtime.ts:704-728`).
- stderr: the last 16,384 string units are kept, then `redact()` caps the result at 4,096 string
  units (`src/acp/process.ts:11,165-167,238-246`; `src/acp/errors.ts:32-42`); it is shown only by
  `doctor --verbose` (`src/runtime.ts:437`). Process exit is reported as `process_exit`, even for
  a child spawn-error settlement (`src/acp/process.ts:168-172,238-246`;
  `src/acp/connection.ts:78-84`).

## 3. Tool channel

- `agy`-executed native tools arrive as ACP `tool_call` / `tool_call_update` notifications and are
  rendered into pi thinking text (`src/acp/events.ts:22-36`; `src/runtime.ts:974-977`). Pi's own
  tools never reach the model through that path.
- Pi tools are exposed by a real MCP server built on `@modelcontextprotocol/sdk` with
  `StreamableHTTPServerTransport`, an in-process HTTP server registered as one `McpServer` entry
  (`src/mcp/bridge.ts:1-12,78-95`; `src/runtime.ts:790-801`). It starts only when the tool set is
  non-empty and the agent advertises `mcpCapabilities.http`; otherwise the tools are reported as
  omissions rather than advertised unusable (`src/runtime.ts:790-800`).
- Descriptor:
  `{type: "http", name: "pi-bridge", url: "http://127.0.0.1:<ephemeral>/mcp", headers: [{name: "Authorization", value: "Bearer <token>"}]}`,
  with a dash-stripped UUID token minted per bridge (`src/mcp/bridge.ts:64,69,106-114`).
- Endpoint: only `POST /mcp`; a wrong path or method gets 405 before auth; the exact,
  case-sensitive `Bearer <token>` is compared with `timingSafeEqual` on equal byte lengths, else
  401 before the body is read; body at most 1 MiB, with body-limit and JSON exceptions reaching a
  generic 500 rather than 413 / 400; `maxConnections = 8`; each authenticated POST gets a fresh
  stateless MCP `Server` and `StreamableHTTPServerTransport({sessionIdGenerator: undefined})`,
  closed afterwards (`src/mcp/bridge.ts:14,18-19,81-94,116-162,197-213`). The bridge itself does
  no Host or Origin check; SDK middleware behavior was not inspected.
- Projection: names become `pi_<name>`, sanitized to `[a-zA-Z0-9_-]{1,64}`, with a hard cap of
  64 tools; names that collide after sanitizing or truncation are omitted
  (`src/mcp/bridge.ts:19,45-58,165-193`). A schema it cannot represent omits the whole tool, never
  widens it, with seven typed reasons:
  `unsupported_keyword | invalid_keyword_value | unsafe_property_name | too_deep | cyclic_schema | not_object | too_large`
  (`src/mcp/schema.ts:9-34`).
- Schema policy: only annotations may be dropped; an unknown validation keyword rejects the tool;
  proxy, accessor, custom-prototype and symbol objects, sparse or custom arrays, cycles and
  `__proto__` properties are rejected; small shared acyclic subschemas are allowed; supported
  combinators are preserved; `const` gains a singleton `enum`; no type is ever inferred; only a
  root `type === "object"` is accepted (`src/mcp/schema.ts:22-34,55-118,125-181,190-217`).
  Budgets: 64 KiB (also checked after projection), 100k work units, depth 16, with an ancestry
  `WeakSet` for cycle detection (`src/mcp/schema.ts:5-8,22-29,36-52,106-118`).
- Omissions are reported by name and reason in `doctor` / `status` (`src/runtime.ts:136,864`;
  `extensions/index.ts:228`) and are part of the tool fingerprint; a changed fingerprint
  invalidates the warm binding (`src/runtime.ts:513-517,587-595`).
- Arguments are validated at call time against the original pi schema with typebox
  (`Value.Check(tool.originalSchema, args)`), so projection loss cannot widen what a tool accepts;
  a validation failure or exception returns MCP `isError` and never dispatches
  (`src/mcp/bridge.ts:12,21-27,137-148,215-216`).
- Results return in-process, never through `session/prompt`: `onCall` ->
  `runtime.requestPiTool` -> `writer.toolCall(...)`, then a 100 ms debounce before
  `done("toolUse")`; the ACP prompt stays parked with the watchdog held, and the pi `toolResult`
  on the next `stream()` call resolves the `CallToolResult`
  (`src/runtime.ts:550-570,907-936,1189-1198`). The pi-visible tool-call id is a fresh bridge
  UUID, not the ACP `toolCallId` (`src/mcp/bridge.ts:148`).
- Permissions bypass the MCP bridge: `PERMISSION_TOOL_NAME` (`src/constants.ts:8`;
  `src/mcp/bridge.ts:18`) is excluded from MCP and synthesized as a real pi tool,
  `antigravity_acp_permission`, whose result carries
  `details.kind = "pi-antigravity-acp-permission-v1"`; a missing, malformed or disabled result is
  an immediate deny, never an implicit approval or a hang
  (`src/runtime.ts:938-963,1094-1121`; `extensions/index.ts:75-111`). The permission UI has its
  own 120 s auto-deny (`src/runtime.ts:56,945-952`).
- A call arriving with no live writer, during an open permission, or after an aborted turn is
  refused with `isError` text `"Pi cannot accept this tool call in the current turn"`
  (`src/runtime.ts:911-916`).

## 4. Thinking and reasoning

- `agent_thought_chunk` -> `{type: "thought", delta}` (`src/acp/events.ts:18-21`) -> a pi
  thinking block via an event builder that enforces block invariants ("Pi thinking block
  invariant failed"): `block.thinking += delta` plus a `thinking_delta` event; the close event
  carries only the text (`src/stream/pi-events.ts:18-58,109-142`). Non-text thought content is
  dropped (`src/acp/events.ts:18-21`).
- ACP `tool_call` and `plan` entries are rendered as thinking text; usage arrives as
  `usage_update.used > 0` (`src/acp/events.ts:11-46`; `src/runtime.ts:974-982`).
- Thought and tool-update text is sanitized: C0/C1 control bytes stripped, 2,000 characters per
  field, at most 8 content items and 4,000 characters per tool update
  (`src/acp/events.ts:49-70`).
- No signature: blocks are `{type: "thinking", thinking}` only; the only `signature` in `src/` is
  the runtime manifest's Ed25519 signature (`src/acp/runtime-manifest.ts:32-72`). Reasoning
  tokens surface solely as `usage.reasoning` from `thoughtTokens`, folded into output
  (`src/stream/pi-events.ts:49-56`; `src/stream/usage.ts:24-27`).
- Levels: models are registered `reasoning: true` with a `thinkingLevelMap` of exact ACP ids,
  `off | minimal | xhigh | max` = `null` (`src/models.ts:44,105-147`); pi effort clamps to the
  nearest advertised tier (`src/models.ts:107-130`). The id is split into `model` and
  `thought_level` selectors; each write is read back and both must confirm, or the turn fails
  (`src/acp/connection.ts:228-260,346-369`). Anthropic `thinking.type === "disabled"` is not
  handled.

## 5. Errors

- Codes: `aborted | auth | model | protocol | quota | spawn | timeout | process_exit | invalid_input`
  (`src/acp/errors.ts:1-29`): cancellation; sign-in or credential; selector mismatch; malformed
  ACP; account out of quota; lifecycle (spawn, timeout, process exit); request cannot be
  represented.
- `classifyError` keeps existing typed errors; a structured error with code `-32000` becomes
  `auth`, any other numeric code becomes `protocol` with the code embedded and a string
  `data.details` appended (redacted), cause retained; an unstructured `Error` is returned
  unchanged. Operations are raced against transport-failure and process-exit promises
  (`src/acp/connection.ts:399-421,446-476`). Message wording, and an HTTP-like 429, never map to
  `quota` here.
- Host-visible shape: the code is not transmitted. Pi gets `stopReason: "error" | "aborted"` and
  `errorMessage = redact(message)`; `rawStopReason` carries only the ACP stop reason
  (`src/stream/pi-events.ts:78-101`; `src/runtime.ts:672`). No retry hint, no `retryAfter`, no
  structured payload, no `Retry-After` or `x-should-retry`.
- `redact()` replaces URL userinfo, `AIza` / `sk-` / `npm_` / `gh[opurs]_` keys, `ya29.` / `1//`
  tokens, `Basic` credentials, `authorization` / `cookie` / `set-cookie` values, and JSON
  `access_token | refresh_token | id_token | client_secret | api_key` pairs, then slices to 4,096
  UTF-16 units (`src/acp/errors.ts:27-60`). It is a finite vocabulary, not exhaustive removal;
  the cookie/header pattern stops at whitespace, comma or semicolon; the error constructor itself
  does not redact (`src/acp/errors.ts:12-20`); tests cover selected examples
  (`test/errors.test.ts:1-25`).
- Quota gate, inside the provider after a successful prompt: metrics are incremented first; then,
  only when `usage.totalTokens === 0 || stopReason === "refusal"`, the accumulated text blocks
  (not thinking) are matched against one exact English notice, anchored at the start or a newline
  and at the end of the trimmed reply:
  `"Usage Limit Reached\n\nYou have reached your current quota for this period."` plus an optional
  reset sentence, relative (`N day/hour/...`, for example `in 3 hours, 20 minutes`) or absolute
  (`Mon D, YYYY HH:MM UTC`, for example `on Nov 14, 2026 09:00 UTC`), returned as an ISO `resetAt`
  (`src/runtime.ts:652-662`; `src/acp/quota.ts:1-25`).
- What the gate does and does not do: it stops the provider checkpoint from advancing
  (`src/runtime.ts:658-660,673-676`), but the text has already streamed
  (`src/runtime.ts:974-975`), the failure keeps the content (`src/stream/pi-events.ts:89-100`), and
  the live ACP process can remain (`test/runtime-safety.test.ts:338-351`). The test asserts no
  checkpoint progress, a retained live binding, and preservation of a normal reply that quotes the
  notice (`test/runtime-safety.test.ts:338-380`). A paraphrase, a locale change, or any non-zero
  token count turns exhaustion into a normal empty answer, and the notice is never forwarded as an
  error.
- Stop reasons: `cancelled` -> abort; `max_tokens` / `max_turn_requests` -> `length`; everything
  else -> `stop`, so a refusal without the quota notice is a normal stop
  (`src/runtime.ts:676-685`).
- Other invariants that fail the turn: an image without the advertised capability
  (`src/runtime.ts:1052-1059`); instructions over 256 KiB (`src/stream/context.ts:19-26`); no user
  message (`src/stream/context.ts:47,92`); mode drift mid-turn or an external
  `config_option_update` / `current_mode_update` (`src/runtime.ts:626-629,965-972`); an
  unconfirmed model or mode selection (`src/acp/connection.ts:346`; `src/runtime.ts:834-836`).
  The requested permission mode is compared with the server-confirmed one before each prompt, and
  drift invalidates the binding (`src/runtime.ts:514-518,626-629`). A model switch is
  all-or-nothing: because the base model can change before the effort selector fails, any failure
  after a partial apply invalidates the binding and its saved session
  (`src/runtime.ts:598-607`; `src/acp/connection.ts:236-247`).
- Usage accounting: per-turn usage comes from ACP `_meta.quota.token_count`, falling back to
  standard usage (`src/stream/usage.ts:15-28`). An in-code comment states that Antigravity
  double-counts cache reads into `usage_update.used`, so pi's `totalTokens` is corrected only when
  exactly one inference ran; multi-inference turns overcount by the last inference's cached tokens
  (`src/runtime.ts:662-672`; `src/acp/events.ts:41-43`).

## 6. Prompt handling

- Fresh session: one `resource` block (`urn:pi:antigravity-acp:context/<uuid>`, `text/markdown`)
  holding `# Pi session instructions` and `# Prior conversation` (`HISTORY_HEADING`): labelled
  entries under an explicit untrusted-data heading, fence length derived from the body, a 32,000
  UTF-16-unit budget (`MAX_RECONSTRUCTION_CHARS`), active tool-call and result identities pinned,
  tool results allocated before call arguments, oldest entries dropped first; the current user
  turn goes last and verbatim (`src/stream/context.ts:6-16,58-93,107-167,176-185`). Entry bodies
  may be truncated; only a failure to fit the minimum identities of the current tool turn throws
  (`src/stream/context.ts:58-61,107-166,197-205`). The code credits this budgeting to another
  project's "labelled history budgeting" (`src/stream/context.ts:103`).
- Warm session: a delta resource for messages the session has not seen (`DELTA_HEADING`) plus
  `WARM_CONTINUATION` / `CONTINUATION_LABEL` text; when the session already saw the request, only
  new tool results are sent (`src/stream/context.ts:15-16,70-91`).
- Instructions are never truncated: over `MAX_INSTRUCTION_BYTES` (256 KiB of UTF-8) the turn fails
  with `invalid_input` telling the user to reduce them (`src/stream/context.ts:7,19-25`).
- Context resources degrade to text when `embeddedContext` is false
  (`src/runtime.ts:1049-1064`).
- Warm identity: `messageCount` and `messagesFingerprint(prefix)` must match exactly, and
  `expectedAssistantFingerprint` skips the assistant message the model itself produced
  (`src/runtime.ts:587-596,610-618`). The binding is dropped when
  `messages.length < binding.messageCount` or the prefix fingerprint mismatches
  (`src/runtime.ts:586-596`); an instruction change forces a rebuild because ACP has no
  system-update RPC (`src/runtime.ts:181-190,1002-1009`).
- Compaction: none in the provider, and no compaction case in event parsing; unknown update types
  fall through (`src/acp/events.ts:11-46`). Whether the server compacts internally is not known.
- No trigger cloaking. Text adaptation is limited to labelling (`HISTORY_HEADING`,
  `CONTINUATION_LABEL`), truncation, fencing, control-line normalization, image placeholders,
  native tool and plan annotations, and model/effort selection
  (`src/stream/context.ts:107-194,241-248`; `src/acp/events.ts:22-39,68-69`).
- Images: only the current user message's images are forwarded, as ACP image blocks
  (`src/stream/context.ts:82-91`); history images become `"[image omitted]"`
  (`src/stream/context.ts:245-248`); sending is capability-gated (`src/runtime.ts:1049-1064`);
  there is no resizing. Every model declares `input: ["text", "image"]` unconditionally
  (`src/models.ts:167`) while the send path can throw.

## 7. Accounts, quota, models

- One identity at a time: the provider and runtime choose credentials, not a pool; no rotation or
  cooldown (`src/provider.ts:68-103`; `src/runtime.ts:765-788,1034-1046`).
- Logout deletes `acp_token.json` and strips `settings.auth` via a 0600 temp file and rename
  (`src/acp/antigravity.ts:132-146`); pi's own marker is cleared by `/logout`
  (`extensions/index.ts:148-155`). Local health is structural
  (`api-key-env | oauth-refreshable | configured-not-authenticated | corrupt | missing`), with a
  separate network probe (`src/acp/antigravity.ts:43-123`; `src/runtime.ts:372-380`).
- `/usage`: a separate throwaway ACP connection sends the literal text `/usage` (no model turn)
  and parses the Markdown `### Quota Limits` section (`**Group**`,
  `**label:** N% remaining (resets ...)`) into `{window: "5h" | "weekly" | <label>, remainingFraction, resetTime}`,
  1 % precision, ISO resets; buckets reported as units or "Available" are skipped deliberately,
  and a reply with no groups is a protocol error (`src/runtime.ts:222-282`;
  `src/acp/usage-quota.ts:6-42`). 60 s cache with in-flight dedupe that isolates each caller's
  abort; the temporary conversation files are deleted once the process is gone. Results are
  re-broadcast on `antigravity-acp:quota:request` with an exactly-once reply
  (`src/constants.ts:11`; `extensions/index.ts:43-73`).
- Prompt-response quota metadata: per-process totals (turns, input, output, reasoning, cache) plus
  a `latestQuota` scraped from `_meta.quota` field variants (`remainingRequests | remainingQueries | remaining`,
  `requestLimit | queryLimit | limit`, `resetTimestamp | resetAt | reset_time`, `tier | plan`)
  (`src/status.ts:50-69`).
- Models: discovery runs `session/new` and reads the config selectors or legacy `models`
  (`src/runtime.ts:200-219`; `src/acp/session-state.ts:81-124`). Effort-qualified ids collapse to
  one pi entry when at least two tiers exist; single-tier models keep their exact id
  (`src/models.ts:43-92`). These are effort tiers, not subscription tiers. A hard-coded offline
  fallback catalog uses `contextWindow: 1_000_000`, `maxTokens: 65_536`, zero cost
  (`src/models.ts:15-41,153-172`); refresh is network-only and silent on failure
  (`src/provider.ts:106-129`).

## 8. Packaging

- npm ships TypeScript `extensions/`, `src/`, `docs/` and the manifest, not a runtime binary; MIT;
  Node >= 22.19.0; wildcard pi and typebox peers; exact SDK, MCP and lockfile dependencies
  (`package.json:5-6,29-43,60-73`; `LICENSE:5-13`). The manifest is signed with
  `scripts/sign-runtime-manifest.mjs`.

## 9. Reported or unverified

- Whether real servers implement `session/resume` as well as `session/load`; both are attempted
  speculatively (`src/runtime.ts:806-826`).
- The actual `/usage` and "Usage Limit Reached" wordings (`src/acp/usage-quota.ts:14-16`;
  `src/acp/quota.ts:4-9`).
- Whether the agent calls the loopback bridge and honors the Bearer header: the repository's own
  `docs/IMPLEMENTATION-STATUS.md:28` records live qualification only on server 1.1.1.
- The real model and effort inventory and plan eligibility (`src/models.ts:16-41`).
- Whether the thought stream carries withheld reasoning that the provider drops
  (`src/acp/events.ts:18-21`).
- The cache-read double counting (section 5) is a code comment, not reproduced.
- That pi 1.5.0 downgrades unsigned thinking to plain text on a handoff to Claude when
  `allowEmptySignature` is false: pi's handoff code is not in this repository
  (`package.json:75-77`; `src/stream/pi-events.ts:118-138`).
- That uncloaked Claude Code / Codex trigger lines are refused upstream and surface as generic
  failures: the prompt passes them through (`src/stream/context.ts:81-90`) and refusals map to a
  normal stop (`src/runtime.ts:677-685`), but no live runtime was exercised.
- Whether the managed runtime is a documented Google artifact; the code restricts the URL and the
  expected agent identity (`src/acp/runtime-manifest.ts:142-163`; `src/acp/setup.ts:414-428`).
