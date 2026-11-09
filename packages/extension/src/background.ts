// The service worker. It never calls the server and never sees the token: it opens the side
// panel and leaves it a capture, from the context menu or from the Gmail button, removes a
// capture whose time is up, and refuses every other message (worker.ts, contract.ts). It reads
// only the captures' keys in storage.session (pending.ts). This file is only Chrome's wiring.

import { MENU, onAlarm, onMenuClick, onMessage } from "./worker.js";

// storage.session holds the token and the captures, for extension pages only. Trusted
// contexts is Chrome's default; it's set anyway, so no change of default could open it.
void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: MENU, title: "Save selection to Docsworth", contexts: ["selection"] });
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.contextMenus.onClicked.addListener((info, tab) => onMenuClick(chrome, info, tab));
chrome.runtime.onMessage.addListener((msg: unknown, sender, reply) => onMessage(chrome, msg, sender, reply));
chrome.alarms.onAlarm.addListener((alarm) => void onAlarm(chrome, alarm, Date.now()));
