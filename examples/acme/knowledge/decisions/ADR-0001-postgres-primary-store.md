---
title: "ADR-0001: Postgres as the primary store"
id: adr-0001
type: adr
status: canonical
owner_team: platform
last_verified: 2026-04-10
review_every: 1y
description: Why every service stores system-of-record data in Postgres.
---
# ADR-0001: Postgres as the primary store

**Status:** accepted · **Date:** 2024-02-12

## Context
Teams were choosing between DynamoDB, MongoDB and Postgres per service, and the
operational cost of three engines was showing up in on-call load.

## Decision
System-of-record data lives in Postgres, run by CloudNativePG. Other stores are allowed
only as caches or derived indexes.

## Consequences
- One backup and restore path ([Restore a Postgres backup](../runbooks/restore-postgres-backup.md)).
- Schema migrations go through `atlas` and must be backward compatible for one release.
