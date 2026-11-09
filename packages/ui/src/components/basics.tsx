import type { ComponentChildren, TargetedMouseEvent } from "preact";
import { DocsworthError } from "../client.js";
import type { PageSummary, SlaState, StaleEntry, Tally } from "../types.js";

/** Where an in-app link goes; the host app (web or extension) decides how to show it. */
export type Navigate = (href: string) => void;

/** An anchor with a real href that the host app routes itself (new-tab clicks still work). */
export function Link(props: { href: string; navigate: Navigate; children: ComponentChildren; class?: string }) {
  const onClick = (e: TargetedMouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    props.navigate(props.href);
  };
  return (
    <a href={props.href} class={props.class} onClick={onClick}>
      {props.children}
    </a>
  );
}

const SLA: Record<SlaState, [string, string]> = {
  fresh: ["ok", "in review window"],
  due_soon: ["warn", "due soon"],
  overdue: ["bad", "past review date"],
  unverified: ["bad", "never verified"],
};

export function SlaBadge({ state, due }: { state: SlaState; due?: string | null }) {
  const [tone, label] = SLA[state];
  return (
    <span class={`dw-badge ${tone}`} title={due ? `review due ${due}` : undefined}>
      {label}
    </span>
  );
}

export function CitableBadge({ page }: { page: Pick<PageSummary, "citable" | "status"> }) {
  if (page.citable) return <span class="dw-badge ok">citable</span>;
  return <span class="dw-badge warn">{page.status === "canonical" ? "not citable" : page.status}</span>;
}

export function PageMeta({ page, navigate }: { page: PageSummary; navigate: Navigate }) {
  return (
    <div class="dw-meta">
      <CitableBadge page={page} />
      <SlaBadge state={page.sla_state} due={page.due} />
      <span>{page.type}</span>
      <span>
        owned by{" "}
        <Link href={`/t/${encodeURIComponent(page.owner_team)}`} navigate={navigate}>
          {page.owner_team}
        </Link>
      </span>
      <span class="dw-num">verified {page.last_verified}</span>
    </div>
  );
}

export function Tiles({ items }: { items: { value: number | string; label: string }[] }) {
  return (
    <div class="dw-tiles">
      {items.map((t) => (
        <div class="dw-tile" key={t.label}>
          <b>{t.value}</b>
          <span>{t.label}</span>
        </div>
      ))}
    </div>
  );
}

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((100 * n) / d));
const tone = (p: number) => (p >= 90 ? "dw-good" : p >= 70 ? "dw-warn" : "dw-bad");

export function Bar({ value }: { value: number }) {
  return (
    <div class="dw-bar" role="img" aria-label={`${value}%`}>
      <span class={tone(value)} style={{ width: `${Math.min(100, value)}%` }} />
    </div>
  );
}

/** Per team: how many of its visible pages are citable, and what needs a review. */
export function TeamBars({ teams, navigate }: { teams: (Tally & { team: string })[]; navigate: Navigate }) {
  return (
    <div class="dw-scroll">
      <table class="dw-table">
        <thead>
          <tr>
            <th scope="col">Team</th>
            <th scope="col">Pages</th>
            <th scope="col">Citable</th>
            <th scope="col">Overdue</th>
            <th scope="col">Due soon</th>
          </tr>
        </thead>
        <tbody>
          {teams.map((t) => (
            <tr key={t.team}>
              <th scope="row">
                <Link href={`/t/${encodeURIComponent(t.team)}`} navigate={navigate}>
                  {t.team}
                </Link>
              </th>
              <td class="dw-num">{t.pages}</td>
              <td>
                <Bar value={pct(t.citable, t.pages)} />
                <span class="dw-num dw-muted">
                  {t.citable}/{t.pages} · {pct(t.citable, t.pages)}%
                </span>
              </td>
              <td class="dw-num">{t.overdue}</td>
              <td class="dw-num">{t.due_soon}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StaleTable({ entries, navigate }: { entries: StaleEntry[]; navigate: Navigate }) {
  if (entries.length === 0) return <p class="dw-muted">Nothing is past its review date.</p>;
  return (
    <div class="dw-scroll">
      <table class="dw-table">
        <thead>
          <tr>
            <th scope="col">Page</th>
            <th scope="col">Team</th>
            <th scope="col">Why</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((s) => (
            <tr key={s.id}>
              <td>
                <Link href={`/p/${encodeURIComponent(s.id)}`} navigate={navigate}>
                  {s.title}
                </Link>
              </td>
              <td>{s.owner_team}</td>
              <td class="dw-muted">{s.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ErrorNotice({ error }: { error: unknown }) {
  const message = error instanceof DocsworthError || error instanceof Error ? error.message : String(error);
  return (
    <div class="dw-note dw-error" role="alert">
      {message}
    </div>
  );
}
