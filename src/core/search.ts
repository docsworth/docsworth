// In-memory BM25 (BM25F-lite: per-field boosts folded into term frequency).
// The plan says "BM25 first, embeddings later"; this keeps search dependency-free and
// fast enough for 5,000 pages (scripts/bench-search.ts holds it to p95 < 500 ms).

export interface SearchDoc {
  title: string;
  headings?: string[];
  description?: string;
  body: string;
  /** Extra exact-ish tokens such as ids or service names. */
  keywords?: string[];
}

export interface Hit {
  index: number;
  score: number;
}

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from has have how i if in into is it its of on or our should that the their then there this to was we what when where which who why will with you your".split(" "),
);
const BOOST = { title: 3, keywords: 3, headings: 2, description: 2, body: 1 } as const;
const K1 = 1.2;
const B = 0.75;

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => !STOPWORDS.has(t))
    .map(stem);
}

/** Deliberately light stemming: plural and common verb suffixes only. */
function stem(t: string): string {
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export class SearchIndex {
  private postings = new Map<string, { doc: number; tf: number }[]>();
  private lengths: number[] = [];
  private avgLength = 0;

  constructor(docs: SearchDoc[]) {
    docs.forEach((doc, i) => {
      const tf = new Map<string, number>();
      const add = (text: string | undefined, boost: number) => {
        for (const t of tokenize(text ?? "")) tf.set(t, (tf.get(t) ?? 0) + boost);
      };
      add(doc.title, BOOST.title);
      add(doc.keywords?.join(" "), BOOST.keywords);
      add(doc.headings?.join(" "), BOOST.headings);
      add(doc.description, BOOST.description);
      add(doc.body, BOOST.body);
      let len = 0;
      for (const [term, f] of tf) {
        len += f;
        let list = this.postings.get(term);
        if (!list) this.postings.set(term, (list = []));
        list.push({ doc: i, tf: f });
      }
      this.lengths.push(len);
    });
    this.avgLength = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, this.lengths.length);
  }

  get size(): number {
    return this.lengths.length;
  }

  /** Top hits for a query; `accept` filters candidates before ranking (ACL, filters). */
  search(query: string, limit: number, accept: (index: number) => boolean = () => true): Hit[] {
    const n = this.lengths.length;
    const scores = new Map<number, number>();
    for (const term of new Set(tokenize(query))) {
      const list = this.postings.get(term);
      if (!list) continue;
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const { doc, tf } of list) {
        const norm = tf + K1 * (1 - B + (B * this.lengths[doc]!) / this.avgLength);
        scores.set(doc, (scores.get(doc) ?? 0) + idf * ((tf * (K1 + 1)) / norm));
      }
    }
    return [...scores.entries()]
      .filter(([doc]) => accept(doc))
      .map(([index, score]) => ({ index, score: Math.round(score * 1000) / 1000 }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, limit);
  }
}

/** A ~maxLen window of `body` around the densest run of query terms. */
export function snippet(body: string, query: string, maxLen = 240): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (text.length <= maxLen) return text;
  const terms = new Set(tokenize(query));
  const words = text.split(" ");
  let best = 0;
  let bestScore = -1;
  const window = 30;
  for (let i = 0; i < words.length; i += 5) {
    const score = words.slice(i, i + window).filter((w) => terms.has(tokenize(w)[0] ?? "")).length;
    if (score > bestScore) [best, bestScore] = [i, score];
  }
  // Start a few words before the first match in the winning window, so the matches
  // themselves land inside the visible length.
  const firstMatch = words.findIndex((w, i) => i >= best && terms.has(tokenize(w)[0] ?? ""));
  const start = firstMatch === -1 ? best : Math.max(0, firstMatch - 4);
  const out = words.slice(start).join(" ").slice(0, maxLen);
  return `${start > 0 ? "…" : ""}${out}${out.length >= maxLen ? "…" : ""}`;
}
