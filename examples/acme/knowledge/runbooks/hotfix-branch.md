---
title: Cut a hotfix
id: rb-hotfix
type: runbook
status: canonical
owner_team: platform
last_verified: 2026-10-08
review_every: 90d
description: Ship an urgent fix outside the normal release flow.
---
# Cut a hotfix

## When to use
- A SEV1 or SEV2 needs a code fix and `main` contains unreleased changes.

## Steps
1. Branch from the deployed SHA: `git checkout -b hotfix/<ticket> <deployed-sha>`.
2. Open a PR against the hotfix branch; one approval from the owning team is enough.
3. Deploy with `shipyard deploy <service> --env prod --sha <hotfix-sha> --fast-canary`.

## Checks
- The incident's symptom clears on the service dashboard.
- The fix is cherry-picked back to `main` the same day.
