# zacbemis/pi-antigravity-acp-provider

Studied at the repository's default branch, shallow clone. Citations are relative to the
repository root (~3.5k lines of `src`, plus 19 design documents in `docs/`). This one is the
most SDK-native and the most conservative about losing information.

## 1. What it is

A **pi extension** over the **ACP SDK** (`@agentclientprotocol/sdk`) that talks to a
Google-provided `agy_acp_server` runtime, not to a user-installed CLI wrapper. It manages
that runtime itself: download/install with an integrity manifest, executable repair, a
supervisor script, headless OAuth. Authentication goes through a credential-storage resolver
and an OAuth flow that replaces the browser command with a private capture helper
(`src/acp/headless-oauth.ts:16`, `src/acp/setup.ts:104-189`,
`src/acp/runtime-manifest.ts:32-72`).

## 2. Transport and process model

| Aspect | Implementation |
|---|---|
| Protocol | ACP through the SDK: `session.new` / `session.load` / `session.resume`, each taking `cwd` and `mcpServers` (`src/acp/connection.ts:173-219`) |
| Spawn | own `spawn` wrapper with 16 KiB stderr ring, 1.5 s kill grace matched to `supervisor.mjs` ("longer than supervisor's 750 ms agent-tree escalation") (`src/acp/process.ts:12-14`) |
| Environment | proxy and credential-storage environment applied per child (`src/acp/process.ts:10-11`, `src/acp/proxy.ts`, `src/acp/credential-storage.ts`) |
| Runtime identity | managed binary `agy_acp_server.par` / `.exe` plus a signed manifest checked before use (`src/acp/integrity.ts:9`, `src/acp/runtime-manifest.ts:32-72`) |
| Warmth | session store with locks (`src/acp/session-store.ts`, `store-lock.ts`) and a resume→load→new fallback chain (`src/runtime.ts:801-826`) |

## 3. Tool channel

A **real MCP server** built on `@modelcontextprotocol/sdk` with
`StreamableHTTPServerTransport`, exposed to ACP as one `McpServer` entry
(`src/mcp/bridge.ts:1-12`, `src/runtime.ts:801`):

- 1 MiB body limit, at most 64 tools (`src/mcp/bridge.ts:21-22`).
- Constant-time token comparison (`timingSafeEqual`, `src/mcp/bridge.ts:14`).
- Tool schemas are projected for the agent (`projectToolSchema`,
  `src/mcp/bridge.ts:19`, `src/mcp/schema.ts`), validated with typebox before dispatch
  (`Value.Check`, `src/mcp/bridge.ts:12`).
- A dedicated permission tool name is reserved for approval round-trips
  (`PERMISSION_TOOL_NAME`, `src/mcp/bridge.ts:18`).

## 4. Thinking / reasoning

- Thoughts are streamed as **pi's own** `thinking_delta` blocks through an event builder that
  enforces block invariants ("Pi thinking block invariant failed",
  `src/stream/pi-events.ts:18-55`).
- **`signature`: absent.** No `signature`, `signature_delta`, `thinkingSignature` or
  `redacted_thinking` exists in `src/`; the only "signature" is the runtime manifest's
  integrity signature (`src/acp/runtime-manifest.ts:32-72`).
- `thinking.type === "disabled"`: not applicable at the bridge; pi's thinking tiers are
  modelled in the catalog (`src/models.ts:44-166`, `thinkingLevelMap`).

## 5. Error handling

A closed set of codes instead of HTTP statuses, because the host is pi
(`src/acp/errors.ts:1-9`):

```ts
type AntigravityAcpErrorCode = "aborted" | "auth" | "model" | "protocol" | "quota"
  | "spawn" | "timeout" | "process_exit" | "invalid_input";
```

| Concern | Handling | Citation |
|---|---|---|
| redaction of diagnostics | proxy credentials, `Basic`, API keys, OAuth tokens, `Authorization`, `Cookie` all replaced before surfacing | `src/acp/errors.ts:30-60`, `test/errors.test.ts:1-25` |
| instructions too large | **fails** rather than truncating: `invalid_input` | `src/stream/context.ts:19-23` |
| prompt deadline | dedicated watchdog module | `src/acp/prompt-watchdog.ts` |
| stream bounds | bounded stream reader | `src/acp/bounded-stream.ts` |
| quota | its own error code plus a quota snapshot path | `src/acp/errors.ts:1-9`, `src/acp/quota.ts` |

`Retry-After` / `x-should-retry`: **absent** (no HTTP response is produced for the client).

## 6. Prompt handling

- **Instructions are never silently truncated**: if the pi system instructions exceed the
  byte ceiling the turn fails with `invalid_input` instead
  (`src/stream/context.ts:19-23`).
- **History is delivered as labelled, bounded sections**: a `HISTORY_HEADING` section and a
  `DELTA_HEADING` section for the unseen tail, with trailing tool results pinned so a
  continuation never loses them (`src/stream/context.ts:58-103`). The budgeting is credited
  to another project's "labelled history budgeting" (`:103`).
- **Compaction/cloaking: absent.** There is no trigger rewriting and no compaction event
  parsing; the design relies on the visible sections to keep the model oriented.
- **Images:** preserved across the handoff to the delta prompt (`src/stream/context.ts:82`).

## 7. Accounts / quota

Single signed-in account, with credential storage abstracted (keychain vs file) and a
headless OAuth helper (`src/acp/credential-storage.ts`, `src/acp/headless-oauth.ts:16`).
Quota comes from two places: `_meta.quota` on a prompt response
(`remainingRequests` / `requestLimit` / `resetTimestamp` / `tier`,
`src/status.ts:50-58`) and parsing the **markdown** `### Quota Limits` section of agy's
`/usage` reply, with buckets reported as units or "Available" deliberately skipped
(`src/acp/usage-quota.ts:14-24`). Model catalog maps tiers to pi's thinking levels
(`src/models.ts:44-166`).

## 8. Notable and fragile

**Worth stealing**
- Fail instead of truncating instructions: a silent clip is worse than an actionable error
  (`src/stream/context.ts:19-23`).
- Labelled `HISTORY` / `DELTA` sections with pinned trailing tool results
  (`src/stream/context.ts:58-103`) — a cheap way to make a flat prompt legible to the model.
- Signed runtime manifest plus executable repair before spawn
  (`src/acp/runtime-manifest.ts:32-72`, `src/acp/setup.ts:177`).
- A closed error-code set with redaction built into the message path
  (`src/acp/errors.ts:1-60`).
- `session.resume → load → new` fallback chain (`src/runtime.ts:801-826`).

**Looks fragile**
- Managing Google's runtime binary means owning download, integrity, permissions and
  version drift — much more surface than wrapping the user's `agy`
  (`src/acp/setup.ts:104-189`, `:421-428`).
- Quota parsed from a markdown section by regex; a wording change silently yields no buckets
  (`src/acp/usage-quota.ts:6-24`).
- Thinking is pi-native only, so a client that requires signed reasoning gets nothing
  (section 4).

## Open questions

- Whether the managed `agy_acp_server` release is a documented Google artifact or an
  inferred one; the code treats its version string as `agy_acp_server_<semver>`
  (`src/acp/setup.ts:421-428`).
- Whether `session.resume` exists on every runtime build; the fallback chain implies doubt
  (`src/runtime.ts:801-826`).
