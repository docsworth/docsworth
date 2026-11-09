---
title: Secrets handling policy
id: pol-secrets
type: policy
status: canonical
owner_team: security
last_verified: 2026-10-01
review_every: 1y
acl: security
description: Where secrets live, who can read them, and how they rotate.
---
# Secrets handling policy

- All secrets live in Vault under `secret/prod/<service>`; nothing in env files or CI variables.
- Database credentials rotate every 30 days via [Rotate database credentials](rotate-db-credentials.md).
- Break-glass root tokens are held by two security leads and audited monthly.
