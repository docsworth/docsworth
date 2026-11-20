import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type Node, Parser } from "commonmark";
import { Document, isMap, isSeq, parse as parseYaml, parseDocument, stringify } from "yaml";
import { type Codeowners, describeOwnershipProblem, loadCodeowners, parseCodeowners, resolveTeamOwner } from "./codeowners.js";
import { CONFIG_PATH, type Config, ConfigSchema, loadConfig } from "./config.js";
import { DURATION_RE, formatDate, utcToday } from "./duration.js";
import { applyEdits, type Edit } from "./edits.js";
import { UserError } from "./errors.js";
import { gitAt } from "./git.js";
import { frontmatterSpan, splitFrontmatter } from "./frontmatter.js";
import { EXTERNAL, isAttachment, isCategoryIndex, type LinkSpan, linkFault, linkPath, linkSpans, pageLinks, readDestination, routePages, servedFrom, shownPath, siteRoute, unprefixed } from "./links.js";

export { unprefixed };
import { ID_RE, OPTIONAL_FIELDS, type PageType, REQUIRED_FIELDS, SLUG_RE, validateFrontmatter } from "./schema.js";

// `docsworth adopt`: give existing markdown docs the frontmatter Docsworth needs, and turn
// their route links into links to page files, in the working tree only. A page's id is its
// own, else its file name, so a Docusaurus site's URLs don't move. Pages are drafts until a
// team verifies them. A page adopt can't settle is left byte for byte, and reported.

export class AdoptError extends UserError {}

export interface AdoptOptions {
  now: Date;
  /** The owning team where CODEOWNERS doesn't name exactly one. */
  team?: string;
  /** `review_every` for pages without one (default 90d). */
  reviewEvery?: string;
  /** Report, and write nothing. */
  dryRun?: boolean;
  /** Git repos the pages were copied from (`--dates-from`): a page adopt dates gets the newest commit there with its content. */
  datesFrom?: string[];
}

export interface AdoptResult {
  dryRun: boolean;
  /** Pages adopt changed (or would, on a dry run). */
  adopted: string[];
  /** Pages it had nothing to change on. */
  unchanged: string[];
  /** Pages, and symbolic links, it left as they are, and why. */
  left: { path: string; reason: string }[];
  /** What the team still has to do: a CODEOWNERS line, say. */
  hints: string[];
  /** Route links rewritten to relative `.md` links (R2). */
  linksRewritten: number;
  /** Links lint fails that adopt couldn't rewrite, as written, and why. */
  linksLeft: { path: string; link: string; why: string }[];
  /** With `--dates-from` only: how many adopted pages each repo dated (every source listed, then this repo's own history if it dated any). */
  datedFrom?: { repo: string; pages: number }[];
  /** With `--dates-from` only: adopted pages no commit had the content of, dated today. */
  datedToday?: string[];
  /** Keys added to the config's `frontmatter.extra_fields`: the adopted pages' unknown keys (R3). */
  extraFields: string[];
}

/** The repo, its config and its knowledge root, by real path, each checked to be inside the repo (R9). */
export interface RepoPaths {
  repo: string;
  config: Config;
  configPath: string;
  knowledge: string;
}

/** Whether `child` is `parent` or under it, by path components (so `/repo-other` isn't under `/repo`). */
export function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** R9's checks, before any page is read: the config and the knowledge root are inside the repo. */
export function repoPaths(root: string, Err: new (m: string) => Error = AdoptError, verb = "adopt"): RepoPaths {
  let repo: string;
  try {
    repo = realpathSync(root);
  } catch {
    throw new Err(`no directory at ${root}`);
  }
  const configAbs = join(repo, CONFIG_PATH);
  const configPath = existsSync(configAbs) ? realpathSync(configAbs) : configAbs;
  if (!within(repo, configPath)) throw new Err(`${CONFIG_PATH} leads outside the repo (to ${configPath}); ${verb} writes only inside it`);
  const config = loadConfig(repo);
  const knowledgeAbs = join(repo, config.knowledge_root);
  const knowledge = existsSync(knowledgeAbs) ? realpathSync(knowledgeAbs) : knowledgeAbs;
  if (!within(repo, knowledge)) throw new Err(`knowledge_root \`${config.knowledge_root}\` is outside the repo; ${verb} writes only inside it`);
  if (!existsSync(knowledge) || !statSync(knowledge).isDirectory())
    throw new Err(`no knowledge root at ${config.knowledge_root} (knowledge_root in ${CONFIG_PATH})`);
  // The loader names pages by the path it was given, CODEOWNERS and git by the real one: a
  // link between them would give one page two names.
  if (knowledge !== resolve(repo, config.knowledge_root))
    throw new Err(`knowledge_root \`${config.knowledge_root}\` is a symbolic link, or under one (to ${knowledge}); set knowledge_root to the directory itself`);
  // A config linked to a file in the knowledge root would be walked, and written, as a page.
  if (within(knowledge, configPath)) throw new Err(`${CONFIG_PATH} is a file in the knowledge root (${configPath}), which ${verb} would read as a page; keep it outside`);
  return { repo, config, configPath, knowledge };
}

/**
 * Why a file with other hard links is left, or null: the other path could be anywhere,
 * outside the repo too, and a write here would change the file there (R9).
 */
export function hardLinked(abs: string, verb: string): string | null {
  const n = lstatSync(abs).nlink;
  return n > 1 ? `it has ${n} hard links: ${verb} writes no file another path shares` : null;
}

/** Why a symbolic link in the knowledge root is left. */
export const symlinkReason = (verb: string) => `a symbolic link: Docsworth reads no page through one, and ${verb} writes none`;

/**
 * The knowledge root's pages, as the loader finds them (directories starting with a dot
 * skipped), by real path. It follows no symbolic link: the loader reads none, and a link is
 * the one way a walk could leave the root (R9). A link that names a page or a directory is
 * reported.
 */
export function walk(dir: string, out: { files: string[]; symlinks: string[] }) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    if (e.isSymbolicLink()) {
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        /* a dangling link names nothing */
      }
      if (isDir || e.name.endsWith(".md")) out.symlinks.push(abs);
    } else if (e.isDirectory()) {
      if (!e.name.startsWith(".")) walk(abs, out);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.files.push(abs);
    }
  }
}

const TYPE_DIRS = new Map<string, PageType>([
  ["runbooks", "runbook"],
  ["decisions", "adr"],
  ["adr", "adr"],
  ["services", "service"],
  ["policies", "policy"],
]);

/** A page's type from its closest directory that names one, else `guide`. */
function typeFor(dirs: string[]): PageType {
  for (const d of [...dirs].reverse()) {
    const t = TYPE_DIRS.get(d.toLowerCase());
    if (t) return t;
  }
  return "guide";
}

/** A heading's text and code, its line breaks as spaces (a setext heading can run over lines). */
function headingText(node: Node): string {
  let out = "";
  const walker = node.walker();
  for (let e = walker.next(); e; e = walker.next()) {
    if (!e.entering) continue;
    if (e.node.type === "text" || e.node.type === "code") out += e.node.literal ?? "";
    else if (e.node.type === "softbreak" || e.node.type === "linebreak") out += " ";
  }
  return out;
}

/** The text of the first level-one heading (ATX or setext) outside code, as CommonMark reads it. */
function firstHeading(body: string): string | null {
  const walker = new Parser().parse(body).walker();
  for (let e = walker.next(); e; e = walker.next()) {
    if (e.entering && e.node.type === "heading" && e.node.level === 1) {
      const text = headingText(e.node).replace(/\s+/g, " ").trim();
      if (text) return text;
    }
  }
  return null;
}

/** Each file's last commit date (author, YYYY-MM-DD), by repo-relative path; empty outside git. */
function lastCommitDates(repo: string, knowledgeRel: string): Map<string, string> {
  const out = new Map<string, string>();
  // --literal-pathspecs: the root is a path, whatever it's called (`:(attr:x)kb` is pathspec magic).
  const r = spawnSync("git", ["-C", repo, "--literal-pathspecs", "log", "--format=%x00dwdate:%as", "--name-only", "-z", "--relative", "--", knowledgeRel], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return out;
  let date = "";
  for (const token of r.stdout.split("\0")) {
    if (token.startsWith("dwdate:")) date = token.slice("dwdate:".length);
    else if (token) {
      const path = token.replace(/^\n/, "");
      if (!out.has(path)) out.set(path, date);
    }
  }
  return out;
}

// `--dates-from`: copied pages dated by content, from other repos' history.

/** Each markdown blob a repo's HEAD history introduced, by object id, to the greatest author date among the commits that did. */
export interface ContentIndex {
  repo: string;
  format: "sha1" | "sha256";
  dates: Map<string, string>;
}

/** A repo's top level, object format and content index; `null` when `dir` isn't in a git repo with commits. */
function contentIndex(dir: string): ContentIndex | { refused: string } {
  const top = gitAt(dir, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0 || !top.stdout.trim()) return { refused: "isn't a git repository" };
  const repo = realpathSync(top.stdout.trim());
  if (gitAt(repo, ["rev-parse", "--verify", "--quiet", "HEAD"]).status !== 0) return { refused: "has no commits to date pages from" };
  const format = gitAt(repo, ["rev-parse", "--show-object-format"]).stdout.trim();
  if (format !== "sha1" && format !== "sha256") return { refused: `uses an object format adopt doesn't read (\`${format}\`)` };
  // --root: log.showRoot=false would hide the first commit's files. --full-history: with a pathspec,
  // git otherwise drops a merged branch's commits when the merge's tree equals one parent's.
  const log = gitAt(repo, ["-c", "log.showSignature=false", "log", "-z", "--root", "--full-history", "--no-renames", "--raw", "--no-abbrev", "--format=dwdate:%as", "HEAD", "--", ":(glob)**/*.md", ":(glob)**/*.mdx"]);
  if (log.error || log.status !== 0) return { refused: `has a history adopt couldn't read (${log.error?.message ?? log.stderr.trim().split("\n")[0]})` };
  const dates = new Map<string, string>();
  let date = "";
  let pathNext = false;
  for (const raw of log.stdout.split("\0")) {
    const token = raw.replace(/^\n/, "");
    if (pathNext) {
      pathNext = false; // the path of the entry just read: not needed
      continue;
    }
    if (token.startsWith("dwdate:")) {
      date = token.slice("dwdate:".length);
      continue;
    }
    const entry = /^:\d{6} \d{6} ([0-9a-f]+) ([0-9a-f]+) [A-Z]\d*$/.exec(token);
    if (!entry) continue;
    pathNext = true;
    const [, before, blob] = entry as unknown as [string, string, string];
    // The same blob on both sides is a mode change (chmod), not new content.
    if (before === blob) continue;
    // A maximum, not the first seen: rebases and backdated commits put author dates out of walk order.
    if (!/^0+$/.test(blob) && date > (dates.get(blob) ?? "")) dates.set(blob, date);
  }
  return { repo, format, dates };
}

/** A file's git blob ids in `format`: of its bytes, and of them with CRLF as LF, as git stores text under `eol`/`autocrlf`. */
function blobIds(bytes: Buffer, format: ContentIndex["format"]): string[] {
  const id = (b: Buffer) => createHash(format).update(`blob ${b.length}\0`).update(b).digest("hex");
  if (!bytes.includes(13)) return [id(bytes)];
  return [id(bytes), id(Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1"))];
}

/** The newest date any of the page's blob ids has in `index`, or "". */
function newestIn(index: ContentIndex, bytes: Buffer): string {
  let best = "";
  for (const id of blobIds(bytes, index.format)) {
    const d = index.dates.get(id);
    if (d && d > best) best = d;
  }
  return best;
}

/** A YAML scalar for one field. Title and id are quoted where Docusaurus's YAML 1.1 would read a date or a boolean. */
function scalar(value: string, docusaurusString: boolean): string {
  const plain = stringify(value, { lineWidth: 0 }).trimEnd();
  if (docusaurusString && parseYaml(plain, { schema: "yaml-1.1" }) !== value) return JSON.stringify(value);
  return plain;
}

type Field = (typeof REQUIRED_FIELDS)[number];
const KNOWN_FIELDS = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);

/**
 * The config with `keys` added to `frontmatter.extra_fields`, its comments and everything else
 * byte for byte; or why not: YAML wouldn't write it back as it was, or the result wouldn't be
 * a config that loads, the same but for those keys.
 */
function withExtraFields(text: string, keys: string[]): { text: string } | { why: string } {
  const doc = parseDocument(text);
  const cannot = { why: "adopt couldn't add them and keep a config that loads, the same but for them" };
  let next: string;
  if (!doc.errors.length && doc.toString({ lineWidth: 0 }) === text) {
    try {
      const list = doc.getIn(["frontmatter", "extra_fields"]);
      if (isSeq(list)) for (const k of keys) list.add(doc.createNode(k));
      else doc.setIn(["frontmatter", "extra_fields"], doc.createNode(keys));
    } catch {
      return cannot; // `frontmatter:` holding something other than a mapping
    }
    next = doc.toString({ lineWidth: 0 });
  } else {
    // YAML would write it differently (a flow mapping inside, say): where the top level is a
    // block mapping without the key, the list goes after the last line, as text.
    if (doc.errors.length || !isMap(doc.contents) || doc.contents.flow || doc.has("frontmatter"))
      return { why: "YAML wouldn't write this config back byte for byte, and adopt can't append to it" };
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const lines = ["frontmatter:", "  extra_fields:", ...keys.map((k) => `    - ${stringify(k, { lineWidth: 0 }).trimEnd()}`)];
    next = `${text}${text === "" || text.endsWith("\n") ? "" : eol}${lines.join(eol)}${eol}`;
  }
  const was = parseYaml(text, { schema: "core" }) as Record<string, Record<string, unknown> | undefined>;
  const want = { ...was, frontmatter: { ...was.frontmatter, extra_fields: [...((was.frontmatter?.extra_fields as string[] | undefined) ?? []), ...keys] } };
  let now: unknown;
  try {
    now = parseYaml(next, { schema: "core" });
  } catch {
    return cannot; // text appended after a document end (`...`), say
  }
  return isDeepStrictEqual(now, want) && ConfigSchema.safeParse(now).success ? { text: next } : cannot;
}

/** A page's line ending: its frontmatter's opening line's, else its first line's. */
function eol(text: string): "\n" | "\r\n" {
  return frontmatterSpan(text)?.eol ?? (/^[^\n]*\r\n/.test(text) ? "\r\n" : "\n");
}

interface Source {
  abs: string;
  path: string;
  /** Directories from the knowledge root down to the page. */
  dirs: string[];
  stem: string;
  /** A category index (Docusaurus routes it by its directory). */
  index: boolean;
  text: string;
  data: Record<string, unknown> | null;
  body: string;
  /** Why adopt can't add to it, found from the file alone. */
  problem?: string;
}

function read(abs: string, repo: string, knowledge: string): Source {
  const path = relative(repo, abs).split(sep).join("/");
  const parts = relative(knowledge, abs).split(sep);
  const stem = parts.pop()!.replace(/\.md$/, "");
  const text = readFileSync(abs, "utf8");
  const src = { abs, path, dirs: parts, stem, index: isCategoryIndex(stem, parts.at(-1)), text, data: null, body: text };
  const shared = hardLinked(abs, "adopt");
  if (shared) {
    // Never written, but its own id is still the page's: read it, for the count.
    const doc = splitFrontmatter(text);
    return { ...src, data: doc.data, body: doc.body, problem: shared };
  }
  if (text.startsWith("﻿")) return { ...src, problem: "it starts with a byte-order mark, which Docsworth doesn't read frontmatter past; remove it, then rerun adopt" };
  const doc = splitFrontmatter(text);
  if (!doc.data) {
    if (doc.error === "missing frontmatter block") return { ...src, data: {} };
    return { ...src, problem: `its frontmatter doesn't parse: ${doc.error}` };
  }
  const span = frontmatterSpan(text)!;
  const contents = parseDocument(text.slice(span.start, span.end)).contents;
  // The loader reads a flow mapping: its data stays, so its own id is counted, though it's left.
  if (!isMap(contents) || contents.flow) return { ...src, data: doc.data, body: doc.body, problem: "its frontmatter is a flow mapping (`{…}`); adopt adds fields to a block mapping only" };
  return { ...src, data: doc.data, body: doc.body };
}

/** Each page's id, or why it gets none: its own, else its file name, unique across the root. */
function assignIds(sources: Source[]): Map<Source, { id: string } | { problem: string }> {
  const out = new Map<Source, { id: string } | { problem: string }>();
  const holders = new Map<string, Source[]>(); // id → pages with it as their own
  const wanting = new Map<string, Source[]>(); // id → pages whose file name makes it
  const add = (m: Map<string, Source[]>, id: string, s: Source) => m.set(id, [...(m.get(id) ?? []), s]);
  // Docusaurus routes a page by its directories and its id, else its file name: a new id
  // moves it, unless a slug pins it where it is.
  const keep = (s: Source, baseId: string) => ` and, on a Docusaurus site, \`slug: /${[...s.dirs.map(unprefixed), baseId].join("/")}\` to keep its URL`;
  for (const s of sources) {
    if (!s.data) continue;
    if (s.problem) {
      // A page adopt leaves keeps its own id, if the loader can read one: no other page gets it.
      if (typeof s.data.id === "string" && ID_RE.test(s.data.id)) add(holders, s.data.id, s);
      continue;
    }
    if (s.data.id !== undefined) {
      if (typeof s.data.id === "string" && ID_RE.test(s.data.id)) add(holders, s.data.id, s);
      else out.set(s, { problem: `its id \`${String(s.data.id)}\` isn't a Docsworth id (lowercase letters, digits and dashes): set one by hand${keep(s, String(s.data.id))}` });
    } else if (s.index) {
      const route = s.dirs.map(unprefixed);
      const say = route.length ? route.join("-").toLowerCase().replace(/[^a-z0-9-]+/g, "-") : "index";
      out.set(s, {
        problem: `a category index: Docusaurus routes it by its directory, so it takes no id from its file name. Set an \`id\` by hand (say \`${say}\`) and, on a Docusaurus site, \`slug: /${route.join("/")}\` to keep its URL`,
      });
    } else {
      const id = unprefixed(s.stem);
      if (ID_RE.test(id)) add(wanting, id, s);
      else out.set(s, { problem: `its file name doesn't make an id (\`${id}\`: lowercase letters, digits and dashes only): set an \`id\` by hand${keep(s, id)}` });
    }
  }
  const others = (all: Source[], s: Source) => all.filter((o) => o !== s).map((o) => o.path).join(", ");
  for (const [id, pages] of holders) {
    for (const s of pages) out.set(s, pages.length === 1 ? { id } : { problem: `its id \`${id}\` is also on ${others(pages, s)}: set one by hand${keep(s, id)}` });
  }
  for (const [id, pages] of wanting) {
    const all = [...(holders.get(id) ?? []), ...pages];
    for (const s of pages) out.set(s, all.length === 1 ? { id } : { problem: `its file name makes the id \`${id}\`, which ${others(all, s)} has or would get too: set an \`id\` by hand${keep(s, id)}` });
  }
  return out;
}

export function adoptRepo(root: string, opts: AdoptOptions): AdoptResult {
  if (opts.team !== undefined && !SLUG_RE.test(opts.team))
    throw new AdoptError(`--team \`${opts.team}\` isn't a team slug (like \`platform\`: no @, no org)`);
  const reviewEvery = opts.reviewEvery ?? "90d";
  if (!DURATION_RE.test(reviewEvery)) throw new AdoptError(`--review-every \`${reviewEvery}\` isn't a period like 30d, 12w, 6m or 1y`);
  const { repo, config, configPath, knowledge } = repoPaths(root);
  const codeowners = loadCodeowners(repo);
  // --dates-from's sources, refused before any page is read: a wrong path changes no byte.
  const dating = opts.datesFrom?.length
    ? {
        sources: opts.datesFrom.map((dir) => {
          const index = contentIndex(resolve(dir));
          if ("refused" in index) throw new AdoptError(`--dates-from \`${dir}\` ${index.refused}`);
          return index;
        }),
        own: (() => {
          const index = contentIndex(repo);
          return "refused" in index ? null : index;
        })(),
        /** By page path: the index whose date it got, or "today". */
        by: new Map<string, ContentIndex | "today">(),
      }
    : null;

  const found = { files: [] as string[], symlinks: [] as string[] };
  walk(knowledge, found);
  const result: AdoptResult = { dryRun: opts.dryRun === true, adopted: [], unchanged: [], left: [], hints: [], linksRewritten: 0, linksLeft: [], extraFields: [] };
  const rel = (abs: string) => relative(repo, abs).split(sep).join("/");
  for (const abs of found.symlinks) result.left.push({ path: rel(abs), reason: symlinkReason("adopt") });

  const sources = found.files.sort().map((abs) => read(abs, repo, knowledge));
  const ids = assignIds(sources);
  const knowledgeRel = rel(knowledge);
  const dates = dating ? new Map<string, string>() : lastCommitDates(repo, knowledgeRel);
  const today = formatDate(utcToday(opts.now));
  const unowned = new Map<string, string[]>(); // CODEOWNERS problem → pages --team owns despite it
  const writes: { abs: string; text: string; inside: string }[] = [];
  const unknownKeys = new Set<string>();
  const leftDests: LeftLink[] = []; // the links left, with CommonMark's destination for each

  /**
   * A page's date. Without --dates-from, its last commit here by path, else today. With it, by
   * content: the newest commit with its bytes in a --dates-from repo (a copy committed here
   * mustn't beat its source), else in this repo's own history, else today.
   */
  const dateFor = (s: Source): string => {
    if (!dating) return dates.get(s.path) || today;
    const bytes = readFileSync(s.abs);
    let pick: { date: string; from: ContentIndex } | null = null;
    for (const index of dating.sources) {
      const date = newestIn(index, bytes);
      if (date && (!pick || date > pick.date)) pick = { date, from: index };
    }
    if (!pick && dating.own) {
      const date = newestIn(dating.own, bytes);
      if (date) pick = { date, from: dating.own };
    }
    dating.by.set(s.path, pick ? pick.from : "today");
    return pick ? pick.date : today;
  };

  /** The fields a page lacks, as lines to insert, and its frontmatter with them added; or why it gets none. */
  const addedFields = (s: Source, missing: Field[]): { lines: string; merged: Record<string, unknown>; ownerProblem?: string } | { problem: string } => {
    // A date adopt gave a page that says it's canonical would make it citable unverified (R5).
    if (s.data!.status === "canonical" && missing.includes("last_verified"))
      return { problem: "it says `status: canonical` but carries no `last_verified`, and adopt dates no verification it didn't see: set `status: draft`, or verify it by hand" };
    const id = ids.get(s)!;
    if ("problem" in id) return id;
    const owner = missing.includes("owner_team") ? ownerFor(s.path, codeowners, config, opts.team) : { team: String(s.data!.owner_team) };
    if (!("team" in owner)) return owner;
    const values: Record<Field, string> = {
      title: firstHeading(s.body) ?? s.stem,
      id: id.id,
      type: typeFor(s.dirs),
      status: "draft",
      owner_team: owner.team,
      last_verified: missing.includes("last_verified") ? dateFor(s) : "",
      review_every: reviewEvery,
    };
    const merged = { ...s.data, ...Object.fromEntries(missing.map((f) => [f, values[f]])) };
    const valid = validateFrontmatter(merged);
    if (!valid.ok) return { problem: `its own frontmatter isn't valid (${valid.issues.map((i) => i.message).join("; ")}); fix it, then rerun adopt` };
    const lines = missing.map((f) => `${f}: ${scalar(values[f], f === "title" || f === "id")}${eol(s.text)}`).join("");
    return { lines, merged, ownerProblem: "problem" in owner ? owner.problem : undefined };
  };

  /** A page with every field: adopt adds none, but leaves it alone if its id or values aren't valid. */
  const asItIs = (s: Source): { lines: ""; merged: Record<string, unknown>; ownerProblem?: undefined } | { problem: string } => {
    const id = ids.get(s);
    if (id && "problem" in id) return id;
    const valid = validateFrontmatter(s.data!);
    if (!valid.ok) return { problem: `its own frontmatter isn't valid (${valid.issues.map((i) => i.message).join("; ")}); fix it, then rerun adopt` };
    return { lines: "", merged: s.data! };
  };

  const links: LinkContext = { repo, knowledgeRel, pages: new Set(sources.map((s) => s.path)), byDir: new Map(), moved: new Set(), aliases: new Map(), staticDirs: config.static_dirs };
  for (const s of sources) {
    const dir = posix.dirname(s.path);
    links.byDir.set(dir, [...(links.byDir.get(dir) ?? []), s.path]);
    const route = siteRoute([...s.dirs, `${s.stem}.md`].join("/"), s.data?.slug, s.data?.id);
    if (route === null) continue;
    links.moved.add(s.path);
    links.aliases.set(route, [...(links.aliases.get(route) ?? []), s.path]);
  }

  for (const s of sources) {
    const leave = (reason: string) => result.left.push({ path: s.path, reason });
    if (s.problem || !s.data) {
      leave(s.problem!);
      continue;
    }
    const missing = REQUIRED_FIELDS.filter((f) => s.data![f] === undefined);
    const fields = missing.length ? addedFields(s, missing) : asItIs(s);
    if ("problem" in fields) {
      leave(fields.problem);
      continue;
    }
    const converted = convertLinks(s, links);
    result.linksLeft.push(...converted.left.map((l) => ({ path: s.path, link: l.link, why: l.why })));
    leftDests.push(...converted.left);
    if (!fields.lines && !converted.edits.length) {
      result.unchanged.push(s.path);
      continue;
    }

    const span = frontmatterSpan(s.text);
    const bodyStart = span?.bodyStart ?? 0;
    const edits: Edit[] = converted.edits.map((e) => ({ ...e, start: e.start + bodyStart, end: e.end + bodyStart }));
    if (fields.lines) edits.push(span ? { start: span.start, end: span.start, insert: fields.lines } : { start: 0, end: 0, insert: `---${eol(s.text)}${fields.lines}---${eol(s.text)}` });
    const next = applyEdits(s.text, edits);

    // The page's own keys must say what they said, and its body be what the link edits made it.
    const after = splitFrontmatter(next);
    if (!after.data || after.body !== applyEdits(s.body, converted.edits) || !isDeepStrictEqual(after.data, fields.merged)) {
      leave("adding fields to its frontmatter would change what the page's own keys say; add them by hand");
      continue;
    }
    writes.push({ abs: s.abs, text: next, inside: knowledge });
    result.adopted.push(s.path);
    for (const key of Object.keys(fields.merged)) if (!KNOWN_FIELDS.has(key)) unknownKeys.add(key);
    result.linksRewritten += converted.edits.length;
    if (fields.ownerProblem) unowned.set(fields.ownerProblem, [...(unowned.get(fields.ownerProblem) ?? []), s.path]);
  }

  // Root-relative files a docs site serves from a `static/` directory the config doesn't list.
  const fromStatic = new Map<string, number>();
  // Read as lint reads them, by CommonMark's destination (`\\/img/x.png` and `/img/x%2Epng` too).
  const candidates = leftDests.filter((l) => l.why === NAMES_NO_PAGE && l.dest.startsWith("/") && isAttachment(shownPath(linkPath(l.dest))));
  const dirs = candidates.length ? staticDirsIn(repo) : [];
  for (const l of candidates) {
    const target = shownPath(linkPath(l.dest)).replace(/^\/+/, "");
    const dir = dirs.find((d) => servedFrom(repo, d, target));
    if (dir) fromStatic.set(dir, (fromStatic.get(dir) ?? 0) + 1);
  }
  if (fromStatic.size) {
    // The whole list, the config's and these: a second `static_dirs:` key would be invalid YAML.
    // Written as one flow list, so YAML quotes what a flow list would split (`website/a,b/static`).
    const seq = new Document([...config.static_dirs, ...fromStatic.keys()]);
    if (isSeq(seq.contents)) seq.contents.flow = true;
    const list = `static_dirs: ${seq.toString({ flowCollectionPadding: false, lineWidth: 0 }).trimEnd()}`;
    const n = [...fromStatic.values()].reduce((a, b) => a + b, 0);
    const where = config.static_dirs.length ? `set \`${list}\` in` : `add \`${list}\` to`;
    const found = [...fromStatic.keys()];
    // One inside another directory named static could be a monorepo's `static` package holding a
    // site, or a site root's own `static/` asset folder: nothing here tells them apart, so ask.
    const outer = found.flatMap((d) => dirs.filter((a) => d.startsWith(`${a}/`)));
    if (outer.length)
      result.hints.push(
        `if your docs site serves ${found.join(" and ")} at its root (it's inside ${[...new Set(outer)].join(" and ")}, which may be the root instead), ${where} ${CONFIG_PATH}: ${n === 1 ? "1 link names a file" : `${n} links name files`} there`,
      );
    else
      result.hints.push(`${where} ${CONFIG_PATH}: ${n === 1 ? "1 link names a file" : `${n} links name files`} a docs site serves from ${found.join(" and ")}, and lint reads them there once it's listed`);
  }

  for (const [problem, paths] of unowned) {
    const n = paths.length === 1 ? "1 adopted page" : `${paths.length} adopted pages`;
    const line = problem === "no_rule" ? codeownersLine(knowledgeRel, config.github.org, opts.team!, paths) : null;
    result.hints.push(
      problem !== "no_rule"
        ? `${problem}: lint fails on ${n} until CODEOWNERS names one team of \`${config.github.org}\` for them`
        : line
          ? `add \`${line}\` to ${codeowners.path ?? "CODEOWNERS"}: no rule there covers ${n}, and lint needs one team for each`
          : `give \`${knowledgeRel}/\` one team in ${codeowners.path ?? "CODEOWNERS"}: no line adopt can write matches it, and lint needs one team for each of ${n}`,
    );
  }
  const listed = new Set(config.frontmatter.extra_fields);
  const added = [...unknownKeys].filter((k) => !listed.has(k)).sort();
  if (added.length) {
    const shared = existsSync(configPath) && lstatSync(configPath).nlink > 1 ? lstatSync(configPath).nlink : 0;
    const next = shared ? { why: `it has ${shared} hard links, and adopt writes no file another path shares` } : withExtraFields(readFileSync(configPath, "utf8"), added);
    if ("why" in next) result.hints.push(`add ${added.map((k) => `\`${k}\``).join(", ")} to frontmatter.extra_fields in ${CONFIG_PATH} by hand: ${next.why}`);
    else {
      result.extraFields = added;
      writes.push({ abs: configPath, text: next.text, inside: repo });
    }
  }

  if (!opts.dryRun) {
    // The walk followed no link; this checks again, before the first write, that each file is
    // still a regular file where it was. (Defense in depth: no test races the walk.)
    for (const w of writes) {
      if (!lstatSync(w.abs).isFile() || lstatSync(w.abs).nlink > 1 || !within(w.inside, realpathSync(w.abs))) throw new AdoptError(`${rel(w.abs)} changed while adopt ran; nothing written`);
    }
    for (const w of writes) writeFileSync(w.abs, w.text);
  }
  if (dating) {
    // Counted over the pages adopted: a page left after it was dated got no date.
    const count = (index: ContentIndex) => result.adopted.filter((path) => dating.by.get(path) === index).length;
    result.datedFrom = dating.sources.map((index) => ({ repo: index.repo, pages: count(index) }));
    if (dating.own && count(dating.own)) result.datedFrom.push({ repo: dating.own.repo, pages: count(dating.own) });
    result.datedToday = result.adopted.filter((path) => dating.by.get(path) === "today");
  }
  return result;
}

/**
 * Directories named `static` in the repo, however deep (hidden directories, links and
 * `node_modules` aside): where a docs site keeps the files it serves at its root.
 */
function staticDirsIn(repo: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(join(repo, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = dir ? `${dir}/${e.name}` : e.name;
      if (e.name === "static") out.push(p);
      walk(p); // a static directory can hold another (a monorepo's `static` package)
    }
  };
  walk("");
  return out.sort();
}

/**
 * The CODEOWNERS line giving the knowledge root to `team`, its whitespace and `#` escaped; null
 * unless CODEOWNERS's own parser reads it as giving each of `paths` to that team.
 */
function codeownersLine(knowledgeRel: string, org: string, team: string, paths: string[]): string | null {
  const pattern = `/${knowledgeRel.replace(/[\s#\\]/g, (c) => `\\${c}`)}/`;
  const line = `${pattern} @${org}/${team}`;
  const co = parseCodeowners(line);
  const ok = paths.every((p) => {
    const owner = resolveTeamOwner(co, p, org);
    return owner.ok && owner.team === team;
  });
  return !co.errors.length && ok ? line : null;
}

/**
 * The owning team: CODEOWNERS's, else --team (with what's wrong in CODEOWNERS: `no_rule`, or
 * the problem's description), else why there's none.
 */
function ownerFor(path: string, co: Codeowners, config: Config, team: string | undefined): { team: string; problem?: string } | { problem: string } {
  const owner = resolveTeamOwner(co, path, config.github.org);
  if (owner.ok) return { team: owner.team };
  if (team) return { team, problem: owner.problem.kind === "no_rule" ? "no_rule" : describeOwnershipProblem(owner.problem, config.github.org) };
  return { problem: `no owning team: ${describeOwnershipProblem(owner.problem, config.github.org)}; pass --team <slug>, or give the path one team in CODEOWNERS` };
}

interface LinkContext {
  /** Directories a docs site serves at its root (config `static_dirs`). */
  staticDirs: readonly string[];
  /** Pages a slug or an own id puts at another URL than their file's (Docusaurus's routing). */
  moved: Set<string>;
  /** The route each such page answers to instead, without a leading slash → its page files. */
  aliases: Map<string, string[]>;
  repo: string;
  /** The knowledge root, repo-relative. */
  knowledgeRel: string;
  /** Every page file under the knowledge root, repo-relative. */
  pages: Set<string>;
  /** Page files by their directory. */
  byDir: Map<string, string[]>;
}

/**
 * The page files a link's path could mean, read each way a Docusaurus site or GitHub reads
 * it (R2). A root-relative path is read from the knowledge root, from the repo root, and
 * without a leading `/docs`; a relative one from the page's directory, and from a category
 * index's URL. Each reading names `p` itself, `p.md`, or the category index in directory `p`.
 */
function pagesNamed(path: string, s: Source, ctx: LinkContext): string[] {
  const bare = path.replace(/\/+$/, "");
  const root = ctx.knowledgeRel;
  const bases: string[] = [];
  const named = new Set<string>();
  if (path.startsWith("/")) {
    const rest = bare.replace(/^\/+/, "");
    bases.push(posix.join(root, rest), rest);
    if (rest === "docs" || rest.startsWith("docs/")) bases.push(posix.join(root, rest.slice("docs".length)));
    // A page a slug or an id moved answers to its route too: a reading that names it.
    for (const r of [rest, ...(rest === "docs" || rest.startsWith("docs/") ? [rest.slice("docs".length).replace(/^\//, "")] : [])])
      for (const p of ctx.aliases.get(r) ?? []) named.add(p);
  } else {
    const dir = posix.dirname(s.path);
    bases.push(posix.join(dir, bare));
    // A category index's URL is its directory, with no trailing slash, so a browser reads its
    // relative links from the directory above.
    if (s.index && dir !== root) bases.push(posix.join(posix.dirname(dir), bare));
    // And the routes the site resolves them to, from the page's URL (its directories without
    // their number prefixes): a page a slug or an id puts there is named too.
    const urlDir = posix.join(".", ...s.dirs.map(unprefixed));
    const routes = [posix.join(urlDir, bare), ...(s.index && s.dirs.length ? [posix.join(posix.dirname(urlDir), bare)] : [])];
    for (const r of routes) for (const p of ctx.aliases.get(posix.normalize(r).replace(/^\.(\/|$)/, "").replace(/\/+$/, "")) ?? []) named.add(p);
  }
  for (const base of bases) {
    const b = posix.normalize(base || ".");
    if (ctx.pages.has(b)) named.add(b);
    if (ctx.pages.has(`${b}.md`)) named.add(`${b}.md`);
    for (const p of ctx.byDir.get(b) ?? []) if (isCategoryIndex(posix.basename(p, ".md"), b === root ? undefined : posix.basename(b))) named.add(p);
  }
  return [...named].sort();
}

// A name `resolveLink`'s decodeURI can't give back: it leaves %23 and %3F encoded, and a bare
// `%` makes it throw.
const NO_LINK_NAMES = /[%#?]/;

/**
 * A path segment written so CommonMark reads back the same name, inside a link and around
 * it: whitespace, controls, `<` `>` `(` `)` `\\`, and the backticks and brackets that could
 * open a code span or a link across it. `decodeURI` gives each back. Unicode stays as it is.
 */
function escapeSegment(segment: string): string {
  return segment.replace(/[\x00-\x20\x7f<>()\\`[\]]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** A destination's query and fragment, from its first `?` or `#` (as lint splits it). */
const suffixOf = (dest: string) => {
  const i = dest.search(/[?#]/);
  return i < 0 ? "" : dest.slice(i);
};

/** The same, as written: a backslash escaping that `?` or `#` kept with it. */
const rawSuffixOf = (raw: string) => {
  const i = raw.search(/\\?[?#]/);
  return i < 0 ? "" : raw.slice(i);
};

const NAMES_NO_PAGE = "it names no page";

/** One link's destination rewritten as a relative `.md` link to the page it names, or why not. */
function rewriteLink(span: LinkSpan, s: Source, ctx: LinkContext): { raw: string; dest: string } | { why: string } {
  const route = shownPath(linkPath(span.dest));
  // A relative route on a page a slug moved follows the slug's URL, not the file's.
  if (!route.startsWith("/") && ctx.moved.has(s.path) && typeof s.data?.slug === "string")
    return { why: "its page's slug gives it another URL, which a relative route follows: link it by hand" };
  const named = pagesNamed(route, s, ctx);
  if (!named.length) {
    // A page the site serves at the route through a number prefix: not followed, but listed.
    const viaPrefix = route.startsWith("/") ? routePages(ctx.repo, ctx.knowledgeRel, route.replace(/^\/+|\/+$/g, "")) : [];
    return { why: viaPrefix.length ? `on a docs site it's the route of ${viaPrefix.join(" or ")}, through a number prefix adopt doesn't follow: link it by hand` : NAMES_NO_PAGE };
  }
  if (named.length > 1) return { why: `it could name ${named.join(" or ")}: link the one you mean` };
  const target = named[0]!;
  // Its URL isn't its file's: which page the route meant is routing adopt doesn't model.
  if (ctx.moved.has(target)) return { why: `${target} has a slug or an id that gives it another URL: link it by hand` };
  const rel = posix.relative(posix.dirname(s.path), target);
  if (NO_LINK_NAMES.test(rel)) return { why: "its page's path holds `%`, `#` or `?`, which no link here can name: rename the file, or link it by hand" };
  let path = rel.split("/").map(escapeSegment).join("/");
  if (EXTERNAL.test(path)) path = `./${path}`; // a first segment that would read as a scheme
  const raw = path + rawSuffixOf(span.raw);
  // CommonMark must read it back as naming the page, with the query and fragment it had.
  const dest = readDestination(raw, span.angle);
  if (EXTERNAL.test(dest) || linkFault(ctx.repo, ctx.knowledgeRel, s.path, linkPath(dest), { aliases: (r) => ctx.aliases.get(r) ?? [], staticDirs: ctx.staticDirs }).target !== target || suffixOf(dest) !== suffixOf(span.dest))
    return { why: "adopt couldn't write a link that names it: link it by hand" };
  return { raw, dest };
}

/**
 * The page's links lint fails (R8, R8b), rewritten where they name one page, as edits to its
 * body; the rest, listed. If the rewritten body, parsed whole, wouldn't give the same links
 * with only the rewritten destinations changed, nothing on the page is rewritten.
 */
/** A link adopt leaves: as written, CommonMark's destination for it, and why. */
type LeftLink = { link: string; dest: string; why: string };

function convertLinks(s: Source, ctx: LinkContext): { edits: Edit[]; left: LeftLink[] } {
  // `fails`: lint fails it. `route`: lint takes it for a directory or an extensionless file
  // outside the knowledge root (`/guides` naming the repo's `guides/`), but on the site it's a
  // page's route; rewritten if it names one page, and otherwise left as lint accepts it.
  const judge = (dest: string): "fails" | "route" | null => {
    const path = dest && !EXTERNAL.test(dest) ? linkPath(dest) : "";
    if (!path) return null;
    const { target, fault, underRoot } = linkFault(ctx.repo, ctx.knowledgeRel, s.path, path, { aliases: (r) => ctx.aliases.get(r) ?? [], staticDirs: ctx.staticDirs });
    if (fault) return "fails";
    // (A file served from a static directory exists only there: it's no route.)
    const abs = join(ctx.repo, target);
    return !underRoot && existsSync(abs) && (posix.extname(target) === "" || statSync(abs).isDirectory()) ? "route" : null;
  };
  const edits: Edit[] = [];
  const left: LeftLink[] = [];
  const rewritten: LinkSpan[] = [];
  const renamed = new Map<string, string>(); // destination → its rewrite (one per page: same path, same page)
  const spans = linkSpans(s.body);
  for (const span of spans) {
    const verdict = judge(span.dest);
    if (!verdict) continue;
    const r = rewriteLink(span, s, ctx);
    if ("why" in r) {
      if (verdict === "fails" || r.why !== NAMES_NO_PAGE) left.push({ link: span.raw, dest: span.dest, why: r.why });
    } else {
      edits.push({ start: span.start, end: span.end, insert: r.raw });
      rewritten.push(span);
      renamed.set(span.dest, r.dest);
    }
  }
  const before = pageLinks(s.body);
  // A link CommonMark reads that adopt found nowhere in the source: listed, for lint to judge.
  const located = new Set(spans.map((sp) => sp.dest));
  for (const dest of new Set(before)) if (judge(dest) === "fails" && !located.has(dest)) left.push({ link: dest, dest, why: "adopt couldn't find where it's written: link it by hand" });
  // A whole parse, not linkSpans's: its markers hide what a destination holds (a backtick that
  // would open a code span across the rest of the line, say).
  if (edits.length && !isDeepStrictEqual(pageLinks(applyEdits(s.body, edits)), before.map((d) => renamed.get(d) ?? d))) {
    const why = "rewriting it would change how the page's links parse: link it by hand";
    return { edits: [], left: [...left, ...rewritten.map((sp) => ({ link: sp.raw, dest: sp.dest, why }))] };
  }
  return { edits, left };
}
