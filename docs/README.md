# Documentation scheme

Every document in this repository is one of the kinds below. Pick the kind first;
the kind decides the location, the tense, and what may appear in it.

| Kind | Location | Holds | Tense |
|---|---|---|---|
| User guide | `README.md`, `README.zh-CN.md` | install, configure, use | present |
| Reference | `docs/<subject>.md` | how this plugin behaves now, and why, with code locations | present |
| Research | `docs/research/<project>.md` | facts about one external project at a pinned commit | present, about that commit |
| Comparison | `docs/research/comparison.md` | one matrix: the external projects against this plugin | present |
| Research index | `docs/research/README.md` | what was compared, durable conclusions, links | present |
| Plan | `docs/plan.md` | open work only, each item a decision with acceptance criteria | future |
| History | `CHANGELOG.md` (repository root) | releases, what changed and why, incidents, review and research history | past, dated |

Current documents: [`claude-bridge-parity.md`](claude-bridge-parity.md) (shipped in the
npm package; the release gate pins this exact path), [`error-routing.md`](error-routing.md),
[`plan.md`](plan.md), and [`research/`](research/README.md).

## Rules for reference, research and comparison documents

1. State what is true at the commit or version the document names. One fact, one place:
   link to the document that owns a fact instead of restating it.
2. Never include process narrative. None of: how a pass or review was run, "pass N said X",
   "corrected from the first pass", "overturned on re-check", "this document once said",
   "previously" / "originally" / "an earlier version", checkboxes, progress logs, test counts
   for a past run, or the names of agents or models that produced or checked the text.
   That material goes to `CHANGELOG.md`, under the release or the research history entry.
3. Observations of upstream behavior carry their version and date
   ("observed on `agy 1.5.8`", "reported for `agy_acp_server` RC01, 2026-09-03"). A fact that
   differs between versions is stated per version; that is not history.
4. Label what is not established by code: *reported* (the external project says so and was
   not reproduced), *unverified* (no evidence either way), *inference* (our reading).
5. If two sources disagree, keep both in one sentence, each with its citation. Do not pick
   a winner without evidence; do not drop either side.
6. Recommendations do not belong in research documents. An open recommendation is a plan
   item; a closed one (adopted or rejected) is one row in the comparison and one line in
   `CHANGELOG.md`.

## Rules for the plan

Open work only. Each item: the problem, the evidence (links), the options with cost, the
recommended decision, and acceptance criteria. When an item ships, delete it from the plan
and record it in `CHANGELOG.md`. No status markers, no "done", no dates of progress.

## Rules for the changelog

Newest release first. For each release: what changed and why, the verification that was
run, and any incident it answered. Dates and versions where they exist; no speculation about
dates that are not recorded. Review and research history (passes, corrections, who-checked-what
in neutral terms) lives in its own section at the end.

## Citations

- `path:line`, `path:line-line`, or `path:a-b,c-d`, relative to the root of the checkout
  the document names in its header (repository, commit, version, date read).
- In a research or comparison document, a path into this repository is prefixed `agy-acp:`
  (for example `agy-acp:src/mcp/broker.ts:57`); unprefixed paths point into the external
  checkout. In reference documents, unprefixed paths are this repository.
- Magpie's own source is cited by its repository path (`internal/gateway/fallback.go:1667`).
- Never cite an absolute local path (`/Users/...`, `/tmp/...`).

## Language

English only, ASCII prose. The only places Chinese may appear are `README.zh-CN.md`,
`package.json` `magpie.summary.zh`, and the localization fields in `src/` (`src/options.ts`
labels and descriptions, `src/accounts/auth.ts` `IMPORT_FROMS`). `bun scripts/check-release.mjs`
enforces this for every file in the repository. Verbatim upstream strings (log lines, notices) may be
quoted exactly inside code spans. No emoji.

## Placing a new document

- It describes this plugin's current behavior: reference, `docs/<subject>.md`.
- It describes another project: research, `docs/research/<project>.md`, plus a column or
  rows in `comparison.md` and a link in the research index.
- It proposes work: an item in `docs/plan.md`, not a new file.
- It tells what happened (a release, an incident, a review): `CHANGELOG.md`.
