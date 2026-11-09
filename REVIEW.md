# Review policy — Docsworth

Three passes, in this order. Report findings for each pass separately.

## Pass 1 — Bugs and logic

Does it do what it claims? Look for off-by-one errors, unhandled error paths, the wrong
branch taken, shared state mutated, and leaks.

Read these twice:

- SLA date arithmetic. It's UTC and date-only, with month-end clamping.
- CODEOWNERS last-match-wins.
- The BM25 index's dirty and rebuild path.
- Mirror pagination and retry.
- Partial failure of the multi-call write flow: ref, then file, then PR.

## Pass 2 — Security

This repo's security surface is the ACL and the write path.

- **ACL.** Every MCP tool must resolve page ids through `visiblePages(identity)`. Look
  for anything that bypasses that view:
  - raw `repo.pages` access in a tool
  - an error message that differs between a hidden id and an unknown one
  - a snippet or link that names a hidden page
- **Writes.** Every mutating GitHub request must carry an explicit branch that isn't the
  default branch. There are no exceptions.
- **Page and mirror content** is untrusted data. It must never reach an instruction
  position, a shell, or a URL the server fetches.
- **Tokens** (GitHub, Confluence, Notion, Anthropic, Slack) must never appear in logs,
  errors, fixtures, or the usage log.

## Pass 3 — Conformance

Check the diff against what the PR says it does, against `docs/format-spec.md` where it
touches the format, and against `AGENTS.md`. Look for:

- a requirement silently dropped
- a test that can pass without the guard it names (prove it by deleting the guard)
- anything in core (`src`, `test`, `scripts`) that imports pro, or pro reaching core other than through `@docsworth/cli/host` (and, in its tests and scripts, `@core-repo`)
- the word "contradiction" where the code only detects overlap
- "cited" where the data is retrievals

## Important versus Nit

**Important** — wrong, unsafe, or soon to be wrong. Say what breaks and under which
input. **Nit** — style or preference, prefixed `Nit:`, at most five per review.

## Do not report

- Formatting or type errors. `npm test` runs `tsc`.
- `package-lock.json`, `examples/**` content prose, or recorded API fixtures.
- Speculation. "Could not check X" is a gap, not a finding.

## Approval

The model that wrote the diff doesn't review it. Every finding gets checked against the
code before it's applied or rebutted. A finding seen twice becomes a line in
`AGENTS.md`.
