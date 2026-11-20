import { spawnSync } from "node:child_process";

/** Variables that would send git to another repo or change how it reads pathspecs: never passed to it. */
const GIT_REDIRECTS = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|LITERAL_PATHSPECS|GLOB_PATHSPECS|NOGLOB_PATHSPECS|ICASE_PATHSPECS)$/;

/** git, run in `cwd` and nowhere else. */
export function gitAt(cwd: string, args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !GIT_REDIRECTS.test(k)));
  return spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env, maxBuffer: 1 << 28 });
}

/**
 * True only when `dir` is in a git repository with no remote: a change there lands as a
 * commit, since there's nowhere to open a pull request. Anything git can't answer is false.
 */
export function localOnlyRepo(dir: string): boolean {
  const inside = gitAt(dir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return false;
  const remotes = gitAt(dir, ["remote"]);
  return remotes.status === 0 && remotes.stdout.trim() === "";
}
