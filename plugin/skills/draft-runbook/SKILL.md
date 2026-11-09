---
name: draft-runbook
description: Turn an incident write-up, postmortem, Slack thread or pasted notes into a draft runbook in the team's knowledge repo, opened as a draft pull request for the owning team. Use when someone says "write a runbook for this", "turn this incident into a runbook", or pastes an incident timeline and asks for a procedure.
---

# Draft a runbook

The goal is a draft PR that adds one runbook in the Docsworth format. It's owned by one
team and has the four sections the skills compiler needs. Nothing merges without that
team's review.

## 1. Gather the source

Work only from material the user gave you: pasted text, a file path, or an incident
document they point to. If a command or step isn't in the source, don't invent it. Leave
a `TODO(owner):` line where the source is silent.

## 2. Check for an existing page first

Use the Docsworth `search` tool twice: once with the incident's symptoms, once with the
service name. Pass `include_stale: true` both times, so you also see excluded pages.

- If a runbook already covers this procedure, stop. Use the `update-after-incident`
  skill instead and propose edits to that page. A second runbook for the same thing is
  how wikis rot.
- If a gated or overdue page covers it, say so and name the owning team.

## 3. Work out the owner

The owner is a team, never a person. Read the service page with the `read` tool (for
example `svc-<service>`) and use its `owner_team`. If several teams are plausible, ask
the user. You don't pick the file name: `draft_page` names the page and places it where
CODEOWNERS gives it to that team, as `<team>-<slug>` where CODEOWNERS routes runbooks by
prefix.

## 4. Write the body

`draft_page` writes the frontmatter itself (`status: draft`, the owner, today's
`last_verified`, `review_every: 90d`), so write only the markdown after it, in this
shape. The skills compiler needs all four sections.

```markdown
# <Imperative title, e.g. Drain the webhook backlog>

## When to use
- <the alert, symptom or request that triggers this>

## Steps
1. <one action per step, with the exact command in backticks>

## Checks
- <how to tell it worked>

## Rollback
- <how to undo it, or why it cannot be undone>
```

## 5. Open the draft PR with `draft_page`

Call the Docsworth `draft_page` tool. Don't use git or `gh` for this: the tool opens the
PR from its own `docsworth/draft/` branch and never writes to the default branch.

- `type`: `runbook`
- `title`: the imperative title
- `owner_team`: the team from step 3
- `description`: one sentence, what this procedure does
- `body`: the markdown from step 4
- `source_url`: the incident document's link, if the user gave one
- `reason`: the incident it comes from, every `TODO(owner):` you left, and the service
  it applies to (`applies_to: [service:<name>]`), which the owners add in review

If it refuses because CODEOWNERS gives the directory to another team, tell the user what
it said and ask which directory the team owns; pass that as `dir` and call it again.

Report the PR URL and the page's path, and list every `TODO(owner):` you left.
