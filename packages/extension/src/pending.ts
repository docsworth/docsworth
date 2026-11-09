// Captures waiting in storage.session for their window's side panel. Each is under its own
// key, so being done with one never removes a newer one, and the panel takes only its own
// window's. A capture stays stored until the panel is done with it or its time is up, so a
// panel that reloads (a new session, another token) or is closed and opened again gets it back.
//
// Only the captures are read, never the whole area: it holds the token too, and the worker,
// which takes messages from pages, never reads it (docs/security-model.md).

import { isPending, type Pending, PENDING_PREFIX, PENDING_TTL_MS } from "./contract.js";
import type { StorageLike as Area } from "./storage.js";

/** A capture as the panel holds it: with its key, so it can say when it's done with it. */
export type Taken = { key: string; capture: Pending };

/** Starts writing `capture` under a new key; `written` settles when the write does. */
export function writePending(area: Area, capture: Pending, id: string = crypto.randomUUID()): { key: string; written: Promise<void> } {
  const key = `${PENDING_PREFIX}${id}`;
  return { key, written: area.set({ [key]: capture }) };
}

/** Every key under the prefix and what's stored there, and nothing else in the area. */
async function readPending(area: Area): Promise<[string, unknown][]> {
  const keys = (await area.getKeys()).filter((k) => k.startsWith(PENDING_PREFIX));
  return keys.length ? Object.entries(await area.get(keys)) : [];
}

/** The keys of captures older than the time limit, and of anything under the prefix that isn't one. */
const staleOf = (entries: [string, unknown][], now: number) => entries.filter(([, v]) => !isPending(v) || now - v.at > PENDING_TTL_MS).map(([k]) => k);

/** Removes captures older than the time limit, and anything under the prefix that isn't one. */
export async function prunePending(area: Area, now: number): Promise<void> {
  const stale = staleOf(await readPending(area), now);
  if (stale.length) await area.remove(stale);
}

/**
 * This window's captures within the time limit that this panel hasn't been given yet, oldest
 * first. They aren't removed: the panel calls donePending for each when it's done with it.
 * Captures past the limit are pruned on the way, so one whose alarm wasn't set still goes.
 * `seen` holds the keys this panel document was given, so a load and a change event racing
 * never give one twice; a reloaded panel starts with a new one, and is given them again.
 */
export async function takePending(area: Area, window: number, now: number, seen: Set<string>): Promise<Taken[]> {
  const all = await readPending(area);
  const stale = staleOf(all, now);
  // A prune that failed is retried by the next pull, or the alarm's.
  if (stale.length) await area.remove(stale).catch(() => undefined);
  const mine = all
    .filter((e): e is [string, Pending] => !seen.has(e[0]) && isPending(e[1]) && e[1].window === window && now - e[1].at <= PENDING_TTL_MS)
    .sort(([, a], [, b]) => a.at - b.at);
  for (const [k] of mine) seen.add(k);
  return mine.map(([key, capture]) => ({ key, capture }));
}

/** The panel is done with this capture: its draft became a PR, or it left it for another view. */
export function donePending(area: Area, key: string): Promise<void> {
  return area.remove(key);
}
