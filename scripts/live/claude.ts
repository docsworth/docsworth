// Run a headless Claude Code session with the Docsworth plugin loaded from ./plugin and
// the MCP server pointed at a local build (DOCSWORTH_BIN), returning the final result and
// every tool call made. Uses the caller's own Claude Code login.
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const TOOL = (name: string) => `mcp__plugin_docsworth_docsworth__${name}`;
export const READ_TOOLS = ["search", "read", "list", "stale"].map(TOOL);

export interface ClaudeRun {
  result: string;
  /** e.g. "success", "error_max_turns". */
  subtype: string;
  /** Tool calls Claude Code refused for lack of permission. */
  denials: { tool_name: string; tool_input: unknown }[];
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  /** What each tool call returned, by the call's id. */
  toolResults: Map<string, { isError: boolean; text: string }>;
  seconds: number;
  exitCode: number | null;
}

/** A PATH entry with `docsworth` pointing at the local build, as an installed package would. */
export function docsworthOnPath(): string {
  const bin = mkdtempSync(join(tmpdir(), "docsworth-bin-"));
  const shim = join(bin, "docsworth");
  writeFileSync(shim, `#!/bin/sh\nexec "${resolve("dist/cli.js")}" "$@"\n`);
  chmodSync(shim, 0o755);
  return bin;
}

export function runClaude(cwd: string, prompt: string, opts: { allowedTools: string[]; env?: Record<string, string>; maxTurns?: number }): Promise<ClaudeRun> {
  const t0 = Date.now();
  const args = [
    "-p",
    prompt,
    "--plugin-dir",
    resolve("plugin"),
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(opts.maxTurns ?? 30),
    "--allowedTools",
    opts.allowedTools.join(","),
  ];
  return new Promise((done) => {
    const child = spawn("claude", args, {
      cwd,
      env: { ...process.env, DOCSWORTH_BIN: resolve("dist/cli.js"), PATH: `${docsworthOnPath()}:${process.env.PATH}`, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    const run: ClaudeRun = { result: "", subtype: "", denials: [], toolCalls: [], toolResults: new Map(), seconds: 0, exitCode: null };
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line) as {
            type: string;
            subtype?: string;
            result?: string;
            permission_denials?: ClaudeRun["denials"];
            message?: {
              content?: { type: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean; content?: unknown }[];
            };
          };
          if (msg.type === "assistant")
            for (const c of msg.message?.content ?? []) if (c.type === "tool_use") run.toolCalls.push({ id: c.id ?? "", name: c.name!, input: c.input ?? {} });
          if (msg.type === "user")
            for (const c of msg.message?.content ?? [])
              if (c.type === "tool_result" && c.tool_use_id) {
                const text = typeof c.content === "string" ? c.content : ((c.content as { text?: string }[] | undefined) ?? []).map((x) => x.text ?? "").join("");
                run.toolResults.set(c.tool_use_id, { isError: Boolean(c.is_error), text });
              }
          if (msg.type === "result") Object.assign(run, { result: msg.result ?? "", subtype: msg.subtype ?? "", denials: msg.permission_denials ?? [] });
        } catch {
          /* non-JSON line */
        }
      }
    });
    child.on("close", (code) => done({ ...run, exitCode: code, seconds: Math.round((Date.now() - t0) / 100) / 10 }));
  });
}
