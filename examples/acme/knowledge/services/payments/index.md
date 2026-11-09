---
title: Payments API
id: svc-payments
type: service
status: canonical
owner_team: payments
last_verified: 2026-10-01
review_every: 90d
applies_to: [service:payments]
description: What the Payments API does, its dependencies, SLOs and on-call.
---
# Payments API

The Payments API authorises cards, captures funds, issues refunds and emits webhooks to
merchants. It is a Go service running in the `payments` namespace.

## Dependencies
- Postgres cluster `pg-payments` (primary store, see [ADR-0001](../../decisions/ADR-0001-postgres-primary-store.md)).
- The [Ledger](../ledger/index.md) for every balance change.
- PSPs: Stripe (primary) and Adyen (fallback for EU cards).

## SLOs
- Authorisation p99 latency under 400 ms.
- 99.95% monthly availability for `POST /v1/charges`.

## On-call
The `payments-primary` PagerDuty schedule. Escalate per [page escalation](../../runbooks/sre-page-escalation.md).
