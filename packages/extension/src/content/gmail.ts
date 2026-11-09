// The Gmail content script. Gmail is a single-page app, so the button is (re)mounted whenever
// the page changes and a thread is open; what it does on a click is in adapter.ts.

import type { GmailContext } from "../contract.js";
import { clickHandler, mount } from "./adapter.js";

const onClick = clickHandler(document, () => location.href, (ctx: GmailContext) => chrome.runtime.sendMessage(ctx));

let scheduled = false;
const remount = () => {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    mount(document, onClick);
  }, 250);
};

new MutationObserver(remount).observe(document.body, { childList: true, subtree: true });
mount(document, onClick);
