# Data inventory

Docsworth runs no hosted service. Everything below lives in the customer's own GitHub and machines, or with the systems they connect. For each store, this says who owns it, how long it's kept, and how to delete it.

| Store | Where | Holds | Owner | Kept | Delete with |
| --- | --- | --- | --- | --- | --- |
| Knowledge pages | the knowledge repo, in GitHub and every clone | the pages | the owning teams (CODEOWNERS) | git history, forever | a PR; for erasure, see below |
| `docsworth/*` branches and PRs | GitHub | proposed edits and verifications | the knowledge repo admins | until closed or deleted | GitHub; `gh pr close --delete-branch` |
| Mirror ownership records | `$XDG_STATE_HOME/docsworth/<repo>-<hash>/mirror/` on each machine that runs `docsworth mirror` | which files each mirror run wrote, and their hashes | the machine's owner | until the next run or purge of that space | removed by `docsworth mirror-purge`, or delete the directory |
| Audit log | `$XDG_STATE_HOME/docsworth/<repo>-<hash>/audit/` on each machine running the server, or `audit_log.dir` | who called which tool, on which page ids, with what outcome. No content, and no queries unless `include_queries`. | the machine's owner; centrally, the server's operator | `audit_log.retention_days` (default 365), pruned at server start | delete the daily files |
| Audit copies in the SIEM | the customer's collector (`audit_http`) | the same events | the customer's security team | the SIEM's policy | the SIEM |
| Usage log | `.knowledge/usage.jsonl` in each clone (when `usage_log: true`). Git-ignored by `.knowledge/.gitignore`; lint warns if not. | page ids and tool names per read, with no identity and no queries | the machine's owner | until deleted (the digest reads the last 7 days) | delete the file |
| Mirror cache | `mirror.out_dir` (default `.knowledge/mirror/`), git-ignored, marked by a `.docsworth-mirror` file | copies of Confluence and Notion pages the service account could read. Restricted pages are never written. | whoever runs `docsworth mirror` | replaced on every run | `docsworth mirror-purge [--source confluence\|notion]`. It deletes only files one of this user's runs wrote and that are unchanged since. That's known from a record kept in the user's state directory (outside the repo, so a checkout can't forge it), with each file's hash. It never deletes recursively, never through a symlink, and leaves anything else in place. Reads follow the same record |
| Promoted pages | the knowledge repo | a mirrored page copied in through a reviewed PR | the owning team | git history | as for knowledge pages |
| Bench results | `bench-results/` (git-ignored in this repo) or `--out` | questions, transcripts and the model's answers about the pages | whoever ran the bench | until deleted | delete the directory |
| Reports | wherever `--out` points: the audit report, the coverage dashboard, the digest | page titles, owners and freshness. A digest names restricted pages only in that team's own channel. | whoever generated them | until deleted | delete the files; Slack's own retention |
| The search index | memory of the running server | redacted page text | the server process | the life of the process | stop the server |
| The browser extension's token and captures | `chrome.storage.session` in the user's Chrome profile, readable by the extension's own pages only | the `docsworth serve` token; each panel's MCP session id; captures waiting for the side panel (a Gmail thread's or a page selection's text, at most 64 KB, with its title and address) | the user | until Chrome quits; a capture is removed when the panel is done with it (its draft is a PR, or the panel moved on), or 10 minutes after it was made (its alarm fires a second later). The capture on a panel's screen stays in that panel's memory until the panel moves on or closes | quit Chrome, or "Forget the token" on the extension's options page |
| The browser extension's server address | `chrome.storage.local` in the user's Chrome profile | the local server's address (`http://127.0.0.1:<port>`) | the user | until the extension is removed | remove the extension |
| Captured email and selections | the knowledge repo, once a draft PR is opened from the side panel | what the person kept in the draft: by default an email thread's text and its senders' names (not addresses), or a selection and its page's address | the owning team | git history, as for knowledge pages | close the PR; for erasure, see below |
| Agent transcripts | the agent client and the model provider the customer configured | tool output the agent received | the customer's agent configuration | the client's and provider's policies | the client and provider |

## Erasing a page from git history

Deleting a page in a PR removes it from the default branch, not from history. To erase it:

1. **Find every path the page has had:** a rename leaves the content under its old paths too. Run `git log --all --follow --name-only --format= -- knowledge/<page>.md | sort -u`. Copies made elsewhere don't follow a rename, so also search for a distinctive sentence: `git log --all -S '<sentence>' --name-only --format= | sort -u`.
2. **Rewrite history** on a fresh mirror clone. Pass `--path <p>` for every path found, then `--invert-paths`. If the text also appears inside other files, use `--replace-text` with the sentences to remove instead. Then force-push every branch and tag.
3. **Ask GitHub to purge cached views:** contact GitHub Support. Old PRs and forks keep references.
4. **Delete local copies:** ask everyone with a clone to delete and re-clone it.
5. **Check the logs:** audit logs and usage logs hold page *ids*, never page content. With `audit_log.include_queries: true`, though, audit events also hold raw search text, which may quote the page. Search the audit files and the SIEM copy for it, and delete matching events there too.

**The limits:** a rewrite can't reach clones, forks, or copies already pasted elsewhere. For material that must not spread, keep it in a separate repository with narrower access (see [security-model.md](../security-model.md), "`acl` isn't confidentiality").
