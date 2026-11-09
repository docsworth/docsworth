---
title: Page escalation
id: rb-sre-escalation
type: runbook
status: canonical
owner_team: sre
last_verified: 2026-09-10
review_every: 90d
description: Who to page when the primary on-call does not acknowledge.
---
# Page escalation

## When to use
- A page is unacknowledged after 5 minutes, or the on-call needs another team.

## Steps
1. PagerDuty auto-escalates to the secondary after 5 minutes and to the team lead after 15.
2. To pull in another team, use `/page <team>` in the incident channel.
3. For SEV1 outside business hours, also page the `eng-leadership` schedule.

## Checks
- Every page has an acknowledging responder within 15 minutes.

## Rollback
- Release extra responders with `/page release <team>` once they are no longer needed.
