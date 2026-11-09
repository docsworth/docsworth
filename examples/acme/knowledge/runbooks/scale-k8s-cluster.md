---
title: Scale the Kubernetes cluster
id: rb-scale-cluster
type: runbook
status: canonical
owner_team: platform
last_verified: 2026-08-01
review_every: 90d
description: Add node capacity to the production cluster ahead of load.
---
# Scale the Kubernetes cluster

## When to use
- Planned traffic events (Black Friday, a large merchant launch).
- Pending pods for more than 10 minutes because of insufficient capacity.

## Steps
1. Raise the node pool maximum: `terraform apply -var 'prod_pool_max=<n>'` in `infra/clusters/prod`.
2. Let the cluster autoscaler add nodes; do not add nodes by hand.

## Checks
- `kubectl get nodes` shows the new nodes `Ready`.
- No pods remain `Pending`.

## Rollback
- Lower `prod_pool_max` again after the event; the autoscaler drains idle nodes.
