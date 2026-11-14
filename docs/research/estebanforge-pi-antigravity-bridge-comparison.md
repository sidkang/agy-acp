# `@estebanforge/pi-antigravity-bridge` vs this plugin

Second pass, read against `/Users/sid/Devs/antigravity-magpie` (`99de26c3`, 0.1.9).
Companion to `estebanforge-pi-antigravity-bridge.md`.

## Where we differ

| Axis | Them | Us |
|---|---|---|
| Engines | two: ACP (default) and stream-json, switchable (`docs/ENGINES.md:3-8`) | one: ACP with `--worker` |
| Minimum `agy` | 1.5.3 for ACP, with an installer offer (`docs/ENGINES.md:20-24`) | declared only |
| System prompt | agent file (stream-json) or prepended to the first turn (ACP); digest as `embeddedContext` (`docs/ENGINES.md:35-36`) | generated agent file + `systemPrompt.append` (`src/runtime/worker.ts:533-541`) |
| Tools | direct `mcpServers` + sanitized private MCP home (`docs/ENGINES.md:33`) | ACP `mcpServers` HTTP + broker |
| Thinking text | ACP yes, stream-json no (`docs/ENGINES.md:24`) | ACP yes |
| Cancel | `session/cancel`, teardown fallback (`docs/ENGINES.md:32`) | `session/cancel` + queue detach (`src/runtime/worker.ts` `abortUpstreamRetryStorm`) |
| Accounts | one | pooled, isolated homes |

## What to adopt

1. **Their ACP error shapes, verbatim.** `-32602` carries `data.errors[].loc` naming the field
   (`methodId`, not `method`; `configId`, not `configOptionId`), `-32000` carries server-state
   messages (`Authentication required`, `Onboarding failed`), `-32601` is an unimplemented
   method (`docs/ACP-PROTOCOL-REFERENCE.md:284-300`). We classify by *message text*
   (`src/runtime/diagnostics.ts`); adding the JSON-RPC code and `loc` makes a schema rename
   self-explaining instead of a mystery `INTERNAL` 500.
2. **`session/cancel` is version-dependent.** On the RC01 build it answers `-32601` and an
   in-flight prompt keeps running (`docs/ACP-PROTOCOL-REFERENCE.md:269-283`). We notify and
   assume it lands (`src/runtime/worker.ts`, `abortUpstreamRetryStorm`). Their fallback —
   tear the connection down and `session/load` next time — is the honest behaviour when the
   method returns `-32601`.
3. **Capability matrix as a design tool.** Their `docs/ENGINES.md` table is exactly the
   document we keep rewriting in prose: one row per capability, one column per channel, every
   cell verified live. Worth mirroring for our ACP-only design so the claims in
   `docs/claude-bridge-parity.md` are structured the same way.
4. **Parked-turn stall probe** (`src/parked-turn.ts:1-30`): a watcher for an answer that was
   written but never surfaced. We have no equivalent; our symptom would be a turn that ends
   with `end_turn` and no text.

## What we do better

- One engine, so no behavioural drift between two drivers.
- Account pooling, quota attribution, isolation: none of it exists there.
- Our error classification is built for a router that reads status *and* wording
  (`src/runtime/diagnostics.ts`), which their `stopReason` mapping never needs.

## Not worth copying

- The two-engine design: it doubles every behavioural claim. If we ever need stream-json it
  should be a separate spike, not a config switch.
- Prepending the system prompt to the first user turn: our generated agent file keeps the
  prompt out of the transcript, which matters for cache and for compaction.
