# Research: four sibling Antigravity bridges

Four third-party bridges were cloned and read on 2026-11-14 to compare their
choices with `magpie-agy-acp` 0.1.10. Each project has three files:

| project | package | upstream | extraction | second pass (independent) | verdict pass (audit) |
|---|---|---|---|---|---|
| `TianZuo555/pi-extensions` | `@tian.zuo/pi-antigravity` 0.12.1 | `agy` stream-json | [`…md`](tianzuo555-pi-antigravity.md) | [`…-pass-ds.md`](tianzuo555-pi-antigravity-pass-ds.md) | [`…-pass-gpt.md`](tianzuo555-pi-antigravity-pass-gpt.md) |
| `fdkevin0/pi-agy-acp` | `pi-agy-acp` 0.1.3 | `agy acp` | [`…md`](fdkevin0-pi-agy-acp.md) | [`…-pass-ds.md`](fdkevin0-pi-agy-acp-pass-ds.md) | [`…-pass-gpt.md`](fdkevin0-pi-agy-acp-pass-gpt.md) |
| `EstebanForge/pi-extensions` | `@estebanforge/pi-antigravity-bridge` 1.10.6 | `agy acp` (default) + stream-json | [`…md`](estebanforge-pi-antigravity-bridge.md) | [`…-pass-ds.md`](estebanforge-pi-antigravity-bridge-pass-ds.md) | [`…-pass-gpt.md`](estebanforge-pi-antigravity-bridge-pass-gpt.md) |
| `zacbemis/pi-antigravity-acp-provider` | `pi-antigravity-acp-provider` 0.1.19 | managed `agy_acp_server` | [`…md`](zacbemis-pi-antigravity-acp-provider.md) | [`…-pass-ds.md`](zacbemis-pi-antigravity-acp-provider-pass-ds.md) | [`…-pass-gpt.md`](zacbemis-pi-antigravity-acp-provider-pass-gpt.md) |

The `-pass-gpt.md` files audit the extraction claim by claim (`confirmed` /
`wrong` / `unverifiable`) with the line checked. **Where they disagree, the
verdict pass wins**; the first extractions keep their errors on purpose, as a
record of what a single reading gets wrong. `zacbemis` also has an
[extra deep dive](zacbemis-pi-antigravity-acp-provider-deep-dive.md).

None of them is a Magpie plugin. All four plug into **pi** as a provider
extension, which decides several of their choices before they start.

## What their host choice gives them, and what ours costs

| | them (pi provider) | us (Magpie plugin, Anthropic HTTP) |
|---|---|---|
| thinking transport | a pi message part; **no signature field exists in any of the four** | a `thinking` block whose `signature` the real API verifies |
| error surface | `errorMessage` string plus `stopReason`; no HTTP statuses | HTTP status + `error.type` + body wording a router reads |
| retry policy | pi's, or none at all | Magpie's `retryable()`/`failure()`/`restID()`, by status *and* wording |
| multi-account | **absent in all four** | the reason this plugin exists |

The signature problem and the wording problem are **ours alone**: they are
created by the Anthropic shape, not by `agy`. Every sibling can answer "no
signature exists here" because pi never asks for one.

The four reasoning surfaces still differ, and the difference is worth knowing:
`tianzuo555` reserves a thinking slot and fills it with a synthetic label,
`Thought for <n>s, <k> tokens` (`src/provider.ts:606-648`); `fdkevin0` forwards
thought text but **drops historical reasoning from the replay transcript**
(`src/history.ts:139-145`); `zacbemis` forwards thought deltas and renders
`tool_call`/`plan` text as thinking; `estebanforge` renders native tool cards,
with thinking labels as a fallback (`src/provider.ts:1186-1258`). None of them
has the problem 0.1.9 solved with a UUID-shaped signature.

## ACP facts: what the siblings actually established

Three claims from the first extraction round did **not** survive audit, and they
matter because this repository used two of them as design inputs:

- **`session/cancel` answering `-32601`** was observed on one build
  (`agy_acp_server_20260818_01_RC01`, Linux, 2026-09-03) for an **id-bearing
  request**; the reference itself retires that guidance, and current code sends a
  **notification** (`estebanforge` `docs/ACP-PROTOCOL-REFERENCE.md:3,269-282`).
  Treat a cancel as best-effort and close on an unsettled turn, but do not
  restate "cancel does not exist" as a rule.
- **ACP carrying no usage fields** was an RC01 observation. Since at least agy
  1.5.3 the prompt response carries exact usage — `inputTokens`, `outputTokens`,
  `totalTokens`, optional `thoughtTokens`, `cachedReadTokens`
  (`estebanforge` `docs/ENGINES.md:7`, `src/acp/connection.ts:328-343,558-577`).
  Our SQLite step rows are therefore a choice, not the only source; see action 1.
- **The ~25 KB prompt-line cap** was measured on **agy 1.2.14 over stream-json**
  (`estebanforge` `CHANGELOG.md:247-248`, `src/sysprompt-agent.ts:1-10`). ACP
  deliberately keeps the inline block. Whether ACP has any size limit on 1.5.8 is
  **unverified** — including in our own render budget, which is our policy.

## Tool channel: all four use MCP, at three different seams

| project | seam |
|---|---|
| `fdkevin0` | loopback HTTP MCP, 16-byte tenant key + 24-byte bearer, constant-time compare; lifetime is the ACP session (`src/runtime.ts:761-778`, `src/mcp-bridge.ts:74-120`) |
| `zacbemis` | loopback MCP with `Authorization: Bearer` + `timingSafeEqual`, a schema projection that **drops a tool it cannot project** instead of widening it (`src/mcp/bridge.ts:107-142`, `src/mcp/schema.ts:14-40`) |
| `estebanforge` | ACP `mcpServers` with a header array plus a sanitized private MCP home; global MCP registration is now a fallback (`extensions/index.ts:316-353,964-975`) |
| `tianzuo555` | per-instance `pi-<12 hex>` MCP server name in a private config (`lib/mcp-config.ts:7-11`) |

Our seam (ACP `mcpServers` + loopback URL token) is the same one `estebanforge`
and `fdkevin0` use. Nobody here uses `--ide-mcp-port`/`nc`; that is specific to
the Magpie community plugin `agy-cli`.

## Long tool calls: the upstream gives up first

Both ACP bridges work around a deadline we currently ignore:

- `fdkevin0` races every parked call against a **default 85-second relay timer**
  and answers with a relay notice instead of blocking
  (`src/runtime.ts:1447-1466`, `src/config.ts:42-43`), because `agy` abandons a
  `tools/call` at roughly **180 seconds** (`src/mcp-bridge.ts:6-9`).
- `estebanforge` sends `STILL RUNNING` at 20 seconds and a `bridge_poll_result`
  escape, for the same reason (`docs/ACP-PROTOCOL-REFERENCE.md:355`).

Our broker parks the HTTP call for up to 15 minutes with no progress event. If
`agy 1.5.8` still abandons a tool call on a wall clock, the caller waits for a
result nobody will consume. That is the strongest single argument for a
progress/relay path, and it is cheaper than the "synthesize a result and ask the
model to repeat its arguments" trick used elsewhere.

## Timeouts: three of four bound inactivity, not total time

`zacbemis` arms a watchdog on progress with two budgets, 10 minutes idle and 60
minutes while work is outstanding (`src/acp/prompt-watchdog.ts`). `estebanforge`
caps a turn (TTY-aware, 0/20 minutes) and separately a stall (5 minutes), and
before failing it probes the transcript for an answer `agy` wrote but never
streamed (`src/parked-turn.ts:39-79`, stream-json only). `tianzuo555` runs a
stall ladder: bytes seen, a longer budget while a tool is active, positive `ps`
evidence, a few graces, then an off-stream verdict (`lib/agy-driver.ts:650-712,
736-787`). `fdkevin0` has **no** `session/prompt` timeout and no watchdog at all.

Our 30-minute wall clock is the direct cause of the 0.1.10 review's watchdog
defect. An inactivity watchdog is the shape that cannot have it.

## Quota: one of them parses the notice we treat as words

`zacbemis` matches the fixed exhaustion notice and derives a reset time
(`src/acp/quota.ts:4-9`):

```
Usage Limit Reached

You have reached your current quota for this period. Your limit will reset in 2 hours, 30 minutes.
```

That is a **named spent window with a reset instant**: our `quota` class, plus a
`Retry-After` that does not have to be guessed. It only recognizes this after the
reply, and only when `totalTokens === 0 || stopReason === "refusal"`
(`src/runtime.ts:653-662`); if the wording changes it degrades to a normal empty
answer, so it is a pattern to add, not a mechanism to trust alone.

`fdkevin0` is the counter-example: `429 … quota` still maps to `RATE_LIMIT`,
with no quota override (`src/runtime.ts:1534-1537`). Splitting the two classes is
our decision, and this research does not argue against it.

## Ranked actions, and where they stand

**Landed in 0.1.10** (see the commits that cite this file): the progress-armed
inactivity watchdog (action 2), failing instead of clipping an oversized raw turn
(action 4), the "Usage Limit Reached … reset in" window with its `Retry-After`
(action 5), and reading a turn's usage from the prompt result (action 1).

Landed, with what each one had to get right:

1. ~~Read usage from ACP before reading SQLite.~~ **Done, with a fallback.** A
   generating turn returns
   `{"stopReason":"end_turn","usage":{"inputTokens":8886,"outputTokens":30,
   "cachedReadTokens":0,"cachedWriteTokens":0,"thoughtTokens":29,"totalTokens":8916}}`,
   with `cachedReadTokens` populated on a warm turn, and the prompt result covers
   the whole turn, tool steps included: what a batch already reported is
   subtracted, and the step rows are skipped so a row that lands late is never
   read as the next turn's work. The one `usage_update` session update is context
   occupancy (`{"used":8916,"size":1048576}`), not a token breakdown.

   Two caveats from the probes: **a turn that produces no generation returns
   `{"stopReason"}` and no `usage` at all** (seen when the account answered with
   the vendor's suspension sentence), and the two probes ran on **different host
   logins** (the first on the account that was suspended, the second after the
   account was switched), so nothing here is a statement about one account's
   behaviour over time.

**Corrected from the first pass:** `agentCapabilities.mcpCapabilities` is `null`
on 1.5.9 — the agent does not advertise HTTP MCP at all, so the 0.1.9 guard fires
only on an explicit `false`, never on silence.

2. ~~Replace the 30-minute wall clock with a progress-armed inactivity
   watchdog.~~ Done: 10 minutes silent while generating, 60 minutes while a tool
   call is outstanding, and the wall clock demoted to a backstop.
**Still open:**

3. **Give a long tool call a progress or relay path.** The upstream abandons a
   `tools/call` before our 15-minute park expires (`fdkevin0`
   `src/mcp-bridge.ts:6-9`), and two siblings already handle it.
4. ~~Fail, never truncate, when the rendered prompt would lose information.~~
   Done for a raw oversized turn (400 with the overflow wording, so the client
   compacts); a client's own `<conversation>`-framed compaction request is still
   trimmed, as intended.
5. ~~Add the "Usage Limit Reached … reset in …" notice as a named-window pattern
   and a `Retry-After` source.~~ Done.
6. **Keep the ACP `mcpServers` seam.** The alternatives are the same protocol at
   a different layer, with more moving parts.

## Caveats

Read-only: no sibling project was executed, no account or login state touched, no
`agy` run. Every upstream observation they report is a dated probe on a specific
build (`agy` 1.2.14 stream-json, `agy_acp_server` RC01, `agy` 1.5.3 ACP); none is
a protocol guarantee, and none has been re-probed on our `agy 1.5.8`. The
`*-comparison.md` files were written against 0.1.9 (`99de26c3`); 0.1.10 changed
the terminal-notice corroboration, the prompt-refusal wording and the retry
storm's class, so a claim there about those three is one release out of date.
