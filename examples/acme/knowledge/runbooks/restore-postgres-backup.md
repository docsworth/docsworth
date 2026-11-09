---
title: Restore a Postgres backup
id: rb-restore-postgres
type: runbook
status: canonical
owner_team: platform
last_verified: 2026-10-05
review_every: 90d
applies_to: [service:payments, service:ledger]
description: Point-in-time restore of a production Postgres cluster.
---
# Restore a Postgres backup

Clusters run on CloudNativePG with continuous WAL archiving to the `pg-backups` bucket,
so any point in the last 14 days can be restored.

## When to use
- Data was deleted or corrupted and must be recovered.
- Never to "undo" a migration: write a forward migration instead.

## Steps
1. Pick the target time just before the bad write (UTC).
2. Create a recovery cluster: `kubectl cnpg restore <cluster> --target-time "<UTC time>" --name <cluster>-restore`.
3. Verify the data on the restore cluster, then copy the affected rows back with a reviewed SQL script.

## Checks
- The restore cluster reports `Cluster in healthy state`.
- Row counts for the affected tables match the expected values from before the incident.

## Rollback
- The production cluster is never overwritten; delete the `-restore` cluster when done.
