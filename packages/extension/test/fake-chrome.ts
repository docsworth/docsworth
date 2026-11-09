// An in-memory chrome.storage area, with the same get/set/remove shapes, that records what
// was written. Each call resolves in a later turn, as Chrome's do.

export type Write = { op: "set" | "remove"; items: Record<string, unknown> | string[] };

export class FakeArea {
  data = new Map<string, unknown>();
  writes: Write[] = [];
  /** What each get() asked for (null: everything), to test what a reader could see. */
  reads: (string[] | null)[] = [];

  async getKeys(): Promise<string[]> {
    await Promise.resolve();
    return [...this.data.keys()];
  }

  async get(keys: string | string[] | null): Promise<Record<string, any>> {
    this.reads.push(keys === null ? null : typeof keys === "string" ? [keys] : [...keys]);
    await Promise.resolve();
    const wanted = keys === null ? [...this.data.keys()] : typeof keys === "string" ? [keys] : keys;
    return Object.fromEntries(wanted.filter((k) => this.data.has(k)).map((k) => [k, structuredClone(this.data.get(k))]));
  }

  async set(items: Record<string, unknown>): Promise<void> {
    await Promise.resolve();
    this.writes.push({ op: "set", items });
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }

  async remove(keys: string | string[]): Promise<void> {
    await Promise.resolve();
    const list = typeof keys === "string" ? [keys] : keys;
    this.writes.push({ op: "remove", items: list });
    for (const k of list) this.data.delete(k);
  }
}
