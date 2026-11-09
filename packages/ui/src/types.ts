// What Docsworth's tools return, as the UI reads it (src/core/service.ts is the source).

export type SlaState = "fresh" | "due_soon" | "overdue" | "unverified";
export type PageType = "runbook" | "adr" | "service" | "guide" | "policy";
export type PageStatus = "canonical" | "draft" | "deprecated";

export interface PageSummary {
  id: string;
  title: string;
  path: string;
  type: PageType;
  status: PageStatus;
  owner_team: string;
  last_verified: string;
  due: string | null;
  sla_state: SlaState;
  citable: boolean;
}

export interface SearchResult extends PageSummary {
  snippet: string;
  score: number;
}

export interface Excluded {
  id: string;
  title: string;
  owner_team: string;
  reason: string;
}

export interface SearchResponse {
  results: SearchResult[];
  excluded: Excluded[];
  note?: string;
}

export interface ReadResponse extends PageSummary {
  review_every: string;
  acl: string;
  supersedes: string[];
  applies_to: string[];
  flags: string[];
  gate_reason?: string;
  content: string;
}

/** A mirrored wiki page (mirror.serve): context only, never citable, never edited here. */
export interface MirrorReadResponse {
  id: string;
  title: string;
  source: "confluence" | "notion";
  space: string;
  source_url: string;
  owner_team: string | null;
  last_edited: string | null;
  acl: string;
  citable: false;
  flags: string[];
  gate_reason: string;
  content: string;
}

/** What `read` and `ui_page` return: a repo page or a mirrored one. */
export type AnyPage = ReadResponse | MirrorReadResponse;
export const isMirror = (p: AnyPage): p is MirrorReadResponse => "source" in p;

export interface StaleEntry {
  id: string;
  title: string;
  path: string;
  owner_team: string;
  status: PageStatus;
  due: string | null;
  reason: string;
  detail: string;
}

export interface Tally {
  pages: number;
  citable: number;
  overdue: number;
  due_soon: number;
}

export interface Overview {
  as_of: string;
  totals: Tally & { draft: number; deprecated: number };
  teams: (Tally & { team: string })[];
  due_soon: PageSummary[];
  stale: StaleEntry[];
}

export interface GraphNode extends PageSummary {
  has_restricted_links: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: { from: string; to: string }[];
}

export interface Capabilities {
  mode: "local" | "github";
  login: string | null;
  org: string;
  repo: string | null;
  writes: boolean;
  write_tools: string[];
  writes_off?: string;
  /** Teams the app may offer as a new page's owner (names only). */
  teams: string[];
  pro: string[];
}

export interface WriteResult {
  pr_url: string;
  pr_number: number;
  branch: string;
}

export interface DraftResult extends WriteResult {
  id: string;
  path: string;
}
