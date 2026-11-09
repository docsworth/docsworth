---
title: Flush the CDN cache
id: rb-flush-cdn
type: runbook
status: canonical
owner_team: platform
last_verified: 2026-10-22
review_every: 180d
description: Purge stale assets or API responses from the Fastly CDN.
---
# Flush the CDN cache

## When to use
- A deploy shipped new static assets but users still get the old ones.
- A cached API response is wrong and must be removed before its TTL expires.

## Steps
1. Purge one URL: `shipyard cdn purge --url <url>`.
2. Purge everything for a service by surrogate key: `shipyard cdn purge --key <service>`.
3. Never purge the whole account; it spikes origin load for every service.

## Checks
- `curl -sI <url> | grep -i x-cache` shows `MISS` on the first request after the purge.
- Origin request rate on the CDN dashboard returns to baseline within 10 minutes.

## Rollback
- Purges cannot be undone; if origin load spikes, enable `shield` mode with
  `shipyard cdn shield --service <service> --on` until it settles.
