---
title: Acme engineering knowledge
id: index
type: guide
status: canonical
owner_team: devex
last_verified: 2026-10-20
review_every: 90d
description: Root map of Acme's engineering knowledge. Agents read this first.
---
# Acme engineering knowledge

Start here. Every page below has one owning team and a review date; agents only cite
pages that are canonical and inside their review window.

## Services
- [Payments API](services/payments/index.md): card authorisation, refunds, webhooks.
- [Ledger](services/ledger/index.md): double-entry ledger behind every balance.

## Runbooks
- [Deploy to production](runbooks/deploy-production.md)
- [Roll back a deploy](runbooks/rollback-deploy.md)
- [Rotate TLS certificates](runbooks/rotate-tls-certs.md)
- [Scale the Kubernetes cluster](runbooks/scale-k8s-cluster.md)
- [Restore a Postgres backup](runbooks/restore-postgres-backup.md)
- [Cut a hotfix](runbooks/hotfix-branch.md)
- [Flush the CDN cache](runbooks/flush-cdn-cache.md)
- [Refund failures](runbooks/payments-refund-failure.md)
- [Webhook backlog](runbooks/payments-webhook-backlog.md)
- [Incident response](runbooks/sre-incident-response.md)
- [Page escalation](runbooks/sre-page-escalation.md)
- [Rotate database credentials](security/rotate-db-credentials.md)

## Decisions
- [ADR-0001: Postgres as the primary store](decisions/ADR-0001-postgres-primary-store.md)
- [ADR-0002: Argo Rollouts for deploys](decisions/ADR-0002-argo-rollouts.md)
- [ADR-0003: Idempotency keys on every write API](decisions/ADR-0003-idempotency-keys.md)

## Onboarding
- [Backend engineer](onboarding/backend-engineer.md)
- [Joining on-call](onboarding/on-call.md)

## Security
- [Secrets handling policy](security/index.md)

See also the [glossary](glossary.md).
