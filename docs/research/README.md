# Research: sibling Antigravity bridges

Four third-party bridges to Google Antigravity were cloned and read on 2026-11-14 and compared
with `magpie-agy-acp` 0.1.9-0.1.10. All four are pi provider extensions; none is a Magpie plugin.
Nothing was executed: no sibling code, no `agy`, no account or login state.

| Project | Package | Upstream | Document |
|---|---|---|---|
| `TianZuo555/pi-extensions` | `@tian.zuo/pi-antigravity` 0.12.1 | `agy` stream-json | [tianzuo555-pi-antigravity.md](tianzuo555-pi-antigravity.md) |
| `fdkevin0/pi-agy-acp` | `pi-agy-acp` 0.1.3 | `agy acp` | [fdkevin0-pi-agy-acp.md](fdkevin0-pi-agy-acp.md) |
| `EstebanForge/pi-extensions` | `@estebanforge/pi-antigravity-bridge` 1.10.6 | `agy acp` (default) + stream-json | [estebanforge-pi-antigravity-bridge.md](estebanforge-pi-antigravity-bridge.md) |
| `zacbemis/pi-antigravity-acp-provider` | `pi-antigravity-acp-provider` 0.1.19 | managed `agy_acp_server` | [zacbemis-pi-antigravity-acp-provider.md](zacbemis-pi-antigravity-acp-provider.md) |

The side-by-side matrix and the status of every idea taken from them:
[comparison.md](comparison.md). Open items: [`../plan.md`](../plan.md). How the research was
done and what it changed: the research history in [`CHANGELOG.md`](../../CHANGELOG.md).

## Durable conclusions

1. The host decides most of the design. A pi provider never produces an HTTP status, a
   router-read error body, or a verifiable thinking signature, and none of the four handles more
   than one account. This plugin's signature and wording problems come from serving the Anthropic
   shape to Magpie's router, not from `agy`.
2. All five projects reach the caller's tools through MCP. The ACP `mcpServers` seam this plugin
   uses is the one fdkevin0, estebanforge and zacbemis use; keep it.
3. Upstream behavior the siblings report is dated and build-specific: `session/cancel` answering
   `-32601` (RC01), no usage in ACP (RC01), the ~25 KB prompt drop (`agy` 1.2.14, stream-json),
   the ~180 s MCP call abandonment (2026-09-05). None was re-probed on `agy 1.5.8`; none is a rule.
4. Inactivity, not total duration, is the right shape for a turn watchdog: three of the four bound
   inactivity, and this plugin moved to an inactivity watchdog in 0.1.10.
5. The remaining structural gap is long tool calls: two ACP siblings work around an upstream
   deadline on `tools/call` that this plugin's 15-minute park ignores. Whether that deadline exists
   on 1.5.8 is the first thing to measure.
6. Splitting a spent window (`quota`) from a bare throttle (`rate_limit`) is this plugin's
   decision; fdkevin0 folds `429 ... quota` into its rate-limit class, zacbemis recognizes only
   one exact exhaustion notice. Nothing here argues against the split.
