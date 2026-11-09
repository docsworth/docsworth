import { render } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import { PageView } from "../src/components/pages.js";
import type { MirrorReadResponse, ReadResponse } from "../src/types.js";

let root: HTMLElement;
afterEach(() => {
  render(null, root);
  root.remove();
});
function mount(node: preact.ComponentChildren) {
  root = document.createElement("div");
  document.body.appendChild(root);
  render(node, root);
  return root;
}

const PAGE: ReadResponse = {
  id: "rb-deploy-prod",
  title: "Deploy to production",
  path: "knowledge/runbooks/deploy-production.md",
  type: "runbook",
  status: "canonical",
  owner_team: "platform",
  last_verified: "2026-10-15",
  due: "2027-01-13",
  sla_state: "fresh",
  citable: true,
  review_every: "90d",
  acl: "internal",
  supersedes: [],
  applies_to: [],
  flags: [],
  content: "# Deploy to production\n\nSee [the ADR](../decisions/ADR-0002-argo-rollouts.md).\n",
};

const MIRROR: MirrorReadResponse = {
  id: "mirror:confluence:ENG:123",
  title: "Kafka runbook (old wiki)",
  source: "confluence",
  space: "ENG",
  source_url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/123",
  owner_team: "platform",
  last_edited: "2025-03-01",
  acl: "internal",
  citable: false,
  flags: ["mirrored"],
  gate_reason: "mirrored from Confluence: a copy of the old wiki, not a verified page",
  content: "Restart with [the script](./restart.md) or [the old page](/wiki/x).\n",
};

describe("PageView", () => {
  it("shows a repo page's title once, with its meta, and routes its links in the app", () => {
    const el = mount(<PageView page={PAGE} pageIds={new Map([["knowledge/decisions/ADR-0002-argo-rollouts.md", "adr-0002"]])} navigate={() => {}} />);
    expect([...el.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Deploy to production"]);
    expect(el.querySelector(".dw-badge")?.textContent).toBe("citable");
    expect(el.querySelector(".dw-prose a")?.getAttribute("href")).toBe("/p/adr-0002");
  });

  it("renders a mirrored page as context: its source, the gate's reason, and no in-app routes", () => {
    const el = mount(<PageView page={MIRROR} pageIds={new Map([["restart.md", "rb-x"]])} navigate={() => {}} />);
    expect(el.querySelector(".dw-badge")?.textContent).toBe("mirrored");
    expect(el.textContent).toContain("Confluence · ENG");
    expect(el.textContent).toContain("a copy of the old wiki");
    const original = [...el.querySelectorAll("a")].find((a) => a.textContent === "the original");
    expect(original?.getAttribute("href")).toBe(MIRROR.source_url);
    expect(original?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(el.querySelectorAll(".dw-prose a")).toHaveLength(0);
    expect(el.querySelector(".dw-prose")?.textContent).toContain("Restart with the script or the old page.");
  });

  it("doesn't link a mirrored page's source unless it is http or https", () => {
    const el = mount(<PageView page={{ ...MIRROR, source_url: "javascript:alert(1)" }} pageIds={new Map()} navigate={() => {}} />);
    expect([...el.querySelectorAll("a")].some((a) => a.textContent === "the original")).toBe(false);
  });
});
