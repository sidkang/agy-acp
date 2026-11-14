# `@tian.zuo/pi-antigravity` vs this plugin

Second pass over the same checkout, read against `/Users/sid/Devs/antigravity-magpie` (`99de26c3`,
0.1.9). Companion to `tianzuo555-pi-antigravity.md`.

## Where we differ

| Axis | Them | Us |
|---|---|---|
| Host | pi extension (`pi-ai` provider) | Magpie plugin serving Anthropic HTTP |
| Upstream channel | persistent `agy` **stream-json** process (`src/provider.ts:1-9`) | `agy acp --worker` + ACP JSON-RPC (`src/runtime/worker.ts:696`) |
| Tool channel | loopback MCP HTTP, `pi__<name>`, re-attach on the next request (`lib/bridge.ts:1-21`) | ACP `mcpServers` HTTP + broker parking (`src/runtime/worker.ts:696`, `src/mcp/broker.ts:57`) |
| Thinking text | none available in stream-json; empty block + `thinking_tokens` (`src/provider.ts:7-9,164,608`) | real ACP `agent_thought_chunk` text; UUID-shaped signature (`src/protocol/anthropic.ts`) |
| Errors | pi `stopReason: "error"`, no codes (`src/provider.ts`) | full class → status/message mapping for Magpie's router (`src/runtime/diagnostics.ts`) |
| Accounts | one CLI identity | pooled accounts, per-account isolated HOME, quota routing |
| Version gate | `MIN_AGY_VERSION = "1.1.22"` enforced (`lib/agy-diagnostics.ts:12`) | declared in README only |

## What to adopt

1. **The binary gate we skipped.** They resolve the binary (override/path/managed), run
   `--version`, and classify `not-found | permission-denied | timeout | spawn-failed |
   invalid-version | unsupported-version` (`lib/agy-diagnostics.ts:14-21`), failing with the
   candidate list in the message. We have the same need: our ACP handshake assumes
   `mcpCapabilities.http` and `session/resume`, and today a stale `agy` fails deep in a turn
   instead of at startup. Add the same six categories around our existing capability probe in
   `src/runtime/worker.ts`.
2. **Fingerprint-keyed cache revision.** Their candidate fingerprint is
   `binary:size:mtimeMs:ctimeMs` and the whole report is hashed into a `revision`
   (`lib/agy-diagnostics.ts:108-120`). We already fence the catalog on
   `getAgyBinaryFingerprint()` (`src/usage/catalog.ts:617`) — their extra step is to hash the
   *resolution* as well, so a changed `agy` path invalidates too, not only a changed binary.
3. **Fail-closed parked calls.** Their bridge handler never answers from its own side: it
   blocks until the provider hands back the executed result, or fails (`lib/bridge.ts:17-19`).
   Worth checking our broker's deadline path does the same (it does: `src/mcp/broker.ts:57`),
   but their explicit statement documents it as a contract.
4. **A cap below the upstream's own timeout.** "Per-call cap; must stay below agy's 600s turn
   timeout so agy can still report the failure" (`lib/bridge.ts:29`). Our 15-minute broker
   deadline (`src/mcp/broker.ts:57`) is *above* the 600 s they measured — if `agy`'s turn
   timeout applies to ACP too, we park past the point where `agy` gives up. That is a testable
   claim, and one line to change.

## What we do better

- Their thinking story is a no-op block that carries a token count (`src/provider.ts:403-416`);
  ours carries the real summary and a signature shaped so clients keep it.
- No failure classification at all: everything is one `stopReason: "error"`.
- Single account, so nothing like our per-account workers, quota attribution or ladder.

## Not worth copying

- Signal-based task sweeping because stream-json has no stop channel (`README.md:32`) — ACP
  gives us `session/cancel`.
- Compaction inferred from a context-footprint drop (`lib/agy-compaction.ts:3-30`).
