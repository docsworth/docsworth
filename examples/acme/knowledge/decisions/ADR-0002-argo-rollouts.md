---
title: "ADR-0002: Argo Rollouts for deploys"
id: adr-0002
type: adr
status: canonical
owner_team: platform
last_verified: 2026-07-01
review_every: 1y
supersedes: []
description: Why production deploys use Argo Rollouts canaries instead of Jenkins.
---
# ADR-0002: Argo Rollouts for deploys

**Status:** accepted · **Date:** 2025-04-03

## Context
The Jenkins `deploy-prod` job deployed all-at-once with a manual approval gate. Two
SEV1s in 2024 came from bad deploys that reached 100% of traffic instantly.

## Decision
All production deploys use Argo Rollouts canaries (5% → 25% → 100%), driven by the
Shipyard CLI. The Jenkins job is retired.

## Consequences
- Deploy procedure: [Deploy to production](../runbooks/deploy-production.md).
- Automatic abort on error-rate regressions during the canary.
