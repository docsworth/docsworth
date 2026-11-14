import { describe, expect, it, vi } from "vitest";
import { CAPTURE_FN, type Extraction, isExtraction, MAX_TEXT_BYTES, MAX_TITLE, refusalOf } from "../src/contract.js";
import { CAPTURE_FILE, extract, pendingFrom } from "../src/capture.js";

// R4: capture.js runs in the tab only when asked, in the frame asked for, and what comes back
// is used only once it has exactly the shape of a capture.

const good: Extraction = { title: "Rotating TLS certificates", url: "https://docs.example.com/tls", markdown: "## Rotate\n\nRun it.", cut: false };

/** A chrome.scripting that answers the second call (the function's) with `result`. */
function scripting(result: unknown) {
  const executeScript = vi.fn(async (inj: chrome.scripting.ScriptInjection<unknown[], unknown>) => ("files" in inj && inj.files ? [{ frameId: 0, documentId: "d", result: undefined }] : [{ frameId: 0, documentId: "d", result }]));
  return { api: { scripting: { executeScript } } as never, executeScript };
}

describe("what capture.js gives back", () => {
  it("is a capture only with exactly its four fields, of their types, within the limits", () => {
    expect(isExtraction(good)).toBe(true);
    for (const bad of [
      null,
      [],
      "markdown",
      { ...good, extra: 1 },
      { title: good.title, url: good.url, markdown: good.markdown },
      { ...good, cut: "no" },
      { ...good, markdown: 4 },
      { ...good, title: "t".repeat(MAX_TITLE + 1) },
      { ...good, url: `https://a.example/${"x".repeat(2048)}` },
      { ...good, markdown: "é".repeat(MAX_TEXT_BYTES / 2 + 1) },
    ])
      expect(isExtraction(bad), JSON.stringify(bad)?.slice(0, 80)).toBe(false);
  });

  it("is a refusal only as one short string under `error`", () => {
    expect(refusalOf({ error: "nothing is selected on this page" })).toBe("nothing is selected on this page");
    for (const bad of [{ error: 1 }, { error: "x", more: 1 }, { error: "x".repeat(201) }, "error", null]) expect(refusalOf(bad)).toBeNull();
  });
});

describe("running capture.js", () => {
  it("injects the file into the frame asked for, then calls its one function with the mode", async () => {
    const { api, executeScript } = scripting(good);
    expect(await extract(api, { tabId: 7, frameId: 3 }, "selection")).toEqual(good);
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript.mock.calls[0]![0]).toEqual({ target: { tabId: 7, frameIds: [3] }, files: [CAPTURE_FILE] });
    const second = executeScript.mock.calls[1]![0] as { target: unknown; func: (...a: unknown[]) => unknown; args: unknown[] };
    expect(second.target).toEqual({ tabId: 7, frameIds: [3] });
    expect(second.args).toEqual([CAPTURE_FN, "selection"]);
    // The function Chrome serializes into the tab reaches capture.js's by name, and nothing else.
    const called = vi.fn(() => good);
    (globalThis as Record<string, unknown>)[CAPTURE_FN] = called;
    expect(second.func(CAPTURE_FN, "page")).toEqual(good);
    expect(called).toHaveBeenCalledWith("page");
    delete (globalThis as Record<string, unknown>)[CAPTURE_FN];
  });

  it("says what the page refused, and refuses what isn't a capture", async () => {
    await expect(extract(scripting({ error: "nothing is selected on this page" }).api, { tabId: 7, frameId: 0 }, "selection")).rejects.toThrow("nothing is selected on this page");
    await expect(extract(scripting({ ...good, html: "<b>x</b>" }).api, { tabId: 7, frameId: 0 }, "page")).rejects.toThrow("what the page gave back wasn't a capture");
    await expect(extract(scripting(undefined).api, { tabId: 7, frameId: 0 }, "page")).rejects.toThrow("what the page gave back wasn't a capture");
  });

  it("passes on Chrome's refusal to run in the tab", async () => {
    const executeScript = vi.fn().mockRejectedValue(new Error("Cannot access contents of the page. Extension manifest must request permission to access the respective host."));
    await expect(extract({ scripting: { executeScript } } as never, { tabId: 7, frameId: 0 }, "page")).rejects.toThrow("Cannot access contents of the page");
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("gives up on a page that takes too long", async () => {
    const executeScript = vi.fn(() => new Promise(() => {}));
    await expect(extract({ scripting: { executeScript } } as never, { tabId: 7, frameId: 0 }, "page", 20)).rejects.toThrow("the page took too long to read");
  });
});

describe("a capture from an extraction", () => {
  it("carries the markdown, the title and the address, and says when it was cut", () => {
    const base = { window: 2, source: "page", at: 5 } as const;
    expect(pendingFrom(good, base)).toEqual({ window: 2, source: "page", at: 5, title: good.title, text: good.markdown, url: good.url });
    expect(pendingFrom({ ...good, cut: true }, base).note).toBe("Cut at 64 KB: the rest of the page isn't in the draft.");
    expect(pendingFrom({ ...good, markdown: "  " }, base).note).toBe("No text was found there.");
  });
});
