---
title: Refund failures
id: rb-payments-refund-failures
type: runbook
status: canonical
owner_team: payments
last_verified: 2026-10-12
review_every: 30d
applies_to: [service:payments]
description: Triage refunds stuck in `failed` or `pending` at the PSP.
---
# Refund failures

## When to use
- The `RefundFailureRate` alert fires (more than 2% of refunds failing over 15 minutes).
- A merchant reports refunds stuck in `pending` for over 24 hours.

## Steps
1. Check the PSP status pages (Stripe, Adyen) for an ongoing incident.
2. List failures: `payctl refunds list --status failed --since 1h`.
3. For PSP timeouts, retry with the same idempotency key: `payctl refunds retry <refund-id>`.
4. For `insufficient_balance`, do not retry; open a ticket for the merchant success team.

## Checks
- The failure rate drops below 2% on the payments dashboard.
- Retried refunds move to `succeeded` within 10 minutes.

## Rollback
- Retries are idempotent; nothing to undo. If a retry double-refunded, reverse it with
  `payctl refunds reverse <refund-id>` and post a correcting ledger entry.
