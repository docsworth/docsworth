import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_IDENTITY } from "../src/core/identity.js";
import { createMcpServer } from "../src/core/mcp/server.js";
import { toolRefusal } from "../src/core/policy.js";
import { KnowledgeService } from "../src/core/service.js";
import { FIELD_CHECKS, TOOLS, toolSpec, WRITE_TOOLS } from "../src/core/tool-registry.js";
import { copyAcme, fixedIdentity, NOW } from "./helpers.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

describe("tool registry", () => {
  it("names exactly the tools a stdio server registers", async () => {
    const acme = copyAcme();
    cleanups.push(acme.cleanup);
    const service = new KnowledgeService(acme.root, fixedIdentity(LOCAL_IDENTITY), () => NOW);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createMcpServer(service).connect(serverSide);
    const client = new Client({ name: "registry-test", version: "0" });
    await client.connect(clientSide);
    cleanups.push(() => void client.close());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.filter((t) => t.surface === "all").map((t) => t.name).sort());
    // A tool that writes is annotated as one, and the other way round.
    for (const t of tools) expect(t.annotations?.readOnlyHint === true).toBe(!WRITE_TOOLS.has(t.name));
  });

  it("has a shape check for every argument it lets the audit log record", () => {
    for (const t of TOOLS) for (const f of t.auditFields) expect(FIELD_CHECKS[f], `${t.name}.${f}`).toBeTypeOf("function");
  });

  it("knows no tool by a name that only looks like an object property", () => {
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) expect(toolSpec(name)).toBeUndefined();
  });

  it("makes the policy refuse a name that is no tool, so an unregistered tool fails closed", () => {
    const policy = { tools: {}, writes: "enabled", require_human_approval: false, include_stale: "allowed", identity_cache_seconds: 300 } as const;
    expect(toolRefusal(policy, "acme", "search", LOCAL_IDENTITY)).toBeNull();
    expect(toolRefusal(policy, "acme", "ui_secret", LOCAL_IDENTITY)).toBe("no tool called `ui_secret`");
    expect(toolRefusal(policy, "acme", "__proto__", LOCAL_IDENTITY)).toBe("no tool called `__proto__`");
  });
});
