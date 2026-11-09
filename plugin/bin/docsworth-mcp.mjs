#!/usr/bin/env node
// Launches the Docsworth MCP server for Claude Code.
//   DOCSWORTH_KNOWLEDGE_DIR  local clone of the knowledge repo (default: the current project)
//   DOCSWORTH_BIN            a local `docsworth` executable to use instead of the published
//                            package: an absolute path, needed to use Docsworth pro, which an
//                            npx-run CLI can't see
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

// The npm package to run. `agent-kb` on npm belongs to another publisher and nobody owns the
// bare `docsworth`: never fall back to either. Kept equal to PUBLISHED_PACKAGE in
// src/core/version.ts by test/package-name.test.ts.
const PUBLISHED_PACKAGE = "@docsworth/cli@^0.2";

// The repo reaches the server in the environment, never on the command line, which Windows
// runs through cmd.exe: a path would split at a space there, and what follows an `&` would
// run. A leading `~` is the home directory, as a shell would read it.
const dir = resolve((process.env.DOCSWORTH_KNOWLEDGE_DIR || process.cwd()).replace(/^~(?=$|[\\/])/, () => homedir()));
const env = { ...process.env, DOCSWORTH_KNOWLEDGE_DIR: dir };

// npx runs in the home directory, so a .npmrc in the project can't send `@docsworth` to
// another registry. A local CLI runs in the repo, which one too old to read the variable
// serves by default.
const [cmd, args, cwd] = process.env.DOCSWORTH_BIN
  ? [process.env.DOCSWORTH_BIN, ["mcp"], dir]
  : ["npx", ["-y", PUBLISHED_PACKAGE, "mcp"], homedir()];

// Windows starts npx, and npm's .cmd shims, only through cmd.exe: each word is quoted, so the
// `^` of the range and a space in DOCSWORTH_BIN arrive as they are. Quotes don't stop cmd.exe
// expanding %VAR% (or !VAR!), and a quote or a line break would end the word, so a
// DOCSWORTH_BIN with any of them is refused, not misread. No Windows path has them but %, !.
const windows = process.platform === "win32";
if (windows && /[%!"\x00-\x1f]/.test(cmd)) {
  process.stderr.write(`docsworth: DOCSWORTH_BIN (${JSON.stringify(cmd)}) has a %, !, " or control character, which cmd.exe would read as part of a command; use a path without them\n`);
  process.exit(1);
}
const child = windows
  ? spawn([cmd, ...args].map((w) => `"${w}"`).join(" "), { stdio: "inherit", shell: true, cwd, env })
  : spawn(cmd, args, { stdio: "inherit", cwd, env });
child.on("error", (e) => {
  process.stderr.write(`docsworth: couldn't start ${cmd}: ${e.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill(s));
