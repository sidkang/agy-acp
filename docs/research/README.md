# Research: four sibling Antigravity bridges

Four third-party bridges were cloned and read on 2026-11-14 to compare their
choices with `magpie-agy-acp` 0.1.10. One file per project:

- [`tianzuo555-pi-antigravity.md`](tianzuo555-pi-antigravity.md) — `@tian.zuo/pi-antigravity` 0.12.1, stream-json.
- [`fdkevin0-pi-agy-acp.md`](fdkevin0-pi-agy-acp.md) — `pi-agy-acp` 0.1.3, ACP.
- [`estebanforge-pi-antigravity-bridge.md`](estebanforge-pi-antigravity-bridge.md) — `@estebanforge/pi-antigravity-bridge` 1.10.6, ACP + stream-json, with a live-verified ACP reference.
- [`zacbemis-pi-antigravity-acp-provider.md`](zacbemis-pi-antigravity-acp-provider.md) — `pi-antigravity-acp-provider` 0.1.19, ACP, signed runtime manifest, inactivity watchdog.
  - deeper extraction: [`zacbemis-pi-antigravity-acp-provider-deep-dive.md`](zacbemis-pi-antigravity-acp-provider-deep-dive.md) — its upstream is Google's downloadable `agy_acp_server` runtime rather than the `agy` CLI, its loopback MCP endpoint authenticates with a bearer header, warm-session identity is an exact history fingerprint, instructions are never truncated (it throws `invalid_input`), a quota reply is rejected before it is persisted, and the session store is guarded by `proper-lockfile`.

None of them is a Magpie plugin. All four plug into **pi** as a provider
extension, which decides several of their choices before they start.

## What their host choice gives them, and what ours costs

| | them (pi provider) | us (Magpie plugin, Anthropic HTTP) |
|---|---|---|
| thinking transport | a pi message part; no signature field exists | a `thinking` block whose `signature` the real API verifies |
| error surface | a typed exception (`LlmError`, code enum) | HTTP status + `error.type` + body wording a router reads |
| retry policy | pi's, per provider | Magpie's `retryable()`/`failure()`/`restID()`, by status *and* wording |
| multi-account | absent in all four | the reason this plugin exists |

So the signature problem this repository spent 0.1.9 on is **ours alone**: it is
created by the Anthropic shape, not by `agy`. `tianzuo555` says it outright —
"agy never streams thought text (print mode exposes counts only)"
(`tianzuo555` `src/provider.ts:162-164`) — while the ACP-based ones forward
thought text as pi reasoning (`fdkevin0` `src/conversation.ts:258-261`,
`estebanforge` `docs/ENGINES.md:26-30`).

The error problem is also ours alone, and it is the harder one: every sibling
can throw one exception. We have to choose a status and words that a router
reads *as a budget claim*, which is exactly the mechanism of the 2026-11-14
incident.

## Transport: two engines, and what they disagree about

- **stream-json** (`tianzuo555`, `estebanforge`'s alt engine) runs one `agy` per
  turn with `--conversation <id>` and `--print`, and has a **~25KB prompt-line
  cap**: a longer single prompt is dropped with SUCCESS, an empty response, and
  no error, and a conversation whose turn was dropped never answers again
  (`estebanforge` `CHANGELOG.md:247`). Their fix is to stage the system block as
  an `agy` agent file and pass `--agent`, since agent files are read from disk.
- **ACP** carries no such cap — "ACP keeps the inline block: the JSON-RPC
  transport has no cap" (`estebanforge` `CHANGELOG.md:247`). Our 112 KiB render
  budget in `src/sessions/prompt-render.ts` is therefore a **policy choice for
  lens and cost, not an upstream limit**; the review's complaint about silent
  clipping stands on its own merits, not on a hidden cap.

Two live ACP facts worth keeping, from `estebanforge`'s captured reference
(`docs/ACP-PROTOCOL-REFERENCE.md:269-300`):

- `session/cancel` answers `-32601 Method not found` on the RC01 build, and an
  in-flight `session/prompt` **cannot be stopped over the protocol** — a 3000
  number stream ran to completion after the cancel returned. Anything that
  depends on a cancel settling must also close the connection.
- ACP reported **no usage fields anywhere** (`initialize`, `session/new`,
  `agent_message_chunk`, prompt results) on that build, which is why our usage
  comes from `agy`'s SQLite step rows rather than from the protocol.

## Quota: one of them parses the notice we treat as words

`zacbemis` matches the fixed exhaustion notice in the response text and derives
a reset time from it (`src/acp/quota.ts:1-22`):

```
Usage Limit Reached

You have reached your current quota for this period. Your limit will reset in 2 hours, 30 minutes.
```

It also accepts an absolute form (`Your limit will reset on Sep 4, 2026 12:30 UTC`).
That is a **named spent window with a reset instant**: exactly the class our
`quota` verdict wants, and a source for `Retry-After` that is better than
guessing from `retrying in 4s`. Worth adopting the exact wording as an
additional pattern (our current `EXHAUSTED_QUOTA_RE` does not match
"Usage Limit Reached").

## Timeouts: two of them bound inactivity, not total time

`zacbemis` `src/acp/prompt-watchdog.ts:1-25` arms on progress with two budgets —
an idle one and a longer one while work is outstanding — and fires when nothing
moves. `fdkevin0` keeps a per-turn deadline plus the CLI's `--print-timeout`
(`lib`-equivalent `src/runtime.ts`). Our 30-minute wall clock is the direct
cause of the defect the 0.1.10 review found (`worker.ts` watchdog expiring while
awaiting tool results, then starting a second `session/prompt` on a live native
session). An inactivity watchdog is the shape that does not have that failure.

`estebanforge`'s "parked turn" probe is the complementary idea: when a turn
falls silent, read the conversation transcript tail and settle with an answer
that `agy` wrote but never streamed (`src/parked-turn.ts:1-30`). It is
stream-json only, and their sweep found 96.6% of `PLANNER_RESPONSE` steps carry
tool calls, so the probe requires the newest step to be a tool-free response.

## Tool channel: all four use MCP, at three different seams

| project | seam |
|---|---|
| `fdkevin0` | loopback HTTP MCP with a per-tenant bearer token, tool names `mcp_<server>_<tool>` (`src/mcp-bridge.ts:74-120`, `src/history.ts:17-20`) |
| `zacbemis` | ACP MCP bridge plus a schema projection with explicit omission reasons (`src/mcp/schema.ts:14-29`) |
| `estebanforge` | ACP: direct `mcpServers` + a sanitized private MCP home; stream-json: per-session MCP home via `--gemini_dir` (`docs/ENGINES.md:42-43`) |
| `tianzuo555` | an MCP directory handed to the turn, `agy` calls through `call_mcp_tool` (`index.ts:407`, `src/provider.ts:212-224`) |

Our choice (ACP `mcpServers` with a loopback URL) is the same seam as
`estebanforge`'s ACP engine and `fdkevin0`. Nobody uses `--ide-mcp-port`/`nc`
here — that trick is specific to `agy-cli` (the Magpie community plugin).

## Ranked actions this research suggests

1. **Adopt the "Usage Limit Reached … Your limit will reset in …" notice** as a
   named-spent-window pattern and as a `Retry-After` source (`zacbemis`
   `src/acp/quota.ts`). Cheap, and it removes another way for a real window to be
   answered as a plain `429`.
2. **Replace the 30-minute wall clock with an inactivity watchdog** (two budgets,
   progress-armed). It retires the 0.1.10 review's watchdog defect by design
   rather than by patching (`zacbemis` `src/acp/prompt-watchdog.ts`).
3. **Treat `session/cancel` as best-effort** and close the connection when it is
   not settled, because some ACP builds answer `-32601` and keep generating
   (`estebanforge` `docs/ACP-PROTOCOL-REFERENCE.md:269-283`).
4. **Consider a parked-turn probe** for the "turn was answered but nothing
   streamed" class, if it ever shows up in our own logs. It is transcript-shaped
   and stream-json-specific, so it is a fallback, not a design.
5. **Keep the ACP `mcpServers` seam**; the alternatives in the wild are the same
   protocol at a different layer, with more moving parts.

## Caveats

Read-only: no sibling project was executed, no account or login state touched.
Each per-project file states its own scope, and quotes only what was read. The
`*-comparison.md` files were written against 0.1.9 (`99de26c3`); 0.1.10 changed
the terminal-notice corroboration, the prompt-refusal wording and the retry
storm's class, so a claim there about those three is out of date by one
release. The ACP `mcpServers` response shape, the quota notice and the
inactivity watchdog below are unaffected.
`tianzuo555` and `fdkevin0` were read at file level rather than line by line;
their `lib/`-scale detail is only partially covered.
