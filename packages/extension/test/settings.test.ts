import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SERVER, loadSettings, parsePairing, saveSettings, serverOrigin } from "../src/settings.js";
import { FakeArea } from "./fake-chrome.js";

// R15: the token lives only in storage.session, which content scripts can't read (proven in
// Chrome by chrome.e2e.test.ts). storage.local, which they can, gets the server's address alone.

const TOKEN = `test_${"t".repeat(34)}-tok`; // 43 characters, the shape of a real one
const EXT = process.env.DOCSWORTH_EXTENSION_ROOT!;

describe("the server's address", () => {
  it("is http on 127.0.0.1 or localhost, as an origin", () => {
    expect(serverOrigin("http://127.0.0.1:4747/")).toBe("http://127.0.0.1:4747");
    expect(serverOrigin(" http://localhost:9000/x#y ")).toBe("http://localhost:9000");
    for (const bad of ["https://127.0.0.1:4747", "http://127.0.0.2:4747", "http://localhost.evil.example:4747", "http://user:pw@127.0.0.1:4747", "http://example.com", "javascript:alert(1)", "127.0.0.1:4747"])
      expect(serverOrigin(bad), bad).toBeNull();
  });

  it("comes with the token when the printed link is pasted", () => {
    expect(parsePairing(`http://127.0.0.1:4747/#t=${TOKEN}`)).toEqual({ server: "http://127.0.0.1:4747", token: TOKEN });
    expect(parsePairing(` ${TOKEN} `)).toEqual({ token: TOKEN });
    for (const bad of ["", "hello", `https://evil.example/#t=${TOKEN}`, `http://127.0.0.1:4747/?t=${TOKEN}`, TOKEN.slice(1)]) expect(parsePairing(bad), bad).toBeNull();
  });
});

describe("saving the settings", () => {
  it("puts the token in storage.session and only the address in storage.local", async () => {
    const local = new FakeArea();
    const session = new FakeArea();
    await saveSettings({ local, session }, "http://localhost:4800", TOKEN);
    expect(Object.fromEntries(local.data)).toEqual({ server: "http://localhost:4800" });
    expect(session.data.get("token")).toBe(TOKEN);
    expect(JSON.stringify(local.writes)).not.toContain(TOKEN);
    expect(await loadSettings({ local, session })).toEqual({ server: "http://localhost:4800", token: TOKEN });
    await saveSettings({ local, session }, "http://localhost:4800", null);
    expect(session.data.has("token")).toBe(false);
  });

  it("starts every panel over on a new token, and forgets the captures with the token", async () => {
    const local = new FakeArea();
    const session = new FakeArea();
    const seed = () => {
      session.data.set("token", TOKEN);
      session.data.set("session:3", "mcp-session-id");
      session.data.set("pending:a", { title: "an email thread" });
    };
    seed();
    await saveSettings({ local, session }, DEFAULT_SERVER, TOKEN);
    expect([...session.data.keys()].sort()).toEqual(["pending:a", "token"]);
    seed();
    await saveSettings({ local, session }, DEFAULT_SERVER, null);
    expect([...session.data.keys()]).toEqual([]);
  });

  it("refuses a server it may not call and a value that isn't a token", async () => {
    const areas = { local: new FakeArea(), session: new FakeArea() };
    await expect(saveSettings(areas, "https://evil.example", TOKEN)).rejects.toThrow("the server must be http://127.0.0.1:<port> or http://localhost:<port>");
    await expect(saveSettings(areas, DEFAULT_SERVER, "not-a-token")).rejects.toThrow("that isn't a docsworth serve token");
    expect(areas.local.writes).toEqual([]);
  });

  it("falls back to the default server and no token when what's stored is wrong", async () => {
    const local = new FakeArea();
    const session = new FakeArea();
    local.data.set("server", "https://evil.example");
    session.data.set("token", "short");
    expect(await loadSettings({ local, session })).toEqual({ server: DEFAULT_SERVER, token: null });
  });

  it("is the only code that touches storage.local, and it writes only the address there", () => {
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    const users = walk(join(EXT, "src")).filter((f) => readFileSync(f, "utf8").includes("storage.local") || /\blocal\.set\(/.test(readFileSync(f, "utf8")));
    expect(users.map((f) => relative(EXT, f))).toEqual(["src/settings.ts"]);
    const sets = readFileSync(join(EXT, "src/settings.ts"), "utf8").match(/local\.set\([^)]*\)/g);
    expect(sets).toEqual(["local.set({ [SERVER]: origin })"]);
  });
});
