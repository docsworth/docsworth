---
title: Roll back a deploy
id: rb-rollback-deploy
type: runbook
status: canonical
owner_team: platform
last_verified: 2026-10-10
review_every: 90d
description: Return a service to its previous version after a bad production deploy.
---
# Roll back a deploy

## When to use
- A deploy reached 100% and error rate or latency regressed.
- An incident commander asks for a rollback during an incident.

## Steps
1. Find the previous good SHA with `shipyard history <service> --env prod`.
2. Run `shipyard rollback <service> --env prod --to <sha>`; this skips the canary.
3. Announce the rollback in `#deploys` and in the incident channel if one is open.

## Checks
- `shipyard status <service>` shows the previous SHA on every pod.
- Error rate returns to its pre-deploy baseline within 5 minutes.

## Rollback
- A rollback is itself reversible: redeploy the newer SHA with [Deploy to production](deploy-production.md) once fixed.
