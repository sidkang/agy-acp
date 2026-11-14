# `zacbemis/pi-antigravity-acp-provider` — deep-dive note

Companion to `zacbemis-pi-antigravity-acp-provider.md` (the shorter note written in parallel): this one adds what that note does not cover and corrects one point — the upstream is **not** the `agy` CLI but Google's downloadable `agy_acp_server` runtime.

Studied at commit `1598d38` (2026-11-12, "chore(runtime): approve Antigravity ACP 1.5.0"), package version `0.1.19` (`package.json:3`). Read-only inspection of a fresh clone; nothing was executed.

## 1. What it is

A **Pi provider extension**, not an HTTP proxy: `pi.extensions` → `./extensions/index.ts` (`package.json:33-37`), and a `Provider` object built in `src/provider.ts:22-24`. Pi calls it in-process and receives Pi's own `AssistantMessageEventStream`, so there is no Anthropic wire shape, no `signature_delta`, and no HTTP status mapping anywhere in the project.

Upstream is Google's **`agy_acp_server`** (a `.par` binary plus a `localharness_external` companion), pinned per platform in `runtime-manifest.json:4-40` with `archiveSha256` from `https://dl.google.com/agy-extensions/releases/...`; the manifest itself is Ed25519-signed and verified at `src/acp/runtime-manifest.ts:54-72`. Launch resolves that runtime and starts it under a supervisor (`src/acp/process.ts:140-155`). Auth is the user's existing Antigravity credential: `src/acp/antigravity.ts:90,125,132`. There is **no multi-account pool** anywhere in `src/` — one identity per Pi install.

## 2. Transport and process model

| Concern | Implementation |
|---|---|
| Transport | ACP over stdio via `@agentclientprotocol/sdk` 2.2.0 (`src/constants.ts:5`), custom NDJSON adapter |
| Frame limit | `DEFAULT_MAX_FRAME_BYTES = 32 MiB`; malformed frames fail the transport (`src/acp/bounded-stream.ts:3,16-22`) |
| Processes | one ACP server child per session binding, through `supervisor.mjs` (`src/acp/process.ts:140-155`) |
| Supervision | stdio proxy, agent spawned `detached` so a watchdog can kill the group, parent-pid watch, hard-kill timer (`src/acp/supervisor.mjs:20-40`) |
| Warm sessions | persisted record `{piSessionId, acpSessionId, acpModelId, cwd, messageCount, historyFingerprint, expectedAssistantFingerprint, lastActive}`, LRU 256 / 30 days (`src/acp/session-store.ts:6-25`) |
| Cross-process safety | whole read-modify-rename under `proper-lockfile`, `stale: 30_000`, 5 s deadline (`src/acp/store-lock.ts:4-16`) |
| Turn serialization | one queue per session key in-process (`src/runtime.ts:572-578`) |

## 3. Tool channel

In-process MCP over Streamable HTTP — the same channel we use, with a bearer header rather than a path token:

- descriptor `{ type: "http", name: "pi-bridge", url: "http://127.0.0.1:<port>/mcp", headers: [{ name: "Authorization", value: "Bearer <token>" }] }` (`src/mcp/bridge.ts:107-113`); token is a dash-stripped UUID (`:69`), compared with `timingSafeEqual` (`:209`), 1 MiB body cap (`:19`), `maxConnections = 8` (`:90`).
- stateless per request: a fresh MCP `Server` + `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })` per POST; only `POST /mcp` (`src/mcp/bridge.ts:118-160`).
- projection: `pi_<name>`, ≤64 chars, ≤64 tools; a schema it cannot represent **omits the tool whole** and reports why (`src/mcp/bridge.ts:170-190`, `src/mcp/schema.ts:28-40`).
- arguments are validated at call time against the **original** Pi schema (`Value.Check(tool.originalSchema, args)`, `src/mcp/bridge.ts:142`), so projection loss cannot widen what the tool accepts.
- schema budget: 64 KiB, 100k work units, depth 16, ancestry WeakSet for cycles (`src/mcp/schema.ts:5-8,41-52`).

## 4. Thinking / reasoning

`agent_thought_chunk` → `{ type: "thought", delta }` (`src/acp/events.ts:18-21`) → Pi thinking block with **no signature field at all**: `block.thinking += delta` plus a `thinking_delta` event (`src/stream/pi-events.ts:52-58`); the close event carries only the text (`:130-142`).

- `signature`: **absent**. `rg signature src/` finds only the runtime-manifest Ed25519 signature (`src/acp/runtime-manifest.ts:32-72`); nothing fabricates or forwards an Anthropic signature.
- `thinking.type === "disabled"`: **not handled**; reasoning is driven through Pi's `thinkingLevelMap`/effort (`src/models.ts:44,105-120`) and the provider forwards whatever Antigravity streams.
- Consequence on a Pi→Claude handoff: unsigned thinking is what Pi 1.5.0 downgrades to plain text when `allowEmptySignature` is false — the same trade-off as our `""`, with no fabricated provenance (and none of the replay benefit our UUID scheme buys).

## 5. Error handling

No HTTP layer: a typed code plus a redacted message.

| Code | Meaning | Cited |
|---|---|---|
| `aborted` | cancellation | `src/acp/errors.ts:2` |
| `auth` | sign-in / credential | `:3` |
| `model`, `protocol` | selector mismatch, malformed ACP | `:4-5` |
| `quota` | account out of quota | `:6` |
| `spawn`, `timeout`, `process_exit` | lifecycle | `:7-9` |
| `invalid_input` | request cannot be represented | `:10` |

- `redact()` strips URL userinfo, `AIza`/`sk-`/`npm_`/`gh[opurs]_`, `ya29.`/`1//`, `authorization`/`cookie`/`set-cookie`, and JSON `access_token|refresh_token|id_token|client_secret|api_key`, then caps at 4 KiB (`src/acp/errors.ts:30-45`) — a wider vocabulary than our `redactSecrets`.
- quota is detected **before the turn is persisted**, and only when `usage.totalTokens === 0 || stopReason === "refusal"`: the reply text is then matched against the fixed notice plus reset arithmetic (`src/runtime.ts:653-662`, `src/acp/quota.ts:4-9`). A quota refusal therefore never enters history as an answer.
- stop reasons: `cancelled` → abort; `max_tokens`/`max_turn_requests` → `length`; everything else → `stop` (`src/runtime.ts:676-684`) — a refusal without the quota notice is reported as a normal stop.
- no `Retry-After`, no `x-should-retry`, no statuses: they do not exist in a Pi stream.

## 6. Prompt handling

- **Fresh session**: one prompt of `# Pi session instructions` + a bounded untrusted-history section + the current user turn last (`src/stream/context.ts:63-75`, current turn `:83-92`).
- **Warm session**: only messages unseen by the session go out as a delta section (`:76-81`); when the session already saw the request, only new tool results and `WARM_CONTINUATION` (`:78`).
- **Budgets**: history `MAX_RECONSTRUCTION_CHARS = 32_000` (`:6`), instructions `MAX_INSTRUCTION_BYTES = 256 KiB` (`:7`); instructions are **never truncated** — over budget throws `invalid_input` (`:27-32`), and a current tool turn that cannot fit throws too (`:119`).
- warm identity: `messageCount` + `messagesFingerprint(prefix)` must match exactly, plus `expectedAssistantFingerprint` to skip the assistant message the model itself produced (`src/runtime.ts:587-596,610-618`).
- **cloaking/rewriting: absent**; the only text adaptation is labelling (`HISTORY_HEADING`, `CONTINUATION_LABEL`) and model/effort selection.
- images pass through as ACP image blocks of the current turn (`src/stream/context.ts:88-90`); no resizing anywhere.

## 7. Accounts / quota

- single identity; no pool, rotation or cooldown.
- `/usage` is parsed from Markdown: `### Quota Limits`, `**Group**`, `**label:** N% remaining (resets …)` → `{window: "5h"|"weekly"|label, remainingFraction, resetTime}` (`src/acp/usage-quota.ts:20-30`); no groups → protocol error (`:39`).
- catalog: static fallback plus live projection of Antigravity's model/thought selectors into Pi model ids and `thinkingLevelMap` (`src/models.ts:17-40,74-104`).
- per-turn usage comes from ACP `_meta.quota.token_count`, with an explicit correction for Antigravity double-counting cache reads when the turn made exactly one inference (`src/runtime.ts:663-672`).
- credential storage is delegated to the server's own switch, `AGY_ACP_FORCE_FILE_STORAGE` (`src/acp/credential-storage.ts:8`), plus a macOS keychain probe for `service=gemini, account=antigravity-acp` (`:12-13`).

## 8. Worth stealing / fragile

Worth stealing:

1. `AGY_ACP_FORCE_FILE_STORAGE` (`src/acp/credential-storage.ts:8`) — the server's own knob for file-backed credentials, instead of our `SSH_CONNECTION` marker hack.
2. Inactivity-based prompt watchdog with separate idle and busy windows, `unref()`ed (`src/acp/prompt-watchdog.ts:6-10,29-42`) — the shape our total-duration timer lacks, since ours can expire mid-tool-call and leave the native generation alive.
3. Exact history identity (`src/runtime.ts:587-596,610-618`) replacing tolerant tool-argument matching.
4. Never truncate instructions; throw `invalid_input` instead (`src/stream/context.ts:27-32,119`).
5. Quota gate before persisting the turn, conditioned on zero usage or `refusal` (`src/runtime.ts:653-662`).
6. Bearer header + per-request stateless transport for the loopback MCP endpoint (`src/mcp/bridge.ts:107-160`).
7. Whole-tool omission on schema failure with call-time validation against the original schema (`src/mcp/schema.ts:28-40`, `src/mcp/bridge.ts:142`).
8. `proper-lockfile` around the session store's read-modify-write (`src/acp/store-lock.ts:4-16`) — the cross-process claim our shelf store lacks.
9. `redact()` vocabulary at `src/acp/errors.ts:30-45`, which covers shapes our `redactSecrets` misses (`sk-`, `npm_`, `gh*_`, cookie headers).

Fragile / narrow:

1. Pinned runtime: a newer Antigravity release needs a catalog update, and artifacts are 280–930 MB per platform (`runtime-manifest.json:4-40`).
2. Single identity: no failover, no per-account gating.
3. A refusal without the fixed quota notice becomes a normal `stop` (`src/runtime.ts:676-684`).
4. No prompt cloaking, so Claude-Code/Codex trigger lines are refused upstream and surface as generic failures.
5. `refusal`-gated quota detection depends on one exact wording (`src/acp/quota.ts:4-9`); a reworded notice silently becomes a normal reply.
