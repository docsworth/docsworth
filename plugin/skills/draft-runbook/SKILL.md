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
the user. Then confirm that CODEOWNERS assigns that team to the target path. That path is
normally `knowledge/runbooks/<slug>.md`, or `knowledge/runbooks/<team>-<slug>.md` where
CODEOWNERS routes by prefix.

## 4. Write the page

Use this shape exactly. `docsworth lint` enforces the frontmatter, and the skills compiler
needs all four sections.

```markdown
---
title: <Imperative title, e.g. Drain the webhook backlog>
id: rb-<slug>
type: runbook
status: draft
owner_team: <team slug>
last_verified: <today, YYYY-MM-DD>
review_every: 90d
applies_to: [service:<name>]
description: <one sentence: what this procedure does>
---
# <Title>

## When to use
- <the alert, symptom or request that triggers this>

## Steps
1. <one action per step, with the exact command in backticks>

## Checks
- <how to tell it worked>

## Rollback
- <how to undo it, or why it cannot be undone>
```

Always use `status: draft`. The owning team promotes it to `canonical` in review.

## 5. Open a draft PR

The knowledge repo is the directory in `DOCSWORTH_KNOWLEDGE_DIR`, or the current project if
that isn't set. Work on a new branch and never commit to the default branch:

1. `git switch -c docsworth/draft/<id>`
2. Write the file.
3. Run `docsworth lint .` and fix every
   error. Overdue warnings on other pages are fine.
4. `git add <file> && git commit -m "docs(<id>): draft runbook from <incident>"`
5. `git push -u origin docsworth/draft/<id>`
6. `gh pr create --draft --title "Draft runbook: <title>" --body "<source and open TODOs>"`

Report the PR URL and list every `TODO(owner):` you left.
