import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadToken, TOKEN_FILE, TokenError, tokenMatches } from "../src/core/serve/token.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "docsworth-token-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const mode = (p: string) => statSync(p).mode & 0o777;

describe("serve token file (R10)", () => {
  it("creates a 0600 token in a 0700 directory, and returns the same one next time", () => {
    const dir = join(scratch(), "state");
    const t = loadToken(dir);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, TOKEN_FILE))).toBe(0o600);
    expect(loadToken(dir)).toBe(t);
    expect(readdirSync(dir)).toEqual([TOKEN_FILE]); // no temporary file left behind
  });

  it("tightens a directory others can read", () => {
    const dir = join(scratch(), "state");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    loadToken(dir);
    expect(mode(dir)).toBe(0o700);
  });

  it("rotates to a new token, atomically and still 0600", () => {
    const dir = join(scratch(), "state");
    const old = loadToken(dir);
    const next = loadToken(dir, { rotate: true });
    expect(next).not.toBe(old);
    expect(loadToken(dir)).toBe(next);
    expect(mode(join(dir, TOKEN_FILE))).toBe(0o600);
    expect(readdirSync(dir)).toEqual([TOKEN_FILE]);
  });

  it("refuses a token file that is a symlink, and doesn't read through it", () => {
    const root = scratch();
    const dir = join(root, "state");
    mkdirSync(dir, { mode: 0o700 });
    const target = join(root, "elsewhere");
    writeFileSync(target, `${"a".repeat(43)}\n`, { mode: 0o600 });
    symlinkSync(target, join(dir, TOKEN_FILE));
    expect(() => loadToken(dir)).toThrow(TokenError);
    expect(() => loadToken(dir)).toThrow(/is a symlink; refusing to read the serve token through it/);
  });

  it("refuses a state directory that is a symlink", () => {
    const root = scratch();
    mkdirSync(join(root, "real"), { mode: 0o700 });
    symlinkSync(join(root, "real"), join(root, "state"));
    expect(() => loadToken(join(root, "state"))).toThrow(/is a symlink or not a directory; refusing to keep the serve token there/);
  });

  it("refuses a token path that is not a regular file", () => {
    const dir = join(scratch(), "state");
    mkdirSync(join(dir, TOKEN_FILE), { recursive: true });
    expect(() => loadToken(dir)).toThrow(/is not a regular file; refusing to use it as the serve token/);
  });

  it("refuses a token other users can read, rather than quietly trusting it", () => {
    const dir = join(scratch(), "state");
    loadToken(dir);
    chmodSync(join(dir, TOKEN_FILE), 0o644);
    expect(() => loadToken(dir)).toThrow(/can be read by other users; run `docsworth serve --rotate-token`/);
    // Rotation is the way out: a fresh 0600 file replaces it.
    expect(loadToken(dir, { rotate: true })).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mode(join(dir, TOKEN_FILE))).toBe(0o600);
  });

  it("refuses a file that holds something other than a token", () => {
    const dir = join(scratch(), "state");
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, TOKEN_FILE), "hunter2\n", { mode: 0o600 });
    expect(() => loadToken(dir)).toThrow(/doesn't hold a serve token/);
  });

  it("gives every server started at once the same token", async () => {
    const dir = join(scratch(), "state");
    const script = `import { loadToken } from ${JSON.stringify(resolve("src/core/serve/token.ts"))}; process.stdout.write(loadToken(${JSON.stringify(dir)}));`;
    const run = () =>
      new Promise<string>((done, fail) => {
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (d: Buffer) => (out += d));
        child.stderr.on("data", (d: Buffer) => (err += d));
        child.on("close", (code) => (code === 0 ? done(out) : fail(new Error(err))));
      });
    const tokens = await Promise.all([run(), run(), run(), run(), run(), run()]);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).toBe(loadToken(dir));
    expect(readdirSync(dir)).toEqual([TOKEN_FILE]);
  }, 30_000);

  it("compares tokens in full: a prefix, a longer string or nothing never matches", () => {
    const t = "a".repeat(43);
    expect(tokenMatches(t, t)).toBe(true);
    expect(tokenMatches(t, t.slice(1))).toBe(false);
    expect(tokenMatches(t, `${t}a`)).toBe(false);
    expect(tokenMatches(t, "")).toBe(false);
    expect(tokenMatches(t, undefined)).toBe(false);
  });
});
