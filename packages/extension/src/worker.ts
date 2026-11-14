// What the service worker does with a message, a menu click and a toolbar click, apart from
// Chrome's wiring (background.ts), so the tests reach the worker's own boundary: a refused
// message opens nothing and stores nothing.

import { extract, type Mode, pendingFrom, type ScriptingApi } from "./capture.js";
import { clip, type GmailContext, MAX_TITLE, type Pending, PENDING_PREFIX, refusal } from "./contract.js";
import { type Handoff, type HandoffApi, handOff } from "./handoff.js";
import { prunePending } from "./pending.js";

export const MENU = "docsworth-save-selection";
export const MENU_PAGE = "docsworth-save-page";
/** The context menu's items, as background.ts creates them. */
export const MENUS = [
  { id: MENU, title: "Save selection to Docsworth", contexts: ["selection"] },
  { id: MENU_PAGE, title: "Save page to Docsworth", contexts: ["page"] },
] as const;

export type WorkerApi = HandoffApi & ScriptingApi & { runtime: { id: string } };

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

type MenuInfo = Pick<chrome.contextMenus.OnClickData, "menuItemId" | "selectionText" | "pageUrl" | "frameUrl" | "frameId">;

/**
 * "Save selection" or "Save page to Docsworth": the panel of the tab it was clicked in opens,
 * in the click's turn, and then capture.js reads the selection (in the frame it's in) or the
 * page's main content (in the top frame) as markdown. Where Chrome doesn't let the extension
 * read (another origin's frame, a page it protects), a selection falls back to Chrome's plain
 * text of it, and a page to an empty draft, each saying why.
 */
export function onMenuClick(api: WorkerApi, info: MenuInfo, tab: Pick<chrome.tabs.Tab, "id" | "windowId" | "title"> | undefined): void {
  const mode: Mode | null = info.menuItemId === MENU ? "selection" : info.menuItemId === MENU_PAGE ? "page" : null;
  if (!mode || tab?.id === undefined || tab.id < 0) return;
  const tabId = tab.id;
  const base = { window: tab.windowId, source: mode, at: Date.now() };
  // Without the tabs permission a tab's title isn't given; the panel suggests one from the text.
  const title = (tab.title ?? "").slice(0, MAX_TITLE);
  const unread = (): Pending =>
    mode === "selection"
      ? { ...base, title, text: clip(info.selectionText ?? ""), url: info.frameUrl ?? info.pageUrl ?? "", note: "Plain text: Chrome didn't let Docsworth read that part of the page, so its links and formatting are gone." }
      : { ...base, title, text: "", url: info.pageUrl ?? "", note: "Chrome didn't let Docsworth read this page. Paste what you need into the draft." };
  const frameId = mode === "selection" ? (info.frameId ?? 0) : 0;
  void handOff(api, tabId, () => extract(api, { tabId, frameId }, mode).then((e) => pendingFrom(e, base), unread));
}

/**
 * The toolbar button: the worker opens the panel itself, rather than Chrome on its own
 * (openPanelOnActionClick), because only then does Chrome give the extension activeTab on
 * the tab, which the panel's Save buttons need.
 */
export function onAction(api: Pick<WorkerApi, "sidePanel">, tab: Pick<chrome.tabs.Tab, "id" | "windowId"> | undefined): void {
  if (tab?.id === undefined || tab.id < 0) return;
  api.sidePanel.open({ tabId: tab.id }).catch(() => undefined);
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
