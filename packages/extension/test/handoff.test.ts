import { describe, expect, it } from "vitest";
import { type Pending, PENDING_PREFIX, PENDING_TTL_MS } from "../src/contract.js";
import { handOff } from "../src/handoff.js";
import { donePending, prunePending, takePending, writePending } from "../src/pending.js";
import { FakeArea } from "./fake-chrome.js";

// The handoff from the worker to the side panel: each capture under its own key, for its own
// window; the panel takes its own, oldest first, once per panel document, and each stays
// stored until the panel is done with it or its time is up.

const NOW = 1_800_000_000_000;
const cap = (over: Partial<Pending> = {}): Pending => ({ window: 1, source: "gmail", title: "t", text: "x", url: "https://mail.google.com/mail/u/0/", at: NOW, ...over });
const titles = (taken: { capture: Pending }[]) => taken.map((t) => t.capture.title);

/** No read asked for everything, or for a key that isn't a capture's. */
function readOnlyCaptures(area: FakeArea) {
  expect(area.reads.length).toBeGreaterThan(0);
  for (const keys of area.reads) {
    expect(keys).not.toBeNull();
    for (const k of keys!) expect(k.startsWith(PENDING_PREFIX), k).toBe(true);
  }
}

describe("pending captures", () => {
  it("keeps two quick captures apart, and gives them oldest first, with their keys", async () => {
    const area = new FakeArea();
    await writePending(area, cap({ title: "second", at: NOW + 1 }), "b").written;
    await writePending(area, cap({ title: "first" }), "a").written;
    const taken = await takePending(area, 1, NOW + 2, new Set());
    expect(taken.map((t) => [t.key, t.capture.title])).toEqual([
      ["pending:a", "first"],
      ["pending:b", "second"],
    ]);
  });

  it("leaves each capture stored until the panel is done with it, so a reloaded panel gets it again", async () => {
    const area = new FakeArea();
    await writePending(area, cap({ title: "kept" }), "a").written;
    const [taken] = await takePending(area, 1, NOW, new Set());
    expect(area.data.has("pending:a")).toBe(true);
    // The panel reloads (a new session, another token) before it's done: a new document, a new `seen`.
    expect(titles(await takePending(area, 1, NOW, new Set()))).toEqual(["kept"]);
    await donePending(area, taken!.key);
    expect(area.data.size).toBe(0);
    expect(await takePending(area, 1, NOW, new Set())).toEqual([]);
  });

  it("is done with exactly one capture, never one written since", async () => {
    const area = new FakeArea();
    await writePending(area, cap({ title: "old" }), "a").written;
    const [taken] = await takePending(area, 1, NOW, new Set());
    await writePending(area, cap({ title: "new" }), "b").written;
    await donePending(area, taken!.key);
    expect([...area.data.keys()]).toEqual(["pending:b"]);
  });

  it("takes only its own window's captures", async () => {
    const area = new FakeArea();
    await writePending(area, cap({ window: 2, title: "theirs" }), "a").written;
    await writePending(area, cap({ title: "mine" }), "b").written;
    expect(titles(await takePending(area, 1, NOW, new Set()))).toEqual(["mine"]);
    expect([...area.data.keys()].sort()).toEqual(["pending:a", "pending:b"]);
  });

  it("gives a capture once per panel, when a load and a change event race", async () => {
    const area = new FakeArea();
    await writePending(area, cap(), "a").written;
    const seen = new Set<string>();
    const [x, y] = await Promise.all([takePending(area, 1, NOW, seen), takePending(area, 1, NOW, seen)]);
    expect(x.length + y.length).toBe(1);
  });

  it("drops a capture past ten minutes, and prunes it from the store", async () => {
    const area = new FakeArea();
    await writePending(area, cap({ title: "stale", at: NOW - PENDING_TTL_MS - 1 }), "a").written;
    await writePending(area, cap({ title: "fresh" }), "b").written;
    area.data.set("pending:junk", { not: "a capture" });
    await prunePending(area, NOW);
    expect([...area.data.keys()]).toEqual(["pending:b"]);
    await writePending(area, cap({ title: "stale", at: NOW - PENDING_TTL_MS - 1 }), "c").written;
    area.data.set("pending:junk", { not: "a capture" });
    expect(titles(await takePending(area, 1, NOW, new Set()))).toEqual(["fresh"]);
    // A pull prunes too, so a capture whose alarm wasn't set still goes at the next one.
    expect([...area.data.keys()]).toEqual(["pending:b"]);
  });

  it("reads only the captures: never the token, nor a panel's session", async () => {
    const area = new FakeArea();
    area.data.set("token", "t".repeat(43));
    area.data.set("session:1", "a-session");
    await writePending(area, cap({ title: "stale", at: NOW - PENDING_TTL_MS - 1 }), "a").written;
    await writePending(area, cap(), "b").written;
    await prunePending(area, NOW);
    await takePending(area, 1, NOW, new Set());
    readOnlyCaptures(area);
    expect(area.data.has("token") && area.data.has("session:1")).toBe(true);
  });
});

describe("handOff", () => {
  function api(open: () => Promise<void>) {
    const session = new FakeArea();
    const calls: string[] = [];
    const alarms: [string, { when: number }][] = [];
    const cleared: string[] = [];
    return {
      session,
      calls,
      alarms,
      cleared,
      api: {
        sidePanel: { open: (o: { tabId: number }) => (calls.push(`open ${o.tabId}`), open()) },
        storage: {
          session: {
            getKeys: session.getKeys.bind(session),
            get: session.get.bind(session),
            set: (i: Record<string, unknown>) => (calls.push("set"), session.set(i)),
            remove: session.remove.bind(session),
          },
        },
        alarms: {
          create: (name: string, info: { when: number }) => (calls.push("alarm"), alarms.push([name, info]), Promise.resolve()),
          clear: (name: string) => (cleared.push(name), Promise.resolve(true)),
        },
      } as unknown as Parameters<typeof handOff>[0],
    };
  }

  it("opens the panel in the click's turn, then sets the alarm, then stores the capture", async () => {
    const t = api(() => Promise.resolve());
    const done = handOff(t.api, 9, cap(), "k");
    // Nothing awaited yet: only the open, which needs the click's turn.
    expect(t.calls).toEqual(["open 9"]);
    expect(await done).toEqual({ ok: true });
    expect(t.calls).toEqual(["open 9", "alarm", "set"]);
    expect(t.session.data.get("pending:k")).toEqual(cap());
  });

  it("sets an alarm for when the capture's time is up, so it goes even if nothing else happens", async () => {
    const t = api(() => Promise.resolve());
    expect(await handOff(t.api, 9, cap(), "k")).toEqual({ ok: true });
    expect(t.alarms).toEqual([["pending:k", { when: NOW + PENDING_TTL_MS + 1000 }]]);
  });

  it("never reads the token: the worker sees only captures", async () => {
    const t = api(() => Promise.resolve());
    t.session.data.set("token", "t".repeat(43));
    t.session.data.set("session:3", "a-session");
    await writePending(t.session, cap({ at: NOW - PENDING_TTL_MS - 1 }), "old").written;
    expect(await handOff(t.api, 9, cap(), "k")).toEqual({ ok: true });
    expect(t.session.data.has("pending:old")).toBe(false); // the prune ran
    readOnlyCaptures(t.session);
  });

  it("leaves nothing when the panel didn't open: no capture, no alarm", async () => {
    // A page can send messages without a click: each would otherwise leave an alarm, until
    // Chrome's limit refused real captures.
    const t = api(() => Promise.reject(new Error("`sidePanel.open()` may only be called in response to a user gesture.")));
    expect(await handOff(t.api, 9, cap(), "k")).toEqual({ ok: false, error: "`sidePanel.open()` may only be called in response to a user gesture." });
    expect(t.session.writes).toEqual([]);
    expect(t.alarms).toEqual([]);
  });

  it("leaves no capture when its alarm can't be set, so none outlives its ten minutes", async () => {
    const t = api(() => Promise.resolve());
    t.api.alarms.create = () => Promise.reject(new Error("too many alarms"));
    expect(await handOff(t.api, 9, cap(), "k")).toEqual({ ok: false, error: "too many alarms" });
    expect(t.session.writes).toEqual([]); // never stored, so no panel could have shown it
  });

  it("answers with the write's error when the store refused it", async () => {
    const t = api(() => Promise.resolve());
    t.api.storage.session.set = () => Promise.reject(new Error("quota"));
    expect(await handOff(t.api, 9, cap(), "k")).toEqual({ ok: false, error: "quota" });
    expect(t.cleared).toEqual(["pending:k"]); // its alarm goes with it
  });
});
