// Text a page holds, made safe to print on a terminal: a decoded link, a frontmatter value or a
// file name could carry escape sequences that clear or spoof a report, line breaks that fake
// another line, or bidirectional overrides that reorder it.

// C0 and C1 controls, Unicode's Bidi_Control set, and its line and paragraph separators.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

// The same but C0, which JSON.stringify escapes inside strings and uses outside them (a newline).
const UNPRINTABLE_IN_JSON = /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

const hex = (c: string, width: number) => c.charCodeAt(0).toString(16).padStart(width, "0");

/** `text` with control and bidirectional characters written as escapes (`\x1b`, `\u202e`). */
export function printable(text: string): string {
  return text.replace(UNPRINTABLE, (c) => (c.charCodeAt(0) < 0x100 ? `\\x${hex(c, 2)}` : `\\u${hex(c, 4)}`));
}

/** `value` as JSON, every such character a `\u` escape: JSON.stringify leaves C1 and bidirectional ones as they are. */
export function printableJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(UNPRINTABLE_IN_JSON, (c) => `\\u${hex(c, 4)}`);
}
