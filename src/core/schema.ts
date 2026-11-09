import { z } from "zod";
import { DURATION_RE, parseDate } from "./duration.js";

// The frontmatter contract from docs/format-spec.md (format: 1).

export const PAGE_TYPES = ["runbook", "adr", "service", "guide", "policy"] as const;
export const STATUSES = ["canonical", "draft", "deprecated"] as const;
export const REQUIRED_FIELDS = [
  "title",
  "id",
  "type",
  "status",
  "owner_team",
  "last_verified",
  "review_every",
] as const;
export const OPTIONAL_FIELDS = ["supersedes", "applies_to", "acl", "description"] as const;

/** Default ACL: anyone with read access to the knowledge repo. */
export const ACL_INTERNAL = "internal";

const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const ID = /^[a-z0-9][a-z0-9-]*$/;

export const FrontmatterSchema = z.object({
  title: z.string().trim().min(1),
  id: z.string().regex(ID, "lowercase letters, digits and dashes"),
  type: z.enum(PAGE_TYPES),
  status: z.enum(STATUSES),
  // A bare team slug; the org comes from config (github.org). Never `@user`.
  owner_team: z.string().regex(SLUG, "a team slug like `platform` (no @, no org)"),
  last_verified: z
    .string()
    .refine((s) => parseDate(s) !== null, "a real calendar date as YYYY-MM-DD"),
  review_every: z.string().regex(DURATION_RE, "a period like 30d, 12w, 6m or 1y"),
  supersedes: z.array(z.string().regex(ID)).optional(),
  applies_to: z.array(z.string().min(1)).optional(),
  acl: z.string().regex(SLUG, "`internal` or a team slug").default(ACL_INTERNAL),
  description: z.string().optional(),
});

export type Frontmatter = z.infer<typeof FrontmatterSchema>;
export type PageType = (typeof PAGE_TYPES)[number];
export type PageStatus = (typeof STATUSES)[number];

export interface FieldIssue {
  field: string;
  message: string;
}

/** Validate raw frontmatter, returning issues keyed by field for the linter. */
export function validateFrontmatter(
  data: Record<string, unknown>,
): { ok: true; value: Frontmatter; unknownFields: string[] } | { ok: false; issues: FieldIssue[] } {
  const result = FrontmatterSchema.safeParse(data);
  const known = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
  const unknownFields = Object.keys(data).filter((k) => !known.has(k));
  if (result.success) return { ok: true, value: result.data, unknownFields };

  const issues = result.error.issues.map((issue) => {
    const field = String(issue.path[0] ?? "(root)");
    const missing = data[field] === undefined;
    return { field, message: missing ? `missing required field \`${field}\`` : `\`${field}\`: ${issue.message}` };
  });
  return { ok: false, issues };
}
