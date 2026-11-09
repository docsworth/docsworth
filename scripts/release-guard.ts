// Refuses a release tag that can't be published as ours. The release workflow runs it
// before anything else; a person can run it before tagging:
//   npx tsx scripts/release-guard.ts v0.2.0 [--tarball <package.tgz>]
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
};

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
  return out;
}

/**
 * The packed tarball's own manifest: what npm publishes, which a pack script could have
 * changed. Its name and version must be what the guard checked.
 */
export function tarballProblems(manifest: { name?: string; version?: string }, name: string, version: string): string[] {
  const out: string[] = [];
  if (manifest.name !== name) out.push(`the tarball's package.json names ${manifest.name}, not ${name}`);
  if (manifest.version !== version) out.push(`the tarball's version is ${manifest.version}, not ${version}`);
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
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string };
  const plugin = JSON.parse(readFileSync(join(root, "plugin/.claude-plugin/plugin.json"), "utf8")) as { version: string };
  const problems = releaseProblems({
    tag,
    name: pkg.name,
    version: pkg.version,
    codeVersion: PACKAGE_VERSION,
    pluginVersion: plugin.version,
    published: PUBLISHED_PACKAGE,
    notes: existsSync(join(root, "docs/release-notes", `${tag}.md`)),
  });
  // `--tarball <file>`: and the packed artifact is the package that was checked.
  const at = process.argv.indexOf("--tarball");
  if (at > 0) {
    const manifest = JSON.parse(execFileSync("tar", ["-xOzf", process.argv[at + 1]!, "package/package.json"], { encoding: "utf8" })) as { name?: string; version?: string };
    problems.push(...tarballProblems(manifest, pkg.name, pkg.version));
  }
  for (const p of problems) console.log(`REFUSED  ${p}`);
  console.log(problems.length ? `\n${tag} can't be released` : `${tag} can be released as ${PUBLISHED_PACKAGE}`);
  process.exit(problems.length ? 1 : 0);
}
