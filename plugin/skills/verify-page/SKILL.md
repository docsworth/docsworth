---
name: verify-page
description: Walk a page's owner through checking that a knowledge page is still true, fix what is not via a proposed edit, then open the verify PR that resets its review clock. Use when someone says "verify this runbook", "this page is overdue", "re-verify our team's docs", or after the weekly owner digest lists pages due for review.
---

# Verify a page

Verification is the owning team saying "this is still true", and it's what lets agents
cite the page. Only a member of the page's `owner_team` can verify it. The `verify` tool
enforces that, so check membership before doing a long walkthrough.

## 1. Pick the page

If the user named a page, `read` it. If they named a team, call `stale` with
`owner_team` and offer the overdue pages oldest first, then the pages that are due soon.
Show the page's `owner_team`, `last_verified`, `due` and `flags` before starting.

## 2. Walk through it with the owner

Go section by section: *When to use*, *Steps*, *Checks*, *Rollback*. For each one, ask
the owner a concrete question rather than "is this right?". For example:

- "Is `shipyard deploy` still the command?"
- "Is the canary still 5% → 25% → 100%?"
- "Does this alert still exist under this name?"

Where a step names something you can check without changing anything, offer to check it
and run it only after the owner agrees. Examples are a CLI's `--help`, a file in the
repo, or a dashboard URL. Never run a mutating command as part of verification.

Record every answer. Anything wrong or out of date becomes an edit in step 3.

## 3. Fix first, then verify

- **If anything needs changing:** call `propose_edit` with the exact edits and a
  `reason` that says it came from verification. Verify only once those changes are
  agreed. Verifying a page you know is wrong defeats the gate.
- **If everything is still true:** call `verify` with the page id. It opens a PR that
  sets `last_verified` to today. If it's refused because the user isn't on the owning
  team, say which team can verify it and stop.

## 4. Report

Give the PR URL or URLs, the new review due date, and anything the owner was unsure
about. Log the unsure items as `TODO(owner):` lines in a proposed edit rather than
dropping them.
