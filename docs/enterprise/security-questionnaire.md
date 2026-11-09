# Security questionnaire: pre-filled answers

Answers to the questions a vendor security review usually asks. Each one says which
mode it holds in:

- **[both]:** local mode (each user runs `docsworth mcp`) and central mode (one server for
  everyone, planned)
- **[local]:** local mode only
- **[central]:** central mode only, which isn't shipped yet

The modes, the checklist and the responsibility matrix are in [README.md](README.md).
Where an answer depends on GitHub or the IdP being configured a certain way, it says so.

## Product and hosting

**Is this a hosted service? Where is our data processed?** [both]
No. Docsworth is software the customer runs, on their machines or servers. It runs no
hosted service, has no accounts, sends no telemetry and checks no licence. Pages stay in
the customer's GitHub repository; everything else Docsworth writes stays on the machine
that runs it ([data-inventory.md](data-inventory.md)).

**What are your sub-processors?** [both]
Docsworth has none, because it processes nothing on our side. The systems the customer
connects it to (GitHub, and optionally Confluence, Notion, a SIEM, Slack, Anthropic)
are the customer's own vendors.

**Can it run in our network, or air-gapped?** [both]
It runs wherever the user or server can reach GitHub. GitHub Enterprise Server is
supported through `github.api_url`; that path is covered by tests but hasn't yet been
run against a live GHES instance. With no `github.repo` configured it runs fully
offline in local-only mode, serving only `internal` pages and refusing writes.

**Which data residency options do you offer?** [both]
Docsworth runs no service, so it adds no location of its own. Where data lives is set by
the customer's deployment and the vendors they connect: their GitHub (or GHES), their
wiki, their SIEM, Slack, and the model provider behind their agent client.

## Identity and access

**Do you support SSO (SAML/OIDC)?** [both]
Through GitHub. Docsworth identifies every caller by their own GitHub token, so the org's
SSO enforcement applies to it. A token that isn't SSO-authorized for the org is refused,
with GitHub's authorization link. The prerequisite is SAML SSO (or EMU) configured on the
GitHub org.

**Is MFA enforced?** [both]
By the GitHub org or the IdP, not by Docsworth.

**How are leavers removed?** [both]
- **Removed from the org** (SCIM or EMU): the token loses repository access. Writes
  stop at once, because they re-check identity live. Reads stop within
  `policy.identity_cache_seconds` (default 300, settable from 30 to 3600).
- **Removed from a team:** needs IdP group to team sync in GitHub. That team's pages
  are hidden within the same window.

**What roles are there, and who can do what?** [both, enforced against the user in central]
Reader, contributor, owner and admin, derived from GitHub and `policy:` in
`.knowledge/config.yaml`; none are stored by Docsworth. Admins can restrict any tool to
named teams, switch writes off, deny stale results, and require a human approval prompt
on every write. In local mode the policy lives in the user's clone, so it steers agents
but a user can edit it; GitHub still enforces every write.

**Can an agent do more than its user?** [both]
No. The agent calls the server with the user's own token and is limited to what that
token can do. GitHub App installation tokens, which act for no person, are refused.

**Is access to individual documents controlled?** [both]
Each page has an `acl`: `internal` (anyone with repo access) or a team. The server
serves a page only to its audience, on every tool, and a hidden page answers exactly
like a missing one. **This isn't confidentiality:** anyone who can read the repository
can clone the files. Keep confidential material in a separate repository whose GitHub
access matches its audience ([security-model.md](../security-model.md)).

## Audit and monitoring

**Is there an audit log? What does it record?** [both]
Yes, off by default (`audit_log.enabled`). One JSON event per MCP tool call, named for
the GitHub login, with the tool, its closed-set arguments, the outcome, the page ids in
the final ACL-filtered response, any PR link, and the knowledge snapshot served. Write
tools record their intent before they act. Server start and stop, mirror runs, purges
and promotes are recorded too. Full scope: [security-model.md](../security-model.md),
"Audit log".

**What does it never record?** [both]
Tokens, page content, edit text, a hidden page's id or title (except an id the caller
typed, logged as `not_found`), and search text unless `include_queries: true`. Every
string also passes a token-shape redaction before it's written.

**Can it be sent to our SIEM?** [both, Pro]
Yes. `audit_http` sends each event as it happens, HTTPS only, redirects refused, with
bounded retries and queue. Set `required: true` and a call is refused rather than
answered unrecorded.

**Can the log be tampered with?** [local: yes, by the machine's owner; central: by the server's operator]
A file on a user's machine can be edited by that user; per-session sequence numbers
show a deleted line as a gap, but don't prevent it. The SIEM copy is the record of
reference.

**How long are logs kept?** [both]
`audit_log.retention_days`, default 365, pruned at server start. The SIEM's copy
follows the SIEM's policy.

## Data handling

**What data does Docsworth store?** [both]
Every store is listed in [data-inventory.md](data-inventory.md) with its owner,
retention and how to delete it: the pages (in git), PR branches, the audit and usage
logs, the mirror cache and its ownership records, reports and benchmark results.

**Can data be deleted on request?** [both]
Yes. Each store has a deletion path. Erasing a page from git history needs a history
rewrite, and can't reach existing clones or forks; the procedure and its limits are in
[data-inventory.md](data-inventory.md).

**Is data encrypted?** [both]
In transit, yes: Docsworth refuses to send a credential over plain HTTP. A GHES
`api_url`, a Confluence URL, the SIEM collector and Slack webhooks must be `https://`
(plain HTTP is allowed only on loopback, for local testing), and GitHub, Notion and
Anthropic are fixed HTTPS endpoints. At rest, Docsworth encrypts nothing
itself: GitHub encrypts the repository, and machines that hold a clone, the mirror cache
or audit files need disk encryption, which is the customer's.

**Do you mirror content from other systems?** [both, Pro]
Only if configured. `docsworth mirror` reads Confluence or Notion, read-only, with the account
the customer configures. Pages with read restrictions in Confluence, and their
descendants, are never written. Nothing is written back to the source. Mirrored pages
are never citable, and are served to agents only with `mirror.serve: true`, to the same
audience rules as pages.

## AI and model use

**Does Docsworth send our data to an AI model?** [both]
Docsworth makes no model calls, except the opt-in benchmark (`docsworth bench`), which calls
the Anthropic API with the customer's own key. The agent client the customer uses (for
example Claude Code) sends tool output, which includes the page text the user may see,
to the model provider that client is configured with. That choice and its terms are the
customer's.

**How do you handle prompt injection?** [both]
Page text is returned only in `content` and `snippet` fields, and the tool descriptions
and server instructions tell the agent it's data. Docsworth's own write path is limited to opening a pull request, which a human on the
owning team must approve, after a taint check that blocks copying team-only content into
a broader page. The agent around it may have other tools (a shell, a browser, other MCP
servers), and a server can't stop a model from following text it reads. So pages should
be reviewed like code before they merge, and the agent's other tools governed by the
client's own permissions.

**Can an agent change our documentation?** [both]
Only by opening a pull request from a `docsworth/` branch. Docsworth never writes to a default
branch. Merging is a person's decision, routed by CODEOWNERS to the owning team once
branch protection requires code-owner review. A `polish` PR is additionally checked by
the server to keep every command, number, link and negation. That check is structural,
so the owners still read the diff.

## Secure development

**How is the software built and tested?** [both]
Every PR and push to `main` runs CI: a clean install, type checks and the full test
suite (over 400 tests, including an ACL matrix that fails if any response carries a
hidden page's id, title, path or description), a production dependency audit, a build
and a pack check. Actions are pinned by commit SHA, in this repo's CI and in the workflow `docsworth init --ci` writes for customers. Changes are reviewed by a second
model before merge.

**Do you publish an SBOM? Are releases signed?** [both]
CI produces a CycloneDX SBOM for every run. Signed releases with npm provenance are
planned for the first published release.

**What third-party dependencies are there?** [both]
Six in production: `@modelcontextprotocol/sdk`, `zod`, `yaml`, `commander`, `turndown`,
and `@anthropic-ai/sdk` (benchmark only).

**How do we report a vulnerability? How fast do you respond?** [both]
Through GitHub private vulnerability reporting, as in [SECURITY.md](../../SECURITY.md):
acknowledgement within 3 business days, and a fix or mitigation for high and critical
issues within 30 days of confirmation.

**Do you have SOC 2 or ISO 27001?** [both]
No. They certify a vendor's hosted operations, and Docsworth has none.

## Not offered

BYOK, region choice, HIPAA, FedRAMP, legal hold, DLP, IP allowlists (for central mode,
that's the customer's ingress), multiple IdPs, a web editor, and write-back to
Confluence, Notion or Google.
