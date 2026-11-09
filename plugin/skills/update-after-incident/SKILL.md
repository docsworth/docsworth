---
name: update-after-incident
description: After an incident or postmortem, find the runbooks and service pages it touched and propose corrections to each as pull requests for the owning teams. Use when someone says "update the docs after this incident", "the runbook was wrong during the outage", or shares a postmortem and asks what knowledge needs fixing.
---

# Update knowledge after an incident

Incidents are when runbooks prove wrong. The goal is a small, reviewable PR on each
affected page, each with its evidence from the incident. A rewrite is never the goal.

## 1. Extract what actually happened

From the postmortem or notes the user gave you, list:

- the symptoms and alerts
- the services involved
- every command or step responders actually ran
- what didn't work, and what they did instead
- any new check or rollback they discovered

## 2. Find the affected pages

Use the Docsworth `search` tool with the symptoms, then with each service name, passing
`include_stale: true`. `read` every candidate. A page is affected when the incident
showed that one of these is wrong or missing:

- a step
- a command
- a threshold
- a check
- a rollback

The search results also list excluded pages: overdue, deprecated or draft. Tell the
user which of those the incident touched and which team owns each. An overdue runbook
that failed during an incident is the most important thing to surface.

## 3. Propose edits, one PR per page

For each affected page, call `propose_edit` with:

- **`edits`:** exact `old` → `new` replacements. Copy `old` verbatim from the `read`
  result, and include enough surrounding text that it matches exactly once. Prefer
  several small edits to replacing the whole `content`.
- **`reason`:** the incident id or date, what happened, and which edit fixes what.
  Reviewers read this first.
- **`draft`:** `true` when you're unsure whether a change is right.

Never try to change `id`, `owner_team`, `acl` or `last_verified`; the tool refuses.
Verification belongs to the owners, through the `verify` tool.

If `propose_edit` refuses because this session read pages with a narrower audience,
don't work around it. Tell the user which page needs the edit and let them open it
separately.

## 4. Report

List each PR URL with its page and owning team. Then list the gaps the incident
revealed where no page exists yet. Each gap is a candidate for the `draft-runbook`
skill.
