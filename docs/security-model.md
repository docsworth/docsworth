# Security model

What Docsworth protects, how, and what it does not.

For a security review, start at [enterprise/README.md](enterprise/README.md): the deployment
modes, the checklist, who is responsible for what, and a pre-filled questionnaire.

## Who decides what a caller sees

| Mode | When | Caller identity | Sees | Can write |
| --- | --- | --- | --- | --- |
| GitHub | `github.repo` set | The caller's own token (`GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`) | `internal` pages plus pages whose `acl` is a team they're on | Opens PRs if the token has push access |
| GitHub, no token | `github.repo` set | none | **Nothing.** The server refuses to start. | no |
| Local-only | no `github.repo` | the filesystem user | `internal` pages only; team pages stay hidden | no |

- **Startup fails closed.** If the token can't prove access to the repo (401, 403, 404,
  network error), `docsworth mcp` exits instead of falling back to anonymous.
- **Team membership** comes from `GET /user/teams`, filtered to the configured org.
  - **Caching:** it's cached for `policy.identity_cache_seconds` (default 300) and re-read live before every write.
  - **No `read:org`:** a token without it gets no teams, team pages stay hidden, and a warning goes to stderr.
- **SSO:** single sign-on is GitHub's.
  - **Not SSO-authorized:** in an org that enforces SAML SSO, a classic token that isn't authorized for it fails closed with an error naming SSO and GitHub's authorization link.
  - **Teams withheld:** if GitHub leaves out the org's teams for the same reason (`x-github-sso: partial-results`), team pages stay hidden and a warning says why.
  - **MFA** is enforced by the GitHub org or the IdP.
- **Tokens:**
  - **Accepted:** classic and fine-grained personal tokens, OAuth tokens (`gh auth token`) and GitHub App *user* tokens.
  - **Refused at startup:** GitHub App *installation* tokens (`ghs_`). They act for no person, so they can't carry anyone's team ACLs or put a name on an audit event.
- **Deprovisioning** comes in two parts:
  - **Removal from the org,** which SCIM or EMU usually drives: the token loses repo access. Writes stop at once, because they re-check live. Reads stop when the cache window ends, or at once after any failed live check.
  - **Removal from a team,** which needs IdP group to team sync configured in GitHub: that team's pages are hidden once the window ends.

## Roles and policy

Roles are derived from GitHub and `policy:` in `.knowledge/config.yaml`. None are stored.

| Role | Who | May |
| --- | --- | --- |
| Reader | anyone whose token can read the knowledge repo | search, read, list and stale: `internal` pages, plus their teams' pages |
| Contributor | push access, and `policy.tools.propose_edit` (if set) names one of their teams | open edit PRs |
| Owner | member of a page's `owner_team` | open verify PRs for that page |
| Admin | member of `policy.admins` | approve changes to the config and to CODEOWNERS, as the *only* owner of the winning CODEOWNERS rule (lint errors otherwise, because any one co-owner's approval would satisfy GitHub) |

The admin role is real only when three things hold. Lint can see none of them, so `docsworth access-review` reports all three:
- **Code-owner review is required:** by branch protection or a ruleset.
- **No one can bypass it:**
  - repository admins, unless protection is enforced for admins
  - users, teams or apps on a bypass list
  - ruleset bypass actors. GitHub shows those only to admins, so for anyone else this reads "unverified".
- **The admins team has write access to the repo:** GitHub ignores a CODEOWNERS team without it. The same goes for every owner team.

**Policy controls:**
- **Per-tool allowlists:** checked on every call before any page is resolved, so a refused `read` says the same thing for every id. A refused tool also drops out of that identity's `tools/list`. An identity with no teams (local mode) is refused any allowlisted tool.
- **When the tool list is computed:** at session start, after every call, and every 15 seconds. The timer matters because a disabled tool's calls never reach a handler. The config is re-read when it changes, so a tool the policy now refuses is disabled, one it now allows is enabled (the approval flag follows too), and the client is sent `list_changed`. Every call is also checked against the current policy.
- **`writes: disabled`:** disables the write tools, so they leave `tools/list`. A call is refused before GitHub is asked anything.
- **`include_stale: denied`:** keeps gated pages out of search results.
- **`require_human_approval`:** sets `anthropic/requiresUserInteraction` on the write tools, so Claude Code asks on every call in every permission mode.
  - That is client behaviour and defence in depth.
  - The controls are PR-only writes, CODEOWNERS and branch protection.

**Where the policy is enforced.** On a laptop (stdio) the policy steers the agent, but it lives in the user's own clone, and they can edit it. Every write is still enforced by GitHub: push access, branch protection and code-owner review. A policy no user can change needs the server run centrally, where the config comes from a clone users don't control.

## The one read path

Every tool resolves pages through a single `visiblePages(identity)` view, so no tool can
bypass the filter:

- **Applied everywhere:** search, read, list, stale, and the write tools.
- **No existence oracle:** a hidden id and an unknown id produce the same `not_found`
  error, so writes can't be used to probe for hidden pages.
- **No hidden directories:** `list` only reveals directories that contain a page the
  caller can see.
- **Redacted links:** references from a visible page to a hidden one read
  `[restricted page]` in `read` content and search snippets. The search index is built
  from redacted text, so a hidden page's title in a link can't influence ranking either.
  - **In place:** common links (inline, reference-style with their definitions, and
    quoted HTML `href`s) are replaced alone, and the rest of the line stays.
  - **Then a sweep that fails closed** (`src/core/references.ts`): any line that still
    names a hidden page goes whole. That covers every form a reader resolves: link text
    with nested or escaped brackets, definitions inside quotes and lists or with the
    destination on the next line, unquoted attributes and `img src`, values broken
    across lines, character references, backslash escapes, percent-encoding (`%2F`
    included), `\` as `/`, GitHub and other URLs ending in the page's path, and the
    path written in text or code, also as it renders: paired markup inside a path is
    gone on screen (`security/**x.md**`, a link or code span inside it), and so are
    comments and invisible characters on its line; a path wrapped across lines reads
    whole. Paths
    are compared as a case-insensitive file system would compare them, and Unicode
    composed or not, so `../Security/X.MD` and a decomposed `café.md` count too.
  - **How the sweep decides.** A path can end only with its page's file name, so the
    sweep looks only where a hidden page's file name ends, and reads back every place
    the reference could start. One that resolves to a hidden page as a link redacts the
    line. One that resolves to a visible page settles what a relative path there means:
    from inside `team space/`, `security/x.md` is `team space/security/x.md`, even if a
    hidden `security/x.md` exists. A URL still counts by the path it ends with. Otherwise
    the most specific path the text ends with decides.
  - **Pages that didn't load** count as hidden: their ACL can't be read. So does a link
    to a path under the knowledge root that is no page at all, in any form: a second
    pass reads every place a destination stands (after `](`, after a definition's `]:`,
    and in a tag's URL attributes, `srcset`, an iframe's `srcdoc` and a refresh among
    them, with tags read as CommonMark and as a browser reads them; inside quotes and
    lists, across lines, and in a raw HTML block as written; resolved against a
    `<base href>` too, as a browser resolves it) and refuses it as the first pass does.
    An iframe's `srcdoc` is read by every sweep as a document of its own, with its
    parent's base; nested more than three deep, it fails closed. A path that is no page mentioned in text, not as a link, is served as
    written: it names nothing to protect. A hidden page's path in a destination's query
    (`?next=…`) is the name sweep's, as anywhere in text.
  - **A GitHub URL into the repo** (with `github.repo` set; blob, raw and the rest, on
    any branch, and on GitHub Enterprise Server's host; parsed by the platform's URL
    parser as a browser parses it, so a port, userinfo, `www.`, case, or a host written
    in fullwidth or percent-encoded don't matter) counts the same way, as a link,
    an attribute or a bare URL in text: a page on another branch never loads here, so its
    ACL can't be read. Other URLs count by the loaded pages they name, since nothing ties
    them to this repo; so do the repo's own when it runs locally, without `github.repo`.
  - **Over-redaction is rare:** fuzzing (below) redacts about 2 in 1,000 texts that
    reach only visible pages. That happens with `\.` inside a markdown link (read both as
    CommonMark's escape and as raw HTML reads it), with a value broken across lines
    whose next line starts with a hidden page's file name, where markup splits a path
    that a shorter tail of resolves elsewhere, and where a visible path and a hidden one
    differ only by case or in their non-ASCII characters.
  - **Not redacted:** text the visible page's own authors wrote that mentions a hidden
    page by title or id. Nothing resolves that to a page; it's served as written.
- **`supersedes`** in `read` lists only pages the caller can see (and ids that are no
  page at all).
- **Mirrored pages** are read through the same redaction, so a wiki page's GitHub URL to
  a hidden repo page reads `[restricted page]` too. Links to hidden mirrored pages get
  the same fail-closed sweep, by page id: Confluence `/pages/<id>`, `pageId=`, tiny
  links, and Notion ids, in every view the sweep reads.
- **Tested exhaustively:**
  - `test/acl.test.ts` walks every tool against every page and every identity, and
    fails if any serialized response contains a hidden page's id, title, path or
    description.
  - `test/acl-fuzz.test.ts` does the same on random repos (random team ACLs, links in
    every form, random `supersedes`), with each response decoded first. It also fuzzes
    redaction against CommonMark's reference parser (commonmark.js): no redacted text may
    hold a link, an `href` or `src`, or a path that reaches a hidden page, as written or
    as a browser shows commonmark.js's HTML (an HTML5 parser, domino). A link to a path
    under the knowledge root that is no page counts as reaching one.
  - `scripts/fuzz-acl.ts` runs that longer: 120,000 texts, 0 leaks.
  - Every rule of the sweep fails a test when it's deleted.

## `acl` isn't confidentiality

GitHub permissions are per repository. Anyone who can read the knowledge repo can read an
`acl: security` page's markdown with `git clone`. The `acl` field controls what the MCP
server serves to agents: it reduces need-to-know exposure through agents and keeps
team-only procedures out of other teams' answers. **Confidential material belongs in a
separate repository** whose GitHub access matches its audience, served by its own
`docsworth mcp` instance.

## Writes

- **PRs only.** `propose_edit`, `verify` and `draft_page` read the file at the default branch, create
  a new `docsworth/<verb>/<id>-<timestamp>` branch, commit to it with an explicit `branch`
  parameter, and open a PR.
  - The GitHub contents API writes to the default branch when `branch` is omitted. The
    test fake treats any mutation without an explicit non-default branch as a violation.
  - If a step after branch creation fails, the branch is deleted.
- **Protected fields.** `propose_edit` refuses to change `id`, `owner_team`, `acl` or
  `last_verified`. Otherwise an agent PR could quietly move a page to another team or
  widen its audience.
- **Pages with hidden links.** On a page that links to pages the caller can't see,
  `propose_edit` takes only `edits` (no whole `body` or `content`, and no polish), so an
  edit written from the redacted view can't overwrite or drop a link it never showed.
  That's checked before anything is applied. Edits still match against the real file,
  so whether an `old` string matched can reflect text inside such a link. The write
  tools need push access, which on GitHub reads the whole repository, so that reveals
  nothing the caller's own clone doesn't.
- **Appends.** `propose_edit` with `append` adds to the end of the page as it is on the
  default branch: a change merged since the caller read it isn't overwritten, and the
  redacted view never goes back into the file.
- **New pages.** `draft_page` names the page itself, with 12 random hex digits in its id
  and file name, so it can't be aimed at a hidden page to learn that one exists there.
  A name that turns out to be taken is retried with a fresh one and never named.
- **Polish.** `polish: true` adds a structural guard; see the format spec.
- **Owner-only verify.** `verify` (which bumps `last_verified`) checks membership of the
  page's owner team live.
- **Taint check.** Once a session has read a page whose `acl` is a team, `propose_edit`
  (and `draft_page` to create one) refuses to write into a page with a different
  audience. This closes the "read the security runbook, paste it into a public page's
  PR" path.
  - It's per session and coarse: it blocks some legitimate edits. The refusal says why,
    and the user can make the edit in a fresh session.
- **Human approval.** The Claude Code plugin never pre-approves the write tools, so
  Claude Code asks before every `propose_edit`, `verify` or `draft_page` call. Nothing reaches the
  default branch without a human merging the PR, and CODEOWNERS makes that human a
  member of the owning team when branch protection requires code-owner review.

## The local server (`docsworth serve`)

`docsworth serve` gives the web app and the browser extension the same MCP server agents
get, over HTTP. It runs as the user, on their machine, with their identity: there is still
no hosted service.

- **Who can reach it.** It listens on `127.0.0.1` only. Every request must name it as
  `127.0.0.1:<port>` or `localhost:<port>` in `Host`, which a DNS-rebound page can't. A
  browser request's `Origin` must be the server itself or a `chrome-extension://<id>`
  given with `--allow-extension`; only those get CORS headers, and a preflight is
  answered only after both checks.
- **The token.** `/mcp` needs a bearer token, compared in constant time. There are no
  cookies, so nothing a browser attaches on its own authorizes a request, and another site
  can't make one on the user's behalf. The token lives in the user's state directory
  (`$XDG_STATE_HOME/docsworth/<repo>-<hash>/serve-token`): a 0700 directory that isn't a
  symlink, a 0600 file read without following links and refused if others can read it,
  written atomically. `--rotate-token` replaces it. The URL `serve` prints carries it in
  the fragment, which browsers never send to a server; the app moves it to session
  storage.
- **What the page may do.** Every response carries `Content-Security-Policy:
  default-src 'self'` (no inline script, no external connections, no framing, no forms),
  `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. The static files
  hold no data.
- **Sessions.** Each tab or extension gets its own MCP session with its own service, so the
  taint check is per tab. A session that saw a team page anywhere, the graph included,
  can't write into a broader page; a fresh session can. At most 16 sessions; idle ones
  close after 30 minutes.
- **The same rules.** The tools are the stdio server's, plus the web app's views
  (`ui_capabilities`, `ui_overview`, `ui_graph`), which exist only on HTTP sessions. The
  views answer to the `list` policy, work over `visiblePages(identity)`, and are audited
  at the JSON-RPC boundary like every tool: a required audit sink that fails withholds
  their answer. The graph has no edge to a hidden page; `has_restricted_links` says a page
  has one exactly as `read` shows a placeholder for it.
- **The web app.** It keeps the token, and its MCP session id, in that tab's session storage.
  A tab duplicated from it, or opened from it, starts with a copy of that storage, and so
  shares its session and its taint: that is stricter, never looser. When the server no longer
  knows a tab's session (idle for 30 minutes, or restarted), the tab doesn't carry on in a new
  one, which would hold none of its taint: every call, a write included, is refused until the
  page reloads and reads its views again. The one exception is a reloaded tab whose kept
  session had expired, which has shown nothing yet. Each view asks only for what it shows (`ui_page` for a page with the ids of the visible
  pages it links to, `ui_graph` for one team or all), so a tab is tainted only by what it
  opened. Page markdown renders through commonmark.js in safe mode after its tree is
  rewritten: images become links (nothing is fetched), relative links route in the app only
  to visible pages, and only http, https and mailto stay links.
- **The trust boundary is the user's account.** A process running as the same user can
  read the token file, as it can read the user's GitHub token. `serve` adds no access a
  local program of the user's didn't already have.

## The browser extension

The extension (`packages/extension`, Chromium, loaded unpacked) is another client of
`docsworth serve`, with a side panel and a button in Gmail. It reaches only the local server.

- **Who holds the token.** The side panel and the options page. They are extension pages:
  they read the token from `chrome.storage.session` and call the server themselves, each
  as one MCP session, so a panel's taint follows what it showed, as a web tab's does.
  - **Who can't read it.** `storage.session` is pinned to trusted contexts: content scripts
    can't read it (checked in a real Chrome by `chrome.e2e.test.ts`), and Chrome clears it
    when it quits, so the token is pasted again then.
  - **`storage.local`.** Content scripts can read it, so it holds only the server's address.
  - **Never exposed.** The token is in no URL, message, DOM attribute or log.
  - **The panel's session** is kept per window, and resumed when the panel is opened again.
    When the server no longer knows it, the panel ends as a tab does.
- **The worker** never calls the server and never sees the token. It opens the panel,
  leaves the panel a capture in `storage.session`, and removes captures whose time is up.
  It lists the area's keys and reads only the captures' (`getKeys`, Chrome 130), never the
  token or a panel's session.
- **Captures.** Each is under its own key and names its window. The panel takes only its own
  window's, and shows the text only as form values, never as HTML.
  - **Until the panel is done with it.** A capture stays stored until its draft is a PR or
    the panel moves on to another view. A panel that reloads (a new session, another token,
    closed and opened again) gets it back.
  - **Removed at ten minutes, in storage.** A capture is stored only once the panel has opened
    and its alarm is set, for a second after its ten minutes. When an alarm fires the worker
    removes every capture older than ten minutes, and a panel's pull prunes them too. A prune
    that fails when an alarm fires is tried again a minute on. A handoff that fails leaves
    neither a capture nor an alarm. `storage.session` is in memory, so whatever else fails,
    Chrome quitting clears it.
  - **In a panel.** A panel takes captures only once the server has answered it, and never
    opens one already past its ten minutes. A capture waiting behind the one on screen goes
    with its record. The one on screen stays in that panel until it moves on or closes, since it's the
    draft being written.
- **What a page can send.** A content script runs inside a page and is only as trustworthy
  as that page. It may send one message, `gmail-context` (a subject, at most 64 KB of text,
  a Gmail address), and the worker accepts it only when all of these hold:
  - it comes from this extension, in a tab's top frame
  - the sender's origin is exactly `https://mail.google.com`
  - the schema is exact

  A tool call, a lookalike origin, a subframe or an oversize payload is refused.
  - **What reaches the server.** Of what an accepted message carries, only the subject goes
    to the server unasked: the panel searches for the pages it may already be in, a read
    whose results only the person sees. Whoever wrote the email controls its subject. So
    they can steer that search, and like any search it taints the panel with the restricted
    pages it shows. That refuses drafting into a broader audience until the person starts a
    new session; it can't leak.
  - **What waits for a submit.** The text and the address reach the server only in a draft
    the person submits.
- **Gmail.** The content script runs only on `https://mail.google.com`, in the top frame.
  - **The button** mounts beside an open thread's subject, in a shadow root.
  - **When it reads.** The thread is read only when the button is clicked, and only a
    trusted click counts. A page script clicking it, even during a person's click, does
    nothing.
  - **What it reads.** The capture holds each expanded message's text and its sender's
    name, but not addresses.
- **No write without a submit.** A capture fills a draft. Nothing is written until the person
  submits the form, and the draft says that once its PR exists, everyone who can read the
  repository can read it, whatever its audience. An email captured into a page is
  disclosed that widely.
- **Permissions:** `sidePanel`, `storage`, `contextMenus`, `alarms`, host access to
  `127.0.0.1` and `localhost` only, and the content script's match on Gmail.
  - **Nothing exposed.** No web-accessible resources and no external connections.
  - **The pages' CSP** allows scripts from the extension only, and connections only to
    `127.0.0.1` and `localhost`.
  - **The server's side.** It answers the extension only when started with
    `--allow-extension <its id>`.

## Prompt injection

Page and mirror content is untrusted text written by people:

- **Data, not instructions.** Tool results put page text only in `content` and
  `snippet` fields of structured JSON. The tool descriptions and the server instructions
  tell the agent that text is data.
- **Bounded blast radius.** The worst a malicious page can do through this server is get
  an agent to call `propose_edit`. That means a PR a human must approve, under the taint
  check and per-call approval.
- **Residual risk.** A server can't stop a model from following text it reads. Content
  from another source (a code comment, a web page) can still steer an agent that has
  other tools. Treat knowledge pages like code: reviewed through CODEOWNERS before they
  merge.

## Audit log

Off unless `audit_log.enabled` (or `audit_http`) is set. One JSON line per event, named for a person: the GitHub login, or in local mode (no `github.repo`) the OS user running the server, marked `mode: local`.

- **What's recorded:**
  - every MCP `tools/call`, recorded at the JSON-RPC boundary, so the record also covers:
    - unknown tools
    - malformed arguments
    - calls the SDK refuses before a handler runs
  - an intent event before each write tool runs, and the outcome after it
  - server start and stop, with a hash of the config
  - mirror runs and promotes
- **What each event carries:**
  - the actor: login, mode and teams
  - the tool (only this server's tool names, otherwise `<unknown>`), and that tool's own non-content arguments. Their values come only from closed sets: page ids, team slugs and `applies_to` tags the repo itself uses, a directory path the call actually showed, page types, booleans and limits. Anything else is `<unknown>`, `<invalid>` or `<withheld>`, so a typed token or pasted text never reaches the log as an argument.
  - the client's name and version, held to a product-name shape with long random runs rejected
  - search text, only with `include_queries: true`. That is free text the operator opted into.
  - **Second line of defence:** every string in every event, whoever emits it (the MCP transport or the CLI's mirror, purge and promote), passes a token-shape redaction in `AuditLog.emit`. It's a heuristic: it catches known token formats and long high-entropy runs.
  - the outcome and error code
  - the knowledge snapshot the answer came from:
    - the checkout's `HEAD`
    - whether the served files differ from it
    - a hash of the loaded config, ownership and pages

    It's refreshed on every reload. `server_start` and `server_stop` both carry the config hash and policy summary.
  - the page ids taken from the final, ACL-filtered response, and the PR link
- **What it never contains:**
  - the caller's credentials: tokens are never read into an event. A credential the caller typed into an argument doesn't get in either, because argument values are closed-set (above).
  - page content, and edit or reason text
  - search text, unless `include_queries: true`. An unsalted hash of a short query can be reversed by guessing, so the text is omitted, not hashed.
  - a hidden page's id, title or path, except an id the caller typed themselves, which is logged with `not_found` exactly as for an unknown id
- **What `required: true` guarantees.** Nothing is answered or changed unless its event was written first:
  - a read whose event can't be written is answered `unavailable`, not with the page
  - a write whose intent can't be written never reaches GitHub
  - a required log that can't record the server's start stops it from serving
- **What it can't guarantee.** Writes can't be undone, so these are reported, not hidden:
  - **A write's outcome.** If the outcome can't be written after the change happened, the MCP result still returns, with `audit: { degraded: true, reason }`. The CLI's mirror, purge and promote print the result and exit `3` ("done, audit degraded"), as distinct from `0` and `2`. So does a mirror run that fails partway: it may already have changed the cache.
  - **A refused read's correction.** When one required sink recorded a read's "ok" and another failed, the first gets a correction (`code: audit_unavailable`, `withheld_seq`) before the refusal is sent. If the correction can't land, the refusal carries `audit.degraded` saying that log may show the call as answered.
  - **A crash** between an event and its correction can leave the event uncorrected.
  - An event records what the server decided to answer. It doesn't prove the client received it.
- **Where the file lives:**
  - outside the checkout by default, at `$XDG_STATE_HOME/docsworth/<repo>-<hash>/audit`
  - a directory of its own: new, empty, holding only audit files, or marked `.docsworth-audit`. Anything else (say `$HOME`) is refused untouched, never chmodded or pruned.
  - a directory inside the checkout is refused unless git ignores it
  - the directory is 0700 and the files 0600
  - a symlinked directory or a symlink planted at a day's file is refused. Parent directories may be symlinks: on macOS `/tmp` and `/var` are. So put `audit_log.dir` under a directory only the server's user can write.
  - daily files, pruned after `retention_days`
- **Tamper resistance comes from the collector, not the file.**
  - Per-session `seq` numbers make a line deleted mid-run visible as a gap. But a user can rewrite their own laptop's file.
  - `audit_http` ships each event to the customer's SIEM as it happens: HTTPS only, redirects refused, bounded retries and queue, and the token never echoed. That copy is the record of reference.

## Credentials

- **What's read from the environment:**
  - GitHub, Confluence (email plus API token), Notion (integration token)
  - Anthropic (bench only)
  - Slack webhooks (digest only)
- **Not logged:** no credential appears in any log, error message, fixture or report.
- **Never over plain HTTP:** every URL a credential goes to must be `https://`, or
  `http://` on loopback only: `github.api_url` and `DOCSWORTH_GITHUB_API_URL`, a Confluence
  `base_url` and `CONFLUENCE_BASE_URL`, the `audit_http` collector, and Slack webhooks.
  A webhook URL is itself the secret, so its error names the variable, never the URL.
- **The usage log** (`.knowledge/usage.jsonl`) records page ids and tool names. It never
  records queries, which can contain sensitive text. `docsworth init` git-ignores it with the
  mirror cache (`.knowledge/.gitignore`), and lint warns if either would be committed.
  Every store, and how to delete it: [enterprise/data-inventory.md](enterprise/data-inventory.md).
- **Blast radius of a leaked token:** whatever that token's own scopes reach. Docsworth
  holds no other secrets.

## Mirror permissions

- **Read-only, as the configured identity.** The mirror runs with the Confluence or
  Notion credentials you configure, so the source decides what it returns at all. Use a
  service account whose access matches the mirror's intended audience.
- **Restricted pages skipped.** Confluence pages with read restrictions, and their
  descendants (restrictions inherit), are never written. They're reported by id only.
- **Notion's boundary is sharing.** Notion's API has no per-page restriction model
  beyond sharing: an internal integration sees exactly the pages shared with it.
- **Never citable.** Mirrored pages are always non-citable. They become canonical only
  through `docsworth promote`, which opens a draft PR for the owning team.
- **Served only when asked.** With `mirror.serve: true`, agents see mirrored pages as
  context, through the same audience rules as pages (each space's `acl`): their own
  search index per audience, hidden ids answering like unknown ones, links to hidden
  mirrored pages redacted, and the session tainted by a team space's page. The ACL
  matrix in `test/mirror-view.test.ts` checks every identity against every mirrored page.

## Digest

The owner digest names restricted pages only in a team's own Slack webhook
(`digest.team_webhooks`). Sent to a shared channel, they're counted, not named.
