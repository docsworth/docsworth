import { useState } from "preact/hooks";
import type { ComponentChildren, TargetedEvent, TargetedMouseEvent } from "preact";
import { renderMarkdown } from "../markdown.js";
import { type AnyPage, isMirror, type SearchResponse } from "../types.js";
import { Link, type Navigate, PageMeta } from "./basics.js";

/**
 * A markdown snippet as plain text: link targets, heading marks, emphasis and code ticks taken
 * out. Only for a `serve` that sends markdown snippets; a current one cuts text for the web
 * app and the panel (search's `snippets: "text"`), and those show as they come.
 */
export function plainSnippet(s: string): string {
  return (
    s
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      // The server cuts a snippet from the markdown wherever 240 characters fall, and marks
      // each cut end with "…" (src/core/search.ts), so a link can be cut too: at the start,
      // after its text began; at the end, in its text or its target. Only an end it marked
      // is read that way, and only a bracket not straight after a word (a[0] is no link).
      // Deliberately a heuristic, for display only: a link written straight after a word
      // (foo[bar](x)) cut at the end stays as markdown, as every snippet showed before; and
      // uncut text ending in a literal "[text…" loses its "[". Neither loses words or shows
      // anything new. Knowing the cuts exactly would need search's answer to change (plain
      // text, or cut offsets), and agents read that answer too.
      .replace(/^…([^[\]]*)\]\([^)\s]*\)/, "…$1")
      .replace(/(^|[^\p{L}\p{N}_\]])!?\[([^\]]*)\]\([^)]*…$/u, "$1$2…")
      .replace(/(^|[^\p{L}\p{N}_\]])!?\[([^\]]*…)$/u, "$1$2")
      .replace(/(^|\s)#{1,6}\s+/g, "$1")
      .replace(/[*_`]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export function SearchBox({ initial = "", onSearch, placeholder = "Search the knowledge base" }: { initial?: string; onSearch: (q: string) => void; placeholder?: string }) {
  const [q, setQ] = useState(initial);
  const submit = (e: TargetedEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (q.trim()) onSearch(q.trim());
  };
  return (
    <form class="dw-search" role="search" onSubmit={submit}>
      <input type="search" value={q} placeholder={placeholder} aria-label="Search" onInput={(e) => setQ(e.currentTarget.value)} />
      <button type="submit">Search</button>
    </form>
  );
}

/** Citable results, then what matched but the gate excluded, with why and who owns it. */
/**
 * Search results, citable first, then what matched but can't be cited. `action` adds a control
 * to each (the extension's "Add the capture here").
 */
export function ResultList({ response, navigate, action }: { response: SearchResponse; navigate: Navigate; action?: (page: { id: string; title: string }) => ComponentChildren }) {
  const { results, excluded } = response;
  const asText = response.snippets === "text";
  return (
    <div>
      {results.length === 0 ? (
        <p class="dw-muted">No citable page matched.</p>
      ) : (
        <ul class="dw-results">
          {results.map((r) => (
            <li class="dw-result" key={r.id}>
              <h3>
                <Link href={`/p/${encodeURIComponent(r.id)}`} navigate={navigate}>
                  {r.title}
                </Link>
              </h3>
              <PageMeta page={r} navigate={navigate} />
              <p>{asText ? r.snippet : plainSnippet(r.snippet)}</p>
              {action?.(r)}
            </li>
          ))}
        </ul>
      )}
      {excluded.length > 0 && (
        <section aria-label="Excluded">
          <h2>Matched, but not citable</h2>
          {excluded.map((x) => (
            <div class="dw-excluded" key={x.id}>
              <Link href={`/p/${encodeURIComponent(x.id)}`} navigate={navigate}>
                {x.title}
              </Link>{" "}
              <span class="dw-muted">· {x.reason}</span>
              {action && <div>{action(x)}</div>}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/**
 * A page as `read` returns it, rendered safely (markdown.ts). Links to other visible pages
 * route inside the app; `pageIds` maps their repo paths to ids.
 */
export function PageView({ page, pageIds, navigate }: { page: AnyPage; pageIds: ReadonlyMap<string, string>; navigate: Navigate }) {
  // Pages usually open with "# <title>", which the view already shows above the meta.
  const body = page.content.replace(/^\s*#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/, (line, text: string) => (text.trim() === page.title.trim() ? "" : line));
  // A mirrored page has no repo path: none of its relative links is an app route.
  const html = renderMarkdown(body, { pagePath: isMirror(page) ? "" : page.path, pageIds: isMirror(page) ? new Map() : pageIds });
  // In-app links are rendered as plain anchors; route them without a reload.
  const onClick = (e: TargetedMouseEvent<HTMLDivElement>) => {
    const a = (e.target as Element | null)?.closest?.("a");
    const href = a?.getAttribute("href");
    if (!href || !href.startsWith("/p/") || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <article class="dw-page">
      <h1>{page.title}</h1>
      {isMirror(page) ? (
        <div class="dw-meta">
          <span class="dw-badge warn">mirrored</span>
          <span>{page.source === "confluence" ? "Confluence" : "Notion"} · {page.space}</span>
          {page.owner_team && <span>labelled for {page.owner_team}</span>}
          {/^https?:\/\//i.test(page.source_url) && (
            <a href={page.source_url} target="_blank" rel="noopener noreferrer">
              the original
            </a>
          )}
        </div>
      ) : (
        <PageMeta page={page} navigate={navigate} />
      )}
      {page.gate_reason && <div class="dw-note">Agents won't cite this page: {page.gate_reason}.</div>}
      {page.acl !== "internal" && <div class="dw-note">Docsworth shows this page only to the {page.acl} team.</div>}
      <div class="dw-prose" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}
