// Replacing ranges of a text by their original offsets: every rewrite `adopt` and `verify`
// make goes through here, so one edit never shifts another's place.

export interface Edit {
  /** Start offset in the original text. */
  start: number;
  /** End offset (exclusive) in the original text. */
  end: number;
  insert: string;
}

/**
 * `text` with each edit applied at its original offsets, rebuilt in one pass after sorting the
 * edits (O(E log E) plus the text, not once per edit). Edits must not overlap; ones at the same
 * offset apply in the order given.
 */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = edits.map((e, i) => ({ e, i })).sort((a, b) => a.e.start - b.e.start || a.e.end - b.e.end || a.i - b.i);
  const parts: string[] = [];
  let at = 0;
  for (const { e } of sorted) {
    if (e.start < at) throw new Error(`edits overlap at offset ${e.start}`);
    parts.push(text.slice(at, e.start), e.insert);
    at = e.end;
  }
  parts.push(text.slice(at));
  return parts.join("");
}
