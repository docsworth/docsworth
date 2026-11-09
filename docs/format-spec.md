# Docsworth format spec

**Format version:** 1 · **License:** Apache-2.0

This is the public contract between a knowledge repo and the tools that read it:
`docsworth lint`, the MCP server, the skills compiler and the mirror. A repo that follows it
can be linted, served to agents and compiled into skills by any implementation.

## Repo layout

```
knowledge/
  index.md                     # root map; agents read this first (required)
  glossary.md                  # acronyms and codenames (recommended)
  services/<name>/index.md     # type: service
  runbooks/<slug>.md           # type: runbook
  decisions/ADR-0001-<slug>.md # type: adr
  onboarding/<role>.md         # type: guide
  <anything>/…                 # any type; only the three directories above constrain it
.knowledge/config.yaml         # org, repo, SLA window, mirror sources
CODEOWNERS                     # or .github/CODEOWNERS or docs/CODEOWNERS
```

Every `.md` file under the knowledge root is a page, and every page has frontmatter.

## Frontmatter

At most 16 KB of YAML between the `---` lines; a page over that is reported by lint and
not served (frontmatter runs to a few hundred bytes, and YAML parsing slows past linear
on hostile input).

```yaml
---
title: Deploying to production
id: rb-deploy-prod            # required, stable, unique; lowercase letters, digits, dashes
type: runbook                 # required: runbook | adr | service | guide | policy
status: canonical             # required: canonical | draft | deprecated
owner_team: platform          # required: team slug; CODEOWNERS must assign @<org>/platform
last_verified: 2026-10-15     # required: YYYY-MM-DD, a real calendar date
review_every: 90d             # required: <n>d | <n>w | <n>m | <n>y
supersedes: [rb-deploy-legacy] # optional: ids this page replaces
applies_to: [service:payments] # optional: free-form tags, matched exactly by search filters
acl: internal                 # optional, default internal; or a team slug
description: One sentence.    # optional; used in search and compiled skills
---
```

Unknown fields produce a lint warning, never an error.

## Ownership

- CODEOWNERS uses GitHub's semantics: the last matching rule wins. It supports anchored,
  `*`, `**` and trailing-slash patterns, and `docs/*` matches direct children only.
- The winning rule for a page's path must name **exactly one owner**, and that owner
  must be a **team of the configured org** (`@<org>/<team>`). Individual owners (`@alice`,
  emails), several owners, foreign-org teams and owner-less rules are all lint errors.
  Individual ownership is banned deliberately: people change teams, and teams don't.
- `owner_team` must equal that team's slug.

## Review SLA

Dates are date-only and compared as UTC calendar dates. The due date is
`last_verified + review_every`:

- `d` and `w` add fixed days.
- `m` and `y` add calendar months or years, clamped to the end of the month
  (2026-01-31 + 1m = 2026-02-28).

States are evaluated in this order:

| State | Condition |
| --- | --- |
| `unverified` | `last_verified` or `review_every` missing or invalid (this is also a lint error) |
| `overdue` | today is after the due date (a lint warning on canonical pages) |
| `due_soon` | at most `sla.due_soon_days` (default 14) days until due |
| `fresh` | otherwise |

The due date itself is still within SLA.

## Citation gate

A page is **citable** when all three hold:

1. `status: canonical`.
2. Its SLA state is `fresh` or `due_soon`.
3. Its ownership resolves as above.

The gate is fixed by this spec; configuration cannot widen it.

- **`search`:** returns only citable pages. Matching pages that aren't citable are
  listed separately as `excluded`, each with a reason such as "past review date (due
  2026-10-30), owned by platform". Agents can then say what was excluded instead of
  silently missing it.
- **`read`:** returns any visible page, with `citable`, `flags` and `gate_reason`.

## ACL

`acl` narrows which callers the **MCP server serves** a page to:

- **`internal`:** anyone the server serves at all.
- **A team slug:** only members of `@<org>/<slug>`.

In a page the caller can see, a reference to a page they can't see (a link in any form,
a URL, or its path in text) reads `[restricted page]`. A page that doesn't load counts as
one they can't see, and so does a link to a path under the knowledge root that is no page
at all: relative, or, with `github.repo` set, a GitHub URL into the repo on any branch.
See [security-model.md](security-model.md#the-one-read-path).

**`acl` isn't confidentiality.** GitHub has no per-file read permissions, so anyone with
read access to the knowledge repo can read every file in it. Keep confidential content
in a separate repository whose GitHub permissions match its audience. See
[security-model.md](security-model.md).

## Runbook sections

For the skills compiler, a runbook has these `##` sections. The heading match is
case-insensitive:

| Section | Holds |
| --- | --- |
| `## When to use` | Triggers: alerts, symptoms, requests. This becomes the skill's description. |
| `## Steps` | Numbered actions with exact commands. |
| `## Checks` | How to tell it worked. |
| `## Rollback` | How to undo it, or why it can't be undone. |

A canonical runbook missing any of these still lints. It's reported and skipped by
`docsworth compile`.

## Compiled skills

`docsworth compile` writes `skills/<id>/SKILL.md` in the Agent Skills format: `name` and
`description` frontmatter, plus string-valued `metadata`:

```yaml
metadata:
  source_id: rb-deploy-prod
  source_path: knowledge/runbooks/deploy-production.md
  source_sha256: <sha256 of the source file>
  owner_team: platform
  last_verified: 2026-10-15
  review_every: 90d
  review_due: 2027-01-13
  compiled_at: 2026-11-02
  stale: "false"
```

A skill is **stale** when its source page changed (`source_sha256`), was re-verified
(`last_verified`), stopped being canonical, or was deleted. `docsworth compile --check` exits 1
on stale skills. `--mark-stale` sets `stale: "true"` and prefixes the description with
`[STALE: …]`. Runbooks with a non-`internal` ACL are compiled only with
`--include-restricted`.

Compiling removes only skills whose `generator` is `docsworth`. A skill whose generator
is `agent-kb`, the pre-release name, is rewritten if its page still compiles. If it
remains, `--check` reports it, but it's never removed or marked, because that name now
belongs to another publisher: delete it by hand.

## Polish

`propose_edit` with `polish: true` proposes a restructure or rewording that must not
change what the page says. The agent sends the new `body` (what `read` returns as
`content`, rewritten), and the server keeps the frontmatter. Before any branch is
created, the server compares the current page with the proposed one and refuses
(`invalid`, naming the changes it saw, up to eight) unless all of these are unchanged.
Pages over 64 KB, before or after, aren't polished.

| Compared | How |
| --- | --- |
| Frontmatter | byte for byte |
| Code order | all code, fenced and inline, in reading order; and the code under each heading both versions have (ATX or setext, in a quote or a list item or neither, subsections included) stays under it. Headings match as written, apart from spacing and closing `#`s, and a repeated heading matches by its occurrence while both versions repeat it as often. Sections without code may move, and headings may be added or reworded |
| Code blocks, fenced (backticks or tildes) and indented (four spaces or a tab), in quotes and list items too | content, as CommonMark reads the page's block structure: a line is code only where CommonMark makes it code, and leaves code where CommonMark ends the block (a quote or list item that ends, an outdented line). Each line loses its containers' markers and up to the fence's own indentation, so moving a block into a list item or a quote is a polish but shifting its code isn't. Trailing spaces count (`\ ` ends a shell line differently from `\`), and so does a fence's info string (```` ```text ```` stays inert where ```` ```mermaid ```` draws a diagram), added, dropped or changed. The fence's characters and line endings are ignored, and a fenced block without an info string equals an indented one with the same lines |
| Reference definitions | read for the links that use them, and otherwise treated as invisible, as they render: nothing inside one counts as page text. A line is a definition only if CommonMark takes it as one: its destination in `<…>`, or bare with no space or control character and its parentheses balanced. Anything else renders, and is compared, as text. Code spans in a label, destination or title count as written, and labels match as CommonMark matches them (`[STRASSE]` uses `[straße]: …`). A page isn't polished at all if a definition-like line is indented by a tab or four spaces, has a label or title spanning lines, or follows an indented or `===` line: whether it renders depends on block structure this check doesn't model. Use `edits` there |
| HTML comments (outside code) | as a multiset, and kept out of every other row: a fact moved into a comment has left the page a reader sees. A comment inside a code block is code. A comment block (a line starting `<!--`, to its `-->`) holds text, as CommonMark reads it: code or a definition inside it isn't one. A comment opened mid-paragraph that wraps a code block makes the page unpolishable |
| Raw HTML (tags, processing instructions, declarations, CDATA, and any opener such as `<!--`, `<?` or `<div`, closed or not) | none may be added: an unclosed opener hides everything after it. A page that already has raw HTML (outside code), or a control character U+0000 to U+0004 (the check's own marks), isn't polished at all: where a tag sits decides what it hides (`<span hidden>…</span>`), which only a renderer could compare. Use `edits` there |
| Unusual characters | a polish may not add an invisible character (zero-width, soft hyphen, an ASCII control), even one the page already has or a letter from a script the page doesn't use (a Cyrillic `о` in an English word). Numeric entities and `&amp; &lt; &gt; &quot; &apos; &nbsp; &minus; &plus;` are decoded first, for this and for numbers and negation words. Other named entities are compared as written, each with what follows it: a polish adds, removes or moves none |
| Inline code, link targets | as multisets: order may change, nothing added or dropped. Each link is also compared with the text that shows it, as written apart from spacing, and its title, so links may move but not trade destinations or change what they say on hover. Link targets are inline and reference links (resolved through their definitions), autolinks (`<https://…>`, `<ops@example.com>`), bare URLs, emails and `www.` links, and HTML `href`/`src`, quoted or not. Punctuation after a bare URL isn't part of it, as GFM links it (`?!.,:*_~;` and an unbalanced `)`). A `](` that doesn't parse as a link is compared as written, to the end of its line |
| Struck-through text (`~~…~~`, `<del>`, `<s>`) | as a multiset, so striking an instruction out is a change |
| Task-list items (`- [ ]`, `1. [x]`) | each box with its task's text, as a multiset: tasks may move with their boxes, but ticking one, or moving a tick to another task, says a different step is done. A task's text stays as written |
| Words with digits (`TLSv1.2`, `IPv4`, `RHEL8`, `p99`) | as a multiset |
| Numbers (digits of any script) | each with its sign and the word after it (`-5 minutes`, `.5 seconds`, `3 retries`, `5-minute`) as a multiset, so swapping two numbers with different units is caught. Every run of digits in the visible text is compared too, whatever it's attached to (`on-c3`). A plural is the same unit. Case counts (`5 MB` isn't `5 Mb`, `500MB` isn't `500Mb`), except that a unit word of three letters or more may be capitalised (`5 Minutes`). Ordered-list markers aren't numbers where they surely start a list item (a `1`, after a blank line or a heading, or after list items at the same indentation), so renumbering a list is a polish; `retry\n3. times` is paragraph text in CommonMark, and its `3` is compared. The word may sit on the next line of the same paragraph; bold and italics are ignored |
| Negation and modal words | the count of each, in any case: not, never, no, must, should, cannot, can't, don't, doesn't, won't, shouldn't, mustn't, isn't, aren't, only, without, unless, except, nor, none, neither, always, and every other "n't" (didn't, wasn't, …) counted together, counted twice: with emphasis markers taken out and with them read as breaks, since an unclosed `**` is text in CommonMark (`no**t` isn't `not`) |

Because the frontmatter and every link target are unchanged, a polished page stays as
valid as it was.

On a page that links to pages the caller can't see (shown as `[restricted page]` in
`read`), `propose_edit` takes only `edits`, and no polish. A whole `body` or `content`
written from the redacted view would overwrite or drop those links, and a polish
refusal would name them. An edit that writes `[restricted page]` is refused too. An
`append` is taken there: it adds to the end of the page as it is on the default branch,
so nothing written from the redacted view goes back into it.

## New pages (`draft_page`)

`draft_page` opens a draft PR that adds one page, on a `docsworth/draft/<id>-…` branch.

- **The server names it.** Its id is `<prefix>-<slug>-<12 hex>` and its file
  `<slug>-<12 hex>.md`, where the slug comes from the title and the hex is random. A name
  the caller chose could be aimed at a page they can't see, and "already exists" would
  then say it is there. Owners can rename it in the PR before merging.
- **Where it lands.** The type's directory (`runbooks/`, `services/<name>/index.md`,
  `guides/`, `policies/`) or a `dir` under the knowledge root. CODEOWNERS must assign
  `owner_team` there, so the page lints. Where the plain name is another team's, the
  server tries `<owner_team>-<slug>-<12 hex>` (id `<prefix>-<owner_team>-<slug>-<12 hex>`)
  in the same directory, so rules on file names (`runbooks/payments-*`) route the page to
  its team; if that isn't the team's either, `draft_page` refuses and names the directory.
  ADRs are written by hand.
- **What it holds.** `status: draft` (never citable until its owners make it canonical),
  `last_verified` today, `review_every: 90d`, the caller's one-line title and optional
  description, and `acl` `internal` or a team the caller is on. A `source_url` becomes a
  first line, `> Captured from <url> on <date>.`

**How it's checked.** Besides its own tests, the guard is fuzzed against CommonMark's
reference parser (commonmark.js): pages are mutated at random, and no pair may change a
code block, inline code, a link (its text, target or title, and GitHub's bare-URL
autolinks), a digit or a negation word as commonmark.js renders it while the guard
reports nothing (`test/polish-fuzz.test.ts`, and `scripts/fuzz-polish.ts` for long
runs). Where CommonMark implementations disagree (a tab inside a link's or a
definition's parentheses), the page is refused rather than read one way.

**Not detected.** This is a structural check, not proof that the meaning is unchanged.
It doesn't see a renamed service or team in prose, a command written as plain prose,
a changed word that isn't a number's unit, a
number spelled out (`five`), two numbers with the same unit trading places (`wait 5
minutes`, `retry after 10 minutes`), steps without code put in another order, code
moved across headings that were reworded in the same polish, a negation moved to
another clause, or a reworded sentence that now means something else. That's why the PR goes to the owner team like any other, titled
`polish(<id>): <title>`, with a body that lists what the guard compared and asks for
the diff to be read.

## Mirror namespace

Mirrored pages live under `mirror.out_dir` (default `.knowledge/mirror/`), never under
the knowledge root, and are never citable. Each file carries a `mirror:` frontmatter block
(source, native id, url, `last_edited`, versions, `owner_team` from a `team-<slug>` or
`owner-<slug>` label, labels, acl). Each source and space directory also holds
`_scores.json` and `_report.json`. Pages with read restrictions in the source, and their
descendants, are never written, and the report lists them by native id only.

**Serving the mirror** (`mirror.serve: true`, off by default, and not yet recommended:
on the benchmark it was neutral on answer questions but just missed its bar on gate
questions). The MCP server then lists
matching mirrored pages in search under `mirrored`, at most 3, apart from `results`, each
with `citable: false`, its source URL and last edit. `read` takes a `mirror:` id and
returns the page with `citable: false` and `flags: ["mirrored"]`. Filters on page type
or `applies_to` leave mirrored pages out; `owner_team` applies to them.

- **Audience:** each space's `acl`, by the same rule as pages. A hidden and an unknown
  mirror id answer alike, and a team space's page taints the session like a team page.
- **Links:** in a mirrored page someone can see, links to a repo page they can't see
  read `[restricted page]` as they do in repo pages (by URL, say). In a page someone can
  see, mirrored or from the repo, links to a mirrored
  page they can't see read `[restricted page]` (and don't count toward ranking): markdown links (any title form, nested or escaped brackets),
  bare URLs, and Confluence's linked-title form. A link is matched by the page it
  names, so a relative path, a URL without its title slug, `?pageId=`, a Confluence
  tiny link (`/wiki/x/…`), or a Notion id in any form is caught too, also encoded,
  broken across lines or with markup inside, as for repo pages.
- **Ranking:** each audience gets its own index, so ranking, snippets and counts never
  draw on a page outside that audience.
- **What is served:** only files one of this user's mirror runs wrote and that are
  unchanged since, read through the records in the state directory. A new run is picked
  up without a restart. An `out_dir` that resolves outside the repo serves nothing, with
  a warning.

## Config (`.knowledge/config.yaml`)

```yaml
format: 1
knowledge_root: knowledge
github:
  org: acme                 # required: team owners resolve to @acme/<team>
  repo: acme/knowledge      # optional: makes GitHub the ACL authority; enables PR tools
  default_branch: main      # optional: otherwise read from GitHub
  api_url: https://ghe.example.com/api/v3   # optional: GitHub Enterprise Server
sla:
  due_soon_days: 14
usage_log: true             # page-id-only read log for the owner digest
audit_log:                  # attributed audit log; off unless enabled
  enabled: true
  dir: /var/lib/docsworth/audit   # optional; default $XDG_STATE_HOME/docsworth/<repo>-<hash>/audit
  include_queries: false    # search text is not recorded unless true
  required: false           # true: nothing is answered or changed unless its event is written first (see security-model.md)
  retention_days: 365
policy:                     # org policy; every default keeps v0.1 behaviour
  admins: kb-admins         # lint: CODEOWNERS must make this team own the config and CODEOWNERS
  tools:                    # per-tool allowlists (search, read, list, stale, propose_edit, verify, draft_page); an empty list disables a tool for everyone
    propose_edit: { teams: [platform, payments] }
  writes: enabled           # disabled: propose_edit, verify and draft_page are not offered
  require_human_approval: false   # true: Claude Code asks on every write call
  include_stale: allowed    # denied: search never returns gated pages inline
  identity_cache_seconds: 300     # team-membership cache for reads (30-3600)
audit_http:                 # pro: ship each event to a collector (SIEM) as it happens
  url_env: DOCSWORTH_AUDIT_URL    # env var with the https:// URL (http only on loopback)
  token_env: DOCSWORTH_AUDIT_TOKEN
  required: false
skills:
  out_dir: skills
mirror:
  out_dir: .knowledge/mirror
  serve: false              # true: search lists matching mirrored pages under `mirrored` (never citable)
  sources:
    - kind: confluence
      base_url: https://acme.atlassian.net
      spaces: [{ key: ENG, acl: internal }]
    - kind: notion
      root_page_ids: []     # empty: everything shared with the integration
      acl: internal
digest:
  slack_webhook_env: SLACK_WEBHOOK_URL
  team_webhooks: { security: SLACK_WEBHOOK_SECURITY }
```
