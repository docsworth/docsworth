import { lstatSync, readFileSync, realpathSync, type Stats, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMap, isScalar, parseDocument } from "yaml";
import { hardLinked, repoPaths, symlinkReason, walk, within } from "./adopt.js";
import { formatDate, utcToday } from "./duration.js";
import { applyEdits, type Edit } from "./edits.js";
import { UserError } from "./errors.js";
import { frontmatterSpan, splitFrontmatter } from "./frontmatter.js";
import { validateFrontmatter } from "./schema.js";

// `docsworth verify <path…>`: a team's verification of its pages, in the working tree. A draft
// or canonical page becomes canonical with today's `last_verified`, each value replaced where
// it's written, so nothing else on the page moves. The PR the team reviews is the safeguard,
// as with editing `last_verified` by hand.

export class VerifyError extends UserError {}

export interface VerifyResult {
  dryRun: boolean;
  /** Pages verify changed (or would, on a dry run). */
  verified: string[];
  /** Pages already canonical and verified today. */
  unchanged: string[];
  /** Pages, and symbolic links, it left as they are, and why. */
  left: { path: string; reason: string }[];
}

export function verifyPages(root: string, paths: string[], opts: { now: Date; dryRun?: boolean }): VerifyResult {
  if (!paths.length) throw new VerifyError("name the pages to verify: a page, or a directory of them");
  const { repo, config, knowledge } = repoPaths(root, VerifyError, "verify");
  const rel = (abs: string) => relative(repo, abs).split(sep).join("/");

  // R9: each path, by real path, under the knowledge root; a directory walked as adopt walks it.
  const found = { files: [] as string[], symlinks: [] as string[] };
  for (const p of paths) {
    const abs = resolve(root, p);
    // The entry itself, not where a link leads: a dangling link is still a link.
    let entry: Stats;
    try {
      entry = lstatSync(abs);
    } catch {
      throw new VerifyError(`${p}: no such file or directory`);
    }
    const located = join(realpathSync(dirname(abs)), basename(abs));
    if (!within(knowledge, located)) throw new VerifyError(`${p} is outside the knowledge root (${config.knowledge_root}); verify changes only pages there`);
    if (entry.isSymbolicLink()) {
      found.symlinks.push(located);
      continue;
    }
    const real = realpathSync(abs);
    if (!within(knowledge, real)) throw new VerifyError(`${p} is outside the knowledge root (${config.knowledge_root}); verify changes only pages there`);
    if (statSync(real).isDirectory()) walk(real, found);
    else if (real.endsWith(".md")) found.files.push(real);
    else throw new VerifyError(`${p} isn't a page (a .md file) or a directory of them`);
  }

  const today = formatDate(utcToday(opts.now));
  const result: VerifyResult = { dryRun: opts.dryRun === true, verified: [], unchanged: [], left: [] };
  for (const abs of new Set(found.symlinks)) result.left.push({ path: rel(abs), reason: symlinkReason("verify") });
  const writes: { abs: string; text: string }[] = [];
  for (const abs of [...new Set(found.files)].sort((a, b) => rel(a).localeCompare(rel(b)))) {
    const path = rel(abs);
    const shared = hardLinked(abs, "verify");
    const text = readFileSync(abs, "utf8");
    const out = shared ? { reason: shared } : verified(text, today);
    if ("reason" in out) result.left.push({ path, reason: out.reason });
    else if (out.text === text) result.unchanged.push(path);
    else {
      writes.push({ abs, text: out.text });
      result.verified.push(path);
    }
  }

  if (!opts.dryRun) {
    // Each was found by real path; checked again before the first write. (Defense in depth.)
    for (const w of writes) {
      if (!lstatSync(w.abs).isFile() || lstatSync(w.abs).nlink > 1 || !within(knowledge, realpathSync(w.abs))) throw new VerifyError(`${rel(w.abs)} changed while verify ran; nothing written`);
    }
    for (const w of writes) writeFileSync(w.abs, w.text);
  }
  return result;
}

/** The page's text with `status: canonical` and `last_verified: today`, each written over its value; or why not. */
function verified(text: string, today: string): { text: string } | { reason: string } {
  const doc = splitFrontmatter(text);
  const span = frontmatterSpan(text);
  if (!doc.data || !span) return { reason: `its frontmatter doesn't parse: ${doc.error}` };
  const yaml = parseDocument(text.slice(span.start, span.end));
  if (!isMap(yaml.contents) || yaml.contents.flow) return { reason: "its frontmatter is a flow mapping (`{…}`); verify edits a block mapping only" };
  const valid = validateFrontmatter(doc.data);
  if (!valid.ok) return { reason: `it isn't a valid page (${valid.issues.map((i) => i.message).join("; ")}): run \`docsworth adopt\`, or fix it by hand` };
  if (valid.value.status === "deprecated") return { reason: "it's deprecated: verify doesn't make it citable again" };

  const want = { status: "canonical", last_verified: today };
  const edits: Edit[] = [];
  for (const [key, value] of Object.entries(want)) {
    const node: unknown = yaml.contents.get(key, true);
    if (!isScalar(node) || !node.range) return { reason: `its \`${key}\` isn't a plain value verify can write over: set it by hand` };
    if (node.value !== value) edits.push({ start: span.start + node.range[0], end: span.start + node.range[1], insert: value });
  }
  const next = applyEdits(text, edits);
  // The page must read as it did, but for the two values.
  const after = splitFrontmatter(next);
  if (!after.data || after.body !== doc.body || !isDeepStrictEqual(after.data, { ...doc.data, ...want }))
    return { reason: "writing the two values would change what the page's other keys say: set them by hand" };
  return { text: next };
}
