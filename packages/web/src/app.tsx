import {
  AppendForm,
  type Capabilities,
  CaptureForm,
  type DocsworthClient,
  DocsworthError,
  type DraftInput,
  type DraftResult,
  ErrorNotice,
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

function OverviewView({ client, caps, navigate }: { client: DocsworthClient; caps?: Capabilities; navigate: Navigate }) {
  const call = useCall(() => client.call<Overview>("ui_overview"), "overview");
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
          <h2>Stale or unowned</h2>
          <StaleTable entries={o.stale} navigate={navigate} />
          {(caps?.pro.length ?? 0) === 0 && (
            <div class="dw-note">Coverage history, the SLA timeline, usage and access panels are part of Docsworth pro.</div>
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
  const call = useCall(() => client.call<SearchResponse>("search", { query: q, limit: 15 }), q);
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

function TeamView({ client, team, navigate }: { client: DocsworthClient; team: string; navigate: Navigate }) {
  const call = useCall(() => client.call<Graph>("ui_graph", { owner_team: team }), team);
  return (
    <Loaded call={call}>
      {(g) => (
        <>
          <h1>{team}</h1>
          <p class="dw-sub">{g.nodes.length} pages owned by this team that you can see.</p>
          <ul class="dw-results">
            {g.nodes.map((p) => (
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

function GraphView({ client, navigate }: { client: DocsworthClient; navigate: Navigate }) {
  const call = useCall(() => client.call<Graph>("ui_graph"), "graph");
  return (
    <Loaded call={call}>
      {(g) => (
        <>
          <h1>Link graph</h1>
          <p class="dw-sub">
            {g.nodes.length} pages and {g.edges.length} links you can see. Opening this view counts as reading every page in it, so drafting
            from this tab follows their audiences.
          </p>
          <LinkGraph graph={g} navigate={navigate} />
        </>
      )}
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
            <th scope="row">Pro panels</th>
            <td>{caps.pro.length ? caps.pro.join(", ") : "not installed"}</td>
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
      view = <GraphView client={client} navigate={navigate} />;
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
