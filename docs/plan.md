# Open work

Open items only, most consequential first. Each states the problem, the evidence, the options,
the recommended decision and how to accept it. When an item ships, delete it here and record it in
[`CHANGELOG.md`](../CHANGELOG.md). Evidence about sibling bridges is in
[`research/`](research/README.md).

## 1. Bound a parked tool call below `agy`'s 180-second MCP deadline

- Problem: the broker parks a caller tool call for up to 15 minutes (`src/mcp/broker.ts:57`), but
  `agy` abandons the `tools/call` POST at 180 s, tells the model the tool timed out, and ends the
  turn as an ordinary 200 answer. The broker then holds a parked call nobody consumes, and the
  caller's real result arrives at a closed connection: neither `src/mcp/http-server.ts` nor
  `src/mcp/broker.ts` observes `request.signal`.
- Evidence (measured 2026-11-14 on `agy 1.5.9`, one live ACP turn against a fake Streamable-HTTP
  MCP server): the call arrives at t=11.3 s with `_meta` carrying
  `antigravity.google/conversation_id` and a `progressToken`; the client aborts the POST at exactly
  180.004 s and sends `notifications/cancelled`; at 199.6 s the model writes the timeout as ordinary
  text and `session/prompt` settles `end_turn` with a normal `usage` block. The client never opens a
  GET/SSE stream on `/mcp/:token`, so `notifications/progress` has no transport and cannot extend
  the deadline. fdkevin0 relays a parked call at 85 s for the same reason
  ([research](research/fdkevin0-pi-agy-acp.md)).
- Decision: a bounded wait, not a relay. At 170 s answer the `tools/call` with an `isError` result
  saying the bridge stopped waiting (not that the tool failed), retire the worker, and let the
  caller's next Messages request cold-replay the transcript with the completed `tool_result`
  (`SessionCoordinator.executeFreshSessionTurn`). Also observe `request.signal` on the parked POST
  and handle `notifications/cancelled`; a permission request outside the `magpie` server answers
  `502` `MAGPIE_BRIDGE_UNEXPECTED_TOOL` instead of an empty 200. A fetch tool stays rejected: the
  caller already has a result-delivery surface, and a second retrieval protocol would still need
  the same replay fallback.
- Acceptance: a fake tool that sleeps past the threshold produces the `isError` notice, the worker
  retires and the next request's result reaches a fresh session; an aborted POST leaves no parked
  call; an unexpected-tool turn answers 502 rather than empty text.

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

## 8. Decisions not yet made

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
