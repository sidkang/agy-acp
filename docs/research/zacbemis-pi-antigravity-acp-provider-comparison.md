# `pi-antigravity-acp-provider` vs this plugin

Second pass, read against `/Users/sid/Devs/antigravity-magpie` (`99de26c3`, 0.1.9).
Companion to `zacbemis-pi-antigravity-acp-provider.md`.

## Where we differ

| Axis | Them | Us |
|---|---|---|
| Host | pi extension | Magpie plugin |
| Upstream | Google's **`agy_acp_server`** runtime over ACP, manifest-pinned (`src/acp/process.ts:140-155`) | the user's `agy` CLI, `agy acp --worker` |
| Runtime integrity | signed runtime manifest (`runtime-manifest.json`, `src/acp/runtime-manifest.ts`) | none; we spawn whatever `agy` resolves to |
| Quota text | exact fixed-notice parser → `resetAt` ISO (`src/acp/quota.ts:5-25`) | regex on retry wording → `Retry-After` seconds (`src/runtime/diagnostics.ts`) |
| Redaction | URL userinfo, `AIza`/`sk-`/`npm_`/`gh*_`, `ya29.`/`1//`, auth headers, JSON token fields, 4096 cap (`src/acp/errors.ts:30-45`) | bearer/`ya29.`/`1//`/`4/0A`, loopback `/mcp/<token>`, OAuth params, JSON keys (`src/accounts/env.ts:605`) |
| Schema sanitizer | `src/mcp/schema.ts` (223) | `src/mcp/schema/` (sanitizer + array-items + RE2 pattern) |
| Accounts | one | pooled |

## What to adopt

1. **The spent-window notice parser.** Their regex pins the exact sentence
   `"Usage Limit Reached\n\nYou have reached your current quota for this period."` and reads
   either a relative reset (`in 3 hours, 20 minutes`) or an absolute one (`on Nov 14, 2026 09:00
   UTC`), returning `resetAt` as an ISO timestamp (`src/acp/quota.ts:5-25`). We currently
   derive `Retry-After` from looser phrasing (`retryAfterSecondsFrom`) and cannot express
   "resets at 09:00 UTC". Their shape is strictly better for a *named* window: it gives an
   absolute time, and it distinguishes a spent window from a throttle by the sentence itself.
2. **Their redaction vocabulary.** `AIza…`, `sk-…`, `npm_…`, `gh[opurs]_…`, URL userinfo
   (`scheme://user:pass@host`), and `authorization`/`cookie`/`set-cookie` values
   (`src/acp/errors.ts:30-45`). Our `redactSecrets` covers OAuth shapes but not an `AIza` API key
   or a `ghp_` token, and we do not touch URL userinfo.
3. **A signed manifest for anything we launch.** They pin the ACP runtime they start with a
   signature check (`src/acp/runtime-manifest.ts`, `scripts/sign-runtime-manifest.mjs`). We
   spawn the user's own `agy`, so this is less pressing, but the pattern is what a version gate
   should look like when the thing being launched can change under us.

## What we do better

- Their quota parser is a fixed string: any vendor rewording silently disables it
  (`src/acp/quota.ts:5-9`). Ours matches a family of phrasings and clamps, and it is covered by
  tests on both sides (a named window answers `quota`, a bare throttle answers `rate_limit`).
- Error codes are coarse (9 values, no client-visible text discipline) versus our
  status + type + wording triple chosen for Magpie's router.
- Pooling, isolation, per-account quota attribution: absent.

## Gaps it already solves on our side

The deep-dive pass (`zacbemis-pi-antigravity-acp-provider-deep-dive.md`) lines these up against
defects we have open:

1. **`AGY_ACP_FORCE_FILE_STORAGE`** (`src/acp/credential-storage.ts:8`) is the server's own knob
   for file-backed credentials; we reach the same effect with an `SSH_CONNECTION` marker
   (`src/accounts/env.ts:273-274`). If the knob exists in the version we support, use it.
2. **Inactivity-based prompt watchdog** with separate idle and busy windows, `unref()`ed
   (`src/acp/prompt-watchdog.ts:6-10,29-42`) — the shape of the still-unfixed defect where our
   total-duration timer can expire mid-tool-call and leave the native generation alive.
3. **Exact history identity**: `messageCount` plus a prefix fingerprint plus the expected
   assistant fingerprint (`src/runtime.ts:587-596,610-618`), instead of our tolerant
   `tool_use.input` matching.
4. **`proper-lockfile` around the session store's read-modify-write**
   (`src/acp/store-lock.ts:4-16`) — the cross-process claim our shelf store lacks.
5. **Never truncate instructions**; throw `invalid_input` instead
   (`src/stream/context.ts:27-32,119`) — the opposite of our silent clipping, where the ledger
   still records the untruncated request.
6. **Quota gate before the turn is persisted**, conditioned on zero usage or `refusal`
   (`src/runtime.ts:653-662`), so a quota refusal never enters history as an answer.

## Concrete next actions here

- Extend `redactSecrets` (`src/accounts/env.ts:605`) with `AIza`, `sk-`, `gh*_`, and URL
  userinfo; add a case to the existing leak regressions.
- Add an absolute-reset branch to the quota path so a notice naming a reset time produces
  `Retry-After` computed against that time, not a fixed number of seconds.
