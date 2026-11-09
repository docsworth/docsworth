// Minimal .env loader for the live checks (no dependency). Values never get printed.
import { existsSync, readFileSync } from "node:fs";

export function loadEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    const value = m[2]!.replace(/^(["'])(.*)\1$/, "$2");
    if (value && process.env[m[1]!] === undefined) process.env[m[1]!] = value;
  }
}

/**
 * The scratch repo the live checks open PRs on: DOCSWORTH_LIVE_GITHUB_REPO, never a default,
 * since they write to it. Skips the check without one.
 */
export function scratchRepo(): string {
  loadEnv();
  const repo = process.env.DOCSWORTH_LIVE_GITHUB_REPO;
  if (!repo || repo === "your-org/your-scratch-repo") {
    console.log("SKIPPED: no scratch repo (set DOCSWORTH_LIVE_GITHUB_REPO to a repo the token can write)");
    process.exit(0);
  }
  return repo;
}

/** Returns the missing variable names, after loading .env. */
export function missing(...names: string[]): string[] {
  loadEnv();
  return names.filter((n) => !process.env[n] || /your-site\.atlassian\.net/.test(process.env[n]!));
}

let failures = 0;
export function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
export function done(): void {
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exitCode = failures ? 1 : 0;
}
