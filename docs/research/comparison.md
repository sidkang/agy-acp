# Sibling bridges compared with `agy-acp`

One matrix for the four bridges in this directory and this plugin, then the status of every idea
taken from them. Facts about a sibling are cited in its own document; this file cites only this
repository (`agy-acp:` paths, current working tree at 0.1.10, line numbers checked 2026-11-14).

| Short name | Document | Package at the commit read |
|---|---|---|
| tianzuo555 | [`tianzuo555-pi-antigravity.md`](tianzuo555-pi-antigravity.md) | `@tian.zuo/pi-antigravity` 0.12.1 |
| fdkevin0 | [`fdkevin0-pi-agy-acp.md`](fdkevin0-pi-agy-acp.md) | `pi-agy-acp` 0.1.3 |
| estebanforge | [`estebanforge-pi-antigravity-bridge.md`](estebanforge-pi-antigravity-bridge.md) | `@estebanforge/pi-antigravity-bridge` 1.10.6 |
| zacbemis | [`zacbemis-pi-antigravity-acp-provider.md`](zacbemis-pi-antigravity-acp-provider.md) | `pi-antigravity-acp-provider` 0.1.19 |

## 1. Matrix

| Axis | tianzuo555 | fdkevin0 | estebanforge | zacbemis | agy-acp 0.1.10 |
|---|---|---|---|---|---|
| Host | pi provider extension | pi provider extension | pi provider extension | pi provider extension | Magpie / OpenCode plugin serving Anthropic Messages HTTP |
| Upstream | user's `agy`, print-mode stream-json | user's `agy`, `agy acp --process-per-session` | user's `agy`: `agy acp` (default) or stream-json, latched at load | managed `agy_acp_server` runtime from a signed manifest, under a Node supervisor | user's `agy`, `agy acp --worker --disable-telemetry` (`agy-acp:src/runtime/worker.ts:646-652`) |
| Processes | one persistent child per pi session, recycled on fingerprint change | one front per runtime; `agy` forks session workers | one persistent child per engine | two per session binding (supervisor + server), fresh pairs for side operations | one worker process per session, per-account pools and a global scheduler |
| Agent isolation | Pi-tools mode only: generated agent, `tools: []` | generated `pi-bridge` agent, `tools: []`, isolated home | ACP: none per turn; stream-json: staged agent file with an explicit tool list | client capabilities fs/terminal off; no agent file | generated `magpie-bridge` agent, `tools: []`, `subagent: false`, no inherited MCP or customizations (`agy-acp:src/runtime/worker.ts:587-596`) |
| MCP registration | private `mcp_config.json` via `--add-dir`, server `pi-<12 hex>` | ACP `mcpServers`, path tenant + Bearer header | ACP `mcpServers` with header array; private MCP home; global config only as fallback | ACP `mcpServers`, Bearer header | ACP `mcpServers`, secret URL path token |
| MCP auth | `x-pi-bridge-token` header | 16-byte tenant path + 24-byte Bearer, constant-time; no Host/Origin check | per-process UUID in `x-bridge-token`, constant-time | dashless UUID Bearer, constant-time; no bridge Host/Origin check | 32-byte random URL token, constant-time, loopback Host/Origin enforced (`agy-acp:src/mcp/http-server.ts:15,126-132`) |
| MCP reply shape | JSON | SSE: headers first, keepalive every 15 s, progress notifications | JSON | JSON, stateless transport per POST | one JSON body after the broker settles (`agy-acp:src/mcp/http-server.ts:168-178`) |
| Long tool calls | fail-closed cap 480 s | 85 s "still running" relay + `pi_await_result` | 20 s `STILL RUNNING` + `bridge_poll_result` (120 s for delegation-shaped names) | parked; watchdog held | parked up to 15 minutes, authentic `toolu_` ids, no synthetic "still running" (`agy-acp:src/mcp/broker.ts:9-11,57`) |
| Thinking text | none (stream-json); synthetic `Thought for <n>s, <k> tokens` label | ACP thought chunks; history drops reasoning | ACP thought chunks; stream-json count only | ACP thought chunks; tool_call/plan rendered as thinking | ACP `agent_thought_chunk` (`agy-acp:src/runtime/worker.ts:956-963`) |
| Thinking signature | none | none | none (declared field unused) | none | UUID-shaped, SHA-256 of session and text (`agy-acp:src/protocol/anthropic.ts:1030`); see [`claude-bridge-parity.md`](../claude-bridge-parity.md) |
| Error surface | pi `stopReason` + free text | 13 codes, 7 from a regex ladder; pi markers `context_length_exceeded:` / `quota exceeded:` | free text; `OK | ERROR | UNKNOWN` outcome | 9 typed codes, not transmitted; redacted text | HTTP status + `error.type` + wording chosen for Magpie's router ([`error-routing.md`](../error-routing.md)) |
| 429 vs quota | not modeled | `RATE_LIMIT` tested first; `429 ... quota` stays rate limit | none in the turn path | exact "Usage Limit Reached" notice on zero-token or refusal replies | named window -> `quota`, bare 429 -> `rate_limit`; "Usage Limit Reached ... reset in" recognized |
| Retry hints | none | none | none | none | `Retry-After` from the last wait named; `x-should-retry: false` on 400/401/404 |
| `agy` notices | stream "was interrupted" downgrade | retry notice dropped; output-cap notice drop/hold/emit; no terminal notices | `<SYSTEM_MESSAGE>` echo stripping | none | retry notices stripped with log corroboration; three terminal notices and the suspension sentence recognized |
| Turn timeout | 600 s logical deadline; byte-level stall ladder (120 s / 300 s + graces) | none on `session/prompt`, no watchdog | turn cap (TTY-aware 0 / 20 min) + 5 min stall cap, park time excluded | inactivity: 10 min idle / 60 min with work outstanding | inactivity: 10 min generating / 60 min awaiting tools; 60 min `session/prompt` backstop (`agy-acp:src/runtime/worker.ts:74-77,1564-1572`) |
| Session reuse | `--conversation <id>`; history replay only when fresh | system digest + exact message-id prefix | `--conversation` or `session/load` | `session/resume -> load -> new`; exact count + prefix + assistant fingerprints | transcript ledger prefix match tolerating `tool_use.input` and stripped media (`agy-acp:src/sessions/ledger.ts:272-276`); `session/resume` from a persisted shelf |
| History budget | 240,000 chars, tail drop | 160,000 bytes newest-first | not replayed (last user message only) | 32,000 UTF-16 units, labelled sections | 112 KiB prompt + 512 KiB `systemPrompt.append`; raw oversized turn refused with the overflow 400 |
| System prompt | labelled user block | `systemPrompt.append` | stream-json agent file; ACP inline in first turn | resource block, never truncated (256 KiB) | `systemPrompt.append` on `session/new` / `session/resume`, inline fallback |
| Images | dropped with a note | live images pass; history `[image]` | ACP native blocks; stream-json temp files | current turn only; history `[image omitted]` | probed and downscaled (PNG, JPEG, GIF, still WebP); stripped history images tolerated |
| Usage source | stream step usage | prompt result, divided by model calls | prompt result (exact since `agy` 1.5.3) | `_meta.quota.token_count` | prompt result; SQLite step rows for tool batches and as fallback (`agy-acp:src/usage/tracker.ts:168`) |
| Accounts | one ambient identity | one | one | one at a time | pooled accounts, isolated per-account homes, quota-aware routing |
| Version gate | 1.1.22 minimum, classified preflight | 1.4.12 minimum | 1.1.22 (stream-json), 1.5.3 (ACP) | signed manifest approval | none beyond refusing an explicit `mcpCapabilities.http: false` (`agy-acp:src/runtime/worker.ts:732-736`) |
| Cancel | signal-based (no stop channel) | abort drain 5 s | notification, teardown after 10 s | notification, close after 1.5 s | notification, broker calls cancelled, retire after 1.5 s (`agy-acp:src/runtime/worker.ts:1319-1328,1716-1730`) |
| stdout frame bound | 8 MiB unterminated line | none found | 32 MiB (string length), kill on breach | 32 MiB, fail on breach | none: uncapped `stdoutRemainder` (`agy-acp:src/runtime/acp-connection.ts:159,176-177`) |

No sibling uses `--ide-mcp-port` / `nc`; that seam is specific to the Magpie community plugin
`agy-cli`.

## 2. What the host decides

| | the four siblings (pi provider) | agy-acp (Anthropic HTTP behind Magpie) |
|---|---|---|
| thinking transport | a pi message part; no signature field in any of them | a `thinking` block whose `signature` a real Anthropic endpoint verifies |
| error surface | `errorMessage` string plus `stopReason`; no HTTP status | HTTP status, `error.type` and body wording that a router reads |
| retry policy | pi's, or none | Magpie's `retryable()` / `failure()` / `restID()`, by status and wording |
| multi-account | absent in all four | the reason this plugin exists |

The signature problem and the wording problem come from the Anthropic shape, not from `agy`;
a pi provider is never asked for either.

## 3. Upstream facts the comparison established

Each is a dated observation on a specific build, not a protocol guarantee. Sources are in the
linked documents.

- `session/cancel` answered `-32601` for an id-bearing request on `agy_acp_server` RC01
  (2026-09-03); the reference that recorded it retires the guidance, and current sibling code
  sends a notification ([estebanforge section 8](estebanforge-pi-antigravity-bridge.md#8-agy-observations-recorded-by-this-project)).
  Treat a cancel as best-effort and retire a worker whose turn does not settle; do not restate
  "cancel does not exist" as a rule.
- ACP carried no usage on RC01; the prompt result carries exact usage from `agy` 1.5.3 (same
  source). This repository's probes on `agy 1.5.9` show the shape and its gaps
  ([`claude-bridge-parity.md`](../claude-bridge-parity.md), usage accounting); they ran on two
  different host logins, so nothing in them describes one account over time.
- The ~25 KB silent prompt drop was measured on `agy 1.2.14` over stream-json and does not
  transfer to ACP. ACP does have a size effect: a single `session/prompt` message is silently
  truncated around 178 KB on 1.5.8, and `systemPrompt.append` fails hard instead
  ([`error-routing.md`](../error-routing.md), section 8). This plugin's 112 KiB render budget is a
  policy bound below that, not a measurement.
- `agy` abandons an MCP `tools/call` at 180 s: fdkevin0 relays at 85 s for it, estebanforge
  reports two abandonments at 180.000 s (2026-09-05), and it was measured again on `agy 1.5.9`
  (aborted at 180.004 s, then `notifications/cancelled`, then the timeout written as ordinary
  assistant text and a normal `end_turn`); see [`plan.md`](../plan.md) item 1.
- `agentCapabilities.mcpCapabilities` is `null` on `agy 1.5.9`.

## 4. Ideas from the siblings, and their status here

| Idea | Seen in | Status |
|---|---|---|
| Read a turn's usage from the prompt result | estebanforge | adopted in 0.1.10, with SQLite step rows as fallback |
| Inactivity watchdog with a separate long window while tools run | zacbemis; also tianzuo555, estebanforge | adopted in 0.1.10 (10 / 60 min, wall clock as backstop) |
| Fail instead of truncating when information would be lost | zacbemis | adopted in 0.1.10 for a raw oversized turn; a client's own `<conversation>` compaction request is still trimmed, by design |
| "Usage Limit Reached ... reset in" as a named window and `Retry-After` source | zacbemis | adopted in 0.1.10 for relative resets; absolute resets open ([plan](../plan.md)) |
| Progress or relay path for long tool calls | fdkevin0 (SSE-first, 85 s relay), estebanforge (20 s poll), tianzuo555 (cap below the upstream deadline) | open ([plan](../plan.md)) |
| Output-cap continuation notice handling | fdkevin0 | open ([plan](../plan.md)); a bounded, log-corroborated variant, not their unbounded hold |
| Bounded ACP stdout reassembly | estebanforge, zacbemis | open ([plan](../plan.md)); byte accounting, not their string-length check |
| Wider redaction vocabulary (`AIza`, `sk-`, `npm_`, `gh*_`, URL userinfo, cookies, JSON secret keys) | zacbemis | open ([plan](../plan.md)); `redactSecrets` (`agy-acp:src/accounts/env.ts:605`) covers bearer, `ya29.`, `1//`, `4/0A`, `/mcp/<token>`, OAuth parameters and JSON keys, which zacbemis lacks |
| Binary preflight with classified failures; cache keyed on the resolved path too | tianzuo555 | open ([plan](../plan.md)); the catalog cache is already fenced on the binary fingerprint (`agy-acp:src/usage/catalog.ts:617-631`) |
| JSON-RPC code and `data.errors[].loc` in failure text | estebanforge (ACP reference) | open ([plan](../plan.md)) |
| Keep the ACP `mcpServers` seam | all four use MCP | decided: keep; the alternatives are the same protocol at another layer with more moving parts |
| Per-session Bearer header instead of a URL token | fdkevin0, zacbemis | deferred: the 32-byte URL secret, constant-time match and Host/Origin checks already scope access; revisit only if URL exposure becomes a concrete threat |
| `AGY_ACP_FORCE_FILE_STORAGE` instead of the `SSH_CONNECTION` marker (`agy-acp:src/accounts/env.ts:273-274`) | zacbemis | deferred: a switch of `agy_acp_server`; support in the `agy` CLI is unverified |
| Whole-tool omission plus validation against the original schema | zacbemis | deferred: this plugin deliberately lowers refs and unions to `agy`'s narrower translator (`agy-acp:src/mcp/schema/sanitizer.ts`); needs a validator and tool-loss policy decision first |
| Exact history identity instead of tolerant `tool_use.input` matching | zacbemis | undecided ([plan](../plan.md)) |
| `proper-lockfile` around the session store | zacbemis | not needed: the shelf store already locks the whole read-modify-write and fails closed (`agy-acp:src/sessions/shelf-store.ts:288-327`), refusing to reclaim a live PID |
| Quota gate before the turn is persisted | zacbemis | not adopted as is: their gate does not retract streamed text; here a spent window is a `quota` failure and the ledger commits only on a clean finish |
| Synthetic thought summaries | tianzuo555 | not adopted: ACP supplies real thought text |
| Native read-only re-execution plus replay wrapper | tianzuo555, estebanforge (stream-json) | not adopted: the caller is an Anthropic HTTP client, not pi's renderer, and `agy` built-ins are disabled |
| pi-style error prefixes and regex taxonomy | fdkevin0 | not adopted: `resource_exhausted` -> `QUOTA` -> `quota exceeded:` would present a transient limit as a spent window, and `token limit` would read an output ceiling as overflow |
| "Still running" / poll protocol | fdkevin0, estebanforge | deferred inside the long-tool-call item: extra model rounds and synthetic results, against the broker's authentic `tool_use` / `tool_result` contract |
| Stream-json carrier staging; a 25 KB ACP limit | estebanforge | not adopted: `systemPrompt.append` is capability-gated at session creation; no evidence of a 25 KB ACP limit |
| Kill-first cancel based on the RC01 probe | estebanforge | not adopted: notification, broker cancel and a 1.5 s settle before retirement already cover a hung cancel |
| Two turn engines behind one interface | estebanforge | not adopted: it doubles every behavioral claim; stream-json would be a separate spike |
| System prompt prepended to the first user turn | estebanforge (ACP) | not adopted: the generated agent plus `systemPrompt.append` keeps it out of the transcript, which matters for cache and compaction |
| Transcript probe for a withheld answer; stall ladder with process evidence | estebanforge, tianzuo555 (both stream-json) | not adopted: needs an ACP-specific reproduction first; couples to the CLI transcript format and process tables |
| Signal-based task sweeps; compaction inferred from a footprint drop | tianzuo555 | not adopted: ACP provides `session/cancel`; heuristics not needed |
| Signed manifest for what is launched | zacbemis | not applicable: this plugin spawns the user's `agy`; informs the preflight design |
| Fail-closed parked calls | tianzuo555 | already present: the broker cancels and expires parked calls; their 480 s number is a pi deadline and not copied |
| Prefix reuse with a byte-budgeted, omission-marked replay | fdkevin0 | already present in a different form (ledger prefix match, `prompt-render.ts` omission markers) |
| Permission grants bound to structured metadata | fdkevin0 | already present ([`claude-bridge-parity.md`](../claude-bridge-parity.md) section 4) |
| Selector read-back and permission-mode drift checks; silent-drop detection; `<SYSTEM_MESSAGE>` echo stripping; per-frame repair of known noise lines | zacbemis, estebanforge | not evaluated ([plan](../plan.md)) |
| A capability matrix structured like estebanforge's `docs/ENGINES.md` | estebanforge | optional documentation refinement ([plan](../plan.md)) |

## 5. Where this plugin differs by design

- Multi-account pooling, per-account isolation and quota attribution exist only here.
- Failure answers are designed for a router that reads status and wording; no sibling has a rule
  that a non-limit body carries no limit words.
- Only this plugin recognizes `agy`'s terminal notices (generic, dead connection, spent credit)
  and the suspension sentence delivered as content.
- zacbemis's quota parser is one fixed string, so any rewording disables it; this plugin matches a
  family of phrasings, clamps the reset, and tests both a named window (`quota`) and a bare
  throttle (`rate_limit`).
- The siblings emit unsigned thinking because pi never asks them for a signature. pi itself turns
  an unsigned block into history text when it replays to an Anthropic endpoint
  ([`claude-bridge-parity.md`](../claude-bridge-parity.md)); this plugin's UUID-shaped signature
  keeps the block replayable without claiming a vendor provenance.
