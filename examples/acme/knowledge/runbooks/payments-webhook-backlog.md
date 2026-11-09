---
title: Webhook backlog
id: rb-payments-webhook-backlog
type: runbook
status: canonical
owner_team: payments
last_verified: 2026-10-25
review_every: 90d
applies_to: [service:payments]
description: Drain a backlog of merchant webhooks after an outage.
---
# Webhook backlog

## When to use
- The `webhook-dispatch` queue depth exceeds 50,000 messages.
- Merchants report missing webhook events.

## Steps
1. Check consumer health: `kubectl -n payments get pods -l app=webhook-dispatcher`.
2. Scale dispatchers up: `kubectl -n payments scale deploy/webhook-dispatcher --replicas=24`.
3. Pause redelivery to merchants returning 5xx: `payctl webhooks pause --failing`.

## Checks
- Queue depth trends down on the webhooks dashboard.
- Delivery success rate is above 98%.

## Rollback
- Scale back to 6 replicas once depth is under 1,000.
- Resume paused merchants with `payctl webhooks resume --all`.
