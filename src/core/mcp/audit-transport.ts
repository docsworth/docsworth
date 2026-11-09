import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { Identity } from "../acl.js";
import { type AuditEvent, type AuditInput, type AuditLog, actorOf, AuditUnavailable, redactSecret } from "../audit-log.js";
import { FIELD_CHECKS, toolSpec, WRITE_TOOLS } from "../tool-registry.js";

// Audit at the JSON-RPC boundary rather than in each tool handler, so calls the SDK
// rejects before any handler runs (unknown tool, malformed arguments, disabled tool) are
// recorded too. Works for any transport (stdio today, HTTP later).

// Which arguments each tool may record, their shapes, which tools write and which page
// ids a response returned all come from the tool registry (src/core/tool-registry.ts).
const MAX = 200;
/** Client-chosen strings that reach the log must look like what they claim to be. */
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
/** A product name ("claude-code") and a version ("2.1.309"): short, no spaces, no long random runs. */
const CLIENT_NAME = /^[a-z][a-z0-9._-]{0,39}$/i;
const CLIENT_VERSION = /^[0-9][0-9a-z.+-]{0,31}$/i;
const RANDOM_RUN = /[a-z0-9]{20,}/i;
const label = (v: unknown, shape: RegExp) => (typeof v === "string" && shape.test(v) && !RANDOM_RUN.test(v) ? redactSecret(v) : "<invalid>");



type Structured = Record<string, any>;

/** The repo's own vocabulary: the only free-form strings a recorded argument may hold. */
export interface KnownValues {
  ids: ReadonlySet<string>;
  teams: ReadonlySet<string>;
  tags: ReadonlySet<string>;
}
/** Which closed set each free-form field must come from. */
const CLOSED: Record<string, keyof KnownValues> = Object.assign(Object.create(null) as Record<string, keyof KnownValues>, { id: "ids", owner_team: "teams", acl: "teams", applies_to: "tags" });

function safeArgs(tool: string, raw: unknown, query: boolean, known: KnownValues | undefined): AuditEvent["args"] {
  if (!raw || typeof raw !== "object") return undefined;
  const fields = toolSpec(tool)?.auditFields;
  if (!fields) return undefined; // unknown tool: record none of its arguments
  const out: Record<string, string | number | boolean> = {};
  for (const k of fields) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (!FIELD_CHECKS[k]!(v)) out[k] = "<invalid>";
    else if (typeof v !== "string") out[k] = v as number | boolean;
    // A free-form value is recorded only if it's one the repo itself uses (a real page id,
    // a team, a tag), so nothing a caller typed (a pasted token) can reach the log.
    else if (CLOSED[k]) out[k] = known?.[CLOSED[k]!].has(v) ? v : "<unknown>";
    else out[k] = redactSecret(v); // `type` (an enum) and `path` (withheld unless shown)
  }
  // Query text only when the operator opted in, and only for search.
  const q = (raw as Record<string, unknown>).query;
  if (query && tool === "search" && typeof q === "string") out.query = redactSecret(q.slice(0, 500));
  return Object.keys(out).length ? out : undefined;
}

/** Page ids and PR links from a successful response. The service already filtered it by ACL. */
function idsIn(tool: string, sc: Structured | undefined): Pick<AuditEvent, "returned" | "excluded" | "pr_url"> {
  return sc ? (toolSpec(tool)?.returned(sc) ?? {}) : {};
}

/** Errors the SDK produces before a handler runs carry text, not our structured `{error}`. */
function sdkErrorCode(text: string): string {
  if (/ not found$/.test(text)) return "unknown_tool";
  if (/ disabled$/.test(text)) return "forbidden";
  return "invalid";
}

/** `audit.degraded`: the caller is told when the log may not match what happened. */
function unavailable(id: RequestId, message: string, degraded?: string): JSONRPCMessage {
  const error = { error: { code: "unavailable", message }, ...(degraded ? { audit: { degraded: true, reason: degraded } } : {}) };
  return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify(error) }], structuredContent: error } };
}

/** The same response, with `audit: { degraded, reason }` added where the caller will see it. */
function withDegraded(message: JSONRPCMessage, reason: string): JSONRPCMessage {
  if (!isJSONRPCResultResponse(message)) return message;
  const result = message.result as Structured;
  const sc = { ...((result.structuredContent as Structured | undefined) ?? {}), audit: { degraded: true, reason } };
  return { ...message, result: { ...result, structuredContent: sc, content: [{ type: "text", text: JSON.stringify(sc, null, 2) }] } };
}

export function auditTransport(
  inner: Transport,
  audit: AuditLog,
  whoami: () => Promise<Identity>,
  opts: {
    includeQueries: boolean;
    log?: (msg: string) => void;
    initialActor?: AuditEvent["actor"];
    known?: () => KnownValues;
    snapshot?: () => NonNullable<AuditEvent["snapshot"]>;
  },
): Transport {
  const log = opts.log ?? ((m: string) => process.stderr.write(`docsworth: ${m}\n`));
  const pending = new Map<RequestId, { tool: string; args: unknown }>();
  let client: AuditEvent["client"];

  // When identity can't be resolved, attribute the event to the last identity this
  // session resolved, and say so, rather than to no one. `whoami` must be the session's
  // own identity source (the one the service dispatches with): one token per stdio
  // process, one per remote session. So the last resolved actor is the same principal.
  // Seeded with the identity proven at server start, so even the first call can be named.
  let lastActor: AuditEvent["actor"] = opts.initialActor;
  const actor = async (): Promise<Pick<AuditEvent, "actor" | "detail">> => {
    try {
      lastActor = actorOf(await whoami());
      return { actor: lastActor };
    } catch {
      return { ...(lastActor ? { actor: lastActor } : {}), detail: { actor_unresolved: true } };
    }
  };
  const base = async (tool: string, args: unknown): Promise<AuditInput> => ({
    kind: "tool_call",
    ...(opts.snapshot ? { snapshot: opts.snapshot() } : {}),
    ...(await actor()),
    ...(client ? { client } : {}),
    tool: toolSpec(tool) ? tool : TOOL_NAME.test(tool) ? "<unknown>" : "<invalid>", // only this server's tool names
    ...(safeArgs(tool, args, opts.includeQueries, opts.known?.()) ? { args: safeArgs(tool, args, opts.includeQueries, opts.known?.()) } : {}),
  });

  /**
   * Tell every sink that recorded event `err.seq` that it never reached the caller, and
   * wait for it: the refusal is sent only after. If a sink can't take the correction
   * either, say so on stderr. (A crash between the event and its correction can still
   * leave the event uncorrected; the event records what the server decided to answer.)
   */
  /** Returns why the log may now be wrong (a correction that didn't land), or null. */
  const correct = async (event: AuditInput, err: unknown): Promise<string | null> => {
    const seq = err instanceof AuditUnavailable ? err.seq : undefined;
    const { returned: _r, excluded: _x, pr_url: _p, ...rest } = event;
    const only = err instanceof AuditUnavailable ? err.accepted : undefined;
    if (!only || only.required.length + only.optional.length === 0) return null; // nothing recorded it
    try {
      await audit.emit({ ...rest, kind: "tool_call", outcome: "error", code: "audit_unavailable", detail: { ...(rest.detail ?? {}), withheld_seq: seq ?? null } }, { only });
      return null;
    } catch (e) {
      const why = `event ${seq} was recorded by ${only.required.map((x) => x.name).join(", ") || "an optional sink"} but its correction couldn't be: that log may show this call as answered`;
      log(`${why} (${(e as Error).message})`);
      return why;
    }
  };

  async function sendAudited(id: RequestId, call: { tool: string; args: unknown }, message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
    {
      const event = await base(call.tool, call.args);
      if (isJSONRPCErrorResponse(message)) {
        Object.assign(event, { outcome: "error", code: `jsonrpc_${message.error.code}` });
      } else if (isJSONRPCResultResponse(message)) {
        const result = message.result as Structured;
        const sc = result.structuredContent as Structured | undefined;
        // A directory path is recorded only when the call showed it to the caller; a path
        // that didn't resolve may name a hidden directory (ids typed are the one exception).
        if (result.isError && event.args?.path !== undefined) event.args = { ...event.args, path: "<withheld>" };
        if (result.isError) {
          const code = typeof sc?.error?.code === "string" ? sc.error.code : sdkErrorCode(String(result.content?.[0]?.text ?? ""));
          Object.assign(event, { outcome: code === "forbidden" ? "denied" : "error", code });
        } else Object.assign(event, { outcome: "ok", ...idsIn(call.tool, sc) });
      }

      try {
        await audit.emit(event);
      } catch (err) {
        if (!WRITE_TOOLS.has(call.tool)) {
          // Fail closed: a read whose access can't be recorded is not answered. Sinks that
          // took the "ok" event get a correction saying the response was withheld.
          const degraded = await correct(event, err);
          return inner.send(unavailable(id, (err as Error).message, degraded ?? undefined), options);
        }
        // The PR already exists and its intent was recorded. The write can't be undone, so
        // the result goes out, marked: the caller learns its outcome isn't in the log.
        const reason = `the outcome of ${call.tool} couldn't be recorded (${(err as Error).message}); its intent was`;
        log(reason);
        return inner.send(withDegraded(message, reason), options);
      }
      return inner.send(message, options);
    }
  }

  const wrapper: Transport = {
    async start() {
      inner.onclose = () => wrapper.onclose?.();
      inner.onerror = (e) => wrapper.onerror?.(e);
      inner.onmessage = (message, extra) => {
        if (!isJSONRPCRequest(message)) return wrapper.onmessage?.(message, extra);
        // Responses are matched to pending tool calls by id, so no request of any method may
        // reuse the id of a tool call still in flight: its response would be taken for the
        // tool's, and the tool's own would then go out unaudited.
        if (message.method !== "tools/call" && pending.has(message.id)) {
          void inner.send({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "a request with this id is already in progress" } });
          return;
        }
        if (message.method === "initialize") {
          const info = (message.params as Structured | undefined)?.clientInfo;
          if (info) client = { name: label(info.name, CLIENT_NAME), version: label(info.version, CLIENT_VERSION) };
        }
        if (message.method !== "tools/call") return wrapper.onmessage?.(message, extra);
        const params = (message.params ?? {}) as Structured;
        const tool = String(params.name ?? "");
        // Pending calls are matched to responses by id. A second call reusing an id still in
        // flight would make one response unaudited, so it's refused here and never forwarded.
        if (pending.has(message.id)) {
          // Recorded like any other call, with the same fail-closed path: if a required sink
          // can't take the refusal, the caller gets `unavailable` (and any correction).
          void base(tool, params.arguments).then(async (e) => {
            const refusal = { ...e, outcome: "error" as const, code: "duplicate_request_id" };
            try {
              await audit.emit(refusal);
              await inner.send({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "a request with this id is already in progress" } });
            } catch (err) {
              const degraded = await correct(refusal, err);
              await inner.send(unavailable(message.id, (err as Error).message, degraded ?? undefined));
            }
          });
          return;
        }
        pending.set(message.id, { tool, args: params.arguments });
        if (!WRITE_TOOLS.has(tool)) return wrapper.onmessage?.(message, extra);
        // Record the intent before anything reaches GitHub; if a required sink can't take
        // it, answer `unavailable` here and never hand the call to the server.
        void base(tool, params.arguments).then((e) =>
          audit.emit({ ...e, kind: "tool_intent" }).then(
            () => wrapper.onmessage?.(message, extra),
            (err: unknown) => {
              pending.delete(message.id);
              const why = err instanceof AuditUnavailable ? err.message : `audit failed: ${(err as Error).message}`;
              log(why);
              // Sinks that did take the intent must learn the write never ran.
              void correct(e, err).then((degraded) => inner.send(unavailable(message.id, why, degraded ?? undefined)));
            },
          ),
        );
      };
      await inner.start();
    },

    async send(message: JSONRPCMessage, options?: TransportSendOptions) {
      const id = isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message) ? message.id : undefined;
      const call = id !== undefined ? pending.get(id) : undefined;
      if (id === undefined || !call) return inner.send(message, options);
      // The id stays reserved until this response is out, so a duplicate can't be accepted
      // (and, for a write, run a second time) while a slow sink is still recording it.
      try {
        return await sendAudited(id, call, message, options);
      } finally {
        pending.delete(id);
      }
    },
    close: () => inner.close(),
    get sessionId() {
      return inner.sessionId;
    },
    setProtocolVersion: (v: string) => inner.setProtocolVersion?.(v),
  };
  return wrapper;
}
