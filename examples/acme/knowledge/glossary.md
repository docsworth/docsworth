---
title: Glossary
id: glossary
type: guide
status: canonical
owner_team: devex
last_verified: 2026-09-01
review_every: 180d
description: Acronyms and codenames used across Acme engineering.
---
# Glossary

- **Argo**: Argo Rollouts, our progressive-delivery controller (see [ADR-0002](decisions/ADR-0002-argo-rollouts.md)).
- **Canary**: a deploy step that sends 5% of traffic to the new version first.
- **IC**: incident commander, the single decision-maker during an incident.
- **Idempotency key**: client-supplied `Idempotency-Key` header that makes a write safe to retry.
- **Ledger**: the double-entry accounting service; codename *Abacus*.
- **PSP**: payment service provider; we route cards through Stripe and Adyen.
- **SEV1 / SEV2 / SEV3**: incident severities; SEV1 means customer money is at risk.
- **Shipyard**: the internal deploy CLI that wraps Argo.
