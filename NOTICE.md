# NOTICE

`magpie-agy-acp` (provider ID `agy-acp`, `https://github.com/sidkang/agy-acp`) is an independent MIT-licensed fork and strict TypeScript rewrite derived from `@magpie-community/opencode-agy-cli-auth` (`magpie-community/plugins/packages/agy-cli`), originally created from `DylanLIiii/opencode-antigravity-bridge` with contributions by `gitxm` and `yce`.

Upstream copyright notices are preserved verbatim in [LICENSE](./LICENSE).

## Major Architectural Changes from `agy-cli`

- **Multi-account pool (`single: false`)**: Supports concurrent Google accounts via isolated `0700` credential directories (`SSH_CONNECTION` file-backed token storage) alongside optional adoption of the host `agy` login.
- **Native Streamable-HTTP MCP**: Registers authenticated per-session loopback HTTP MCP endpoints (`http://127.0.0.1:<port>/mcp/<token>`) directly in ACP `session/new` and `session/resume`, removing `PATH` `nc` binary shims.
- **Session affinity & mid-turn steering**: Tracks normalized conversation ledgers per `account + session`, supporting warm session reuse, LRU shelving with `session/resume`, Pi/Claude Code `steer` / `followUp` / `compact` recovery, and exact per-step WAL SQLite token/cache settlement.
