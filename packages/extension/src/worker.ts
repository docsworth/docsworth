// What the service worker does with a message and a menu click, apart from Chrome's wiring
// (background.ts), so the tests reach the worker's own boundary: a refused message opens
// nothing and stores nothing.

import { clip, type GmailContext, MAX_TITLE, PENDING_PREFIX, refusal } from "./contract.js";
import { type Handoff, type HandoffApi, handOff } from "./handoff.js";
import { prunePending } from "./pending.js";

export const MENU = "docsworth-save-selection";

export type WorkerApi = HandoffApi & { runtime: { id: string } };

/**
 * A message from a content script. Only a Gmail thread's context passes the contract; it
 * opens the panel and leaves it the thread. Anything else is answered with why, and nothing
 * else happens. Returns true while the answer is still to come, as Chrome's listener expects.
 */
export function onMessage(api: WorkerApi, msg: unknown, sender: chrome.runtime.MessageSender, reply: (r: Handoff) => void): boolean {
  const refused = refusal(msg, sender, api.runtime.id);
  if (refused) {
    reply({ ok: false, error: refused });
    return false;
  }
  const m = msg as GmailContext;
  void handOff(api, sender.tab!.id!, { window: sender.tab!.windowId, source: "gmail", title: m.subject, text: m.text, url: m.url, at: Date.now() }).then(reply);
  return true;
}

/** "Save selection to Docsworth": the selection goes to the panel of the tab it was made in. */
export function onMenuClick(api: WorkerApi, info: Pick<chrome.contextMenus.OnClickData, "menuItemId" | "selectionText" | "pageUrl">, tab: Pick<chrome.tabs.Tab, "id" | "windowId" | "title"> | undefined): void {
  if (info.menuItemId !== MENU || tab?.id === undefined || tab.id < 0) return;
  // Without the tabs permission a tab's title isn't given; the panel suggests one from the text.
  void handOff(api, tab.id, { window: tab.windowId, source: "selection", title: (tab.title ?? "").slice(0, MAX_TITLE), text: clip(info.selectionText ?? ""), url: info.pageUrl ?? "", at: Date.now() });
}

/**
 * A capture's alarm: its time is up, so every capture past the limit goes. A prune that failed
 * is tried again a minute on; storage.session is in memory, so Chrome quitting ends it too.
 */
export async function onAlarm(api: Pick<WorkerApi, "storage" | "alarms">, alarm: Pick<chrome.alarms.Alarm, "name">, now: number): Promise<void> {
  if (!alarm.name.startsWith(PENDING_PREFIX)) return;
  try {
    await prunePending(api.storage.session, now);
  } catch {
    await api.alarms.create(alarm.name, { when: now + 60_000 }).catch(() => undefined);
  }
}
