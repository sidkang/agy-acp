# `pi-agy-acp` vs this plugin

Second pass, read against `/Users/sid/Devs/antigravity-magpie` (`99de26c3`, 0.1.9).
Companion to `fdkevin0-pi-agy-acp.md`.

## Where we differ

| Axis | Them | Us |
|---|---|---|
| Host | pi extension | Magpie plugin (Anthropic HTTP) |
| Upstream | `agy acp` stdio (`src/acp-process.ts`) | `agy acp --worker` (`src/runtime/worker.ts:696`) |
| Agent definition | generated `pi-bridge` agent with every built-in tool removed (`src/preflight.ts:1-9`) | generated `magpie-bridge` agent with `tools: []` (`src/runtime/worker.ts:533-541`) |
| Tool channel | loopback Streamable HTTP MCP, **SSE-first with keepalives and progress** (`src/mcp-bridge.ts:1-10,343-380`) | loopback Streamable HTTP MCP, single JSON response, 15-minute park (`src/mcp/broker.ts:57`) |
| Errors | 7 stable codes (`src/runtime.ts:1500-1541`) | status + `error.type` + wording chosen for Magpie's router (`src/runtime/diagnostics.ts`) |
| Accounts | one | pooled |

## What to adopt — the MCP response shape

This is the single most useful thing in the four repositories.

> "Calls answer with a server-sent-event stream so response headers leave immediately; the
> agent's HTTP client otherwise abandons a request after 60 seconds without headers. Comment
> frames and MCP progress notifications keep long Pi tool runs (approvals, subagents, builds)
> visibly alive." (`src/mcp-bridge.ts:1-9`)

They send `: keepalive` comments on an interval and a `notifications/progress` per
`progressToken` (`src/mcp-bridge.ts:85,343-380`).

Why it matters here: our broker parks the client's `tools/call` HTTP request and returns one
JSON body when the result arrives (`src/mcp/broker.ts:57`), so a slow tool is bounded by our
15-minute deadline and by whatever the agent's HTTP client tolerates — and we do not know
which. Their design removes the guess: the headers are sent immediately, and progress keeps
the connection alive while the tool runs.

Concretely: send `Content-Type: text/event-stream` with an opening comment frame from our MCP
`tools/call` handler (`src/mcp/http-server.ts`), emit `notifications/progress` when the broker
exposes a `progressToken`, and end with the existing result as a single SSE `message` event.

## Second: the output-cap notice

They classify agy's "previous response was cut off … please continue from where you left off"
notice into `drop | hold | emit`, normalizing `⚠`, `Error:` and whitespace first so a notice
split across chunks is still recognized (`src/conversation.ts:28-60`). We strip the retry
notice and hold terminal markers, but we know nothing about this one: today it reaches the
caller as text.

## Third: their error precedence

`RATE_LIMIT` is tested before `QUOTA` (`src/runtime.ts:1528-1536`), so a bare
`RESOURCE_EXHAUSTED (code 429)` becomes a rate limit and only a message that also names
`quota|limit reached|exceeded your` becomes a quota. That is the same conclusion our 0.1.8 work
reached by a different route (`src/runtime/diagnostics.ts`), and it is worth citing as
independent agreement.

## What we do better

- Their `tools/call must be sent alone` and `-32601` for anything else (`src/mcp-bridge.ts:320-327`)
  is stricter than the MCP spec; we accept notifications alongside calls.
- No multi-account, no quota attribution, no isolation between accounts.
- Their error codes carry no client-visible text discipline: nothing equivalent to our
  "no limit wording in a non-limit body" rule (they do not answer a router that reads wording).
- They know the retry and output-cap notices but not `agy`'s terminal ones (the generic
  "Agent execution terminated" line, the dead-connection line, the spent-credit line): a search
  of the tree finds none of them.

## Open question this raises for us

If our MCP `tools/call` is not SSE, a long tool call is bounded by our 15-minute park
(`src/mcp/broker.ts:57`). Their comment says the agent abandons after 60 s *without headers* —
which suggests the agent tolerates a long body once headers arrive. We should measure that
before changing our transport, and the measurement is cheap: a test tool that sleeps 200 s.
