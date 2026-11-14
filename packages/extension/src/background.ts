// The service worker. It never calls the server and never sees the token: it opens the side
// panel and leaves it a capture, from the context menu (read in the tab by capture.js) or from
// the Gmail button, opens the panel on a toolbar click, removes a capture whose time is up, and
// refuses every other message (worker.ts, contract.ts). It reads only the captures' keys in
// storage.session (pending.ts). This file is only Chrome's wiring.

import { MENUS, onAction, onAlarm, onMenuClick, onMessage } from "./worker.js";

// storage.session holds the token and the captures, for extension pages only. Trusted
// contexts is Chrome's default; it's set anyway, so no change of default could open it.
void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

// The worker opens the panel on a toolbar click (onAction): Chrome gives the extension activeTab
// only then. Chrome keeps this setting, so it's set on every start: an extension updated from
// a build that had Chrome open the panel would otherwise go on doing so, and never ask here.
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

chrome.runtime.onInstalled.addListener(() => {
  for (const item of MENUS) chrome.contextMenus.create({ ...item, contexts: [...item.contexts] });
});

chrome.action.onClicked.addListener((tab) => onAction(chrome, tab));
chrome.contextMenus.onClicked.addListener((info, tab) => onMenuClick(chrome, info, tab));
chrome.runtime.onMessage.addListener((msg: unknown, sender, reply) => onMessage(chrome, msg, sender, reply));
chrome.alarms.onAlarm.addListener((alarm) => void onAlarm(chrome, alarm, Date.now()));
