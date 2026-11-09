# Security policy

## Reporting a vulnerability

Report it privately through GitHub: on this repository's **Security** tab, choose
**Report a vulnerability**. Please don't open a public issue or PR for a security bug.

Include what you can:

- the version (`docsworth --version`) and how it runs: stdio from a laptop, or central
- what an attacker needs: a token, a page they can edit, a mirrored wiki page
- the steps, and what they reach that they shouldn't

**What to expect.** We acknowledge a report within 3 business days and say whether
we've reproduced it within 10. For a confirmed high or critical issue, we aim to ship a
fix or a mitigation within 30 days, and agree a disclosure date with you. We credit
reporters in the advisory unless you'd rather we didn't.

## Supported versions

Until 1.0, only the latest release gets security fixes.

## What counts

Docsworth makes two promises, and a way to break either is a vulnerability:

1. **No page leaks across its ACL.** An MCP tool never returns a page's content, id,
   title, path or description to a caller who can't see it, and a hidden id answers
   exactly like an unknown one. A mirrored page is held to the same rule.
2. **No write reaches a default branch.** `propose_edit` and `verify` only ever open
   pull requests from `docsworth/` branches.

Also in scope:

- a credential (GitHub, Confluence, Notion, SIEM, Slack, Anthropic) appearing in a log,
  error, report or audit event
- an audit event that records page content, a hidden page's id, or (unless
  `include_queries` is on) search text
- a polish (`propose_edit` with `polish: true`) that changes a code block (fenced or indented), inline code,
  a link target, a URL, a number with its unit, or a negation count without being
  refused
- `docsworth mirror-purge`, or a mirror run, deleting or overwriting a file it didn't write
- the server starting, or answering, when it should fail closed: no token, a token that
  can't see the repo, an installation token, a required audit log that can't write

**Not in scope** (documented limits, see [docs/security-model.md](docs/security-model.md)):

- `acl` isn't confidentiality. Anyone with read access to the knowledge repo can
  `git clone` an `acl: security` page.
- A visible page whose own text mentions a hidden page by title or id. That text is
  served as written; references that resolve to the page (links in any form, URLs,
  paths, as written or as they render) are redacted.
- A page's own author disguising a hidden page's path beyond what a renderer undoes on
  one line: a comment splitting it across lines, look-alike characters. That author can
  see the hidden page and is choosing to disclose it, as with naming it.
- On a laptop the org policy lives in the user's own clone, and they can edit it.
  GitHub still enforces every write.
- A model following instructions it read in a page. The server labels page text as
  data and bounds what it can do; it can't stop a model.
- The polish guard missing a change of meaning that keeps the structure (a renamed
  service, a reworded sentence). It's documented as structural only, and the owners
  review every polish PR.

## How releases are built

- **CI** for this repository runs `npm ci`, the full test suite,
  `npm audit --omit=dev --audit-level=high`, a build and `npm pack --dry-run` on every
  PR and push to `main`. Every action is pinned by commit SHA, here and in the workflow
  `docsworth init --ci` writes into customers' repos; a test checks both.
- **SBOM.** Each CI run produces a CycloneDX SBOM of the production dependencies.
- **Planned, not yet in place:** signed releases with npm provenance, published from
  CI, and the SBOM attached to each release. They wait on the package name and the
  separate packaging of the proprietary tier.

The CLI has four production dependencies (`@modelcontextprotocol/sdk`, `zod`, `yaml` and
`commander`) and holds no secrets of its own. Docsworth pro adds its own (`turndown` for
Confluence pages, and `@anthropic-ai/sdk` for the benchmark).
