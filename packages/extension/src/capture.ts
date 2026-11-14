// Running capture.js (src/extract) in a tab, for the worker (the context menu) and the side
// panel (its Save buttons) alike (R4). Chrome runs it only where the extension has activeTab:
// the tab the person clicked the menu or the toolbar button in. The first call injects the
// file, which defines one function in the extension's isolated world; the second calls it. The
// page's scripts can't see that world, so they can't replace the function, but the page shapes
// what it reads: the answer is used only once it has exactly the shape of a capture.

import { CAPTURE_FN, type Extraction, isExtraction, type Pending, refusalOf, type Source } from "./contract.js";
import type { Mode } from "./extract/index.js";

export type { Mode };
export const CAPTURE_FILE = "capture.js";
export type ScriptingApi = { scripting: Pick<typeof chrome.scripting, "executeScript"> };

/** The tab's markdown, title and address; rejects with Chrome's or the page's reason. */
export async function extract(api: ScriptingApi, at: { tabId: number; frameId: number }, mode: Mode, ms = 10_000): Promise<Extraction> {
  const target = { tabId: at.tabId, frameIds: [at.frameId] };
  const run = async () => {
    await api.scripting.executeScript({ target, files: [CAPTURE_FILE] });
    // Serialized into the tab: it may use only its arguments.
    const [r] = await api.scripting.executeScript({ target, func: (fn: string, m: Mode) => (globalThis as unknown as Record<string, (m: Mode) => unknown>)[fn]!(m), args: [CAPTURE_FN, mode] });
    return r?.result;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error("the page took too long to read")), ms)));
  try {
    const result = await Promise.race([run(), late]);
    const refused = refusalOf(result);
    if (refused) throw new Error(refused);
    if (!isExtraction(result)) throw new Error("what the page gave back wasn't a capture");
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** A capture for the panel, from what was read in the tab. */
export function pendingFrom(e: Extraction, base: { window: number; source: Source; at: number }): Pending {
  const note = e.cut ? "Cut at 64 KB: the rest of the page isn't in the draft." : !e.markdown.trim() ? "No text was found there." : null;
  return { ...base, title: e.title, text: e.markdown, url: e.url, ...(note ? { note } : {}) };
}
