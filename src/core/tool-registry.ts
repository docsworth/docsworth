import type { AuditEvent } from "./audit-log.js";
import { POLICY_TOOLS } from "./config.js";
import { PAGE_TYPES } from "./schema.js";

// Every MCP tool, once. The server registers from it, the policy and audit log read it:
// which tools write, which `policy.tools` entry each answers to, what the audit log may
// record of its arguments, and which page ids its response returned. A tool missing here
// is refused by the policy and recorded as unknown.

/** A name `policy.tools` in .knowledge/config.yaml can key on. */
export type PolicyName = (typeof POLICY_TOOLS)[number];

type Structured = Record<string, any>;
type Returned = Pick<AuditEvent, "returned" | "excluded" | "pr_url">;

export interface ToolSpec {
  readonly name: string;
  /** `all`: every server (stdio and HTTP). `http`: only `docsworth serve` sessions. */
  readonly surface: "all" | "http";
  /** Has side effects: its intent is audited before it runs, and `policy.writes` turns it off. */
  readonly write: boolean;
  /** The `policy.tools` entry this tool answers to. */
  readonly policy: PolicyName;
  /** Arguments the audit log may record, each checked against FIELD_CHECKS. */
  readonly auditFields: readonly string[];
  /** Page ids and PR links in a successful response (the service already filtered it by ACL). */
  returned(sc: Structured): Returned;
}

const SLUGISH = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * The shape each recordable argument must have to be recorded as given. A value that
 * fails its check is recorded as "<invalid>", so a malformed call can't smuggle text into
 * the log through, say, `path`.
 */
export const FIELD_CHECKS: Readonly<Record<string, (v: unknown) => boolean>> = {
  // A page id, or a mirrored page's (`mirror:<source>:<space>:<native id>`, v0.2 L2).
  id: (v) => typeof v === "string" && (/^[a-z0-9][a-z0-9-]{0,99}$/.test(v) || /^mirror:(?:confluence|notion):[A-Za-z0-9_.~-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(v)),
  type: (v) => typeof v === "string" && (PAGE_TYPES as readonly string[]).includes(v),
  owner_team: (v) => typeof v === "string" && SLUGISH.test(v),
  applies_to: (v) => typeof v === "string" && /^[a-z0-9][a-z0-9:_./-]{0,99}$/i.test(v),
  path: (v) => typeof v === "string" && /^[a-z0-9_./-]{0,200}$/i.test(v) && !v.includes(".."),
  include_stale: (v) => typeof v === "boolean",
  draft: (v) => typeof v === "boolean",
  acl: (v) => typeof v === "string" && SLUGISH.test(v),
  polish: (v) => typeof v === "boolean",
  limit: (v) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1000,
};

const ids = (xs: unknown) => (Array.isArray(xs) ? xs.map((x: Structured) => String(x?.id)) : []);
const prUrl = (sc: Structured): Returned => (typeof sc.pr_url === "string" ? { pr_url: sc.pr_url } : {});

export const TOOLS: readonly ToolSpec[] = [
  {
    name: "search",
    surface: "all",
    write: false,
    policy: "search",
    auditFields: ["type", "owner_team", "applies_to", "include_stale", "limit"],
    // Mirrored pages were shown too (as context), so they count as returned.
    returned: (sc) => ({ returned: [...ids(sc.results), ...ids(sc.mirrored)], excluded: ids(sc.excluded) }),
  },
  { name: "read", surface: "all", write: false, policy: "read", auditFields: ["id"], returned: (sc) => ({ returned: [String(sc.id)] }) },
  {
    name: "list",
    surface: "all",
    write: false,
    policy: "list",
    auditFields: ["path", "type"],
    returned: (sc) => ({ returned: [...(sc.index ? [String(sc.index.id)] : []), ...ids(sc.pages)] }),
  },
  { name: "stale", surface: "all", write: false, policy: "stale", auditFields: ["owner_team"], returned: (sc) => ({ returned: ids(sc.pages) }) },
  { name: "propose_edit", surface: "all", write: true, policy: "propose_edit", auditFields: ["id", "draft", "polish"], returned: prUrl },
  { name: "verify", surface: "all", write: true, policy: "verify", auditFields: ["id"], returned: prUrl },
  // The new page's id is the server's (random), so the intent can't name it: it is
  // recorded from the successful response only.
  {
    name: "draft_page",
    surface: "all",
    write: true,
    policy: "draft_page",
    auditFields: ["type", "owner_team", "acl", "draft"],
    returned: (sc) => ({ ...(typeof sc.id === "string" ? { returned: [sc.id] } : {}), ...prUrl(sc) }),
  },
  // The web app's views, on `docsworth serve` sessions only. They show page lists, so they
  // answer to `list`: a policy that refuses `list` refuses them too.
  { name: "ui_capabilities", surface: "http", write: false, policy: "list", auditFields: [], returned: () => ({}) },
  { name: "ui_overview", surface: "http", write: false, policy: "list", auditFields: [], returned: (sc) => ({ returned: [...ids(sc.due_soon), ...ids(sc.stale)] }) },
  { name: "ui_graph", surface: "http", write: false, policy: "list", auditFields: ["owner_team"], returned: (sc) => ({ returned: ids(sc.nodes) }) },
  // A page for the app: `read`'s view plus the ids of the visible pages it links to.
  {
    name: "ui_page",
    surface: "http",
    write: false,
    policy: "read",
    auditFields: ["id"],
    returned: (sc) => ({ returned: [String(sc.id), ...Object.values((sc.links ?? {}) as Record<string, string>)] }),
  },
];

// A Map, not an object: a tool called `constructor` or `__proto__` must not look known.
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The tool called `name`, or undefined for any name that isn't one. */
export function toolSpec(name: string): ToolSpec | undefined {
  return BY_NAME.get(name);
}

/** Names of the tools with side effects. */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(TOOLS.filter((t) => t.write).map((t) => t.name));
