---
title: Onboarding a backend engineer
id: onb-backend
type: guide
status: canonical
owner_team: devex
last_verified: 2026-10-01
review_every: 90d
description: First-week checklist for backend engineers.
---
# Onboarding a backend engineer

## Week one
1. Get access: request the `eng-backend` group in the access portal; it grants GitHub,
   PagerDuty (read-only) and the staging cluster.
2. Install the toolchain with `make bootstrap` in the `dev-env` repo (Go 1.25, Shipyard, `payctl`).
3. Ship a change to staging on day two, and to production with a buddy on day four
   using [Deploy to production](../runbooks/deploy-production.md).

## Read first
- [Payments API](../services/payments/index.md)
- [ADR-0001](../decisions/ADR-0001-postgres-primary-store.md) and [ADR-0003](../decisions/ADR-0003-idempotency-keys.md)
