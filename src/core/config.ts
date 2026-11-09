import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { UserError } from "./errors.js";
import { insecureUrl } from "./url.js";

export const CONFIG_PATH = ".knowledge/config.yaml";

/** The MCP tools a policy can name (kept here so config doesn't import the server). */
export const POLICY_TOOLS = ["search", "read", "list", "stale", "propose_edit", "verify", "draft_page"] as const;
const TeamSlug = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, "a lowercase team slug like `platform`");

const MirrorSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("confluence"),
    name: z.string().default("confluence"),
    base_url: z.string().url().superRefine((u, ctx) => {
      const why = insecureUrl(u);
      if (why) ctx.addIssue({ code: "custom", message: `base_url ${why}` });
    }),
    spaces: z.array(z.object({ key: z.string().min(1), acl: z.string().default("internal") })).min(1),
  }),
  z.object({
    kind: z.literal("notion"),
    name: z.string().default("notion"),
    root_page_ids: z.array(z.string()).default([]),
    acl: z.string().default("internal"),
  }),
]);

export const ConfigSchema = z.object({
  format: z.literal(1).default(1),
  knowledge_root: z.string().default("knowledge"),
  github: z.object({
    /** Team owners resolve to @<org>/<team>. Required even for local-only repos. */
    org: z.string().min(1).transform((s) => s.toLowerCase()),
    /** owner/name. When set, GitHub is the ACL authority and a token is required. */
    repo: z
      .string()
      .regex(/^[\w.-]+\/[\w.-]+$/, "owner/name")
      .optional(),
    default_branch: z.string().optional(),
    /** REST API base for GitHub Enterprise Server, e.g. https://ghe.example.com/api/v3. */
    api_url: z
      .string()
      .url()
      .superRefine((u, ctx) => {
        const why = insecureUrl(u);
        if (why) ctx.addIssue({ code: "custom", message: `github.api_url ${why}` });
      })
      .optional(),
  }),
  sla: z.object({ due_soon_days: z.number().int().min(0).default(14) }).default({ due_soon_days: 14 }),
  /** Append page-id-only read events to .knowledge/usage.jsonl (feeds the digest). */
  usage_log: z.boolean().default(false),
  /** The attributed audit log (src/core/audit-log.ts). Off unless enabled. */
  audit_log: z
    .object({
      enabled: z.boolean().default(false),
      /** Default: a state directory outside the checkout. Inside it, git must ignore it. */
      dir: z.string().min(1).optional(),
      /** Record search query text. Off: queries can carry sensitive text. */
      include_queries: z.boolean().default(false),
      /** Fail a tool call (closed) when its event can't be written. */
      required: z.boolean().default(false),
      retention_days: z.number().int().min(1).default(365),
    })
    .strict() // `requred: true` must fail, not quietly make the log optional
    // "Required" with nothing enabled would quietly mean no audit log at all.
    .refine((a) => !a.required || a.enabled, { message: "audit_log.required needs audit_log.enabled: true (otherwise nothing is audited)" })
    .default({ enabled: false, include_queries: false, required: false, retention_days: 365 }),
  skills: z.object({ out_dir: z.string().default("skills") }).default({ out_dir: "skills" }),
  mirror: z
    .object({
      out_dir: z.string().default(".knowledge/mirror"),
      sources: z.array(MirrorSourceSchema).default([]),
      /** Serve mirrored pages to agents as non-citable context (v0.2 L2). Off by default. */
      serve: z.boolean().default(false),
    })
    .default({ out_dir: ".knowledge/mirror", sources: [], serve: false }),
  /** Org policy and roles (src/core/policy.ts). Every default keeps v0.1 behaviour. */
  policy: z
    .object({
      /** The team that must own .knowledge/config.yaml and CODEOWNERS in CODEOWNERS (lint). */
      admins: TeamSlug.optional(),
      /** Per-tool allowlists. An empty list disables the tool for everyone. */
      tools: z.partialRecord(z.enum(POLICY_TOOLS), z.object({ teams: z.array(TeamSlug) }).strict()).default({}),
      /** `disabled`: propose_edit and verify are not offered at all. */
      writes: z.enum(["enabled", "disabled"]).default("enabled"),
      /** Mark write tools so Claude Code asks a human on every call (defence in depth). */
      require_human_approval: z.boolean().default(false),
      /** `denied`: search never returns gated pages inline, even with include_stale. */
      include_stale: z.enum(["allowed", "denied"]).default("allowed"),
      /** How long team membership is cached for reads: the deprovisioning window. */
      identity_cache_seconds: z.number().int().min(30).max(3600).default(300),
    })
    // A typo here must be an error, not a silently ignored key: `write: disabled`
    // would otherwise leave writes on.
    .strict()
    .default({ tools: {}, writes: "enabled", require_human_approval: false, include_stale: "allowed", identity_cache_seconds: 300 }),
  digest: z
    .object({
      /** Env var holding the shared Slack incoming-webhook URL. */
      slack_webhook_env: z.string().default("SLACK_WEBHOOK_URL"),
      /**
       * Per-team webhook env vars. Each MUST point at that team's own private channel:
       * restricted page titles are posted there by name. Shared channels go through
       * slack_webhook_env, where restricted pages are only counted.
       */
      team_webhooks: z.record(z.string(), z.string()).default({}),
    })
    .default({ slack_webhook_env: "SLACK_WEBHOOK_URL", team_webhooks: {} }),
  /** Pro: the audit collector. Docsworth pro parses it; core only reserves the key. */
  audit_http: z.unknown().optional(),
})
  // Every top-level key is known, so a misspelled block (`polciy:`, `audit_lgo:`) is an
  // error rather than a silently dropped one that would leave writes on or auditing off.
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type MirrorSourceConfig = z.infer<typeof MirrorSourceSchema>;

export class ConfigError extends UserError {}

export function loadConfig(repoRoot: string): Config {
  const abs = join(repoRoot, CONFIG_PATH);
  if (!existsSync(abs)) throw new ConfigError(`no ${CONFIG_PATH} in ${repoRoot} (run \`docsworth init\`)`);
  const raw = parseYaml(readFileSync(abs, "utf8"), { schema: "core" }) as unknown;
  const result = ConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    const detail = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError(`invalid ${CONFIG_PATH}: ${detail}`);
  }
  return result.data;
}
