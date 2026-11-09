import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { canonicalDir, type MirrorPage, mirrorRecordPath, sha256 } from "../src/core/mirror-view.js";
import { loadRepo } from "../src/core/repo.js";

const BASE = "https://acme.atlassian.net/wiki/spaces";

export const mirrorPage = (space: string, native: string, title: string, markdown: string, over: Partial<MirrorPage> = {}): MirrorPage => ({
  id: `mirror:confluence:${space}:${native}`,
  source: "confluence",
  native_id: native,
  space,
  title,
  url: `${BASE}/${space}/pages/${native}/${title.replace(/ /g, "+")}`,
  markdown,
  created: "2025-01-01T00:00:00Z",
  last_edited: "2026-09-01T00:00:00Z",
  versions: 4,
  owner_team: null,
  labels: [],
  acl: "internal",
  links_to: [],
  ...over,
});

/**
 * Three mirrored spaces over the acme example: ENG (internal), SEC (security) and PAY
 * (payments). The ENG page links to the SEC page in every form a mirror writes: the
 * Confluence emphasis form, a markdown link, and a bare URL.
 */
export const SEC_PAGE = mirrorPage("SEC", "900", "Payroll key rotation", "Rotate the payroll signing key with vault rotate payroll-signing every quarter.", { acl: "security", owner_team: "security" });
export const PAY_PAGE = mirrorPage("PAY", "700", "Ledger reconciliation notes", "Reconcile the ledger against the PSP settlement report each morning.", { acl: "payments", owner_team: "payments" });
export const ENG_PAGE = mirrorPage(
  "ENG",
  "101",
  "Deploy checklist from the old wiki",
  `Before a deploy, check the canary dashboard and the Jenkins job. For keys see _Payroll key rotation_, [the rotation page](${SEC_PAGE.url}) or ${SEC_PAGE.url} directly.`,
  { links_to: ["Payroll key rotation"], owner_team: "platform" },
);
export const ENG_OTHER = mirrorPage("ENG", "102", "Canary rollout history", "The canary rollout moved from Jenkins to Shipyard in 2025.");

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "page";

/**
 * Mirrored pages on disk as a mirror run leaves them, in the form core reads: a directory
 * per space, each page a file with its metadata as `mirror:` frontmatter, and this user's
 * record of what was written. Pro writes the mirror (runMirror); its tests check that a
 * real run writes these same files.
 */
export async function writeMirror(root: string, spaces: Record<string, MirrorPage[]>, outDir = join(root, loadRepo(root).config.mirror.out_dir)): Promise<void> {
  for (const [space, pages] of Object.entries(spaces)) {
    const dir = join(outDir, "confluence", slug(space));
    mkdirSync(dir, { recursive: true });
    const files: Record<string, string> = {};
    for (const { markdown, ...meta } of pages) {
      const name = `${slug(meta.title)}--${slug(meta.native_id)}.md`;
      const content = `---\n${stringify({ mirror: meta })}---\n\n${markdown}\n`;
      writeFileSync(join(dir, name), content);
      files[name] = sha256(content);
    }
    // Written aside and renamed in, as a run does: a server notices a new run by the
    // records directory's mtime, which only a new entry changes.
    const record = mirrorRecordPath(root, dir);
    mkdirSync(dirname(record), { recursive: true, mode: 0o700 });
    const tmp = `${record}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ dir: canonicalDir(dir), files }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, record);
  }
}

/** Turn mirror serving on in a copy's config. */
export function serveMirror(root: string, on = true): void {
  const cfg = join(root, ".knowledge/config.yaml");
  writeFileSync(cfg, readFileSync(cfg, "utf8").replace("  out_dir: .knowledge/mirror\n", `  out_dir: .knowledge/mirror\n  serve: ${on}\n`));
}

export const ALL_SPACES = { ENG: [ENG_PAGE, ENG_OTHER], SEC: [SEC_PAGE], PAY: [PAY_PAGE] };
