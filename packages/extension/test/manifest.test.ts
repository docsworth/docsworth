import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// R15: what the extension may do is exactly what the manifest grants. Each line here is a
// permission or exposure the plan decided on; a change to one is a change to this test.

const EXT = process.env.DOCSWORTH_EXTENSION_ROOT!;
const manifest = JSON.parse(readFileSync(join(EXT, "public/manifest.json"), "utf8"));

describe("the manifest", () => {
  it("asks for exactly the side panel, storage, the context menu and alarms", () => {
    expect(manifest.manifest_version).toBe(3);
    // alarms: a capture's time limit is kept even if nothing else happens (handoff.ts).
    expect(manifest.permissions).toEqual(["sidePanel", "storage", "contextMenus", "alarms"]);
    // 130: storage.session.getKeys(), so the worker lists the captures without reading the token.
    expect(manifest.minimum_chrome_version).toBe("130");
    expect(manifest.optional_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toBeUndefined();
  });

  it("reaches only the local server, and runs in Gmail's top frame alone", () => {
    expect(manifest.host_permissions).toEqual(["http://127.0.0.1/*", "http://localhost/*"]);
    expect(manifest.content_scripts).toEqual([{ matches: ["https://mail.google.com/*"], js: ["gmail.js"], run_at: "document_idle", all_frames: false }]);
  });

  it("exposes nothing to pages or other extensions", () => {
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
  });

  it("lets its pages run only its own scripts and connect only to the local server", () => {
    const csp: string = manifest.content_security_policy.extension_pages;
    const directives = Object.fromEntries(csp.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v]));
    expect(directives["script-src"]).toEqual(["'self'"]);
    expect(directives["default-src"]).toEqual(["'self'"]);
    expect(directives["connect-src"]).toEqual(["http://127.0.0.1:*", "http://localhost:*"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
    expect(csp).not.toMatch(/unsafe|https?:\/\/(?!127\.0\.0\.1|localhost)/);
  });

  it("pins storage.session to trusted contexts in the worker, rather than lean on Chrome's default", () => {
    const worker = readFileSync(join(EXT, "src/background.ts"), "utf8");
    expect(worker).toContain('chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })');
  });
});
