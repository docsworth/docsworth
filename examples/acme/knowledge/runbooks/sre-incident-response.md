---
title: Incident response
id: rb-sre-incident-response
type: runbook
status: canonical
owner_team: sre
last_verified: 2026-10-01
review_every: 90d
description: Declare, run and close an incident.
---
# Incident response

## When to use
- Any customer-visible degradation, or any risk to customer money (always SEV1).

## Steps
1. Declare in Slack with `/incident declare`; this creates `#inc-<n>` and pages the IC rotation.
2. The IC assigns a scribe and a comms lead within 10 minutes.
3. Post status updates every 30 minutes for SEV1, every hour for SEV2.
4. Resolve with `/incident resolve` once the symptom is gone for 30 minutes.

## Checks
- The incident has a severity, an IC and a timeline in the incident tool.
- A postmortem is scheduled within 5 business days for SEV1 and SEV2.

## Rollback
- If declared by mistake, downgrade with `/incident severity SEV3` and close it; never delete it.
