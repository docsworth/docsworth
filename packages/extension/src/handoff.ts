// The worker's one job: open the side panel and leave it a capture. The order matters, and
// is the same for the Gmail button and the context menu: `sidePanel.open()` runs first, in
// the turn of the click that allowed it (a user gesture doesn't outlast that turn). Only once
// the panel has opened is the capture's alarm set, and only once that's set is the capture
// stored: never without its time limit, and nothing left behind by a handoff that failed (a
// page can send messages without a click, and each failed open would otherwise leave an
// alarm). The panel is listening (storage.onChanged), so the capture arrives a moment later.

import { type Pending, PENDING_PREFIX, PENDING_TTL_MS } from "./contract.js";
import { prunePending, writePending } from "./pending.js";
import type { StorageLike } from "./storage.js";

export type HandoffApi = {
  sidePanel: Pick<typeof chrome.sidePanel, "open">;
  storage: { session: StorageLike };
  alarms: { create(name: string, info: { when: number }): Promise<void>; clear(name: string): Promise<boolean> };
};

export type Handoff = { ok: true } | { ok: false; error: string };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Opens the panel in `tabId` and leaves it `capture`, under its own key, with an alarm for when
 * its time is up (the worker's onAlarm). Resolves once the capture is stored or refused, so a
 * caller that waits on it (the message channel to the content script) keeps the worker alive
 * until then. If the panel didn't open, nothing is set or stored; if the alarm couldn't be set,
 * nothing is stored; if the capture couldn't be stored, its alarm is cleared.
 */
export function handOff(api: HandoffApi, tabId: number, capture: Pending, id: string = crypto.randomUUID()): Promise<Handoff> {
  const open = api.sidePanel.open({ tabId });
  const pruned = prunePending(api.storage.session, capture.at).catch(() => undefined);
  const key = `${PENDING_PREFIX}${id}`;
  return Promise.allSettled([open, pruned]).then(async ([o]) => {
    if (o.status === "rejected") return { ok: false, error: message(o.reason) };
    try {
      await api.alarms.create(key, { when: capture.at + PENDING_TTL_MS + 1000 });
    } catch (err) {
      return { ok: false, error: message(err) };
    }
    try {
      await writePending(api.storage.session, capture, id).written;
    } catch (err) {
      await api.alarms.clear(key).catch(() => false);
      return { ok: false, error: message(err) };
    }
    return { ok: true };
  });
}
