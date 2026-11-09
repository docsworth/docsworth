# Rolling out to an organization

How to put the Docsworth plugin in front of every engineer, using Claude Code's
managed settings. Settings keys and file paths are as documented at
<https://code.claude.com/docs/en/managed-settings>.

## 1. Publish the plugin where your engineers can reach it

The marketplace manifest lives at `.claude-plugin/marketplace.json` in the Docsworth repo
(or your fork). Engineers, or managed settings, add it as a marketplace by GitHub repo.

## 2. Deploy managed settings

Put this in `managed-settings.json` in the system directory, or as a drop-in under
`managed-settings.d/` next to it:

| OS | Directory |
| --- | --- |
| macOS | `/Library/Application Support/ClaudeCode/` |
| Linux and WSL | `/etc/claude-code/` |
| Windows | `C:\Program Files\ClaudeCode\` |

Server-managed settings from the claude.ai admin console carry the same keys.

```json
{
  "extraKnownMarketplaces": {
    "docsworth": { "source": { "source": "github", "repo": "<org>/agent-kb" } }
  },
  "enabledPlugins": {
    "docsworth@docsworth": true
  },
  "env": {
    "DOCSWORTH_KNOWLEDGE_DIR": "~/src/knowledge"
  }
}
```

- `DOCSWORTH_KNOWLEDGE_DIR` points the MCP server at each engineer's clone of the knowledge
  repo. If engineers keep it elsewhere, leave this out and have them set it in
  `~/.claude/settings.json`.
- To stop engineers adding other marketplaces, add `strictKnownMarketplaces`, an
  allowlist that only managed settings can set.
- **Don't** add `mcp__…propose_edit` or `mcp__…verify` to `permissions.allow`. Both
  tools open PRs, and the per-call prompt is part of the [security
  model](security-model.md).

## 3. Give engineers a token with the right scopes

The server uses each engineer's own GitHub identity: `GITHUB_TOKEN`, then `GH_TOKEN`,
then `gh auth token`.

- **Read-only use:** `repo` (or fine-grained *contents: read*) on the knowledge repo,
  plus `read:org` so team ACLs work.
- **For `propose_edit` and `verify`:** also *contents: write* and *pull requests: write*.

## 4. Turn on the review loop

- **Branch protection on the knowledge repo:** require pull requests and code-owner
  review on the default branch. That's what makes "a human from the owning team approves
  every change" true.
- **CI:** add `templates/github/knowledge.yml` as `.github/workflows/knowledge.yml`
  (`docsworth init --ci`). It lints every PR and recompiles skills on merge.
- **Weekly digest:** schedule `docsworth digest --send`, with `SLACK_WEBHOOK_URL` and optional
  per-team webhooks, from CI or cron.

## 5. Check it landed

On an engineer's machine:

1. Run `/status` in Claude Code. The `Setting sources` line should name the managed
   source.
2. Run `/plugin` and confirm `docsworth` is enabled.
3. Ask "which runbooks are overdue for the platform team?". The answer should come from
   the `stale` tool.
