/** Format version of the knowledge repo contract in docs/format-spec.md. */
export const FORMAT_VERSION = 1;
export const PACKAGE_VERSION = "0.2.0";

/**
 * The npm package Docsworth is published as, with its version range: what `docsworth init
 * --ci` writes into a workflow, and what the plugin launcher runs without DOCSWORTH_BIN.
 * The `@docsworth` scope is ours on npm (the org `docsworth`). Another publisher owns
 * `agent-kb` (and `akb`), our old names, and nobody owns the bare `docsworth`, so nothing
 * may fetch any of those. PUBLISHED_PACKAGE in plugin/bin/docsworth-mcp.mjs is kept equal
 * by a test, and scripts/release-guard.ts refuses a release outside its range.
 */
export const PUBLISHED_PACKAGE = "@docsworth/cli@^0.2";

/** The one package we publish (release checklist, decision 1): a release of any other name is refused. */
export const PACKAGE_NAME = "@docsworth/cli";

/**
 * Names on npm that aren't ours, never to fetch or publish: other publishers own `agent-kb`
 * and `akb`, and nobody owns the bare `docsworth` (2026-11-07), so whoever publishes it first
 * decides what it runs.
 */
export const UNOWNED_PACKAGES = ["agent-kb", "akb", "docsworth"];

/**
 * A registry package and a semver range, nothing else: `@scope/name@^0.2`, `name@1.2.3`.
 * No aliases (`x@npm:agent-kb`), URLs, git or file specs, tags, or shell characters
 * (`*` included: unquoted, a repo's filenames could glob-expand it),
 * since this goes unquoted into a workflow that runs with a token that can push.
 */
const PACKAGE_SPEC = /^(@[a-z0-9][a-z0-9._-]*\/)?([a-z0-9][a-z0-9._-]*)@([\^~]?\d+(?:\.(?:\d+|x)){0,2}(?:-[0-9a-z.]+)?)$/;

/** Whether a spec is a plain registry package with a range, and not a name we don't own. */
export function ownedPackage(spec: string): boolean {
  const m = PACKAGE_SPEC.exec(spec);
  return Boolean(m) && !UNOWNED_PACKAGES.includes(`${m![1] ?? ""}${m![2]}`);
}
