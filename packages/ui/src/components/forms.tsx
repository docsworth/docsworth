import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren, TargetedEvent } from "preact";
import type { Capabilities, DraftResult, PageType, WriteResult } from "../types.js";
import { ErrorNotice } from "./basics.js";

export interface DraftInput {
  type: Exclude<PageType, "adr">;
  title: string;
  owner_team: string;
  acl?: string;
  dir?: string;
  description?: string;
  body: string;
  source_url?: string;
  reason: string;
}

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "page";
const PREFIX: Record<DraftInput["type"], string> = { runbook: "rb", service: "svc", guide: "guide", policy: "pol" };

/** Why a write tool can't be used here, or null when it can. */
export function writeBlocked(caps: Capabilities | null, tool: string): string | null {
  if (!caps) return "checking what this server allows…";
  if (!caps.writes) return caps.writes_off ?? "writes are off";
  if (!caps.write_tools.includes(tool)) return `the policy doesn't allow you \`${tool}\``;
  return null;
}

function Field(props: { label: string; hint?: string; children: ComponentChildren }) {
  return (
    <label>
      <span>
        {props.label}
        {props.hint && <span class="dw-muted"> · {props.hint}</span>}
      </span>
      {props.children}
    </label>
  );
}

function PrDone({ result, what }: { result: WriteResult; what: string }) {
  return (
    <div class="dw-note" role="status">
      {what}:{" "}
      <a href={result.pr_url} target="_blank" rel="noopener noreferrer">
        PR #{result.pr_number}
      </a>
      . Its owners review it there; nothing changes until they merge it.
    </div>
  );
}

/** A new page as a draft PR (draft_page). The server names it and checks every rule again. */
export function CaptureForm(props: { caps: Capabilities | null; teams: string[]; initial?: Partial<DraftInput>; onSubmit: (input: DraftInput) => Promise<DraftResult> }) {
  const { caps, teams } = props;
  const [v, setV] = useState<DraftInput>({ type: "runbook", title: "", owner_team: teams[0] ?? "", body: "", reason: "", acl: "internal", ...props.initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<DraftResult | null>(null);
  const blocked = writeBlocked(caps, "draft_page");
  // The teams arrive with the capabilities, after the first render: default to the first then.
  useEffect(() => {
    if (!v.owner_team && teams[0]) setV((cur) => ({ ...cur, owner_team: teams[0]! }));
  }, [teams.join(",")]);
  const set = (k: keyof DraftInput) => (e: TargetedEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setV({ ...v, [k]: e.currentTarget.value });
  const ready = !blocked && v.title.trim() && v.owner_team && v.body.trim() && v.reason.trim();

  const submit = async (e: TargetedEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const input: DraftInput = { ...v, title: v.title.trim(), reason: v.reason.trim() };
      for (const k of ["dir", "description", "source_url"] as const) if (!input[k]?.trim()) delete input[k];
      if (input.acl === "internal") delete input.acl;
      setDone(await props.onSubmit(input));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const preview = [
    "---",
    `title: ${v.title || "…"}`,
    `id: ${PREFIX[v.type]}-${slug(v.title)}-<12 random hex>`,
    `type: ${v.type}`,
    "status: draft",
    `owner_team: ${v.owner_team || "…"}`,
    "review_every: 90d",
    ...(v.acl && v.acl !== "internal" ? [`acl: ${v.acl}`] : []),
    ...(v.description ? [`description: ${v.description}`] : []),
    "---",
    ...(v.source_url ? [`> Captured from <${v.source_url}>.`, ""] : []),
    v.body || "…",
  ].join("\n");

  return (
    <form class="dw-form" onSubmit={submit}>
      {blocked && <div class="dw-note">Drafting is off here: {blocked}.</div>}
      <div class="dw-row">
        <Field label="Type">
          <select value={v.type} onChange={set("type")}>
            {(["runbook", "service", "guide", "policy"] as const).map((t) => (
              <option value={t} key={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Owning team" hint="CODEOWNERS must give it the directory, or <team>- names in it">
          <select value={v.owner_team} onChange={set("owner_team")}>
            {teams.map((t) => (
              <option value={t} key={t}>
                {t}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Audience" hint="internal, or a team you're on">
          <input value={v.acl} onInput={set("acl")} />
        </Field>
      </div>
      <Field label="Title">
        <input value={v.title} maxLength={200} onInput={set("title")} required />
      </Field>
      <Field label="Description" hint="optional, one line">
        <input value={v.description ?? ""} maxLength={280} onInput={set("description")} />
      </Field>
      <Field label="Body" hint="markdown">
        <textarea value={v.body} onInput={set("body")} required />
      </Field>
      <div class="dw-row">
        <Field label="Source" hint="optional link">
          <input type="url" value={v.source_url ?? ""} onInput={set("source_url")} placeholder="https://" />
        </Field>
        <Field label="Directory" hint="optional, under the knowledge root">
          <input value={v.dir ?? ""} onInput={set("dir")} placeholder="runbooks" />
        </Field>
      </div>
      <Field label="Why it's needed" hint="goes in the PR">
        <input value={v.reason} onInput={set("reason")} required />
      </Field>
      <details>
        <summary>Preview</summary>
        <div class="dw-preview">{preview}</div>
      </details>
      <div class="dw-note">
        It opens as a draft PR{caps?.repo ? ` on ${caps.repo}` : ""}. Once the PR exists, everyone who can read the repository can read it,
        whatever its audience. The page is a draft, so agents won't cite it until its owners make it canonical.
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      {done && <PrDone result={done} what={`Drafted ${done.id}`} />}
      <div>
        <button type="submit" disabled={!ready || busy}>
          {busy ? "Opening the PR…" : "Open a draft PR"}
        </button>
      </div>
    </form>
  );
}

/** A section added to the end of a page, as a PR (propose_edit with append). */
export function AppendForm(props: { caps: Capabilities | null; pageTitle: string; initial?: string; onSubmit: (append: string, reason: string) => Promise<WriteResult> }) {
  const [text, setText] = useState(props.initial ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<WriteResult | null>(null);
  const blocked = writeBlocked(props.caps, "propose_edit");
  const submit = async (e: TargetedEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (blocked || busy || !text.trim() || !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setDone(await props.onSubmit(text, reason.trim()));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="dw-form" onSubmit={submit} aria-label={`Add to ${props.pageTitle}`}>
      {blocked && <div class="dw-note">Adding is off here: {blocked}.</div>}
      <Field label={`Add to “${props.pageTitle}”`} hint="markdown, added at the end">
        <textarea value={text} onInput={(e) => setText(e.currentTarget.value)} />
      </Field>
      <Field label="Why" hint="goes in the PR">
        <input value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
      </Field>
      {error ? <ErrorNotice error={error} /> : null}
      {done && <PrDone result={done} what="Proposed" />}
      <div>
        <button type="submit" disabled={Boolean(blocked) || busy || !text.trim() || !reason.trim()}>
          {busy ? "Opening the PR…" : "Propose the addition"}
        </button>
      </div>
    </form>
  );
}
