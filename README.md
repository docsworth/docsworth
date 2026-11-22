# Docsworth

**Your runbooks, owned, verified and executable by every agent.**

Docsworth is a git-native knowledge layer for coding agents. Pages are markdown in your
own repo. Every page has exactly one owning team in CODEOWNERS and a review date. Agents
reach the pages through an MCP server that cites only pages a team has verified within
their review window. Everything else comes back from `search` and `read` without its text,
as *excluded: past review date, owned by platform*, unless an agent asks for it to update the
page. So the gap is visible rather than silently stale.

- **Customer-owned git.** Plain markdown in your GitHub repo; no lock-in, and it reviews
  like code.
- **Enforced ownership.** `docsworth lint` fails CI unless each page's CODEOWNERS rule names
  exactly one team, and that team matches the page.
- **Citation gate.** Only `canonical` pages inside their SLA are citable. The gate is
  fixed and not configurable.
- **PR-only writes.** Agents propose edits and owners verify pages through pull
  requests. Nothing writes to the default branch.
- **Polish without drift.** Agents can restructure and reword a page as a `polish`
  PR. The server refuses one that changes a code block, inline code, a link, a number
  or a negation word. The check reads pages as CommonMark does, and is fuzzed against
  CommonMark's reference parser: no miss in 1.5 million mutated pages.
- **Mirror, don't migrate.** Read-only Confluence and Notion mirror, scored for
  freshness, ownership and overlap with canonical pages. With `mirror.serve`, agents
  see it as context they may never cite.
- **Skills compiler.** Verified runbooks compile into `SKILL.md` files that agents
  execute.
- **Agents read free.** No metering on reads.

## 5-minute quickstart

You need Node 22.12+, a GitHub repo for your knowledge, and Claude Code.

Install the CLI from npm. It's `@docsworth/cli`: `agent-kb` and `docsworth` there are
not ours.

```bash
npm install --global @docsworth/cli
```

```bash
cd your-knowledge-repo
docsworth init --team platform     # config, CODEOWNERS, root map, a guide
docsworth lint .                   # 3 pages, 0 errors, 0 warnings
```

`init` reads your GitHub org from the repo's remote; in a repo without one yet, add
`--org <your-org>`. Add `--ci` for a workflow that lints every PR and every push to `main`.

Install the Claude Code plugin from this repo's marketplace:

```bash
claude plugin marketplace add docsworth/docsworth
```

```bash
claude plugin install docsworth@docsworth
```

The plugin runs the published CLI through `npx`. To run your own install instead (Docsworth
pro needs it), set `DOCSWORTH_BIN` in Claude Code's environment to its absolute path, such
as `$(npm prefix -g)/bin/docsworth`.

Start Claude Code in the knowledge repo, or set `DOCSWORTH_KNOWLEDGE_DIR` to its path, then ask
*"How do I add a page to our knowledge base?"*. The answer cites
`guide-writing-pages`.

The server uses your own GitHub identity (`GITHUB_TOKEN`, `GH_TOKEN` or `gh auth
token`), so your repo and team permissions decide what you see.

## Adopting existing docs

Docs you already have, a Docusaurus site's say, become pages without moving a URL. With
them under `knowledge/` (or `knowledge_root` in `.knowledge/config.yaml` set to where they
are), after `init`:

```bash
docsworth adopt --team docs        # the frontmatter each page lacks, as drafts
docsworth lint .
```

`adopt` gives each page the fields it lacks, and keeps everything it has:

- a page's `id` is its own, else its file name, a Docusaurus number prefix removed, so the
  site's URLs stay where they are;
- its owner comes from CODEOWNERS, else `--team`;
- a route link like `/guides/setup` becomes a relative link to the file,
  `../guides/setup.md`;
- keys a site generator keeps, such as `sidebar_position`, go in `frontmatter.extra_fields`;
- images a site serves from its `static/` directory (`/img/x.png`) get a hint naming the
  `static_dirs` line to add, after which lint reads them there.

A page or link it can't settle stays as it is, listed, and lint fails it until it's fixed
by hand: a category index like `guides/index.md`, two pages with one file name, a link to
nothing. `--dry-run` reports and writes nothing.

**Pages copied in from other repos.** A page's date (`last_verified`) is when its content
last changed: its last commit here, else today. A file copied in from elsewhere has no
history here. So, before changing the copies in any way, name the repos they came from:

```bash
docsworth adopt --team docs --dates-from ~/src/api --dates-from ~/src/web
```

- **How a page is dated.** It gets the newest commit, in those repos' history, that
  introduced its exact content, whatever the file is called there. Failing that, it gets
  the newest commit here with that content. Failing both, today, and adopt lists it.
- **What adopt reports:** how many pages each repo dated.
- **What won't match:** a copy edited before adopt ran, content behind a git filter other
  than line endings (Git LFS, say), and content that appeared only in a merge's conflict
  resolution.
- **Moves count.** A file moved or renamed there without edits counts as changed when it
  moved.

Adopted pages are drafts, so agents cite none of them yet. `docsworth drafts` is the queue,
newest content first: a page changed last week is likelier to be right than one untouched
for a year. Once a team has read its pages:

```bash
docsworth drafts                   # what to read and verify, newest first
docsworth verify knowledge/guides  # canonical, verified today
```

Both commands only change files. Commit them and open a pull request, which CODEOWNERS
sends to the owning team. In a repository with no remote, both say to commit instead.

If the site stays up, set `site_url` (`https://docs.example.com/docs/`) in the config.
Then a link to a page someone can't see reads `[restricted page]` by its full URL on the
site, as it already does by its route. A link without an extension that names nothing
reads `[restricted page]` too: a route can't be told from a hidden page's.

## Commands

| Command | What it does |
| --- | --- |
| `docsworth init [dir]` | Scaffold config, CODEOWNERS, `knowledge/index.md`, a glossary and a writing guide. Never overwrites. |
| `docsworth lint [dir]` | Frontmatter, CODEOWNERS ownership, links and duplicate ids. Exit 1 on errors; overdue pages only warn. |
| `docsworth adopt [dir] [--team t] [--dates-from repo…]` | Existing pages get the frontmatter they lack, as drafts, and route links become `.md` links; lists what it can't settle. `--dates-from` dates pages copied from other repos by their content's history there. Working tree only; `--dry-run`. |
| `docsworth verify <paths…>` | The draft or canonical pages under the paths become canonical, verified today. Working tree only; `--dry-run`. |
| `docsworth drafts [dir]` | The verify queue: draft pages, newest content first, with each one's owner and SLA state. |
| `docsworth stale [dir]` | Pages past their review SLA or without a team owner. |
| `docsworth coverage [dir] [--html f]` | Percentage team-owned and percentage verified within SLA, by team; optional static dashboard (`--html`, pro). |
| `docsworth digest [dir] [--send]` | **Pro.** Weekly per-team digest: due, overdue, most read by agents. Prints unless `--send`. |
| `docsworth mcp [dir]` | The MCP server (stdio): `search`, `read`, `list`, `stale`, `propose_edit`, `verify`, `draft_page`. Without `dir`, it serves `DOCSWORTH_KNOWLEDGE_DIR`, else the current directory. |
| `docsworth serve [dir]` | The web app at `127.0.0.1:4747` (overview, search, pages, teams, a link graph, capture), and the same server over HTTP for it and the browser extension, behind a token kept in your state directory (`--print-token`, `--rotate-token`, `--allow-extension <id>`). |
| `docsworth compile [dir] [--check]` | **Pro.** Canonical runbooks → `skills/<id>/SKILL.md`; `--check` exits 1 on drift. |
| `docsworth mirror [dir]` | **Pro.** Read-only Confluence and Notion mirror into `.knowledge/mirror`, scored. |
| `docsworth promote <mirror-id> --owner-team t` | **Pro.** Draft PR copying a mirrored page into `knowledge/`. |
| `docsworth audit [dir] [--bench d]` | **Pro.** Audit report: coverage, stale and overlapping pages, DIY accuracy score. |
| `docsworth bench run [dir]` | **Pro.** Citation benchmark: Claude on the raw wiki vs. the ungated layer vs. the gated layer. |

Commands marked pro are Docsworth pro's (`@docsworth-pro/pro`); without it installed, each exits 2 and
says so. `--as-of YYYY-MM-DD` evaluates SLAs on a fixed date, for reproducible reports.

## How it works

```
knowledge/*.md ──lint (CI)──▶ CODEOWNERS: one team per page
      │
      ├─▶ docsworth mcp ──▶ ACL filter (your GitHub teams) ──▶ citation gate ──▶ agent
      │                                         propose_edit / verify ──▶ PR only
      ├─▶ docsworth compile ──▶ skills/<id>/SKILL.md
Confluence / Notion ──docsworth mirror──▶ .knowledge/mirror (scored, never citable) ──promote──▶ PR
```

- [docs/format-spec.md](docs/format-spec.md): the format contract.
- [docs/security-model.md](docs/security-model.md): ACLs, writes and prompt injection.
  Note that `acl` narrows what agents are served; it isn't confidentiality inside one
  repo.
- [docs/enterprise/](docs/enterprise/README.md): for a security review. The two modes, what is
  inherited from GitHub, a responsibility matrix, a data-flow diagram and a pre-filled
  questionnaire. Vulnerabilities: [SECURITY.md](SECURITY.md).
- [docs/rollout.md](docs/rollout.md): org-wide rollout with managed settings.

## Try it on the example

```bash
npm install
```

```bash
npm run docsworth -- --as-of 2026-11-02 lint examples/acme
```

```bash
npm run docsworth -- --as-of 2026-11-02 coverage examples/acme --html coverage.html
```

```bash
npm run mirror-fixture -w @docsworth-pro/pro -- examples/acme
```

```bash
npm run docsworth -- --as-of 2026-11-02 audit examples/acme --out audit
```

## Browser extension

A side panel for Chrome (and other Chromium browsers) over `docsworth serve`. From the panel
you can search and read pages, or suggest an addition to one.

**Saving what you read.**
- **From the menu:** on any page, right-click and choose **Save page to Docsworth**, or
  select some text and choose **Save selection to Docsworth**.
- **From the panel:** **Save this page** and **Save the selection** read the tab you opened
  the panel from with the toolbar button.
- **In Gmail:** a **Save to Docsworth** button beside a thread's subject.

The page's main content or the selection arrives as markdown, with its headings, links,
code blocks and tables, and without what the page hides or its navigation. The panel first
shows the pages that may already cover it, each with **Add the capture here**, then a draft
page filled from it, with its source. Nothing is written until you open the PR. The
extension isn't in the Chrome Web Store yet: build it and load it unpacked.

```bash
npm run build -w @docsworth/extension
```

1. In Chrome, open `chrome://extensions`, turn on **Developer mode**, choose **Load
   unpacked** and pick `packages/extension/dist`. Note the extension's id.
2. Start the server so it answers the extension:

   ```bash
   docsworth serve --allow-extension <the extension's id>
   ```

3. Open the extension's options (its toolbar icon, then **Options**). Paste the link `serve`
   printed, then choose **Connect**. Chrome forgets the token when it quits; paste it again
   then (`docsworth serve --print-token` shows it).

What it can reach and keep, and why the token is safe from pages:
[docs/security-model.md](docs/security-model.md#the-browser-extension).

**Gmail checklist.** Gmail's markup isn't a contract. The tests run against Gmail-shaped
fixtures, so check these by hand, signed in, after loading a new build:

- [ ] An open thread shows **Save to Docsworth** beside its subject. The inbox list shows
  none.
- [ ] Clicking it opens the side panel with "From Gmail", related pages, and a draft whose
  title is the subject and whose body is the expanded messages, each with its sender's name
  and no addresses.
- [ ] Moving to another thread moves the button with it. Clicking it while a draft is open
  shows "Another capture is waiting" rather than replacing the draft.
- [ ] A thread with collapsed messages captures only the expanded ones: expand what you
  want in the draft first.

## Development

The one verify target is `npm test`: a typecheck and the vitest suite, including an MCP
end-to-end test and the ACL matrix. It also builds, packs and installs the real tarball.
See [AGENTS.md](AGENTS.md), and [docs/releasing.md](docs/releasing.md) for releases.

## Status

v0.4. What's in it, and what hasn't been verified against the real thing yet, is in the
release notes for [0.3.0](docs/release-notes/v0.3.0.md), [0.3.1](docs/release-notes/v0.3.1.md),
[0.3.2](docs/release-notes/v0.3.2.md), [0.3.3](docs/release-notes/v0.3.3.md) and
[0.4.0](docs/release-notes/v0.4.0.md).

## License

Apache-2.0. Docsworth pro (`@docsworth-pro/pro`: the mirror connectors, digest, reports,
the SIEM audit sink and the benchmark) is a separate package under its own, proprietary
licence.
