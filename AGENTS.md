# AGENTS.md — `agy-acp`

Multi-account Antigravity ACP (`agy acp`) provider plugin for Magpie (`yetone/magpie`), forked and rewritten in TypeScript from `@magpie-community/opencode-agy-cli-auth` (`packages/agy-cli`).

## Commands

- Typecheck: `bun x tsc --noEmit`
- Unit & offline integration tests: `bun test`
- Install into Magpie: `magpie plugin add /Users/sid/Devs/antigravity-magpie`

## Architecture

- `src/index.ts` & `src/options.ts`: Magpie plugin entry (`id: "agy-acp"`, `single: false`, `auth.loader`, `auth.usage`, `provider.models`, `chat.headers` injecting `x-agy-session-id`).
- `src/accounts/{env,auth}.ts`: Centralized `spawnAgy` / `execAgyBounded` child-process isolation (`mode: "host"` adopts existing local `agy` login; `mode: "isolated"` creates `0700` per-account `HOME` + `SSH_CONNECTION` marker to force `agy` file-backed token storage without OS Keychain contention).
- `src/mcp/{http-server,broker}.ts` & `src/mcp/schema/*`: Loopback Streamable-HTTP MCP server (`POST /mcp/:token`), cross-HTTP-turn parked tool calls, 30ms parallel batching + late sibling queueing, `tool_choice: none` cache-preserving guard, and Gemini/RE2 JSON Schema sanitization.
- `src/runtime/{acp-connection,worker,scheduler}.ts` & `src/sessions/coordinator.ts`: NDJSON ACP client, explicit worker state machine (`STARTING -> IDLE -> GENERATING -> AWAITING_TOOL_RESULTS -> CLOSED`), fair global/per-account scheduler, and transcript-ledger session coordinator.
- `src/protocol/anthropic.ts`: Anthropic Messages request validator and spec-compliant JSON/SSE response encoder.
- `src/usage/{catalog,quota}.ts`: Per-account (`accountRef::slotKey`) model catalog & `/usage` quota window parser.

## Operational Safeguards

- **Never spawn `agy` directly outside `src/accounts/env.ts`**: Every `agy` subprocess must enforce browser suppression (`BROWSER=/usr/bin/false` + `bin-shims/{open,xdg-open}`) and `AGY_CLI_DISABLE_AUTO_UPDATE=true`.
- **Never touch `~/.gemini` or OS Keychain in automated tests**: Always set `AGY_ACP_DATA_DIR` / `ANTIGRAVITY_MAGPIE_DATA_DIR`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME` to isolated `/tmp` paths, and prefer `test/fixtures/fake-acp.ts` for automated tests; for live `agy` smoke tests use `gemini-3.8-flash-low` or `gemini-4-hydrogen-low`.
- **Version control**: `.jj/` is present; use `jj` rather than `git`.
