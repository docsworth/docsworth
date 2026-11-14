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
  isMirror,
  Link,
  Loaded,
  type MirrorReadResponse,
  type Navigate,
  PageMeta,
  PageView,
  type ReadResponse,
  ResultList,
  SearchBox,
  type SearchResponse,
  useCall,
  type WriteResult,
} from "@docsworth/ui";
import { useEffect, useRef, useState } from "preact/hooks";
import type { Mode } from "../capture.js";
import { type Pending, PENDING_TTL_MS } from "../contract.js";
import type { Taken } from "../pending.js";

// The side panel: search, read, add to a page, and save a capture (the panel's Save buttons,
// the context menu or the Gmail button) as an addition to a page or a new draft. Like a
// web-app tab, it asks the server only for what it shows, in its own session, so its taint
// follows what it showed. A capture only fills a form, and only as its values: nothing is
// written until you submit one. A capture from the worker stays stored until the panel is done
// with it (its form became a PR, or the panel moved on), so a reload doesn't lose it; one made
// here by a Save button lives only in this panel.

export type PanelEnv = {
  /** Null until the extension is connected (options page). */
  client: DocsworthClient | null;
  /**
   * Calls back with each batch of this window's captures, oldest first, and with the keys of
   * any whose record was removed (its time was up, or the token was forgotten); returns an
   * unsubscribe.
   */
  captures: (cb: (batch: Taken[]) => void, gone: (keys: string[]) => void) => () => void;
  /** The panel is done with a capture: it isn't given again, even after a reload. */
  done: (key: string) => void;
  openOptions: () => void;
  /** Ends this window's session and reloads the panel, as opening a new tab would. */
  newSession: () => void;
  /** Reads this window's active tab (its main content, or its selection) as a capture. */
  capture: (mode: Mode) => Promise<Pending>;
  extensionId: string;
};

type View = { name: "search"; q: string } | { name: "page"; id: string } | { name: "team"; team: string } | { name: "capture" };

type UiPage = (ReadResponse | MirrorReadResponse) & { links: Record<string, string> };

/** The view an in-app href names (the shared components link as the web app routes). */
export function viewFor(href: string): View | null {
  const u = new URL(href, "https://panel.invalid");
  const page = /^\/p\/(.+)$/.exec(u.pathname)?.[1];
  if (page) return { name: "page", id: decodeURIComponent(page) };
  const team = /^\/t\/(.+)$/.exec(u.pathname)?.[1];
  if (team) return { name: "team", team: decodeURIComponent(team) };
  if (u.pathname === "/search") return { name: "search", q: u.searchParams.get("q") ?? "" };
  return null;
}

/** Within its ten minutes now: a capture past them is never shown, whatever the events say. */
const fresh = (t: Taken) => Date.now() - t.capture.at <= PENDING_TTL_MS;
const firstLine = (s: string) => s.trim().split("\n")[0]!.slice(0, 120);
/** An address a draft may name as its source, and an addition may link to. */
const WEB = /^https?:\/\/[^\s<>]+$/;
/** A subject as a search: without the reply and forward marks. */
const asQuery = (s: string) => s.replace(/^(\s*(re|fwd?|aw|wg)\s*:\s*)+/i, "").trim();

export function Panel({ env }: { env: PanelEnv }) {
  if (!env.client) {
    return (
      <main class="dw-main">
        <h1>Docsworth</h1>
        <p class="dw-sub">Not connected to docsworth serve yet.</p>
        <button type="button" onClick={env.openOptions}>
          Connect
        </button>
      </main>
    );
  }
  return <Connected client={env.client} env={env} />;
}

function Connected({ client, env }: { client: DocsworthClient; env: PanelEnv }) {
  const caps = useCall(() => client.call<Capabilities>("ui_capabilities"), "caps");
  const [view, setView] = useState<View>({ name: "search", q: "" });
  const [capture, setCapture] = useState<Taken | null>(null);
  const [waiting, setWaiting] = useState<Taken[]>([]);
  // The capture on screen, for the captures callback, which outlives renders.
  const shown = useRef<Taken | null>(null);
  /** Shows `next` in place of the capture on screen, which the panel is then done with. */
  const show = (next: Taken | null) => {
    if (shown.current) env.done(shown.current.key);
    shown.current = next;
    setCapture(next);
    if (next) setView({ name: "capture" });
  };

  // Captures are taken only once the server answered: until then they wait in storage, and
  // nothing of them is in the panel. A capture opens at once unless one is already shown: then
  // it waits behind a notice, so a draft being written is never replaced. A waiting capture goes
  // when its record does; the one on screen stays, since it's the draft being written.
  const connected = Boolean(caps.data);
  useEffect(() => {
    if (!connected) return;
    return env.captures(
      (taken) => {
        const batch = taken.filter(fresh);
        const queue = shown.current ? batch : batch.slice(1);
        if (!shown.current && batch[0]) show(batch[0]);
        if (queue.length) setWaiting((w) => [...w, ...queue]);
      },
      (keys) => setWaiting((w) => w.filter((t) => !keys.includes(t.key))),
    );
  }, [connected]);

  const navigate: Navigate = (href) => {
    const next = viewFor(href);
    if (!next) return;
    show(null);
    setView(next);
  };
  const openNext = () => {
    const live = waiting.filter(fresh);
    show(live[0] ?? null);
    setWaiting(live.slice(1));
  };
  // A capture made here, by a Save button: never stored, so nothing to be done with.
  const captured = (capture: Pending) => show({ key: `local:${crypto.randomUUID()}`, capture });

  const c = caps.data;
  let body;
  if (caps.error) body = <ConnectError error={caps.error} env={env} />;
  else if (view.name === "capture" && capture)
    body = <CaptureView key={capture.key} client={client} caps={c ?? null} capture={capture.capture} navigate={navigate} onDrafted={() => env.done(capture.key)} />;
  else if (view.name === "page") body = <PageRoute client={client} caps={c ?? null} id={view.id} navigate={navigate} />;
  else if (view.name === "team") body = <TeamView client={client} team={view.team} navigate={navigate} />;
  else body = <SearchView client={client} q={view.name === "search" ? view.q : ""} navigate={navigate} />;

  return (
    <div class="dw">
      <header class="dw-header">
        <Link href="/search" navigate={navigate} class="dw-brand">
          Docsworth
        </Link>
        {c && (
          <span class="dw-who">
            <span>{c.repo ?? `${c.org} (local)`}</span>
            <span class="dw-badge">{c.mode === "github" ? `@${c.login}` : "local mode"}</span>
          </span>
        )}
      </header>
      <main class="dw-main">
        {c && <SaveBar capture={env.capture} onCaptured={captured} />}
        {waiting.length > 0 && (
          <div class="dw-note" role="status">
            {waiting.length === 1 ? "Another capture is waiting." : `${waiting.length} more captures are waiting.`}{" "}
            <button type="button" class="secondary" onClick={openNext}>
              Open the next one
            </button>
          </div>
        )}
        {body}
        <p class="dw-muted" style={{ marginTop: "32px" }}>
          This panel has its own session: once it has shown a page, drafting follows that page's audience.{" "}
          <button type="button" class="secondary" onClick={env.newSession}>
            Start a new session
          </button>
        </p>
      </main>
    </div>
  );
}

/** Chrome kept the tab from the extension: it has no activeTab there. */
const UNREADABLE = /Cannot access|must request permission|cannot be scripted|chrome:\/\//i;

/** Why the tab couldn't be read, and what would let it be. */
export function readError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (UNREADABLE.test(m))
    return "Docsworth can't read this tab yet. To let it, click the Docsworth button in the toolbar while you're on it, then try again, or right-click the page and choose Save page to Docsworth. Chrome doesn't let extensions read some pages at all, such as the Web Store and chrome:// pages.";
  return `Couldn't read the tab: ${m}`;
}

/** Save this window's tab: its main content, or what's selected in it. */
function SaveBar({ capture, onCaptured }: { capture: (mode: Mode) => Promise<Pending>; onCaptured: (c: Pending) => void }) {
  const [busy, setBusy] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async (mode: Mode) => {
    setBusy(mode);
    setError(null);
    try {
      onCaptured(await capture(mode));
    } catch (err) {
      setError(readError(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div class="dw-save">
      <button type="button" class="secondary" disabled={busy !== null} onClick={() => void save("page")}>
        {busy === "page" ? "Reading the page…" : "Save this page"}
      </button>{" "}
      <button type="button" class="secondary" disabled={busy !== null} onClick={() => void save("selection")}>
        {busy === "selection" ? "Reading the selection…" : "Save the selection"}
      </button>
      {error && (
        <div class="dw-note" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function ConnectError({ error, env }: { error: unknown; env: PanelEnv }) {
  const code = error instanceof DocsworthError ? error.code : "";
  return (
    <>
      <ErrorNotice error={error} />
      <p>A capture sent here is kept for ten minutes from when you made it: reopen this panel with the server running, or connect again, and it opens.</p>
      {code === "forbidden" && (
        <p>
          Start the server so it answers this extension: <code>docsworth serve --allow-extension {env.extensionId}</code>
        </p>
      )}
      <button type="button" onClick={env.openOptions}>
        Connection settings
      </button>
    </>
  );
}

function SearchView({ client, q, navigate }: { client: DocsworthClient; q: string; navigate: Navigate }) {
  return (
    <>
      <SearchBox key={q} initial={q} onSearch={(next) => navigate(`/search?q=${encodeURIComponent(next)}`)} />
      {q ? <SearchResults client={client} q={q} navigate={navigate} /> : <p class="dw-muted">Search your team's pages, as agents see them.</p>}
    </>
  );
}

function SearchResults({ client, q, navigate, limit = 10, action }: { client: DocsworthClient; q: string; navigate: Navigate; limit?: number; action?: Parameters<typeof ResultList>[0]["action"] }) {
  const call = useCall(() => client.call<SearchResponse>("search", { query: q, limit, snippets: "text" }), `${q}:${limit}`);
  return <Loaded call={call}>{(r) => <ResultList response={r} navigate={navigate} action={action} />}</Loaded>;
}

function PageRoute({ client, caps, id, navigate }: { client: DocsworthClient; caps: Capabilities | null; id: string; navigate: Navigate }) {
  const call = useCall(() => client.call<UiPage>("ui_page", { id }), id);
  const [adding, setAdding] = useState(false);
  useEffect(() => setAdding(false), [id]);
  return (
    <Loaded call={call}>
      {(page) => (
        <>
          <PageView page={page} pageIds={new Map(Object.entries(page.links))} navigate={navigate} />
          {!isMirror(page) && (
            <div style={{ marginTop: "20px" }}>
              {adding ? (
                <AppendForm caps={caps} pageTitle={page.title} onSubmit={(append, reason) => client.call<WriteResult>("propose_edit", { id: page.id, append, reason })} />
              ) : (
                <button type="button" class="secondary" onClick={() => setAdding(true)}>
                  Suggest an addition
                </button>
              )}
            </div>
          )}
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

/**
 * A capture: the pages it may already be written down in, each of which it can be added to,
 * then a draft of a new page filled from it. A Gmail thread's address goes nowhere (it means
 * nothing to anyone else); a page's goes in as the draft's source, and as the first line of an
 * addition. The capture is only ever these forms' values.
 */
export function CaptureView({ client, caps, capture, navigate, onDrafted }: { client: DocsworthClient; caps: Capabilities | null; capture: Pending; navigate: Navigate; onDrafted: () => void }) {
  const [target, setTarget] = useState<{ id: string; title: string } | null>(null);
  const title = capture.title.trim() || firstLine(capture.text);
  const web = capture.source !== "gmail" && WEB.test(capture.url);
  const initial: Partial<DraftInput> = {
    type: capture.source === "gmail" ? "runbook" : "guide",
    title: title.slice(0, 200),
    body: capture.text,
    reason: capture.source === "gmail" ? "Written down from an email thread" : "Saved from a page",
    ...(web ? { source_url: capture.url } : {}),
  };
  const addition = `${web ? `> Captured from <${capture.url}> on ${new Date().toISOString().slice(0, 10)}.\n\n` : ""}${capture.text}`;
  return (
    <>
      <h1>{capture.source === "gmail" ? "From Gmail" : "From a page"}</h1>
      {capture.note && (
        <div class="dw-note" role="status">
          {capture.note}
        </div>
      )}
      <h2>Already written down?</h2>
      {target ? (
        <>
          <AppendForm
            caps={caps}
            pageTitle={target.title}
            initial={addition}
            onSubmit={async (append, reason) => {
              const proposed = await client.call<WriteResult>("propose_edit", { id: target.id, append, reason });
              onDrafted();
              return proposed;
            }}
          />
          <button type="button" class="secondary" onClick={() => setTarget(null)}>
            Choose another page
          </button>
        </>
      ) : (
        <SearchResults
          client={client}
          q={asQuery(title) || title}
          navigate={navigate}
          limit={5}
          action={(p) => (
            <button type="button" class="secondary" data-add-to={p.id} onClick={() => setTarget({ id: p.id, title: p.title })}>
              Add the capture here
            </button>
          )}
        />
      )}
      <h2>Draft a page from it</h2>
      <CaptureForm
        caps={caps}
        teams={caps?.teams ?? []}
        initial={initial}
        onSubmit={async (input: DraftInput) => {
          const drafted = await client.call<DraftResult>("draft_page", { ...input });
          onDrafted();
          return drafted;
        }}
      />
    </>
  );
}
