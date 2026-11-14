# Account safety

What the vendor's terms actually say about a plugin of this shape, what enforcement
looks like, and what one disabled account's logs do and do not show. Clauses quoted
2026-11-14; the log evidence is from the same day.

## What the terms prohibit

Google Antigravity Additional Terms of Service, section 6
([antigravity.google/terms](https://antigravity.google/terms/)):

> You must not abuse, harm, interfere with, or disrupt the Service. This includes, but
> is not limited to, using the Service in connection with products not provided by us.
> Using third party software, tools, or services to access the Service (e.g. using
> OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be
> grounds for suspension or termination of your Antigravity and/or Gemini CLI accounts.

Antigravity FAQ ([antigravity.google/docs/faq](https://antigravity.google/docs/faq/)):

> Antigravity CLI headless mode (`agy -p`) is intended for direct scripting and CI
> workflows. Wrapping `agy` inside third-party coding agents or applications, or
> automating account rotation, is not supported under consumer plans.

Gemini CLI FAQ ([geminicli.com/docs/resources/faq](https://geminicli.com/docs/resources/faq/)):

> Using third-party software, tools, or services to harvest or piggyback on Gemini
> CLI's OAuth authentication to access our backend services is a direct violation ...
> such actions may be grounds for immediate suspension or termination of your account.

The generic Google Terms of Service add the intent clauses that make hiding the client
a losing strategy: "bypassing our systems or protective measures", and "hiding or
misrepresenting who you are in order to violate these terms". The supported path for a
third-party coding agent is a Vertex AI or AI Studio API key (Gemini Code Assist FAQ).

A plugin that wraps `agy` for another agent, keeps a pool of accounts and rotates them
is therefore inside the prohibited set by construction. There is no configuration that
removes that risk while keeping the function; the choices are risk reduction and a
bounded loss.

## What enforcement looks like

- A service-level `403 PERMISSION_DENIED` carrying "This service has been disabled in
  this account for violation of Terms of Service. Please submit an appeal to continue
  using this product." This is the only shape observed in the reports below.
- Different from quota exhaustion, geo or age ineligibility, and account verification.
  The four are frequently confused in threads; only this sentence is the terms ban.
- Reported to cover Antigravity, Gemini CLI and Code Assist rather than the whole Google
  account: web Gemini kept working in several reports, and a Google employee said other
  services were unaffected (Varun Mohan, 2026-02-23).
- No advance notice appears in any report consulted. Google's Terms of Service allow
  action without notice where notice would "compromise the operation, integrity, or
  security of our services". One self-serve appeal is reported; the form's own wording
  says repeated violations lead to permanent suspension and asks the user to confirm the
  third-party tool was removed. Restorations in 24-72 hours are reported.
- Named in reports as grounds: OpenClaw, OpenCode, Claude Code, Codex wrappers,
  CLIProxyAPI, CPA, 9router, and Antigravity Manager behind a reverse proxy. Paid Pro and
  Ultra plans are reported as not immune. These are user reports; Google does not publish
  per-account reasons.

### Sources for the enforcement claims

Terms quoted above, fetched 2026-11-14:
[antigravity.google/terms](https://antigravity.google/terms/),
[antigravity.google/docs/faq](https://antigravity.google/docs/faq/),
[geminicli.com/docs/resources/faq](https://geminicli.com/docs/resources/faq/),
[policies.google.com/terms](https://policies.google.com/terms).

Enforcement reports and staff statements consulted: gemini-cli discussion 20632
(maintainer, 2026-02-27), gemini-cli issue 29759 (2026-10-15), openclaw issue 14203
(2026-02-11), and threads on discuss.ai.google.dev 123014, 140740, 198483, 198531,
198859, 199777, plus V2EX and linux.do threads from February to November 2026. Varun
Mohan's statement is his X post of 2026-02-23, quoted by VentureBeat the same day. The
appeal-form wording is quoted in gemini-cli issue 29759 and in the linux.do threads.

## One disabled account, in numbers

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

### What these numbers do not support as the explanation

Each of these is present on the accounts that still work, so none of them separates the
disabled account from the others. That is not the same as excluding a contributing
cause: these are two accounts observed after the fact, not a controlled comparison.

- Concurrency: the disabled account peaked at 5 overlapping HTTP requests, a working
  account at 8.
- `/usage` polling: 569 invocations on the disabled account, 482 on a working one, 380
  on the third, which had no gateway traffic at all.
- "You are not logged into Antigravity" startup lines: present on all three accounts,
  thousands of times each.

### What they point at

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
ToS-disabled account (`CHANGELOG.md:71`) and its fake ACP server has a case for the
suspension notice arriving as normal content.

## What this plugin does that the siblings do not

From the code comparison in [`research/comparison.md`](research/comparison.md):

1. A bridge-owned Google OAuth flow that reuses Antigravity's installed-app client
   identity and writes the resulting token into the account's isolated directory
   (`src/accounts/auth.ts:25-30`).
2. Rewording system-prompt lines that identify a third-party harness so a vendor check
   stops refusing the request (`src/protocol/cloak.ts`). Off by default since 0.1.10.
3. A multi-account pool that fails over on quota `429` and on policy or suspension `403`
   (`src/index.ts:150-205`, `src/runtime/worker.ts:1150-1167`).
4. Bulk refresh-token import, up to 100 accounts per batch (`src/accounts/auth.ts:50-54`).

None of the four siblings does (1), (3) or (4) in the same way; none rewrites prompts.

## Standing decisions

- Account risk is the user's: the README states the clauses, what the plugin does, and
  that the maintainer cannot restore a disabled account.
- Prompt cloaking is off by default; detection of a refusal is unaffected.
- An account the vendor disabled is recorded for six hours and later turns fail fast
  with the same `403` instead of spawning `agy` for a refusal
  (`src/accounts/policy-block.ts`).
- Magpie fails a `403` over to another account, which is unchanged: the account pool is
  the reason the plugin exists, and the rotation decision is the user's.
