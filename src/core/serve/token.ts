import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../errors.js";

// The bearer token `docsworth serve` checks on every /mcp request. It persists in this
// user's state directory (outside the repo, never committable), so a paired browser
// extension keeps working across restarts; `--rotate-token` replaces it. The file is
// handled like the audit log's: a 0700 directory that isn't a symlink, a 0600 file opened
// without following links, and writes that are atomic.

export const TOKEN_FILE = "serve-token";
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

export class TokenError extends UserError {}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new TokenError(`${dir} is a symlink or not a directory; refusing to keep the serve token there`);
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** The token in `file`, or null if there is none yet. */
function readToken(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "ELOOP") throw new TokenError(`${file} is a symlink; refusing to read the serve token through it`);
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new TokenError(`${file} is not a regular file; refusing to use it as the serve token`);
    // A token others could read is a token others have: refuse it rather than quietly fix it.
    if ((st.mode & 0o077) !== 0) throw new TokenError(`${file} can be read by other users; run \`docsworth serve --rotate-token\` to replace it`);
    const token = readFileSync(fd, "utf8").trim();
    if (!TOKEN_SHAPE.test(token)) throw new TokenError(`${file} doesn't hold a serve token; run \`docsworth serve --rotate-token\``);
    return token;
  } finally {
    closeSync(fd);
  }
}

/**
 * Write a new token to `file` through a fresh 0600 file in the same directory. When the
 * token is first created, the new file is linked into place, so of two servers starting
 * at once only one token wins and both read it; a rotation renames over the old one.
 */
function writeToken(dir: string, file: string, replace: boolean): void {
  const tmp = join(dir, `.${TOKEN_FILE}.${process.pid}.${randomBytes(4).toString("hex")}`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, `${randomBytes(32).toString("base64url")}\n`);
  } finally {
    closeSync(fd);
  }
  if (replace) return renameSync(tmp, file); // replaces a symlink itself, never its target
  try {
    linkSync(tmp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; // another start won
  } finally {
    unlinkSync(tmp);
  }
}

/** The serve token kept in `dir`, created on first use, or replaced with `rotate`. */
export function loadToken(dir: string, opts: { rotate?: boolean } = {}): string {
  ensureDir(dir);
  const file = join(dir, TOKEN_FILE);
  if (opts.rotate) writeToken(dir, file, true);
  else if (readToken(file) === null) writeToken(dir, file, false);
  return readToken(file)!;
}

/** Constant-time comparison of a presented token with the expected one. */
export function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (typeof presented !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}
