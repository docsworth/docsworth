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
  /** "text" when the server cut snippets from the page as a reader sees it (search's `snippets: "text"`). */
  snippets?: "text";
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

/** What `ui_page` returns (and `read`, with a page's text): a repo page or a mirrored one. */
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
  /** How many there are when the lists were limited (list_limit). */
  due_soon_total?: number;
  stale_total?: number;
  /** Files under the knowledge root that aren't valid pages: a count only, never their names. */
  skipped_files?: number;
}

export interface GraphNode extends PageSummary {
  has_restricted_links: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: { from: string; to: string }[];
  /** How many visible pages the nodes were chosen from: more than `nodes` when limited. */
  total?: number;
  /** Each team's visible page count (names no page). */
  teams?: { team: string; pages: number }[];
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
  /** The panels Docsworth pro supplies to the overview: none yet. */
  pro: string[];
  /** Docsworth pro's commands when pro is installed beside the server and loads; empty otherwise. Absent from a server before 0.3.2. */
  pro_commands?: string[];
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
