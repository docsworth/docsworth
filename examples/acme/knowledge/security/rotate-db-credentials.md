---
title: Rotate database credentials
id: rb-rotate-db-creds
type: runbook
status: canonical
owner_team: security
last_verified: 2026-10-18
review_every: 90d
acl: security
description: Rotate a service's Postgres credentials through Vault.
---
# Rotate database credentials

## When to use
- Scheduled 30-day rotation, or immediately if a credential may have leaked.

## Steps
1. Trigger rotation: `vault write -force database/rotate-role/<service>-prod`.
2. Restart the service so it picks up the new lease: `shipyard restart <service> --env prod`.

## Checks
- `vault read database/creds/<service>-prod` shows a lease created in the last 5 minutes.
- The service's Postgres connection errors stay at zero.

## Rollback
- Vault keeps the previous credential valid for 1 hour; restart again if connections fail,
  and page security if errors persist.
