// Refuses a release tag that can't be published as ours. The release workflow runs it
// before anything else; a person can run it before tagging:
//   npx tsx scripts/release-guard.ts v0.3.2 [--tarball <package.tgz>]
// It prints every problem and exits 1 if there is one.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedPackage, PACKAGE_NAME, PACKAGE_VERSION, PUBLISHED_PACKAGE } from "../src/core/version.js";

export type ReleaseState = {
  tag: string;
  name: string;
  version: string;
  codeVersion: string;
  pluginVersion: string;
  published: string | null;
  notes: boolean;
  /** package.json's mcpName: the MCP registry reads it from npm to accept the listing. */
  mcpName: string | undefined;
  /** server.json, the MCP registry listing; null when there's none. */
  server: McpListing | null;
};

/** The parts of server.json (the MCP registry's listing) that must agree with package.json. */
export type McpListing = { name?: string; version?: string; packages?: readonly { registryType?: string; identifier?: string; version?: string }[] };

/** Every reason this tag can't be released; empty when it can. */
export function releaseProblems(s: ReleaseState): string[] {
  const out: string[] = [];
  if (s.tag !== `v${s.version}`) out.push(`the tag ${s.tag} isn't v${s.version}, the version in package.json`);
  // A prerelease isn't in a `^`/`~` range as npm resolves it, and isn't published here.
  if (!/^\d+\.\d+\.\d+$/.test(s.version)) out.push(`${s.version} isn't a plain major.minor.patch version; this workflow publishes releases, not prereleases`);
  if (s.codeVersion !== s.version) out.push(`PACKAGE_VERSION (${s.codeVersion}) isn't package.json's ${s.version}`);
  if (s.pluginVersion !== s.version) out.push(`the plugin's version (${s.pluginVersion}) isn't package.json's ${s.version}`);
  if (s.name !== PACKAGE_NAME) out.push(`package.json names ${s.name}, not ${PACKAGE_NAME}, the package we publish`);
  if (s.published === null) out.push("PUBLISHED_PACKAGE is null: set it to this package and its range first (docs/releasing.md)");
  else if (!ownedPackage(s.published)) out.push(`PUBLISHED_PACKAGE (${s.published}) isn't a package we own with a range`);
  else {
    const at = s.published.lastIndexOf("@");
    const [name, range] = [s.published.slice(0, at), s.published.slice(at + 1)];
    if (name !== s.name) out.push(`PUBLISHED_PACKAGE names ${name}, but package.json is ${s.name}`);
    if (!inRange(s.version, range)) out.push(`${s.version} isn't in PUBLISHED_PACKAGE's range ${range}, so installs wouldn't get it`);
  }
  if (!s.notes) out.push(`there are no release notes at docs/release-notes/${s.tag}.md`);
  out.push(...listingProblems(s));
  return out;
}

/**
 * The MCP registry listing: the registry accepts it only when the npm package it installs
 * carries the listing's name as mcpName, so both, and the versions, move with the release.
 */
function listingProblems(s: ReleaseState): string[] {
  if (!s.server) return ["there's no server.json, the MCP registry listing"];
  const out: string[] = [];
  if (!s.mcpName) out.push(`package.json has no mcpName; the MCP registry needs it to be server.json's name, ${s.server.name}`);
  else if (s.server.name !== s.mcpName) out.push(`server.json names ${s.server.name}, but package.json's mcpName is ${s.mcpName}`);
  if (s.server.version !== s.version) out.push(`server.json's version (${s.server.version}) isn't package.json's ${s.version}`);
  const npm = (s.server.packages ?? []).find((p) => p.registryType === "npm" && p.identifier === s.name);
  if (!npm) out.push(`server.json lists no npm package ${s.name}`);
  else if (npm.version !== s.version) out.push(`server.json installs ${s.name} ${npm.version}, not package.json's ${s.version}`);
  return out;
}

/**
 * The packed tarball's own manifest: what npm publishes, which a pack script could have
 * changed. Its name and version must be what the guard checked.
 */
export function tarballProblems(manifest: { name?: string; version?: string; mcpName?: string }, name: string, version: string, mcpName: string | undefined): string[] {
  const out: string[] = [];
  if (manifest.name !== name) out.push(`the tarball's package.json names ${manifest.name}, not ${name}`);
  if (manifest.version !== version) out.push(`the tarball's version is ${manifest.version}, not ${version}`);
  if (manifest.mcpName !== mcpName) out.push(`the tarball's package.json has mcpName ${manifest.mcpName}, not ${mcpName}, so the MCP registry would refuse the listing`);
  return out;
}

/** `^0.2`, `~1.4`, `1.2.3`, `0.2.x`: enough of semver for the ranges PUBLISHED_PACKAGE allows. */
export function inRange(version: string, range: string): boolean {
  const v = version.split("-")[0]!.split(".").map(Number);
  const op = range[0] === "^" || range[0] === "~" ? range[0] : "";
  const r = range.slice(op.length).split("-")[0]!.split(".").map((p) => (p === "x" ? null : Number(p)));
  // At least the range's own version (missing or x parts count as 0).
  const low = [0, 1, 2].map((k) => r[k] ?? 0);
  for (let k = 0; k < 3; k++) {
    if ((v[k] ?? 0) > low[k]!) break;
    if ((v[k] ?? 0) < low[k]!) return false;
  }
  // And the parts that must stay: all given (up to an x) for an exact range, major and
  // minor for ~, up to the first non-zero part for ^.
  const x = r.indexOf(null);
  const nonZero = r.findIndex((p) => p !== null && p !== 0);
  const keep = op === "" ? (x < 0 ? r.length : x) : op === "~" ? Math.min(r.length, 2) : nonZero < 0 ? r.length : nonZero + 1;
  for (let k = 0; k < keep; k++) if (r[k] !== null && v[k] !== r[k]) return false;
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = resolve(import.meta.dirname, "..");
  const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "";
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string; mcpName?: string };
  const serverFile = join(root, "server.json");
  const plugin = JSON.parse(readFileSync(join(root, "plugin/.claude-plugin/plugin.json"), "utf8")) as { version: string };
  const problems = releaseProblems({
    tag,
    name: pkg.name,
    version: pkg.version,
    codeVersion: PACKAGE_VERSION,
    pluginVersion: plugin.version,
    published: PUBLISHED_PACKAGE,
    notes: existsSync(join(root, "docs/release-notes", `${tag}.md`)),
    mcpName: pkg.mcpName,
    server: existsSync(serverFile) ? (JSON.parse(readFileSync(serverFile, "utf8")) as McpListing) : null,
  });
  // `--tarball <file>`: and the packed artifact is the package that was checked.
  const at = process.argv.indexOf("--tarball");
  if (at > 0) {
    const manifest = JSON.parse(execFileSync("tar", ["-xOzf", process.argv[at + 1]!, "package/package.json"], { encoding: "utf8" })) as { name?: string; version?: string; mcpName?: string };
    problems.push(...tarballProblems(manifest, pkg.name, pkg.version, pkg.mcpName));
  }
  for (const p of problems) console.log(`REFUSED  ${p}`);
  console.log(problems.length ? `\n${tag} can't be released` : `${tag} can be released as ${PUBLISHED_PACKAGE}`);
  process.exit(problems.length ? 1 : 0);
}
