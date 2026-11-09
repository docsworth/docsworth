// The part of a chrome.storage area this extension uses: chrome.storage.session and .local
// fit it, and so does the in-memory area the tests use.
export type StorageLike = {
  /** Every key, without its value (Chrome 130). */
  getKeys(): Promise<string[]>;
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};
