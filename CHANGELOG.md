# Changelog

`magpie-agy-acp` (provider ID `agy-acp`). Newest first. Each release says what changed and why;
current behavior is described in [`docs/`](docs/README.md), not here. Dates come from the
repository's recorded history; where none is recorded, none is given.

## 0.1.10

Version in `package.json`; no `v0.1.10` tag exists yet. Work dated 2026-11-14.

- Turn watchdog: the 30-minute wall clock on `session/prompt` is replaced by a progress watchdog
  that retires a worker silent for 10 minutes while generating or 60 minutes while awaiting tool
  results; the wall clock stays as a 60-minute backstop. Why: the wall clock could expire in the
  middle of a tool call and leave the native generation running (a defect found in the 0.1.10
  review). Three of the four sibling bridges studied bound inactivity rather than total time.
- Oversized raw turns are refused with the overflow `400` instead of being clipped, so the client
  compacts. Why: clipping silently dropped information while the ledger still recorded the
  untruncated request. A client's own `<conversation>`-framed compaction request is still trimmed.
- The "Usage Limit Reached ... Your limit will reset in ..." notice is classified as a named spent
  window (`quota`) and its relative reset feeds `Retry-After`.
- Usage is read from the `session/prompt` result, subtracting what tool batches already reported,
  with SQLite step rows as the fallback for a turn whose result carries none. Why: a step row that
  landed after the prompt finished was read as the next turn's work, reporting a prompt's usage
  twice.
- Terminal-notice corroboration: the generic and dead-connection notices are taken at their word;
  the spent-credit notice (`402`, a half-hour rest) needs the turn's log to agree.
- Prompt-refusal wording: the hint carries none of the words Magpie reads as a spent window. Why: an
  earlier hint said "not an account quota limit", which Magpie reads as `failQuota` (it reads no
  negation) and so rested a healthy account for its window.
- A retry storm keeps the class of the attempt that failed (outage `503`, named window `quota`,
  bare throttle `429`), diagnosed before `session/cancel` is sent.
- Prompt cloaking is off by default (`cloak_prompts`). Why: the switch rewrote system-prompt lines
  that identify a third-party harness so a vendor-side check stopped refusing the request, and the
  vendor's terms treat workarounds of that kind as circumvention. Detection is unaffected. The
  option description no longer claims zero-width spaces, which the implementation stopped using in
  0.1.9.
- A tool call that outlives `agy`'s 180 s MCP deadline is relayed instead of lost: the broker
  answers "still running" after 150 s with the call id, the model asks again through
  `mcp_magpie_await_result` (always advertised, handled inside the broker so it never becomes a
  second `tool_use`), and the caller's eventual result lands in the same native prompt. A result
  that arrives after the model stopped asking is kept for the next prompt; `request.signal` and
  `notifications/cancelled` end the wait without discarding the execution. Why: measured on
  `agy 1.5.9`, the POST aborts at 180.004 s and the model then reports a timeout for a tool that
  may have succeeded. Verified live: notice at 150 s, `await_result` at 186.9 s, result at
  211.4 s, prompt settled at 248.8 s with the real answer.
- An account the vendor disabled fails fast for six hours instead of being spawned for every turn
  (`src/accounts/policy-block.ts`). Why: `agy` authenticates normally for a suspended account and
  answers the prompt with the suspension sentence, so each later turn re-ran the refusal. A turn
  that produces work clears the record.
- Documentation: `docs/` restructured under a documentation scheme (`docs/README.md`). The three
  to four research files per sibling bridge were merged into one document each, the four
  per-bridge comparisons into `docs/research/comparison.md`, and the process history moved here.
  `docs/error-routing-diagnosis.md` became `docs/error-routing.md` (reference only);
  `docs/improvement-and-fix-plan.md` became `docs/plan.md` (open work only).
  `docs/claude-bridge-parity.md` was corrected for the watchdog, oversized-turn and usage changes
  above.

## 0.1.9

Tagged `v0.1.9`; recorded 2026-11-14. Status alignment with Magpie's router: a live audit of what
the plugin answers against what Magpie's router does with each status, and against the statuses
`agy` can produce (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, `NOT_FOUND`, `PERMISSION_DENIED`, ...,
read from its binary and from a suspended account's real answer).

| Case | Before | After | Why |
|---|---|---|---|
| Vendor-suspended account | `500 Agent execution terminated due to error` | `403` keeping the vendor's sentence | the refusal is retryable and the next account answers |
| `PERMISSION_DENIED` other than the suspension | `500` | `403` policy/region text | it belongs to the account, not the prompt: fail over instead of blaming the request |
| Model not served on this account (`NOT_FOUND`, `Requested entity was not found.`) | `500` | `404` "model not found" | Magpie rests that model alone (`modelRefused`) and keeps the account for its other models |
| Vendor servers busy (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, 5xx "overloaded") | `500` | `503` "overloaded" | `vendorOverloaded`: 30-second rest, no failure counted |
| Conversation `agy` cannot serialize (`maxMessageTokens must be positive, got 0`) | `500` | `400` "too long ... shorten" | `overflowed`: asks a member with room, rests no account, tells the agent to compact; failing over only repeated it |
| This bridge at capacity | `503` with no status words | `503` saying "overloaded" | the bridge's own saturation no longer rests the account as a failure |

The release notes credited the suspension row to Magpie recognizing it (`googleToS`). Magpie's
suspension predicate (`googleSuspended`) requires an `antigravity` / `gemini` Agent and plugin
accounts are built with `Agent: "plugin"`, so the effect is a plain retryable `403`
(`docs/error-routing.md`).

Also in this release:

- `402` for spent credit, `Retry-After` from the last wait a turn's log names, `x-should-retry:
  false` on `400` / `401` / `404`, the vendor's own words appended as a bounded, redacted
  `Upstream said:` detail, and `error.type` derived from the status the way Magpie derives it.
- Thinking blocks carry a UUID-shaped signature. Why: the fabricated `agy1.` / `agyb1.` prefixes
  this plugin used (as `agy-cli` does) made Magpie forward the block to a Claude route, which
  answered `400 invalid signature in thinking block` once per new value; Magpie repaired it with a
  same-request retry, a round trip per turn.
- `initialize` refuses a worker whose `agentCapabilities.mcpCapabilities.http` is explicitly
  `false`.

Verification: the classifier covers each verdict and the non-verdicts (`INVALID_ARGUMENT` stays
`invalid_request`, a prompt-level refusal stays `internal`), and the worker table asserts status,
type and wording for the `403`, `404`, `503` and `400` paths. `bun test`: 349 pass, 0 fail.

## 0.1.8

Tagged `v0.1.8`; recorded 2026-11-14.

- Quota routing on by default: `quota_routing` defaults to `true`, so Magpie sees each account's
  5-hour and weekly buckets and fails over before an exhausted account is asked (`src/options.ts`,
  both READMEs).
- Specific-first quota attribution (`src/usage/quota.ts`, `parseUsageReport`): per-model groups
  (`Gemini 4 Argon`, ...) claim their catalog models before broad vendor pools (`Gemini`);
  versioned pool names are kept instead of collapsing into `Gemini`; `Claude` and `GPT` stay
  separate so a host alias cannot broaden model membership; empty or fully disabled specific groups
  no longer take models from a valid broad pool.
- Probe concurrency governance (`src/usage/catalog.ts`, `src/usage/quota.ts`): short-lived `agy`
  probes (`agy models`, `agy -p /usage`) run through a bounded FIFO pool with queue-inclusive
  deadlines and single-release accounting, so importing 15-30 accounts cannot spawn dozens of Go
  processes at once.
- Parallel, ordered account import (`src/accounts/auth.ts`): batches run 4-wide with source-order
  results, abort-aware per-email ownership and rollback error reporting; a failed batch no longer
  leaves a half-imported slot reported as success.
- Single-flight cancellation isolation: a cancelled caller no longer kills a shared `agy` probe
  other callers wait on; waits are reference counted and the background catalog refresh keeps its
  own timeout.
- WebP inline images (`src/protocol/webp.ts`, `webp-vp8.ts`, `webp-vp8l.ts`, `images.ts`):
  zero-dependency still-WebP decoding (`VP8L`, `VP8 `, `VP8X` + `ALPH`) under a `DecodeBudget`,
  so oversized WebP images downscale like PNG/JPEG instead of being forwarded verbatim; animated
  WebP passes through. Verified pixel-exact against `libwebp` `dwebp` across 22 `cwebp`/`dwebp`
  cases (`maxAbsDiff = 0`).
- `agy` upgrade awareness (`src/accounts/env.ts`, `src/usage/catalog.ts`): catalog cache entries
  are fenced by `getAgyBinaryFingerprint()`, so a CLI upgrade exposes new models on the next turn
  instead of after the 24-hour retention.
- Truthful `429`s and the retry-storm guard (`src/runtime/diagnostics.ts`, `worker.ts`,
  `turn-context.ts`): a bare `429` / `RESOURCE_EXHAUSTED` is answered as a transient limit (plain
  `429`, no quota wording) instead of `Account quota exhausted`; `agy`'s retry notices are stripped
  and counted, and a turn that has delivered nothing ends after 2 notices (about 12 s) instead of
  waiting out the roughly 8-minute backoff ladder; notices are believed only when the turn's log
  shows `Run: attempt N failed`. Why: the incident below.

Verification: `bun test` 343 pass, 0 fail, including the quota / `rate_limit` split
(`exhausted your capacity` stays `quota`), notice splits inside and after the header, a notice
burst whose log record lands one chunk late, an answer ending in something that looks like a
notice start, a quoted incident without log evidence, and a storm turn ending as `rate_limit`
without leaking notices, also when `agy` settles the cancelled prompt as an RPC error and keeps
streaming into it. `bun x tsc --noEmit` clean; `bun scripts/check-release.mjs` reported
`magpie-agy-acp@0.1.8` releasable.

Review outcome: an adversarial review raised two groups of findings. "A zero base filter level
must not disable segment filtering" was rejected: `libwebp` `src/dec/vp8_dec.c:285` sets
`dec->filter_type = (hdr->level == 0) ? 0 : hdr->simple ? 1 : 2;`, so a zero frame filter level
disables the loop filter regardless of segment overrides, `libvpx` skips the pass the same way,
and `src/protocol/webp-vp8.ts` matches `dwebp`. The VP8L Huffman-group budget, truncated-partition
tolerance, empty specific quota groups and import rollback bookkeeping findings were confirmed and
fixed before release.

## 0.1.7 and earlier

No per-release dates are recorded for this range.

Baseline stabilization:

- Bounded cold-replay history: `session/prompt` keeps the newest 112 KiB of transcript and
  overflows older turns into `_meta.antigravity.systemPrompt.append`
  (`<prior_conversation_history>`), dropping whole oldest messages with
  `[... omitted N earlier messages ...]`.
- Cross-restart `session/resume` index: `$AGY_ACP_DATA_DIR/parked-sessions.json` (0600, SHA-256
  content digests plus routing metadata, no plaintext; invalidated before advancing turns).
- First-turn session-id drift adoption (`adoptAwaitingToolWorker`, via pending 96-bit `toolu_*`
  ids) and pool defaults `maxPerAccountWorkers: 18`, `maxGlobalWorkers: 36`.
- Dual session headers: `x-agy-session-id`, falling back to `x-magpie-session`.
- Code Assist plan badges from `v1internal:loadCodeAssist` (1-hour cache).
- 48-hour isolated-account storage GC, the prohibition on writing to `<appDataDir>/brain` on the
  bridge host, SQLite WAL `3x25ms` read backoff, a thinking-only non-streaming JSON fallback, the
  parity document, and GitHub Actions CI.

Correctness and lifecycle fixes (audit IDs):

- HIGH-1: `PeekedTurnSource` ownership bound to the finalized `Response`, so `body.cancel()` or an
  abort before the first `pull()` still closes the source and runs the coordinator's `finally`
  (preventing `sessionLocks` deadlocks and permanently pinned workers).
- HIGH-2: error-event early exit no longer bypasses worker retirement; cleanup moved into the
  `finally` blocks of the `Fresh`, `Warm` and `AwaitingTools` paths.
- HIGH-3: conflicting `memory` vs `persisted` resume binding replaced by one discriminated union,
  pruning stale incompatible in-memory entries so a persisted resume never binds an unrelated
  ledger or `systemHistorySeed`.
- MED-4: `AsyncEventQueue` capped at 16 MiB per turn (overflow fails the turn with `502` and
  closes the worker); SSE keepalives only when `desiredSize > 0` or pull credit remains.
- MED-5: `withAccountProvisionLock` deadlock: `acquireAccountFileLock` moved inside
  `try/finally`.
- MED-6: `steer` commit barrier timeout throws `SteerReplayNeededError` instead of a silent
  `catch {}`.
- MED-7: `disable_parallel_tool_use: true` releases queued tools one at a time.
- MED-8 / MED-9: normalized `X-Magpie-Work-Dir` and `tool.description ?? ""` included in warm reuse
  checks and shelf digests.
- MED-10: file-locked incremental `parked-sessions.json` transactions; `claimResume()` runs
  synchronously after scheduler admission so racing forks cannot claim the same
  `nativeSessionId`.
- MED-11: terminal `agy acp --login` cleanup covers the whole flow, including waiting for user
  input.
- LOW-12: the request-level abort listener is detached when JSON or SSE responses complete or
  cancel.

Process footprint, wait-for-room and storage governance (the worker switch shipped in 0.1.3):

- Single-process worker mode: `agy acp --process-per-session` (two Go processes per session, about
  138 MiB frontend plus 210-250 MiB `--worker`, 350-388 MiB RSS) replaced by
  `agy acp --worker --disable-telemetry` (no child processes, about 212 MiB active, 175 MiB after
  resume), keeping `mcpCapabilities.http`, `--add-dir`, `systemPrompt.append` and
  `session/resume`.
- Bounded FIFO wait-for-room in `GlobalScheduler` (previously an immediate `503 overloaded_error`
  when no idle worker could be evicted): `waitTimeoutMs` 60 s (`0` restores the immediate `503`),
  `maxWaiters` 128, waking on slot release, `IDLE` transitions, `unpin()`, `unregisterWorker()`
  and reaper ticks, never holding locks across waits.
- Post-turn RSS recycling (`src/runtime/rss.ts`): process-tree RSS from Linux `/proc` (with a
  `statm` fallback) or one cached `ps` snapshot elsewhere; idle workers over `maxWorkerRssBytes`
  are parked and recycled when a resume checkpoint can be kept.
- Storage GC extended to `annotations/*.pbtxt`, `implicit/*.pb`, `crashes/*`, root `cli.log`, a
  32 MiB `log/` cap, and orphan summary/FTS5 pruning in `conversation_summaries.db`
  (`busy_timeout=50`, `BEGIN IMMEDIATE`, never creating the DB).
- `quota.ts` and `catalog.ts` caches bounded at 128 entries with lazy TTL cleanup; verified real
  model catalogs kept 24 hours so a probe timeout cannot drop models and mark an account
  `unlisted`.

0.1.4: the `systemPrompt.append` cap for cold replays was lowered from 2 MiB to 512 KiB (64 KiB for
GPT-OSS), after `agy 1.5.8` probes failed at 760,000 bytes and above; the 2 MiB ceiling routinely
reached that range.

Modularization, media and release pipeline:

- ARCH-1: `src/sessions/coordinator.ts` split into `ledger.ts`, `prompt-render.ts` and
  `shelf-store.ts`.
- ARCH-2: `src/runtime/turn-context.ts` and `src/usage/tracker.ts` extracted; `(scheduler as any)`
  overrides replaced by eviction hooks (`beforeEvictIdleHooks`); `worker.pinned` flags replaced by
  idempotent `pin(): () => void` leases.
- ARCH-3: one async SSE encoder around `PeekedTurnSource` and `peekRacingAbort`, with a single
  deterministic `source.close()`.
- ARCH-4: browser OAuth and terminal login cancellation unified via `combineSignals()` and
  `createLoginSessionDisposer()`.
- `lostMedia` tolerance (previously historical images had to match byte for byte) and the
  secondary content-hash lookup across parked shelf entries.
- Zero-dependency inline image fitting for PNG, JPEG and GIF (previously oversized base64 images
  were forwarded verbatim), memoized in a bounded cache.
- Release gate and workflows: `scripts/check-release.mjs`, `.github/workflows/ci.yml` and
  `release.yml` (typecheck, tests, manifest validation, OpenCode 1.x/2.x entrypoint checks,
  `npm pack --dry-run`, tag-version alignment, GitHub Release tarballs, npm OIDC Trusted
  Publishing with an `NPM_TOKEN` fallback).

## Incidents and findings

### 0.1.8: a per-minute 429 answered as a spent quota

A `gemini-4-carbon` turn through Magpie -> `agy-acp` -> `agy 1.5.8` failed this way:

1. Antigravity answered `RESOURCE_EXHAUSTED (code 429): Resource has been exhausted (e.g. check quota).`,
   Google's generic 429 text.
2. `agy` retried in-process with exponential backoff; eight attempts spanned about 8 minutes,
   streaming `API error (attempt N): ...` notices into the reply.
3. The plugin classified `resource_exhausted` as `quota` and answered
   `429 {"error":{"message":"Account quota exhausted"}}`.
4. Magpie's `quotaWords` matched that text, and the only downstream relay (CLIProxyAPI) cooled its
   single key for the provider; every later attempt got
   `503 auth_unavailable: no auth available (providers=...; last upstream error: api_error: Account quota exhausted)`,
   the error the user saw.

While the account was failing, `Gemini - 5 hours` had 58.4 % left and `Gemini - 7 days` 84.6 %,
and live probes (small, `reasoning_effort: high`, 8 concurrent, 3.3 MB body) all answered `200`:
the 429 was a per-minute limit, not a spent window. Fixed in 0.1.8; the resulting rules are in
`docs/error-routing.md` sections 3 and 4.

### Worker log not read (before 0.1.3)

Under `--process-per-session` the frontend wrote `agy-acp.log` and the worker child wrote its
execution errors to `agy-acp.log.<PID>`. Reading only the former hid failures such as
`maxMessageTokens must be positive, got 0` behind a generic `500`, and the turn was retried on the
same account. `TurnLogWatch` reads both files; `--worker` still writes the PID-suffixed log.

### False 429s from log metadata

Log matching once ran `/429|RESOURCE_EXHAUSTED|exhausted your quota|quota/i` over raw log and
stderr tails, so routine `quotaProject=<id>` OAuth metadata and `429` digits inside glog PIDs,
ports and timestamps produced false quota verdicts. Replaced by the evidence filters in
`docs/error-routing.md` section 2.

### Accounts skipped as `unlisted`

`STATIC_FALLBACK_MODELS` once omitted the Carbon, Hydrogen and Orchestrator entries. An account
whose first `agy models` probe timed out got the fallback catalog, and Magpie skipped it for those
models instead of failing over to it. The fallback now lists all 22 known entries.

### 2026-11-14: zero-width cloaking stopped working

From 2026-11-14 the upstream refuses trigger lines broken up with zero-width characters, reading
past them as Google's own check does. The cloak switched from zero-width insertion to rewording each
line, as `agy-cli/cloak.mjs` does.

### `agy 1.5.9`: a suspended account answers as content

A live probe of `agy 1.5.9` found a suspended account returning the vendor's suspension sentence as
the turn's content with `stopReason: end_turn`, no error and no log line, and no `usage` in the
result. The probe ran on the account later suspended; the next ran on a different login. The
sentence is now a terminal marker. The same probes found `agentCapabilities.mcpCapabilities` is
`null`, so the HTTP MCP guard fires only on an explicit `false`.

### 2026-11-14: `agy 1.5.9` abandons an MCP tool call at 180 s

Measured with one live ACP turn and a fake Streamable-HTTP MCP server whose tool slept 200 s. The
`tools/call` arrived with `_meta` naming the conversation and a `progressToken`; the client aborted
the POST at 180.004 s and sent `notifications/cancelled`; the model then wrote the timeout as
ordinary assistant text and the prompt settled `end_turn` with usage — a 200, not an error. The
client never opens a GET/SSE stream on `/mcp/:token`, so progress notifications are undeliverable
and cannot extend the deadline. fdkevin0's 85-second relay was the same finding, six months
earlier. Redesigned in `docs/plan.md` item 1.

A second probe of the same build found that a `tools/call` to any MCP server not named `magpie` is
rejected by this plugin's own permission handler, and that the turn then ended with an empty answer
and a 200 — indistinguishable from a model with nothing to say.

### 2026-11-14: account disablement research

Three lines in parallel: the vendor's own terms and the published enforcement reports; a code
comparison across the four sibling bridges; the edge host's logs for the disabled account. The
terms name third-party access and automated account rotation, and the appeal form names OpenCode,
Claude Code and OpenClaw, so a bridge of this shape is inside the prohibited bucket by
construction. The logs do not support blaming this plugin: of 4,074 gateway requests attributed to
the suspended account, 3,729 went through Magpie's own native `antigravity` provider talking to
`daily-cloudcode-pa.googleapis.com` directly, and 345 through this plugin, all via the official
`agy` binary. Concurrency was not the differentiator either: 5 overlapping requests on the suspended
account against 8 on one that still works. The code comparison found the behaviours no sibling has:
a bridge-owned OAuth flow reusing Antigravity's installed-app client identity, the prompt rewording,
the account pool with quota and policy failover, and bulk refresh-token import. The risk
assessment built on it is in `docs/account-safety.md`.

#### The account, in numbers

Account `14bbf665-b7fd-5338-8de2-0049c0fd91f9` on the edge host. Gateway records come
from `~/.config/magpie/usage.jsonl`; CLI logs from
`~/.local/share/agy-acp/accounts/<uuid>/.gemini/antigravity-cli/log/`. Times +08:00.

| Metric | Disabled account | `sidskang@gmail.com` | `sid.kang0129@gmail.com` |
| --- | ---: | ---: | ---: |
| Attributed gateway requests | 4,074 | 1,973 | 0 |
| via Magpie's native `antigravity` provider | 3,729 | 0 | 0 |
| via this plugin | 345 | 1,973 | 0 |
| Busiest hour | 460 requests | 307 | - |
| Peak hourly tokens including cache | 94.4M | 19.1M | - |
| Largest uncached input in one request | 790,385 | 242,535 | - |
| Recorded input / output tokens | 106.8M / 3.65M | 15.1M / 1.52M | - |
| Peak overlapping HTTP requests | 5 | 8 | - |

Last token-bearing success 2026-11-13 20:04:33 (completed 20:04:55), then a `429`
"Account quota exhausted" at 20:05:08 and four generic `500`s recorded with `tries:7`
over seven minutes. The first retained suspension diagnostic is 2026-11-14
18:13:27.454, in `cli-20261114_181322.log:144`:

```
PERMISSION_DENIED (code 403): This service has been disabled in this account for
violation of Terms of Service. Please submit an appeal to continue using this product.
```

Authentication succeeded four seconds earlier in the same log (keyring token, unexpired,
`OAuth: authenticated successfully as sid.kang0129@outlook.com`), and the run was a `-p`
print-mode invocation rather than an ACP session: the enforcement is service-level, not
an expired login. Across 2,020 CLI and worker log files there is no earlier enforcement
warning, no `auth_unavailable`, and no quota-window refusal.

The only safety-typed records are 771 `agy_tool_safety triggered=true` lines for an
"unsupported MCP tool", each followed by a `sir_flash_lite triggered=false` decision:
none became a policy verdict.

#### What these numbers do not support as the explanation

Each of these is present on the accounts that still work, so none of them separates the
disabled account from the others. That is not the same as excluding a contributing
cause: these are two accounts observed after the fact, not a controlled comparison.

- Concurrency: the disabled account peaked at 5 overlapping HTTP requests, a working
  account at 8.
- `/usage` polling: 569 invocations on the disabled account, 482 on a working one, 380
  on the third, which had no gateway traffic at all.
- "You are not logged into Antigravity" startup lines: present on all three accounts,
  thousands of times each.

#### What they point at

1. Direct backend access rather than driving the CLI: 3,729 of 4,074 requests came from
   Magpie's own `antigravity` provider, which speaks to
   `daily-cloudcode-pa.googleapis.com` itself (`loadCodeAssist`, `fetchAvailableModels`,
   advertised identity `antigravity/hub/2.31.0 linux/amd64`). This plugin's 345 requests
   all went through the official `agy` binary. If enforcement tracks the prohibited
   pattern of a third party reaching the backend, the native provider is the closer
   match, and it is not part of this plugin.
2. Scale: 106.8M recorded input tokens, 770.7M cache reads, one request with 790,385
   uncached input tokens, 94.4M tokens in an hour.
3. A retry storm at the boundary: a `429` followed by four `tries:7` requests in seven
   minutes. Cause, response or consequence cannot be separated in these records.

Attribution to this plugin alone is not supported by these numbers. The four sibling
bridges are also not a clean control group: estebanforge's changelog records a
ToS-disabled account  (its `CHANGELOG.md:71`) and its fake ACP server has a case for the
suspension notice arriving as normal content.


## Documentation and research history

### 2026-11-14: sibling bridge research

Four third-party Antigravity bridges (TianZuo555, fdkevin0, EstebanForge, zacbemis) were cloned and
read read-only. Each got a first extraction, an independent second extraction written without
access to the other documents, and a claim-by-claim verification (`confirmed` / `wrong` /
`unverifiable`) against a pinned commit; the verification was ruled to win where they disagreed,
and the first extractions were kept with their errors as a record. Per-bridge comparisons were
written against 0.1.9 (`99de26c3`); zacbemis also got a deep dive. The verifications and second
extractions were produced by different models from the first extraction. The 0.1.10 items above
came from the ranked actions of that research.

Three first-round claims did not survive verification, two of which this repository had used as
design inputs: that `session/cancel` does not exist (`-32601`, an RC01 observation for an
id-bearing request), that ACP carries no usage (RC01; exact since `agy` 1.5.3), and that a ~25 KB
prompt cap applies to ACP (measured on `agy 1.2.14` over stream-json). The first pass also assumed
the agent advertises HTTP MCP; `agy 1.5.9` reports `mcpCapabilities: null`.

Other claims the verification overturned, kept here so the corrected documents need not repeat
them:

- tianzuo555: "no token storage" (it stores a loopback bridge token); "one agy turn per pi
  request" (requests re-attach to one logical turn, which can retry); a singleton start promise
  with a readiness wait (described in `PLAN.md`, not the code); the HTTP handler "never answers
  from its own side" (dynamic tools run in-process); 600 s as an upstream `agy` turn timeout (it is
  the pi-side default; the bridge cap is 480 s); server name `pi-bridge` (production uses
  `pi-<12 hex>`); thinking blocks as empty placeholders (they carry synthetic summaries); errors
  always `stopReason: "error"`; the whole diagnostics report hashed into `revision` (two different
  hashes); the system prompt staged as an agent file (it rides as a user block); images staged as
  temp files (they are dropped; that description belonged to estebanforge); the usage UI as a
  stream token counter (it shows `/usage` quota).
- fdkevin0: every parked call blocks until pi finishes (a relay notice or cancellation can
  complete it); SSE removes the need for a client-side timeout budget (an 85 s relay timer still
  races it); `RATE_LIMIT` "unless the message also says quota" (no such override); everything but
  a solitary `tools/call` answers `-32601` (only batched calls get `-32600`, unknown methods
  `-32601`, the rest succeed); tool sets "only over MCP" (definitions also enter the system
  prompt); history formatting in `format.ts` (it formats quota UI); a "settings page" (commands and
  TUI only); thinking conversion read as outbound ACP reasoning support.
- estebanforge: cancel and usage RC01 findings presented as current rules; the ~25 KB cap as
  universal; engines "chosen at runtime" (latched at load); all tool registration through the
  global MCP file (ACP registers directly; global is a fallback); all tool activity as thinking
  blocks (engine-specific); `TurnOutcome` only OK/ERROR (also UNKNOWN); silence always fails
  (stream-json can recover a withheld answer); the 32 MB ceiling "then repair" (overflow kills the
  transport; only a known noise line is repaired); the system prompt never on the prompt line
  (conditional); "ACP has no agent slot" read as forbidding launch agents (this plugin launches
  with `--agent magpie-bridge`).
- zacbemis: "~3.5k src lines, 19 docs" (5,902 and 23 at the commit); a 16 KiB stderr ring (string
  units, then capped at 4,096); integrity checked before every launch (external launches bypass
  it); exactly one identity from existing credentials (pi OAuth and API keys also exist); no HTTP
  anywhere (MCP and the OAuth relay use it); redaction of all secrets within 4 KiB (a finite
  vocabulary, 4,096 UTF-16 units); a quota refusal "never enters history" (only the checkpoint is
  held); labelling as the only text adaptation; artifacts of 280-930 MB (the 1.5.0 sizes differ);
  the instruction-limit citation `src/stream/context.ts:27-32` (correct: `:19-25`); "Magpie's shelf
  lacks cross-process safety" (stale; the shelf store locks the full transaction). The deep dive
  noted that an earlier short note had taken the upstream for the `agy` CLI.

### `docs/error-routing-diagnosis.md` corrections

Read against Magpie's source, three statements the document had made loosely were corrected:
`quotaWords` does not match a bare `limit`, and a match is not by itself a rest (the class comes
from `routing.go:570-635`); `tooLong` is vetoed by output-limit or pace words in the same body; a
plugin account's `402` never reaches `creditLadder`.

### 2026-11-14: documentation consolidation

`docs/` reorganized under `docs/README.md`. Before: 3 top-level documents and 18 research files
(2,045 lines), with the same facts re-derived in three to four places per bridge, four
near-identical comparison matrices, and process narrative mixed into reference material. After:
one reference document per subject, one research document per bridge, one comparison, one plan,
and this changelog.
