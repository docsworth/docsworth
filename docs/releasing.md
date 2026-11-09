# Releasing

A release is a `v<major>.<minor>.<patch>` tag on `main`. `.github/workflows/release.yml`
publishes `@docsworth/cli` to npm with provenance, and attaches the tarball and its SBOM
to a GitHub release.

## Before tagging

1. Bump the version in `package.json` (and the lockfile), `PACKAGE_VERSION` in
   `src/core/version.ts`, `plugin/.claude-plugin/plugin.json` and
   `.claude-plugin/marketplace.json`. If the version leaves the range in
   `PUBLISHED_PACKAGE` (`src/core/version.ts` and `plugin/bin/docsworth-mcp.mjs`, which a
   test keeps equal), move the range too: the plugin and `docsworth init --ci` fetch it.
2. Write the release notes, `docs/release-notes/v<version>.md`.
3. Run the guard. It prints `v<version> can be released as …`, or a `REFUSED` line for
   each disagreement:

   ```bash
   npx tsx scripts/release-guard.ts v<version>
   ```

4. Merge to `main`, then push the tag.

## What the workflow checks

- **Before anything is installed**, with Node alone: the tag is on `main`, is a plain
  release version, and matches `package.json`; the package is `@docsworth/cli`; the
  release notes exist. Then the release guard.
- **`verify`** has read access only. It runs the suite and the production-dependency
  audit, packs exactly one tarball, checks that tarball's own manifest, and installs it as
  a customer would.
- **`publish`** holds the release rights and the npm token, and runs no install or
  project code. It re-checks that the tarball is the bytes `verify` checked, then runs
  `npm publish --ignore-scripts --provenance`.
- **Both can run again** after a partial release. A version already on npm is left alone
  if it's this very tarball, and refused otherwise. An existing GitHub release has its
  assets replaced.

## Repository setup, once

A tag runs the workflow file of the commit it points at, so a check in that file can't
stop a tag whose workflow was edited. These can:

- the npm org `docsworth`, and a publish-only granular token for `@docsworth/cli`, stored
  as the `NPM_TOKEN` secret of the `release` environment
- required reviewers on the `release` environment, so a person approves every publish
- a tag ruleset on `v*`, so only maintainers create release tags

npm checks provenance against `package.json`'s `repository`, so it must name this repo.

## Docsworth pro

Pro is released from its own repository. It pins the exact CLI version it was built for,
and the CLI refuses a pro built for another `HOST_API`. A release that changes the
contract in `src/core/host.ts` raises `HOST_API`, and pro releases against it.
