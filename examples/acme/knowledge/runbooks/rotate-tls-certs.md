---
title: Rotate TLS certificates
id: rb-rotate-tls
type: runbook
status: canonical
owner_team: platform
last_verified: 2026-09-15
review_every: 60d
description: Rotate an ingress TLS certificate managed by cert-manager.
---
# Rotate TLS certificates

Certificates are issued by cert-manager from Let's Encrypt and renew automatically 30
days before expiry. Rotate by hand only when renewal is stuck or a key is compromised.

## When to use
- The `CertificateExpiringSoon` alert fires (under 14 days left).
- A private key may have leaked.

## Steps
1. Find the certificate: `kubectl get certificate -A | grep <hostname>`.
2. Force reissue: `cmctl renew <certificate> -n <namespace>`.
3. If the key leaked, delete the secret first so a new key is generated:
   `kubectl delete secret <certificate>-tls -n <namespace>`.

## Checks
- `kubectl describe certificate <certificate>` shows `Ready=True` and a new `Not After`.
- `openssl s_client -connect <hostname>:443` presents the new serial number.

## Rollback
- cert-manager keeps the previous secret revision; restore it with
  `kubectl apply -f` from the backup in the `tls-backups` bucket if the new cert breaks clients.
