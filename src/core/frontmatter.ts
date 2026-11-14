import { parse as parseYaml } from "yaml";

export interface SplitDoc {
  /** Parsed frontmatter mapping, or null when absent/unparseable (see `error`). */
  data: Record<string, unknown> | null;
  body: string;
  error?: string;
}

const OPEN = /^---\r?\n/;
export const FRONTMATTER_MAX = 16 * 1024;
const CLOSE = /\r?\n---[ \t]*(\r?\n|$)/;

/**
 * Split `---` frontmatter from a markdown file and parse it as YAML.
 *
 * The YAML "core" schema is used on purpose: under YAML 1.1 rules `2026-10-15` would
 * become a Date and `review_every: 90d` could be coerced oddly. Here every scalar that
 * isn't a plain number/bool/null stays a string, so dates round-trip exactly.
 */
export function splitFrontmatter(text: string): SplitDoc {
  if (!OPEN.test(text)) return { data: null, body: text, error: "missing frontmatter block" };
  const span = frontmatterSpan(text);
  if (!span) return { data: null, body: text, error: "unterminated frontmatter block" };

  const yamlSrc = text.slice(span.start, span.end);
  const body = text.slice(span.bodyStart);
  // A page's frontmatter is a few hundred bytes; YAML parsing slows past linear on
  // hostile input (64 KB of `}&`: 650 ms, paid on every reload).
  if (Buffer.byteLength(yamlSrc, "utf8") > FRONTMATTER_MAX) return { data: null, body, error: `frontmatter is over ${FRONTMATTER_MAX / 1024} KB` };
  try {
    const data = parseYaml(yamlSrc, { schema: "core" }) as unknown;
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { data: null, body, error: "frontmatter is not a mapping" };
    }
    return { data: data as Record<string, unknown>, body };
  } catch (err) {
    return { data: null, body, error: `invalid YAML: ${(err as Error).message.split("\n")[0]}` };
  }
}

export interface FrontmatterSpan {
  /** Where the YAML starts: just after the opening `---` line. */
  start: number;
  /** Where it ends, before the closing `---` line's own line break. */
  end: number;
  /** Where the body starts, after the closing `---` line. */
  bodyStart: number;
  /** The opening line's line ending. */
  eol: "\n" | "\r\n";
}

/** Where a page's frontmatter sits in `text`, by offset; null without a terminated block. */
export function frontmatterSpan(text: string): FrontmatterSpan | null {
  const open = OPEN.exec(text);
  if (!open) return null;
  const start = open[0].length;
  const close = CLOSE.exec(text.slice(start));
  if (!close) return null;
  return { start, end: start + close.index, bodyStart: start + close.index + close[0].length, eol: open[0].length === 5 ? "\r\n" : "\n" };
}

/** Serialize frontmatter + body back to a markdown file (used by writes and promote). */
export function joinFrontmatter(yaml: string, body: string): string {
  return `---\n${yaml.trimEnd()}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
}
