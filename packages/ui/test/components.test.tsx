import { render } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import { LinkGraph } from "../src/components/graph.js";
import { PageView, plainSnippet, ResultList } from "../src/components/pages.js";
import type { Graph, MirrorReadResponse, ReadResponse, SearchResponse } from "../src/types.js";

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

describe("LinkGraph", () => {
  /** A graph like a big repo's 150 most-linked pages: sparse, with many pages linking none of the others. */
  function sparse(n: number, links: number): Graph {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const nodes = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, title: `Page ${i}`, path: `knowledge/p${i}.md`, type: "runbook" as const, status: "canonical" as const, owner_team: ["data", "web", "sre"][i % 3]!, last_verified: "2026-10-01", due: null, sla_state: "fresh" as const, citable: true, has_restricted_links: false }));
    const edges = Array.from({ length: links }, () => ({ from: `p${Math.floor(rand() * n)}`, to: `p${Math.floor(rand() * n)}` })).filter((e) => e.from !== e.to);
    return { nodes, edges };
  }
  /** Nodes the layout couldn't fit, left on the frame's edge. */
  function pinned(el: HTMLElement) {
    const svg = el.querySelector("svg")!;
    const [, , w, h] = svg.getAttribute("viewBox")!.split(" ").map(Number);
    return [...svg.querySelectorAll("circle[data-id]")].filter((c) => {
      const x = Number(c.getAttribute("cx"));
      const y = Number(c.getAttribute("cy"));
      return x <= 16 || y <= 16 || x >= w! - 16 || y >= h! - 16;
    }).length;
  }

  it("fits 150 sparsely linked pages inside its frame (115 of them were pinned to its edges)", () => {
    const el = mount(<LinkGraph graph={sparse(150, 80)} navigate={() => {}} />);
    expect(el.querySelectorAll("circle[data-id]")).toHaveLength(150);
    expect(pinned(el)).toBeLessThanOrEqual(15);
  });

  it("keeps a small repo's graph in a 1000 by 560 frame, with nothing on its edges", () => {
    const el = mount(<LinkGraph graph={sparse(21, 34)} navigate={() => {}} />);
    expect(el.querySelector("svg")!.getAttribute("viewBox")).toBe("0 0 1000 560");
    expect(pinned(el)).toBe(0);
  });
});

describe("ResultList", () => {
  const hit = (snippet: string): SearchResponse["results"][number] =>
    ({ id: "p", title: "P", type: "runbook", owner_team: "platform", status: "canonical", last_verified: "2026-10-01", sla_state: "fresh", citable: true, snippet, score: 1 }) as SearchResponse["results"][number];
  const shown = (response: SearchResponse) => mount(<ResultList response={response} navigate={() => {}} />).querySelector(".dw-result p")?.textContent;

  it("shows a text snippet as the server cut it, and cleans a markdown one", () => {
    // Text: already what a reader sees; underscores and stars are the page's own.
    expect(shown({ results: [hit("Set memory_enabled for *.md files")], excluded: [], snippets: "text" })).toBe("Set memory_enabled for *.md files");
    // Markdown, from a serve that doesn't cut text snippets yet: cleaned as before.
    expect(shown({ results: [hit("Set **memory** in `config.yaml`")], excluded: [] })).toBe("Set memory in config.yaml");
  });
});

describe("plainSnippet", () => {
  // The server cuts a snippet from the page's markdown at 240 characters, wherever that
  // falls; these two were cut mid-link on the example repo's search for "deploy".
  it("shows a link cut off at the snippet's end as its text", () => {
    expect(plainSnippet("…balance. Runbooks - Deploy to production - [Scale the Kubernetes cluster](runbooks/scale-k8s-c…")).toBe(
      "…balance. Runbooks - Deploy to production - Scale the Kubernetes cluster…",
    );
    expect(plainSnippet("…Read first - Payments API - ADR-0001 and [ADR-0003](../decisions/ADR-0003-ide…")).toBe("…Read first - Payments API - ADR-0001 and ADR-0003…");
    expect(plainSnippet("…see [Scale the Kube…")).toBe("…see Scale the Kube…");
    expect(plainSnippet("…see ![the diagram](img/arch.pn…")).toBe("…see the diagram…");
  });

  it("shows a link cut off at the snippet's start as the text that's left", () => {
    expect(plainSnippet("…Kubernetes cluster](runbooks/scale-k8s-cluster.md) when load grows")).toBe("…Kubernetes cluster when load grows");
  });

  it("leaves whole links, and brackets that aren't links, as they were", () => {
    expect(plainSnippet("Use [the runbook](a.md) and [b](c.md).")).toBe("Use the runbook and b.");
    expect(plainSnippet("Arrays like a[0] (zero-based) and [draft] notes")).toBe("Arrays like a[0] (zero-based) and [draft] notes");
  });

  it("changes nothing at an end the server didn't cut (it marks each cut with …)", () => {
    expect(plainSnippet("Call handler](argument) now")).toBe("Call handler](argument) now");
    expect(plainSnippet("Use [draft](unfinished")).toBe("Use [draft](unfinished");
    expect(plainSnippet("Index array[0")).toBe("Index array[0");
    expect(plainSnippet("Notes in [draft")).toBe("Notes in [draft");
    // Cut, but inside an index, not a link: a bracket right after a word isn't a link's.
    expect(plainSnippet("…index array[0…")).toBe("…index array[0…");
  });
});
