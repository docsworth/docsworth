# Docsworth for Claude Code

Docsworth keeps a team's engineering knowledge as markdown pages in a git repository the
team owns: runbooks, decisions, service pages. Each page names an owning team and a review
date. This plugin gives Claude Code the Docsworth MCP server and four skills.

- Claude cites only pages that are canonical and inside their review window.
- For every other page it names the team that owns it.
- It changes pages only through pull requests.

## What it adds

- **The `docsworth` MCP server.**
  - **Read tools:** `search`, `read`, `list` and `stale`.
  - **Write tools:** `propose_edit`, `draft_page` and `verify`. Each opens a pull request for
    the page's owning team. Nothing is written to a default branch.
- **Four skills.**
  - `draft-runbook` turns incident notes into a draft runbook.
  - `update-after-incident` proposes fixes to the pages a postmortem touched.
  - `verify-page` walks an owner through re-verifying a page.
  - `polish-page` tidies a page without changing what it says.

## Setup

1. **A knowledge repository.** Install the CLI with `npm install --global @docsworth/cli`.
   In your knowledge repository, `docsworth init --team <team>` writes its config, and
   `docsworth adopt` brings in markdown you already have. The
   [quickstart](https://github.com/docsworth/docsworth#5-minute-quickstart) takes five
   minutes.
2. **Where it is.** Set `DOCSWORTH_KNOWLEDGE_DIR` to its local clone. Without it, the server
   reads the project Claude Code is running in.
3. **Optional: your own CLI.** Set `DOCSWORTH_BIN` to the absolute path of an installed
   `docsworth`, and the plugin runs that instead of the published package. That's how you use
   Docsworth pro, a separately licensed package this plugin doesn't include.

## What it runs, reads and sends

**What it runs.**
- `node bin/docsworth-mcp.mjs` starts the server with `npx -y @docsworth/cli@<version> mcp`,
  from your home directory. `<version>` is this plugin's own version, in
  `.claude-plugin/plugin.json`.
- The first time, npm downloads exactly that version of `@docsworth/cli`, never a newer one. It comes from the
  registry your npm configuration names outside any project (your user or global `.npmrc`),
  which is `registry.npmjs.org` by default. A project's own `.npmrc` can't redirect it.
- With `DOCSWORTH_BIN` set, the plugin runs that executable instead and downloads nothing.

**What it reads.**
- The knowledge repository on disk, and its git history and status.

**What it writes on your machine.**
- Nothing, unless the repository's `.knowledge/config.yaml` turns logging on:
  - `audit_log` writes an audit log of tool calls under `$XDG_STATE_HOME/docsworth/`
    (`~/.local/state/docsworth/` by default);
  - `usage_log` writes the ids of pages read to `.knowledge/usage.jsonl`.

**What it sends.**
- Only when the repository's config names a GitHub repository (`github.repo`). Then the
  server uses your GitHub token, from the first of these that is set:
  1. `GITHUB_TOKEN`;
  2. `GH_TOKEN`;
  3. `gh auth token`.
- It sends the token only to GitHub's API: `api.github.com`, or the GitHub Enterprise Server
  host in `github.api_url` or `DOCSWORTH_GITHUB_API_URL`. It uses GitHub for three things:
  - to learn who you are and which teams you're in, so you see only pages your teams may
    read;
  - to read pages;
  - to open the pull requests the write tools make.
- **With Docsworth pro, run through `DOCSWORTH_BIN`,** the config's `audit_http` block can
  also send each audit event to your own collector, such as a SIEM or a log pipeline:
  - to the URL in the environment variable its `url_env` names, over HTTPS;
  - with a bearer token from the variable its `token_env` names, if that's set.

  The published package this plugin runs has no such sink.

**What it never sends.**
- No telemetry, analytics or usage data, to the plugin's authors or anyone else.
- Page text reaches the model only as tool results in your Claude Code session, like any
  file Claude reads.

## Privacy policy

- **Data collection.** The plugin and its server collect no personal data. Nothing is sent to
  Docsworth's authors.
- **Use and storage.** Pages stay in your repository, on your machine and on GitHub. The
  write tools put page text into commits and pull requests in that repository. The optional
  logs stay on your machine.
- **Third parties.** Only as the previous section says:
  - **GitHub** receives your token and the server's requests, when the repository is on
    GitHub;
  - **npm** serves the CLI download;
  - **your own audit collector** receives audit events, if you run pro with `audit_http`
    configured.
- **Retention.** Commits and pull requests that the write tools open stay in your
  repository's history for as long as GitHub keeps it. Closing a pull request or deleting a
  page doesn't remove its text from git history. The audit log, when you enable it, keeps daily files for
  `audit_log.retention_days`, 365 days by default, then deletes them. The usage log stays until
  you delete it.
- **Contact.** [github.com/docsworth/docsworth/issues](https://github.com/docsworth/docsworth/issues).

## Licence

Apache-2.0. The source, this plugin included, is at
[github.com/docsworth/docsworth](https://github.com/docsworth/docsworth).
