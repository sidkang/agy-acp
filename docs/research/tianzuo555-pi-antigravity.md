# `@tian.zuo/pi-antigravity` (TianZuo555/pi-extensions, packages/pi-antigravity)

Read at `git clone --depth=1` of `TianZuo555/pi-extensions`, package version `0.12.1`.
This is a **pi extension** (it registers a `pi-ai` provider), not a Magpie plugin: it never
speaks Anthropic HTTP, so half of the questions that decide our routing do not exist here.

## 1. What it is

- Drives the official `agy` CLI and nothing else: "This extension never talks to Google's
  servers itself. Authentication, tokens, and all API access stay inside the official
  first-party `agy` CLI" (`README.md:139`). No OAuth code of its own, no token storage.
- Transport is **stream-json**: a persistent `agy` child speaking its NDJSON stream
  (`src/provider.ts:1-9`, `PLAN.md:47`), not ACP.
- Its `provider.api` is a synthetic id, `antigravity-stream-json`, with base URL
  `agy://local-stream-json` (`index.ts:738-740`) — pi treats it as one more API family.

## 2. Transport and process model

- One agy turn per pi request; the adapter translates the reduced outcome into pi
  `AssistantMessageEvent`s (`src/provider.ts:1-19`).
- agy streams **only the visible answer** as `text_delta` continuation chunks on
  `agent_response` steps (`src/provider.ts:5-7`).
- Tool steps render as native pi cards: display-only steps emit a pending card on ACTIVE and
  end the assistant message with `stopReason: "toolUse"`; native read-only steps wait for
  DONE so a failed read is never re-run as a successful pi tool (`src/provider.ts:11-18`).
- Lifecycle: `AntigravityRuntime` owns the child, with a singleton start promise, bounded
  readiness wait, line-buffered diagnostics, graceful-then-force shutdown (`PLAN.md:82`).
- Cancellation is the weak point and they say so: `agy` "offers no usable stop channel for a
  task started from pi", `/tasks` is interactive-only, and `manage_task` only kills from the
  owning process, so their sweeps are signal-based (`README.md:32`).

## 3. Tool channel

- A loopback **MCP streamable-HTTP** server exposes pi's tools to agy as `pi__<name>`, plus a
  pending-call store (`lib/bridge.ts:1-21`). Flow: agy calls `pi__<tool>` → handler enqueues a
  pending call → provider ends the pi turn with `toolUse` → pi runs the tool (its own hooks,
  permissions, abort) → the **next** `streamAntigravity` request re-attaches to the running
  agy turn, matches the result by `toolCallId`, and resolves the HTTP response (`lib/bridge.ts:5-16`).
- The HTTP handler never answers from its own side: it blocks until the provider hands the
  result back, or fails closed (`lib/bridge.ts:17-19`).
- A per-call cap must stay **below agy's 600 s turn timeout** "so agy can still report the
  failure" (`lib/bridge.ts:29`).
- Bridge tool name prefix `pi__`, server name `pi-bridge` (`lib/bridge.ts:25-26`); a
  `WRAPPER_TOOL_NAME` replay path exists for display-only steps (`lib/prompt.ts`,
  `lib/native-tools.ts`).

## 4. Thinking / reasoning

- **agy's print-mode stream-json exposes no thought text at all**; only `thinking_tokens`
  counts appear in usage (`src/provider.ts:7-9`). So they synthesize a **thinking block with
  empty text** and report the count as the reasoning subset:
  `output.content.push({ type: "thinking", thinking: "" })` (`src/provider.ts:608`) and
  `reasoning: u?.thinking_tokens` (`src/provider.ts:164`); a reserved slot that never gets a
  count is closed as an empty block, which the renderer trims (`src/provider.ts:403-416`).
- No Anthropic-style `signature` exists anywhere on this path: the concept belongs to the
  Anthropic API, and this package never builds one. `thinking.type === "disabled"` is absent
  because pi asks for a thinking *level* instead (`src/provider.ts:194` maps it to agy `--effort`).

## 5. Error handling

- Errors surface as pi `stopReason: "error"` with a message; there is no status code and no
  routing classification, because pi does not route across accounts.
- `lib/agy-diagnostics.ts` is about the **binary**, not runtime failures: it resolves
  `agy` (override/path/managed), runs `--version`, and classifies
  `not-found | permission-denied | timeout | spawn-failed | invalid-version | unsupported-version`
  (`lib/agy-diagnostics.ts:14-21`), gated by `MIN_AGY_VERSION = "1.1.22"`
  (`lib/agy-diagnostics.ts:12`).
- Binary choice is cached against a fingerprint of `size:mtimeMs:ctimeMs` per candidate, and
  the whole report is hashed into a `revision` (`lib/agy-diagnostics.ts:108-120`) — the same
  idea as our catalog cache fence.

## 6. Prompt handling

- System prompt is staged as an **agy agent file** in a per-process profile
  (`lib/agy-profile.ts`, `lib/prompt.ts`), not prepended to the prompt text.
- Compaction: "stream-json has no compaction event", so the boundary is **inferred** from a
  large drop in context footprint, with thresholds chosen to avoid mistaking cache churn for
  compaction (`lib/agy-compaction.ts:3-30`).
- Images are handled through a staged temp-file path with a bridge read tool
  (see the capability matrix in the sibling EstebanForge package for the same CLI).

## 7. Accounts and quota

- Single account: whatever `agy` is signed in as. No pool, no rotation.
- Usage UI reads `thinking_tokens` and token counts from the stream (`lib/usage.ts`,
  `src/usage-ui.ts`).
- Background tasks (`lib/tasks.ts`, `src/tasks-ui.ts`) with the signal-based sweep above.

## 8. Worth stealing / looks fragile

- **Worth stealing**: the binary resolution + version gate + fingerprint revision
  (`lib/agy-diagnostics.ts:108-120`); the fail-closed rule for a parked bridge call
  (`lib/bridge.ts:17-19`); the explicit "cap below the upstream's own turn timeout" budget
  (`lib/bridge.ts:29`).
- **Looks fragile**: signal-based task cleanup because the CLI has no stop channel
  (`README.md:32`); compaction inferred from a footprint drop (`lib/agy-compaction.ts:3-30`);
  no-op thinking blocks that only carry a token count (`src/provider.ts:403-416`).
