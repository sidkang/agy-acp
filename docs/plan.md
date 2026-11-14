# Open work

Open items only, most consequential first. Each states the problem, the evidence, the options,
the recommended decision and how to accept it. When an item ships, delete it here and record it in
[`CHANGELOG.md`](../CHANGELOG.md). Evidence about sibling bridges is in
[`research/`](research/README.md).

## 1. Prove the tool-call relay through a real Magpie round trip

- Problem: the relay shipped in 0.1.10 is verified against `agy 1.5.9` with a synthetic caller
  (the probe plays Magpie and delivers the tool result after 200 s), not through Magpie's own
  Anthropic-facing round trip. Two things only that path can show: whether Magpie keeps the
  `tool_use` it was given while the call is relayed, and whether its repaired continuation arrives
  with the same session id so the parked call is found again.
- Evidence: live probe, one turn, tool answered after 200 s — notice at 150 s, the model called
  `mcp_magpie_await_result` at 186.9 s, the result landed at 211.4 s, the prompt settled at 248.8 s
  with the answer "returned: 42" instead of a timeout narrative. `CHANGELOG.md` records it.
- Options: (a) leave it to ordinary use and watch the gateway log; (b) run a scripted turn through
  the gateway's caller key with a local tool that sleeps past the deadline.
- Decision: (b) once, on the edge host, before the version is called stable there.
- Acceptance: a gateway log showing one turn whose `tools/call` outlived 180 s and whose final
  answer carries the tool result, plus no `tool_call_deadline_expired` in that window.

## 2. Bound the ACP stdout reassembly buffer

- Problem: `AcpConnection` appends stdout to an uncapped `stdoutRemainder` and splits on newlines
  (`src/runtime/acp-connection.ts:159,176-177`); a flood without a newline grows memory without
  limit. estebanforge and zacbemis cap a frame at 32 MiB and retire the transport on breach.
- Decision: cap by UTF-8 bytes per line (not string length before splitting); on breach, reject
  pending requests and close the worker as a `502` worker-closed failure. Choose the cap to allow
  large image and tool frames (at least 32 MiB).
- Acceptance: a fake-ACP test streaming an unterminated line past the cap closes the worker with
  a classified failure and does not grow memory beyond the cap; normal large frames still pass.

## 3. Output-cap continuation notice

- Problem: `agy`'s "your previous response was cut off because it exceeded the output token
  limit ... please continue from where you left off" notice (optional `retries remaining: N`)
  reaches the caller as model text; no code path matches it.
- Evidence: fdkevin0 classifies it `drop | hold | emit` across chunks, with an unbounded hold.
- Decision: handle it like the retry notice: newline-complete matching, a bounded hold, and
  stripping only when the turn's own log corroborates it, so a model quoting the notice is
  delivered verbatim.
- Acceptance: `bun test` cases for a split notice, a quoted notice without log evidence, and an
  over-long hold that is released as text.

## 4. Wider secret redaction

- Problem: `redactSecrets` (`src/accounts/env.ts:605`) does not cover `AIza...` API keys,
  `sk-...`, `npm_...`, `gh[opurs]_...` tokens, URL userinfo, `cookie` / `set-cookie` values, or
  JSON `client_secret` / `api_key` keys.
- Decision: add those patterns, keeping the existing bearer, `ya29.`, `1//`, `4/0A`,
  `/mcp/<token>` and OAuth-parameter coverage.
- Acceptance: the existing leak regressions gain one case per new pattern and still pass.

## 5. `Retry-After` for an absolute reset

- Problem: a spent window naming an absolute reset (`reset on Sep 4, 2026 12:30 UTC`) is classified
  `quota` but `retryAfterSecondsFrom` reads only relative waits, so no header is sent
  ([error-routing](error-routing.md#3-spent-quota-versus-transient-limit)).
- Decision: parse `on <Mon D, YYYY HH:MM> UTC`, compute seconds from now, clamp to the existing
  1 s ... 24 h range.
- Acceptance: unit tests for an absolute reset in range, past, and beyond 24 h.

## 6. `agy` binary preflight

- Problem: a stale or wrong `agy` fails deep inside a turn. Only an explicit
  `mcpCapabilities.http: false` is refused at `initialize` (`src/runtime/worker.ts:732-736`); the
  minimum version is declared in the README only.
- Evidence: tianzuo555 classifies `not-found | permission-denied | timeout | spawn-failed |
  invalid-version | unsupported-version` and keys its cache on the resolved path as well as the
  binary's stat signature.
- Decision needed: the minimum supported `agy` version. Then classify preflight failures into
  those six categories, surface them at startup and in the first failing turn as a classified message rather than a generic `500`,
  and include the resolved path in the catalog fingerprint.
- Acceptance: tests with a missing binary, a non-executable file and an old version string each
  yield the matching category without spawning a turn.

## 7. Use JSON-RPC codes in failure text

- Problem: failures are classified from message text only. estebanforge's ACP reference records
  `-32602` with `data.errors[].loc` naming the offending field, `-32000` for server-state
  messages, `-32601` for an unimplemented method.
- Decision: append the JSON-RPC code and any `loc` path to the redacted `Upstream said:` detail of
  `invalid_request`, without changing classification.
- Acceptance: a fake-ACP `-32602` with `loc` produces a `400` whose detail names the field.

## 8. Finish the cloaking scope

- Problem: two scope gaps remain after 0.1.10 closed the other two.
- Evidence: against `packages/agy-cli/cloak.mjs` and `packages/antigravity-cloak/`, the trigger list
  matches line for line. Shipped in 0.1.10: the two Codex lines in **user-authored text**, because
  the middleware measured that "since 11-14 Antigravity also answers a bare 429 to Codex's GPT-5
  line in a user's turn … 3 of 3 on a real account" while the other lines passed there, and a
  `saidAs`-style `phrase=replacement` list (`cloak_said_as`), so an unrecognized phrase no longer
  needs a release.
- Still open:
  1. **Mid-conversation system/developer messages.** `agy-cli` rewrites these; this plugin turns
     them into `<system-reminder>` user text without the rewrite, and only the two Codex lines are
     handled in user text, so a Hermes or RFC 2119 line arriving mid-conversation goes out as
     written. Unobserved either way; the middleware only confirmed the Codex lines in a user turn.
  2. **U+FEFF as a word separator.** Our `SPACE` class excludes the invisible characters because
     including them produced a 12.7 s backtracking blow-up on a long U+FEFF run; the others' `\s+`
     matches them, so a line whose words are separated only by U+FEFF is rewritten by them and
     missed here. Any fix has to be a bounded run plus a timing test, not `\s`.
- Decision: open, both low priority with cloaking off by default.
- Acceptance: a test that the phrase is rewritten in the scope it was added for and left alone
  everywhere else; for (2), a `bun test` timing check with a 3,200-character U+FEFF run.

## 8b. Findings from the 0.1.10 review left open

- Problem: two defects from the review are still open; the usage double count and the reused
  prompt after a local timeout are fixed in 0.1.10.
- Evidence: the `gpt-6-astra` and `deepseek-flash` passes over `v0.1.9..HEAD`, 2026-11-14.
  - `bankSuppressedPromptTurn` still divides the old way and ignores `turnReported`, so a
    suppressed turn that already reported a batch banks too much. Reusing
    `settlePromptTurnFromAcp` for the ACP case is the fix; a test needs a steering cancel that
    carries a prompt result.
  - A caller tool named `await_result` is shadowed by the relay tool; the internal name is not
    reserved in `src/mcp/schema/sanitizer.ts`. Either reserve the name (renaming the caller's tool
    is a visible change to their MCP catalog) or skip the relay for that session and say so.
- Also unverified: whether `session/prompt`'s `usage` includes the tokens of tool steps. The ACP
  path subtracts what batches reported (`src/usage/tracker.ts`), which is only right if it does;
  one probe with a tool call settles it.
- Decision: fix in that order, each with a reproduction.
- Acceptance: a test per defect that fails before the fix.

## 9. Ask Magpie for a "do not fail this turn over" signal

- Problem: a plugin can only choose a status Magpie's `retryable` does not list. `409` works for
  an account's own failure, but every `5xx` is retryable and `400` is retried whenever its words
  read as a quota, a refusal or an unserved model — so a vendor-wide outage, or a refusal worded
  in one of those ways, still reaches another account. There is no header to veto a retry:
  `x-should-retry` has no reader in Magpie.
- Evidence: `internal/gateway/fallback.go:2039-2064` (`retryable`), `internal/gateway/gateway.go:5208-5223`
  (rest then next candidate), and `internal/gateway/routing.go:610-634` (`failRate`/`failQuota`).
  Both `403` and `429` retry, which is why a community write-up's "a `403` would stop the pool"
  is wrong for Magpie.
- Options: (a) ask upstream for a documented stop signal (header or body marker) plus an optional
  per-request account-attempt budget; (b) map every status to `409` when failover is off, which
  lies about `5xx` and `404`; (c) leave it, and document `AffinityStrict` and `Manual` group
  routing as the user-side answer.
- Decision: (a) as a Magpie issue, (c) meanwhile; (b) rejected.
- Acceptance: an issue filed upstream describing the two statuses that cannot be stopped from a
  plugin, with the `409` workaround stated as a workaround.

## 10. Decisions not yet made

Each needs a decision before any code; none is scheduled.

- `application/pdf` documents: `agy 1.5.8` advertises `promptCapabilities.embeddedContext: true`,
  but native handling of a `resource` (`blob` + `mimeType: "application/pdf"`) is unverified, so
  `src/protocol/anthropic.ts` rejects binary PDF document blocks with `400`. Decide after an
  end-to-end probe.
- Structured output: keep prompt-level `output_config.format` / `response_format`, or add a
  virtual `StructuredOutput` MCP tool with a retry loop and streaming `<tool_call>` text
  interception as Magpie's Claude bridge does (`claude_tui_schema.go`, `claude_text_calls.go`).
- Awaiting-tool retirement: the scheduler retires an `AWAITING_TOOL_RESULTS` worker after ten
  minutes (`src/runtime/scheduler.ts`), while the worker's tool-idle budget is sixty. With the
  170-second bound above, a long tool no longer waits inside a parked call, so decide whether ten
  minutes is the intended ceiling for the caller's own tool execution or whether it should match
  the tool budget. Either way the retirement has to reach the replay path, not an empty answer.
- Warm-session identity: keep tolerant `tool_use.input` prefix matching
  (`src/sessions/ledger.ts:272-276`) or require an exact count + prefix fingerprint + expected
  assistant fingerprint (zacbemis).
- Schema projection: whole-tool omission with validation against the original schema (zacbemis)
  versus the current lowering to `agy`'s narrower translator; needs a validator choice and a
  tool-loss policy.
- Credential storage: `AGY_ACP_FORCE_FILE_STORAGE` in place of the `SSH_CONNECTION` marker,
  only if the `agy` CLI is shown to honor it.
- Per-session Bearer header in addition to the URL token, only if URL exposure becomes a concrete
  threat.
- Not yet evaluated against this plugin: selector read-back and permission-mode drift checks
  (zacbemis); "status OK with no model output" as a failure, `<SYSTEM_MESSAGE>` echo stripping,
  and strip-and-reparse of known noise lines (estebanforge).

## Optional refinements

- Restructure `docs/claude-bridge-parity.md` around a capability matrix (one row per capability,
  one column per bridge), in the manner of estebanforge's `docs/ENGINES.md`.
