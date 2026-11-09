# Docsworth — agent context

A git-native knowledge layer for coding agents. The CLI is `docsworth`, and `docsworth mcp` is the
stdio MCP server. It lints team-owned markdown pages, enforces review SLAs, applies a
citation gate, and writes only through PRs. It must never leak a page across its ACL,
and it must never write to a default branch.

## Commands

| What | Command | Healthy output |
|---|---|---|
| Verify | `npm test` | core (`test:core`): `tsc --noEmit` silent, `Test Files 34 passed`, `Tests 1090 passed`; then the web app (`test:web`): the typecheck and tests of `packages/ui` (`Tests 37 passed`), `packages/web` (`Tests 12 passed`; the view tests drive the real `serve` CLI), and `packages/extension` (`Test Files 8 passed`, `Tests 77 passed`; its panel tests drive the real `serve` CLI too, and `chrome.e2e.test.ts` drives a real Chrome: `CHROME_PATH` or the usual install paths, skipped with a warning without one, a failure in CI); exit 0. Core's suite builds, packs and installs the real tarball (`test/package.test.ts`) |
| Polish fuzz (long) | `npx tsx scripts/fuzz-polish.ts --iterations 60000 --seed 1 --depth 6 --edits 3` | `60000 pairs, seed 1, depth 6, edits 3, ~9 s: 0 miss(es)`, exit 0. A miss prints the shrunk pair: a change commonmark.js renders that the polish guard didn't report |
| ACL fuzz (long) | `npx tsx scripts/fuzz-acl.ts --iterations 4000 --seed 1 --seeds 30 --show 0` | `120000 texts, seeds 1–30, ~20 s: 31570 reach a hidden page, 0 leak(s) after redaction; 166 of 58699 reaching only visible pages redacted`, exit 0. A leak prints the text and how it still reaches the page |
| Clean install | `npm run build && npm pack && npx tsx scripts/smoke-install.ts ./<one>.tgz` | eight `PASS` lines (bin, nothing of pro, init lints clean, seven tools, the polish prompt, a citable hit, `serve` serving the web app, `/mcp` answering the token only), then `clean install: all checks passed`, exit 0. CI runs it on every PR |
| Release guard | `npx tsx scripts/release-guard.ts v<version>` | `v<version> can be released as …`, exit 0; otherwise a `REFUSED` line for each disagreement (tag, versions, name, notes), exit 1. The release workflow runs it before anything else |
| Local server | `npm run build && node dist/cli.js serve examples/acme` | `docsworth: serving …/examples/acme (local) at http://127.0.0.1:4747/#t=<token>` on stderr; open that URL for the web app (it is served from `dist/web`, so build first); Ctrl-C stops it. The token lives in `$XDG_STATE_HOME/docsworth/<repo>-<hash>/serve-token`; `--print-token` shows it |
| Lint the example | `npm run docsworth -- --as-of 2026-11-02 lint examples/acme` | `24 pages, 0 errors, 3 warnings`, exit 0 |
| Search latency | `npm run bench:search` | `5000 pages … p95 ~4 ms … → PASS`, exit 0 |
| Plugin manifests | `claude plugin validate plugin && claude plugin validate .` | `✔ Validation passed` twice |
| Live checks | `npm run live:github` · `live:serve` · `live:quickstart` · `live:skills` · `live:governance` · `live:polish` | Read `.env` (see `.env.example`); each prints PASS lines or `SKIPPED: <missing var>`. `live:github`, `live:serve`, `live:skills` and `live:polish` open PRs on the scratch repo `DOCSWORTH_LIVE_GITHUB_REPO` names (`live:serve` needs the one `live:github` seeds, and closes its own); close them, don't merge. `live:polish` costs about $2 |
| Build | `npm run build` | Vite's summary for the web app (about 240 KB of JS), otherwise silent; emits `dist/` (with the app in `dist/web`) and the host facade's declarations |
| Extension | `npm run build -w @docsworth/extension` | Vite's summary twice: the side panel, options page and worker, then `dist/gmail.js` (about 2 KB, a classic script). Load `packages/extension/dist` unpacked in `chrome://extensions`, and run `serve` with `--allow-extension <id>` |

Verification is part of done. A change is finished when `npm test` passes and you have
seen it pass.

## Conventions

- **Commits by an agent for the maintainer:** the maintainer's GitHub noreply address, never
  another account's email: GitHub credits a commit to whichever account holds its email.
- **Language:** TypeScript strict on Node ≥ 22.12, ESM, `module: NodeNext`. Relative
  imports carry `.js`.
- **Dependencies:** use npm (`npm install <pkg>`). Prefer a small `fetch` wrapper over a
  vendor SDK.
- **Time:** every function that compares dates takes `now: Date`. Tests pin `now` to
  `2026-11-02`, so the example repo doesn't rot.
- **Errors:** MCP tools return structured errors. Hidden and unknown page ids must
  produce the *same* not-found error.
- **Output:** stdout belongs to the MCP protocol when running `docsworth mcp`. Logs go to
  stderr.

## Architecture

- `src/core/`: the Apache-2.0 core.
  - schema, frontmatter, CODEOWNERS, SLA, repo loader, lint
  - BM25 search, gate, ACL, identity
  - GitHub client and the PR-only writes
  - the MCP server, and `serve/` (the same server over Streamable HTTP for the web app)
- `packages/ui/` and `packages/web/` (Apache-2.0, private, never published): the shared Preact
  components and MCP client, and the web app. Vite builds the app; `scripts/copy-web.mjs`
  copies it to `dist/web` by path, so core never imports `packages/`. Page markdown renders
  through commonmark.js in safe mode after the tree is rewritten (`packages/ui/src/markdown.ts`):
  never trust page text in the UI.
- `packages/extension/` (Apache-2.0, private, never published): the Chromium MV3 extension. The
  side panel and options page are extension pages that call `serve` with the shared client;
  the worker only opens the panel and leaves it a capture (keyed, per window, in
  `storage.session`); the Gmail content script may send one message, refused unless it's
  exactly a Gmail thread's context from Gmail's top frame (`src/contract.ts`). The token never
  goes to `storage.local`, which content scripts can read.
- **Docsworth pro** (`@docsworth-pro/pro`: mirror connectors, digest, reports, the SIEM
  audit sink, the benchmark) is a separate, proprietary package, not in this repo. The CLI
  finds it by package name at run time (`src/cli.ts`), offers it only `src/core/host.ts`,
  a listed facade, and refuses one built for another `HOST_API`. Raise `HOST_API` on any
  change to that contract. Core never imports pro (`test/layering.test.ts`), and
  `test/package.test.ts` checks the loader against stand-in pros.
- **Tools are declared once,** in `src/core/tool-registry.ts`: surface, write, the policy name
  each answers to, audit fields and returned ids. Policy, server and audit read it.
- **`docsworth serve`:** one KnowledgeService per MCP session, so taint is per tab; the
  `ui_*` tools exist only on HTTP sessions. Host, Origin and the bearer token are checked
  on every request. A cleanup hook goes on the audited transport, not the HTTP one: the
  audit wrapper takes over the inner `onclose`.
- **Every read path goes through `visiblePages(identity)`.** The ACL is applied before
  search, list, stale, read and writes, never after.
- **Writes:** resolve the id → owner check → GET the file at default → create the ref
  `docsworth/<verb>/…` → PUT with an explicit branch → open the PR.
- **Audit:** recorded at the JSON-RPC boundary (`src/core/mcp/audit-transport.ts`), not in
  tool handlers. Write tools log their intent before they run. Events take page ids only
  from the final, ACL-filtered response.
- `docs/format-spec.md` is the public contract.

## Do not touch

- `examples/acme/` dates and the coverage hand count in `test/coverage.test.ts`. They
  move together. Changing one without the other makes the 2% check meaningless.
- Test files, while fixing the bug they catch. Fix the code.

## Recurring mistakes

- A refusal test that only asserts "it throws" can pass through a different, later
  refusal. That happened with hidden-id errors that compared messages but not codes.
  → Assert the specific message *and* code, and prove the test by deleting the guard it
  names.
- `live:quickstart` and `live:skills` run a real `claude -p`, which loads the operator's
  own `~/.claude` configuration and global `CLAUDE.md`. A run that wanders into the
  operator's workflow (for example a review gate) is environmental. Read the denial list
  in the output before blaming the skill.
- A check that reads a tool's output passed on nothing, twice, in the packed tests. npm
  writes its HTTP log to stderr, not stdout. And npm 11 logs reading a local tarball, but
  npm 10.9 (CI's, with Node 22.12) doesn't. → Give such a check a positive control that
  every version and cache state produces, and run the packed tests under CI's npm before
  pushing: `npm i -g --prefix <dir> npm@10.9.0`, then put `<dir>/bin` first on `PATH`.

## Review

The review policy for this repo is in [REVIEW.md](./REVIEW.md).
