import {
  AppendForm,
  type Capabilities,
  CaptureForm,
  type DocsworthClient,
  DocsworthError,
  type DraftInput,
  type DraftResult,
  ErrorNotice,
  GRAPH_LIMIT,
  type Graph,
  Link,
  LinkGraph,
  Loaded,
  type Navigate,
  isMirror,
  type MirrorReadResponse,
  type Overview,
  PageMeta,
  PageView,
  type ReadResponse,
  ResultList,
  SearchBox,
  type SearchResponse,
  StaleTable,
  TeamBars,
  Tiles,
  useCall,
  type WriteResult,
} from "@docsworth/ui";
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { type Route, useRoute } from "./router.js";

// The web app. Every view asks the server only for what it shows (each answer taints this
// tab with exactly the restricted pages it names, so drafting stays possible after reading
// ordinary pages).

export function NoToken({ refused = false }: { refused?: boolean }) {
  return (
    <main class="dw-main">
      <h1>Docsworth</h1>
      <p class="dw-sub">{refused ? "The server didn't accept this tab's token." : "This tab has no access token yet."}</p>
      <p>
        Open the URL <code>docsworth serve</code> printed: it carries the token. <code>docsworth serve --print-token</code> shows it again.
      </p>
    </main>
  );
}

function Header({ route, caps, navigate }: { route: Route; caps?: Capabilities; navigate: Navigate }) {
  const items: [string, string, Route["name"]][] = [
    ["/", "Overview", "overview"],
    ["/search", "Search", "search"],
    ["/graph", "Graph", "graph"],
    ["/capture", "Capture", "capture"],
  ];
  return (
    <header class="dw-header">
      <Link href="/" navigate={navigate} class="dw-brand">
        Docsworth
      </Link>
      <nav class="dw-nav" aria-label="Main">
        {items.map(([href, label, name]) => (
          <a
            key={href}
            href={href}
            aria-current={route.name === name ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate(href);
            }}
          >
            {label}
          </a>
        ))}
      </nav>
      {caps && (
        <span class="dw-who">
          <span>{caps.repo ?? `${caps.org} (local)`}</span>
          <span class="dw-badge">{caps.mode === "github" ? `@${caps.login}` : "local mode"}</span>
          <Link href="/settings" navigate={navigate}>
            Settings
          </Link>
        </span>
      )}
    </header>
  );
}

/** How many of each overview list to ask for first: a big repo has hundreds of stale pages. */
const OVERVIEW_LIST_LIMIT = 20;

function OverviewView({ client, caps, navigate }: { client: DocsworthClient; caps?: Capabilities; navigate: Navigate }) {
  // The server names only the pages it returns, so only those count as read; "Show all"
  // asks again for every one.
  const [all, setAll] = useState(false);
  const call = useCall(() => client.call<Overview>("ui_overview", all ? {} : { list_limit: OVERVIEW_LIST_LIMIT }), `overview:${all}`);
  const more = (shown: number, total: number | undefined) =>
    !all && (total ?? 0) > shown ? (
      <p class="dw-muted">
        The first {shown} of {total}.{" "}
        <button type="button" class="secondary" onClick={() => setAll(true)}>
          Show all {total}
        </button>
      </p>
    ) : null;
  return (
    <Loaded call={call}>
      {(o) => (
        <>
          <h1>Knowledge overview</h1>
          <p class="dw-sub">
            As of {o.as_of}: the {o.totals.pages} pages {caps?.mode === "github" ? `@${caps.login} can see` : "visible in local mode"}.
          </p>
          <Tiles
            items={[
              { value: o.totals.pages, label: "pages" },
              { value: o.totals.citable, label: "citable by agents" },
              { value: o.totals.overdue, label: "past review date" },
              { value: o.totals.due_soon, label: "due for review soon" },
            ]}
          />
          {(o.skipped_files ?? 0) > 0 && (
            <div class="dw-note">
              {o.skipped_files === 1
                ? "1 file under the knowledge root couldn't be read as a page, so nothing here shows it. "
                : `${o.skipped_files} files under the knowledge root couldn't be read as pages, so nothing here shows them. `}
              <code>docsworth lint</code> {o.skipped_files === 1 ? "lists it" : "lists them"} and says why.
            </div>
          )}
          <h2>By team</h2>
          <TeamBars teams={o.teams} navigate={navigate} />
          <h2>Due soon</h2>
          {o.due_soon.length === 0 ? (
            <p class="dw-muted">Nothing is due in the next two weeks.</p>
          ) : (
            <ul>
              {o.due_soon.map((p) => (
                <li key={p.id}>
                  <Link href={`/p/${encodeURIComponent(p.id)}`} navigate={navigate}>
                    {p.title}
                  </Link>{" "}
                  <span class="dw-muted">
                    · {p.owner_team} · due {p.due}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {more(o.due_soon.length, o.due_soon_total)}
          <h2>Stale or unowned</h2>
          <StaleTable entries={o.stale} navigate={navigate} />
          {more(o.stale.length, o.stale_total)}
          {caps && !caps.pro_commands?.length && (
            <div class="dw-note">
              Docsworth pro adds each team's review digest, an ownership dashboard, admin reports (audit, access review, usage), runbooks compiled into agent skills, and a read-only Confluence and Notion mirror.
            </div>
          )}
        </>
      )}
    </Loaded>
  );
}

function SearchView({ client, q, navigate }: { client: DocsworthClient; q: string; navigate: Navigate }) {
  return (
    <>
      <h1>Search</h1>
      <SearchBox key={q} initial={q} onSearch={(next) => navigate(`/search?q=${encodeURIComponent(next)}`)} />
      {q ? <SearchResults client={client} q={q} navigate={navigate} /> : <p class="dw-muted">Agents see the same results: citable pages, and what the gate left out.</p>}
    </>
  );
}

function SearchResults({ client, q, navigate }: { client: DocsworthClient; q: string; navigate: Navigate }) {
  const call = useCall(() => client.call<SearchResponse>("search", { query: q, limit: 15, snippets: "text" }), q);
  return <Loaded call={call}>{(r) => <ResultList response={r} navigate={navigate} />}</Loaded>;
}

type UiPage = (ReadResponse | MirrorReadResponse) & { links: Record<string, string> };

function PageRoute({ client, caps, id, navigate }: { client: DocsworthClient; caps?: Capabilities; id: string; navigate: Navigate }) {
  const call = useCall(() => client.call<UiPage>("ui_page", { id }), id);
  const [adding, setAdding] = useState(false);
  useEffect(() => setAdding(false), [id]);
  return (
    <Loaded call={call}>
      {(page) => (
        <>
          <PageView page={page} pageIds={new Map(Object.entries(page.links))} navigate={navigate} />
          {/* A mirrored page is a copy of the old wiki: it can't be edited here. */}
          {!isMirror(page) && <div style={{ marginTop: "28px" }}>
            {adding ? (
              <AppendForm
                caps={caps ?? null}
                pageTitle={page.title}
                onSubmit={(append, reason) => client.call<WriteResult>("propose_edit", { id: page.id, append, reason })}
              />
            ) : (
              <button type="button" class="secondary" onClick={() => setAdding(true)}>
                Suggest an addition
              </button>
            )}
          </div>}
        </>
      )}
    </Loaded>
  );
}

/** What a team should look at first: past review, then due soon, then unverified; retired pages last. */
const REVIEW_ORDER: Record<string, number> = { overdue: 0, due_soon: 1, unverified: 2, fresh: 3 };
const byReview = (a: Graph["nodes"][number], b: Graph["nodes"][number]) =>
  Number(a.status === "deprecated") - Number(b.status === "deprecated") ||
  (REVIEW_ORDER[a.sla_state] ?? 3) - (REVIEW_ORDER[b.sla_state] ?? 3) ||
  (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
  a.title.localeCompare(b.title);

function TeamView({ client, team, navigate }: { client: DocsworthClient; team: string; navigate: Navigate }) {
  const call = useCall(() => client.call<Graph>("ui_graph", { owner_team: team }), team);
  return (
    <Loaded call={call}>
      {(g) => (
        <>
          <h1>{team}</h1>
          <p class="dw-sub">
            {g.nodes.length} pages owned by this team that you can see, what needs review first.{" "}
            <Link href={`/graph?team=${encodeURIComponent(team)}`} navigate={navigate}>
              Its link graph
            </Link>
          </p>
          <ul class="dw-results">
            {[...g.nodes].sort(byReview).map((p) => (
              <li class="dw-result" key={p.id}>
                <h3>
                  <Link href={`/p/${encodeURIComponent(p.id)}`} navigate={navigate}>
                    {p.title}
                  </Link>
                </h3>
                <PageMeta page={p} navigate={navigate} />
              </li>
            ))}
          </ul>
        </>
      )}
    </Loaded>
  );
}

function GraphView({ client, team, navigate }: { client: DocsworthClient; team: string | null; navigate: Navigate }) {
  // The server picks at most GRAPH_LIMIT pages (the most-linked), and names only those.
  const call = useCall(() => client.call<Graph>("ui_graph", { max_nodes: GRAPH_LIMIT, ...(team ? { owner_team: team } : {}) }), `graph:${team ?? ""}`);
  return (
    <Loaded call={call}>
      {(g) => {
        const total = g.total ?? g.nodes.length;
        const limited = total > g.nodes.length;
        const owned = team ? ` owned by ${team}` : "";
        const links = `${g.edges.length} ${g.edges.length === 1 ? "link" : "links"}`;
        return (
          <>
            <h1>{team ? `Link graph: ${team}` : "Link graph"}</h1>
            <p class="dw-sub">
              {limited
                ? `The ${g.nodes.length} most-linked of the ${total} pages${owned} you can see, and the ${links} among them.`
                : `${g.nodes.length} ${g.nodes.length === 1 ? "page" : "pages"}${owned} and ${links} you can see.`}{" "}
              Opening this view counts as reading the pages drawn in it, so drafting from this tab follows their audiences.
            </p>
            {(limited || team) && g.teams && (
              <p class="dw-teams">
                {team ? (
                  <Link href="/graph" navigate={navigate}>
                    All teams
                  </Link>
                ) : (
                  "One team's pages:"
                )}
                {g.teams.map((t) =>
                  t.team === team ? (
                    <strong key={t.team}>
                      {t.team} ({t.pages})
                    </strong>
                  ) : (
                    <Link key={t.team} href={`/graph?team=${encodeURIComponent(t.team)}`} navigate={navigate}>
                      {t.team} ({t.pages})
                    </Link>
                  ),
                )}
              </p>
            )}
            <LinkGraph graph={g} navigate={navigate} />
          </>
        );
      }}
    </Loaded>
  );
}

function CaptureView({ client, caps }: { client: DocsworthClient; caps?: Capabilities }) {
  return (
    <>
      <h1>Capture a page</h1>
      <p class="dw-sub">Write it down while it's fresh. It opens as a draft PR for the owning team to review.</p>
      <CaptureForm caps={caps ?? null} teams={caps?.teams ?? []} onSubmit={(input: DraftInput) => client.call<DraftResult>("draft_page", { ...input })} />
    </>
  );
}

function SettingsView({ caps }: { caps?: Capabilities }) {
  if (!caps) return <p class="dw-muted">Loading…</p>;
  return (
    <>
      <h1>Settings</h1>
      <table class="dw-table">
        <tbody>
          <tr>
            <th scope="row">Mode</th>
            <td>{caps.mode === "github" ? `GitHub, as @${caps.login}` : "local: internal pages only, no writes"}</td>
          </tr>
          <tr>
            <th scope="row">Repository</th>
            <td>{caps.repo ?? "none (github.repo isn't set)"}</td>
          </tr>
          <tr>
            <th scope="row">Writes</th>
            <td>{caps.writes ? caps.write_tools.join(", ") : caps.writes_off}</td>
          </tr>
          <tr>
            <th scope="row">Docsworth pro</th>
            <td>{caps.pro_commands?.length ? `installed: ${caps.pro_commands.join(", ")}` : "not installed"}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function Shell({ client }: { client: DocsworthClient }) {
  const [route, navigate] = useRoute();
  const caps = useCall(() => client.call<Capabilities>("ui_capabilities"), "caps");
  if (caps.error instanceof DocsworthError && caps.error.code === "unauthorized") return <NoToken refused />;
  const c = caps.data;
  let view: ComponentChildren;
  switch (route.name) {
    case "overview":
      view = <OverviewView client={client} caps={c} navigate={navigate} />;
      break;
    case "search":
      view = <SearchView client={client} q={route.q} navigate={navigate} />;
      break;
    case "page":
      view = <PageRoute client={client} caps={c} id={route.id} navigate={navigate} />;
      break;
    case "team":
      view = <TeamView client={client} team={route.team} navigate={navigate} />;
      break;
    case "graph":
      view = <GraphView client={client} team={route.team} navigate={navigate} />;
      break;
    case "capture":
      view = <CaptureView client={client} caps={c} />;
      break;
    case "settings":
      view = <SettingsView caps={c} />;
      break;
    default:
      view = <p>There's no such page in this app.</p>;
  }
  return (
    <div class="dw">
      <Header route={route} caps={c} navigate={navigate} />
      <main class="dw-main">
        {caps.error ? <ErrorNotice error={caps.error} /> : null}
        {view}
      </main>
    </div>
  );
}

export function App({ client }: { client: DocsworthClient | null }) {
  return client ? <Shell client={client} /> : <NoToken />;
}
