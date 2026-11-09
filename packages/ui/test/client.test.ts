import { describe, expect, it } from "vitest";
import { DocsworthClient, DocsworthError } from "../src/client.js";

/** A scripted server: answers each JSON-RPC method, and records what was sent. */
function fakeServer(handlers: { [method: string]: (body: any, n: number) => Response | Promise<Response> }) {
  const seen: { method: string; headers: Record<string, string>; body: any }[] = [];
  let sessions = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    if (init?.method === "DELETE") {
      seen.push({ method: "DELETE", headers, body: null });
      return new Response(null, { status: 200 });
    }
    const body = JSON.parse(String(init?.body));
    seen.push({ method: body.method, headers, body });
    if (body.method === "initialize") {
      sessions++;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { headers: { "mcp-session-id": `s${sessions}`, "content-type": "application/json" } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return handlers[body.method]!(body, seen.length);
  };
  return { fetchImpl, seen, sessions: () => sessions };
}

const json = (status: number, value: object) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const toolResult = (id: number, result: object) => json(200, { jsonrpc: "2.0", id, result });

describe("DocsworthClient", () => {
  it("opens one session for concurrent calls, and sends the token and session on each", async () => {
    const s = fakeServer({ "tools/call": (b) => toolResult(b.id, { structuredContent: { echo: b.params.name } }) });
    const c = new DocsworthClient({ url: "http://127.0.0.1:4747", token: "tok", fetch: s.fetchImpl });
    const [a, b] = await Promise.all([c.call<{ echo: string }>("ui_overview"), c.call<{ echo: string }>("ui_graph")]);
    expect([a.echo, b.echo]).toEqual(["ui_overview", "ui_graph"]);
    expect(s.sessions()).toBe(1);
    const calls = s.seen.filter((x) => x.method === "tools/call");
    for (const call of calls) expect(call.headers).toMatchObject({ authorization: "Bearer tok", "mcp-session-id": "s1", "mcp-protocol-version": "2025-06-18" });
    expect(s.seen[0]!.body.params.clientInfo.name).toBe("docsworth-web");
  });

  it("throws a tool's structured error with its code and words", async () => {
    const s = fakeServer({ "tools/call": (b) => toolResult(b.id, { isError: true, structuredContent: { error: { code: "not_found", message: "no page with id `x`" } } }) });
    const c = new DocsworthClient({ url: "http://127.0.0.1:4747", token: "t", fetch: s.fetchImpl });
    await expect(c.call("read", { id: "x" })).rejects.toMatchObject({ code: "not_found", message: "no page with id `x`" });
  });

  it("reads a tool the policy disabled (the SDK's plain-text refusal) as forbidden", async () => {
    const s = fakeServer({ "tools/call": (b) => toolResult(b.id, { isError: true, content: [{ type: "text", text: "MCP error -32602: Tool ui_graph disabled" }] }) });
    const c = new DocsworthClient({ url: "http://127.0.0.1:4747", token: "t", fetch: s.fetchImpl });
    const err = await c.call("ui_graph").catch((e: unknown) => e as DocsworthError);
    expect(err).toBeInstanceOf(DocsworthError);
    expect(err).toMatchObject({ code: "forbidden", message: "Tool ui_graph disabled" });
  });

  it("starts a new session once when the server has expired it, and only once", async () => {
    let calls = 0;
    const s = fakeServer({ "tools/call": (b) => (++calls === 1 ? json(404, { error: { code: "not_found", message: "no such session" } }) : toolResult(b.id, { structuredContent: { ok: true } })) });
    const c = new DocsworthClient({ url: "http://127.0.0.1:4747", token: "t", fetch: s.fetchImpl });
    expect(await c.call("ui_overview")).toEqual({ ok: true });
    expect(s.sessions()).toBe(2);
    const always404 = fakeServer({ "tools/call": () => json(404, { error: { code: "not_found", message: "no such session" } }) });
    const d = new DocsworthClient({ url: "http://127.0.0.1:4747", token: "t", fetch: always404.fetchImpl });
    await expect(d.call("ui_overview")).rejects.toMatchObject({ code: "session_expired" });
    expect(always404.sessions()).toBe(2);
  });

  it("ends the tab when a session that answered is lost: nothing is retried in a new one, a write included", async () => {
    // A new session holds none of the reads behind what the tab shows, so it would pass the
    // taint check a tainted tab must fail (docs/security-model.md).
    let expired = false;
    const s = fakeServer({ "tools/call": (b) => (expired ? json(404, { error: { code: "not_found", message: "no such session" } }) : toolResult(b.id, { structuredContent: { ok: true } })) });
    let lost = 0;
    const c = new DocsworthClient({ url: "http://127.0.0.1:4747", token: "t", fetch: s.fetchImpl, onSessionLost: () => lost++ });
    expect(await c.call("ui_page", { id: "security-runbook" })).toEqual({ ok: true });
    expired = true;
    await expect(c.call("draft_page", { title: "x" })).rejects.toMatchObject({ code: "session_expired" });
    expired = false; // even a server that would answer again gets nothing more from this tab
    const sent = s.seen.length;
    await expect(c.call("draft_page", { title: "x" })).rejects.toMatchObject({ code: "session_expired" });
    expect(s.seen.length).toBe(sent);
    expect(s.sessions()).toBe(1);
    expect(lost).toBe(1);
    expect(s.seen.filter((x) => x.body?.params?.name === "draft_page")).toHaveLength(1);
  });

  /**
   * A tab reloaded with a kept session ("old") the server has forgotten. Calls on it can be
   * held, to order an answer from "old" against a call that found "old" gone and started over.
   */
  function rollover() {
    const held = new Map<string, { status: number; release: () => void; done: Promise<void> }>();
    const hold = (tool: string, status: number) => {
      let release!: () => void;
      const done = new Promise<void>((r) => (release = r));
      held.set(tool, { status, release, done });
      return release;
    };
    let releaseInit: (() => void) | null = null;
    let initRequested!: () => void;
    const initSeen = new Promise<void>((r) => (initRequested = r));
    let sessions = 0;
    const sent: { tool: string; session?: string }[] = [];
    const deleted: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const session = ((init?.headers ?? {}) as Record<string, string>)["mcp-session-id"];
      if (init?.method === "DELETE") {
        deleted.push(session!);
        return new Response(null, { status: 200 });
      }
      const body = JSON.parse(String(init?.body));
      if (body.method === "initialize") {
        initRequested();
        if (releaseInit) await new Promise<void>((r) => (releaseInit = r));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }), { headers: { "mcp-session-id": `s${++sessions}`, "content-type": "application/json" } });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      sent.push({ tool: body.params.name, session });
      const h = session === "old" ? held.get(body.params.name) : undefined;
      if (h) {
        await h.done;
        return h.status === 200 ? toolResult(body.id, { structuredContent: { from: "old" } }) : json(404, { error: { code: "not_found", message: "no such session" } });
      }
      if (session === "old") return json(404, { error: { code: "not_found", message: "no such session" } });
      return toolResult(body.id, { structuredContent: { from: session } });
    };
    const holdInit = () => {
      releaseInit = () => undefined; // marks the next initialize to wait; replaced by its resolver
      return () => releaseInit!();
    };
    let lost = 0;
    const client = new DocsworthClient({ url: "http://127.0.0.1:4747", token: "t", fetch: fetchImpl, session: "old", onSessionLost: () => lost++ });
    return { client, hold, holdInit, initSeen, sent, deleted, lost: () => lost };
  }

  it("never shows an answer from a session the tab has since left: the tab ends instead", async () => {
    const r = rollover();
    const releaseB = r.hold("ui_overview", 200); // answered on "old", but slowly
    const b = r.client.call("ui_overview");
    expect(await r.client.call("ui_page", { id: "x" })).toEqual({ from: "s1" }); // found "old" gone, started over
    releaseB();
    await expect(b).rejects.toMatchObject({ code: "session_expired" });
    expect(r.lost()).toBe(1);
    await expect(r.client.call("draft_page", { title: "x" })).rejects.toMatchObject({ code: "session_expired" });
    expect(r.sent.filter((x) => x.tool === "draft_page")).toEqual([]);
  });

  it("runs nothing in a new session once an answer from the old one has arrived", async () => {
    const r = rollover();
    const releaseB = r.hold("ui_overview", 200);
    const releaseInit = r.holdInit();
    const b = r.client.call("ui_overview");
    const a = r.client.call("draft_page", { title: "x" }); // "old" gone: waits for a new session
    await r.initSeen;
    releaseB(); // the old session's answer arrives while the new one opens
    await expect(b).rejects.toMatchObject({ code: "session_expired" });
    releaseInit();
    await expect(a).rejects.toMatchObject({ code: "session_expired" });
    expect(r.sent.filter((x) => x.tool === "draft_page" && x.session !== "old")).toEqual([]);
    expect(r.deleted).toEqual(["s1"]); // the session that opened too late is closed
  });

  it("sends nothing for a call whose tab ended between its session and its send", async () => {
    const r = rollover();
    expect(await r.client.call("ui_page", { id: "x" })).toEqual({ from: "s1" });
    const a = r.client.call("draft_page", { title: "x" }); // its session is ready; its send is a turn away
    (r.client as unknown as { end(): void }).end(); // what an answer from a left session does, in that turn
    await expect(a).rejects.toMatchObject({ code: "session_expired" });
    expect(r.sent.filter((x) => x.tool === "draft_page")).toEqual([]);
  });

  it("runs a call refused on a session the tab already left in the current one, without ending the tab", async () => {
    const r = rollover();
    const releaseB = r.hold("ui_overview", 404); // refused on "old", but only after the tab moved on
    const b = r.client.call("ui_overview");
    expect(await r.client.call("ui_page", { id: "x" })).toEqual({ from: "s1" });
    releaseB();
    expect(await b).toEqual({ from: "s1" });
    expect(r.lost()).toBe(0);
  });

  it("keeps a session only once it is acknowledged, closing one that wasn't", async () => {
    let refuseAck = true;
    const s = fakeServer({ "tools/call": (b) => toolResult(b.id, { structuredContent: { ok: true } }) });
    const acking: typeof fetch = async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (refuseAck && body?.method === "notifications/initialized") {
        refuseAck = false;
        return json(500, { error: { code: "internal", message: "try again" } });
      }
      return s.fetchImpl(url, init);
    };
    const kept: string[] = [];
    const c = new DocsworthClient({ url: "http://127.0.0.1:4747", token: "t", fetch: acking, onSession: (id) => kept.push(id) });
    await expect(c.call("ui_overview")).rejects.toMatchObject({ code: "internal" });
    expect(s.seen.at(-1)).toMatchObject({ method: "DELETE", headers: { "mcp-session-id": "s1" } });
    expect(await c.call("ui_overview")).toEqual({ ok: true });
    const inits = s.seen.filter((x) => x.method === "initialize");
    expect(inits).toHaveLength(2);
    expect(inits[1]!.headers["mcp-session-id"]).toBeUndefined();
    expect(kept).toEqual(["s2"]);
  });

  it("says the link's token was refused on a 401, and lets a later call try again", async () => {
    let refuse = true;
    const fetchImpl: typeof fetch = async (url, init) => {
      if (refuse) return json(401, { error: { code: "unauthorized", message: "a valid bearer token is required" } });
      return fakeServer({ "tools/call": (b) => toolResult(b.id, { structuredContent: { ok: true } }) }).fetchImpl(url, init);
    };
    const c = new DocsworthClient({ url: "http://127.0.0.1:4747", token: "bad", fetch: fetchImpl });
    await expect(c.call("ui_capabilities")).rejects.toMatchObject({ code: "unauthorized" });
    refuse = false;
    await expect(c.call("ui_capabilities")).resolves.toEqual({ ok: true });
  });

  it("reuses a session the tab kept, and reports a new one when it has expired", async () => {
    let calls = 0;
    const s = fakeServer({ "tools/call": (b) => (++calls === 1 ? json(404, { error: { code: "not_found", message: "expired" } }) : toolResult(b.id, { structuredContent: { ok: true } })) });
    const kept: string[] = [];
    const c = new DocsworthClient({ url: "http://127.0.0.1:4747", token: "t", fetch: s.fetchImpl, session: "old", onSession: (id) => kept.push(id) });
    expect(await c.call("ui_overview")).toEqual({ ok: true });
    expect(s.seen[0]).toMatchObject({ method: "tools/call", headers: { "mcp-session-id": "old" } }); // no initialize first
    expect(kept).toEqual(["s1"]);
  });

  it("recovers from an expired session once for concurrent calls, opening one new session", async () => {
    const s = fakeServer({
      "tools/call": (b) => (b.__session === "old" ? json(404, { error: { code: "not_found", message: "expired" } }) : toolResult(b.id, { structuredContent: { ok: true } })),
    });
    // The fake doesn't see headers in handlers; tag each body with the session it was sent on.
    const tagging: typeof fetch = (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (init?.body && typeof init.body === "string") {
        const body = JSON.parse(init.body);
        body.__session = headers["mcp-session-id"];
        init = { ...init, body: JSON.stringify(body) };
      }
      return s.fetchImpl(url, init);
    };
    const c = new DocsworthClient({ url: "http://127.0.0.1:4747", token: "t", fetch: tagging, session: "old" });
    const results = await Promise.all([c.call("ui_capabilities"), c.call("ui_overview"), c.call("ui_graph")]);
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(s.sessions()).toBe(1);
  });

  it("ends the session with DELETE", async () => {
    const s = fakeServer({ "tools/call": (b) => toolResult(b.id, { structuredContent: {} }) });
    const c = new DocsworthClient({ url: "http://127.0.0.1:4747", token: "t", fetch: s.fetchImpl });
    await c.call("ui_capabilities");
    await c.close();
    expect(s.seen.at(-1)).toMatchObject({ method: "DELETE", headers: { "mcp-session-id": "s1" } });
  });
});
