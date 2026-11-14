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

## The observed case, in short

One account on this machine was disabled. Three things in its records bear on the risk:

- **Where its traffic went.** 3,729 of its 4,074 attributed gateway requests went through
  Magpie's own native `antigravity` provider, which speaks to
  `daily-cloudcode-pa.googleapis.com` directly; 345 went through this plugin, all of them
  through the official `agy` binary.
- **What does not separate it from an account that still works.** Concurrency (5 overlapping
  HTTP requests against 8), `/usage` polling, and the "not logged into Antigravity" startup
  lines are all present on the accounts that survived, so none of them explains the choice.
- **Scale.** 106.8M recorded input tokens, 770.7M cache reads, one request with 790,385
  uncached input tokens.

Attribution to this plugin alone is not supported by these numbers, and the four sibling
bridges are not a clean control group either: estebanforge's changelog records a ToS-disabled
account (`CHANGELOG.md:71`) and its fake ACP server has a case for the suspension notice
arriving as normal content.

The metrics table, the request timeline, the log searches and the full hypothesis list are the
incident record, in [`CHANGELOG.md`](../CHANGELOG.md), "account disablement research".

## What this plugin does that the siblings do not

From the code comparison in [`research/comparison.md`](research/comparison.md):

1. A bridge-owned Google OAuth flow that reuses Antigravity's installed-app client
   identity and writes the resulting token into the account's isolated directory
   (`src/accounts/auth.ts:25-30`).
2. Rewording system-prompt lines that identify a third-party harness so a vendor check
   stops refusing the request (`src/protocol/cloak.ts`). Off by default since 0.1.10.
3. A multi-account pool, and until 0.1.10 an automatic failover on quota `429` and on
   policy or suspension `403` (`src/index.ts:150-205`, `src/runtime/worker.ts:1150-1230`).
   Automatic failover is off by default now: `account_failover` decides it, and the router
   stops at the account that failed (see below).
4. Bulk refresh-token import, up to 100 accounts per batch (`src/accounts/auth.ts:50-54`).

None of the four siblings does (1), (3) or (4) in the same way; none rewrites prompts.

## Account rotation, and the claim that a `429` baits the pool

A community write-up argues that Antigravity answers a third-party prompt with a `429`
rather than the `403` a policy refusal would warrant, and that the point is to bait an
account pool: a `429` reads as "rate limited, try the next account", so one refused request
walks every idle account in the pool and hands the vendor a list to enforce against later.

What is established, and what is not:

- **Established by others**: since 11-14 the vendor's check sees through zero-width
  character splitting and folded white space, and reworded equivalents pass
  (`magpie-community/plugins@5bb4194`: 5 of 5 refused before, 10 of 10 after, on a real
  account). `DylanLIiii/opencode-antigravity-bridge` issue #67 and PR #71 are that report.
- **Not established**: a September start date, a rule that matches any `RFC 2119` fragment
  rather than the complete sentence, the vendor omitting `Retry-After` on purpose, and
  deliberate account collection. This repository has no observation either way: an
  account's `agy` log records prompt length, never prompt text, so a refused prompt leaves
  no line to count.
- **One premise of the write-up is false for Magpie**: it says a `403` would stop the pool.
  Magpie retries `403` too (`internal/gateway/fallback.go:2048`), and it reads no response
  header that could veto a retry. Only a status it does not list stops the walk.

What this plugin does about the mechanism, without claiming the motive:

- **`account_failover` is off by default.** A turn that fails on this account's own quota,
  sign-in, credit or policy answers `409`, which Magpie does not fail over, so one failure
  no longer becomes a request from every account. See
  [`error-routing.md`](error-routing.md) §1.1 for the mapping and its two costs.
- **A bare `429` that names no spent window, on a prompt that carries a trigger line, is
  answered `400` with a hint instead of a `429`** — whether or not cloaking was on, because
  a rewording that still met a `429` failed at its job. This is the case the write-up
  describes: the refusal is not read as the account's problem, and nobody is asked in its
  place.
- **A named spent window keeps its own answer.** A `429` that says which window is spent is
  evidence about the account, not about the prompt, so it is not converted into that hint.
- **Still open:** every `5xx` is retryable and a plugin cannot change that, so a vendor-wide
  failure may still reach another account. Magpie's own group routing can stop that for
  every provider: `AffinityStrict` keeps a conversation on the account that answered it,
  and a `Manual` group sends only to the member the user picked
  (`internal/provider/group.go:54-90`). A plugin can only choose a status the router does not
  follow; it cannot veto a retry any other way.

## Standing decisions

- Account risk is the user's: the README states the clauses, what the plugin does, and
  that the maintainer cannot restore a disabled account.
- Prompt cloaking is off by default; detection of a refusal is unaffected.
- An account the vendor disabled is recorded for six hours and later turns fail fast
  with the same `403` instead of spawning `agy` for a refusal
  (`src/accounts/policy-block.ts`).
- The pool does not walk itself: `account_failover` defaults to off, so a failed account's
  error comes back and the user picks the next one. Turning it on is the user's call, and
  the terms call that automation unsupported.
- Prompt-refusal detection does not require cloaking to be off any more: a rewording that
  still met the refusal is the clearest case of the prompt being the problem.
