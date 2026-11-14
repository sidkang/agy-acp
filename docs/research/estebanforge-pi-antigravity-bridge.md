# EstebanForge/pi-extensions — `packages/pi-antigravity-bridge`

Studied at the repository's default branch, shallow clone. Citations are relative to
`packages/pi-antigravity-bridge/` (~11.3k lines of `src`). It is the most feature-dense of
the four, and the only one that ships **two turn engines behind one interface**.

## 1. What it is

A **pi extension** wrapping the Antigravity CLI, with two interchangeable turn drivers: a
`stream-json` CLI driver and an ACP driver, chosen at runtime behind `TurnDriver`
(`src/driver-types.ts:1-20`). Auth is `agy`'s own, read from an isolated home it stages
(`src/driver.ts:461`); no token handling of its own.

## 2. Transport and process model

| Engine | Shape |
|---|---|
| stream-json (`src/driver.ts`) | one child per profile: `agy --add-dir <cwd> [--gemini_dir <staged home>] [--add-dir <bridgeDir>] --model --effort --mode [--agent] [--dangerously-skip-permissions] [--conversation <id>] --input-format stream-json --output-format stream-json --disable-slash-commands` (`:460-481`) |
| ACP (`src/acp/`) | `initialize` with `clientCapabilities{fs:false,terminal:false}` (`src/acp/connection.ts:5`), `session/new` and `session/load` resume, protocol-native cancel (`src/driver-types.ts:8-11`) |
| Process lifecycle | detached process group on POSIX, `windowsHide` on Windows, pid kept after kill so late stragglers cannot write into a home being removed (`src/driver.ts:481-495`) |

Engine-specific capability gaps are documented in code: the ACP driver has no `--agent`
slot, so `/agy agent` refuses to set one while ACP is active
(`src/driver-types.ts:22-24`).

## 3. Tool channel

Pi's tools are staged as an **MCP entry in agy's config**, with a per-pid name and a token
header: `mcpServers[bridgeServerName(pid)] = { disabled:false, serverUrl, headers:{x-bridge-token} }`
(`src/mcp-registration.ts:8-9`, `:91`, `:116`). The file is the user's global agy config,
which the code calls out as a deliberate (and previously audited) trade
(`src/mcp-registration.ts:70`).

Three additional mechanisms are unusual:

1. **Approval gate with shadow tools.** When active, pi's mutating builtins (`bash`,
   `write`, `edit`) are re-registered under the same name and schema plus internal
   `__agy*` marker fields; a marked call is an approval round-trip for an agy *native* tool
   and is never executed locally (`src/approval-gate.ts:1-14`).
2. **Approval hook staging.** agy discovers `.agents/hooks.json` in `--add-dir`
   directories, so the gate's hook file lives in a dedicated bridge dir given only to this
   session's agy — "standalone IDE/CLI sessions must never load our gate"
   (`src/approval-hook.ts:3-16`, `src/driver.ts:465-468`).
3. **Native re-execution.** Read-only agy tools (`read`, `ls`, `grep`, `find`) are emitted
   as real pi tool calls so pi's own renderers run them; mutating and specialty tools are
   replayed through a display-only wrapper instead (`src/native-tools.ts:1-10`).

## 4. Thinking / reasoning

- agy thoughts become **pi thinking blocks**, and agy tool activity is rendered as a
  thinking block labelled `[agy tool: <name>]` (`src/provider.ts:15-16`, `:1262-1317`).
- A `thinking_signature?: string` field exists in the event type
  (`src/stream-events.ts:39`) but is **never emitted**; no `signature`, `signature_delta`
  or `redacted_thinking` handling exists in `src/` — **signature: absent**.
- `thinking.type === "disabled"`: not applicable (pi-side reasoning effort, forwarded as
  `--effort`, `src/driver.ts:466`).

## 5. Error handling

No HTTP statuses, no `Retry-After`, no `x-should-retry` (**absent**) — the host is pi, so a
turn yields a `TurnOutcome` whose status is `"OK" | "ERROR"` (`src/driver-types.ts:5-20`).
What they do instead is worth a table:

| Condition | Handling | Citation |
|---|---|---|
| `status === "OK"` but no model output | treated as agy's **silent drop**, not success | `src/provider.ts:1660-1662` |
| turn past the deadline | labelled by its real cause, not as a generic failure | `src/provider.ts:1681` |
| stdout silent for N minutes | stall guard fails the turn | `src/parked-turn.ts:1-23` |
| ACP cancel | notification first, teardown as fallback | `src/driver-types.ts:8-11` |
| malformed frame | hard 32 MB per-frame ceiling, then repair by dropping to the marker | `src/frame-guard.ts:8-30` |

Quota classification is **absent** at the error layer; quota is read separately (section 7).

## 6. Prompt handling

- **System prompt is not sent in the prompt line.** The stream-json path silently drops any
  turn past a ~25 KB input cap (probed 2026-09-30: `status SUCCESS`, empty response, zero
  usage, conversation then unresponsive), so the system prompt is staged as an **agy agent
  file** discovered under `~/.gemini/config/agents` and passed with `--agent`
  (`src/sysprompt-agent.ts:1-16`).
- **History:** stream-json path keeps a conversation id and recycles the process on profile
  drift (`src/driver.ts:460-481`); ACP path resumes with `session/load`
  (`src/acp/connection.ts:58`).
- **Cloaking/rewriting: absent** — instead the opposite is done: **stream sanitisation**.
  Antigravity injects `<SYSTEM_MESSAGE>…</SYSTEM_MESSAGE>` background-task notifications
  that models echo verbatim; a stateful sanitizer strips those blocks across deltas
  (`src/stream-sanitizer.ts:1-16`).
- **Images:** handled in `src/prompt-images.ts` (not inspected in depth).

## 7. Accounts / quota

Single account per staged home. `parseAgyUsageJson` reads agy's usage JSON into
`groups[].buckets[]` with `window` (`"weekly" | "5h"`, tolerant of new tags),
`remaining_fraction` and `reset_time` (`src/usage.ts:6-7`, `:24-27`, `:62-64`, `:83`), plus a
`quotaBar` and a clock-style reset label (`src/usage.ts:136-141`). Catalog and engine picker
are separate modules (`src/bridge-catalog.ts`, `src/engine-picker.ts`).

## 8. Notable and fragile

**Worth stealing**
- The 25 KB stream-json input cap and the fix: stage the system prompt as an agent file
  instead of riding the prompt line (`src/sysprompt-agent.ts:1-16`). Any bridge that renders
  long history into one prompt inherits this cap.
- Silent-drop detection: `status OK` with no model output is a failure, not a success
  (`src/provider.ts:1660-1662`).
- `<SYSTEM_MESSAGE>` echo stripping (`src/stream-sanitizer.ts:1-16`).
- Per-frame ceiling plus repair, so one flooded frame cannot wedge the reader
  (`src/frame-guard.ts:8-30`).
- Approval hook staged in a private `--add-dir` so other agy sessions never load it
  (`src/approval-hook.ts:3-16`).

**Looks fragile**
- Registering the bridge in the **user's global** agy MCP config means a crashed session can
  leave a stale entry behind (`src/mcp-registration.ts:8-9`, `:70-116`).
- Two engines with different capability sets invites drift; the code already carries
  "ACP has no agent slot" and "recycle on profile drift" carve-outs
  (`src/driver-types.ts:8-11`, `:22-24`).
- The shadow-tool approval scheme depends on marker fields surviving pi's schema handling
  (`src/approval-gate.ts:1-14`).

## Open questions

- Whether the ACP engine reaches the same tool set as stream-json for every tool; only the
  `--agent` gap is documented (`src/driver-types.ts:22-24`).
- Whether the `<SYSTEM_MESSAGE>` preamble is stable across Antigravity builds; the sanitizer
  matches fixed markers (`src/stream-sanitizer.ts:13-16`).
