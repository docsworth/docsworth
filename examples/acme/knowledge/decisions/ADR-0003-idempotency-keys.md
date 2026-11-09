---
title: "ADR-0003: Idempotency keys on every write API"
id: adr-0003
type: adr
status: canonical
owner_team: platform
last_verified: 2026-05-20
review_every: 1y
applies_to: [service:payments, service:ledger]
description: Every money-moving write API requires an Idempotency-Key header.
---
# ADR-0003: Idempotency keys on every write API

**Status:** accepted · **Date:** 2025-09-18

## Decision
Every write endpoint that moves money requires an `Idempotency-Key` header. Keys are
stored for 24 hours; a repeated key returns the original response instead of writing again.

## Consequences
- Clients can retry safely after timeouts, which the [refund failures](../runbooks/payments-refund-failure.md) runbook relies on.
