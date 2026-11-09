---
title: Deploy to production
id: rb-deploy-prod
type: runbook
status: canonical
owner_team: platform
last_verified: 2026-10-15
review_every: 90d
supersedes: [rb-deploy-legacy]
applies_to: [service:payments, service:ledger]
description: Ship a service to production with Shipyard and an Argo canary.
---
# Deploy to production

Production deploys go through Shipyard, which drives an Argo Rollouts canary
([ADR-0002](../decisions/ADR-0002-argo-rollouts.md)). Never `kubectl apply` by hand.

## When to use
- Shipping a merged change on `main` to production.
- Not for emergency fixes outside business hours: use [Cut a hotfix](hotfix-branch.md).

## Steps
1. Confirm the commit is green on CI and has passed staging for at least 30 minutes.
2. Run `shipyard deploy <service> --env prod --sha <commit>`.
3. Watch the canary: Shipyard sends 5% of traffic for 10 minutes, then 25%, then 100%.
4. Post the Shipyard run link in `#deploys`.

## Checks
- Error rate on the service dashboard stays under 0.5% during each canary step.
- p99 latency stays within 10% of the previous version.
- `shipyard status <service>` reports `Healthy` with all pods on the new SHA.

## Rollback
- Run `shipyard abort <service>`; Argo shifts traffic back to the stable version.
- If the rollout already reached 100%, follow [Roll back a deploy](rollback-deploy.md).
