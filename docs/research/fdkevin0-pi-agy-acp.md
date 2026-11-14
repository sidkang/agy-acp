# `pi-agy-acp` (fdkevin0/pi-agy-acp)

Read at `git clone --depth=1`, version `0.1.3`, 5.9k lines of TypeScript.
A **pi extension** that drives `agy acp` (ACP over stdio) and renders it in pi.

## 1. What it is

- pi provider extension ("Google Antigravity ACP provider extension for Pi Coding Agent").
- Upstream is the official `agy` binary in ACP mode; credentials are the CLI's own
  (`src/preflight.ts:1-9`). No Google API client of its own.
- Startup lays out an **isolated Antigravity home** so the user's global rules, skills and MCP
  servers stay out of pi sessions, and installs a `pi-bridge` agent that "removes every
  built-in tool so the agent acts only through Pi tools" (`src/preflight.ts:1-9`).

## 2. Transport and process model

- ACP JSON-RPC 2.0 over stdio (`src/acp-process.ts`, `src/jsonrpc.ts`), one persistent child.
- Conversation state is kept in `src/conversation.ts` (744 lines) and history is rendered in
  `src/history.ts` (357 lines).
- `src/runtime.ts` (1541 lines) owns lifecycle, quota, tier discovery and status.

## 3. Tool channel — the most interesting part

- A loopback **Streamable HTTP MCP server** exposes pi tool schemas to the agent and parks
  each `tools/call` until pi has run it through its own permission/execution pipeline
  (`src/mcp-bridge.ts:1-10`).
- The response is an **SSE stream so headers leave immediately**, because "the agent's HTTP
  client otherwise abandons a request after 60 seconds without headers"; comment frames and
  MCP `notifications/progress` keep long pi tool runs visibly alive
  (`src/mcp-bridge.ts:1-9,343-380`). Keepalive comments are written on a timer
  (`src/mcp-bridge.ts:85,371`).
- `tools/call` must be sent alone (`src/mcp-bridge.ts:320`), and unknown methods answer
  -32601 (`:327`).
- Agent-side tool names carry a prefix (`AGENT_TOOL_PREFIX`, `CALL_TOOL_NAME` in
  `src/history.ts`).

## 4. Thinking / reasoning

- ACP reasoning blocks map to pi thinking blocks: `{ type: 'reasoning', text: block.thinking }`
  on the request side (`src/pi-stream.ts:52-53`) and accumulated into pi `thinking` blocks on
  the response side (`src/pi-stream.ts:224-241,287-289`).
- No `signature` field anywhere: pi's own event stream does not carry one, so the whole
  Anthropic-signature problem is absent here.

## 5. Error handling

- `mapError()` maps failures onto stable pi codes, in this order
  (`src/runtime.ts:1500-1541`; the `RATE_LIMIT` and `QUOTA` returns are `:1535` and `:1537`): closed link → `TRANSPORT`; sign-in wording → `AUTH` (with a
  "run `agy` once in a terminal" message); `timeout|deadline` → `TIMEOUT`;
  context-length wording → `CONTEXT_WINDOW_EXCEEDED`; `rate.?limit|429|too many requests|overloaded|capacity`
  → `RATE_LIMIT`; `quota|resource.?exhausted|limit reached|exceeded your` → `QUOTA`;
  other JSON-RPC remote errors → `SERVER`; everything else → `TRANSPORT`.
- Note the ordering effect: the rate-limit test runs **before** the quota test (`:1535` vs
  `:1537`), so
  `RESOURCE_EXHAUSTED (code 429) ... check quota` lands on `RATE_LIMIT` unless the message
  also says `quota` — the same precedence question our 0.1.8 work answered by status plus
  wording.

### Notices it does recognize

Two of `agy`'s streamed notices are handled in `src/conversation.ts`:

- The transport retry notice, `/^\s*⚠\s*API error \(attempt \d+\)/` (`src/conversation.ts:26-27`) —
  the same one our `splitAgentRetryNotices` strips.
- The **output-cap continuation notice** ("your previous response was cut off because it
  exceeded the output token limit … please continue from where you left off", with an optional
  `retries remaining: N`), classified into `drop | hold | emit` after collapsing `⚠`, `Error:`
  and whitespace so it is recognized across chunk boundaries (`src/conversation.ts:28-60`).

That second notice is one our plugin has no equivalent for.

## 6. Prompt handling

- The agent is fixed by a generated agent definition with every built-in tool removed
  (`src/preflight.ts:1-9`); pi's tool set arrives only over MCP.
- History is rendered into prompt text (`src/history.ts`), with its own content formatting
  (`src/format.ts`).

## 7. Accounts and quota

- One CLI identity; no pool.
- `src/quota.ts` (188 lines) is a `QuotaReader` with a TTL (`src/runtime.ts:209-212`) feeding a
  status snapshot for the settings page and a quota pill (`src/runtime.ts:103,236-239`), plus
  one-shot plan discovery per runtime (`src/runtime.ts:281-305`).
- `src/catalog.ts` (265 lines) builds the model list.

## 8. Worth stealing / looks fragile

- **Worth stealing**: the SSE-first MCP response with progress notifications for long tool
  runs (`src/mcp-bridge.ts:1-9,343-380`) — this is the mechanism we lack for a parked call, and
  it removes the need for a client-side timeout budget; the error-code taxonomy
  (`src/runtime.ts:1500-1541`).
- **Looks fragile**: `tools/call` must arrive alone (`src/mcp-bridge.ts:320`) and anything
  else answers -32601 (`:327`) — a stricter server than the MCP spec requires; the quota
  regex overlaps the rate-limit one (`src/runtime.ts:1528-1536`).
