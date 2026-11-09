---
title: Ledger service
id: svc-ledger
type: service
status: canonical
owner_team: payments
last_verified: 2026-06-01
review_every: 90d
applies_to: [service:ledger]
acl: payments
description: The double-entry ledger (codename Abacus) behind every balance.
---
# Ledger service

The Ledger records every money movement as balanced double-entry journal lines. It is
the source of truth for merchant balances and payouts.

## Interfaces
- gRPC `ledger.v1.Journal/Post` for postings; every call needs an idempotency key.
- Nightly reconciliation job `ledger-recon` compares PSP settlement files to journals.

## Storage
Postgres cluster `pg-ledger`, replicated to a read replica used by reporting.
