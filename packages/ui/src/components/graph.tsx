import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { useMemo } from "preact/hooks";
import type { Graph, GraphNode } from "../types.js";
import type { Navigate } from "./basics.js";

// Visible pages as nodes, coloured by owning team; links between them as edges. A page
// agents can't cite is dimmed; a dashed ring marks one that links to a page you can't see.
// The layout runs to rest before render (no animation), so it is stable and testable.

const PALETTE = ["#2b5fa8", "#2f7d4f", "#b7791f", "#8a4fbf", "#b4442c", "#1f8a8a", "#7a6a2b", "#c2417a"];

type Placed = GraphNode & SimulationNodeDatum;

export function teamColors(teams: string[]): Map<string, string> {
  return new Map([...new Set(teams)].sort().map((t, i) => [t, PALETTE[i % PALETTE.length]!]));
}

export function layout(graph: Graph, width: number, height: number): Placed[] {
  const nodes: Placed[] = graph.nodes.map((n, i) => ({ ...n, x: width / 2 + Math.cos(i) * 80, y: height / 2 + Math.sin(i) * 80 }));
  const ids = new Set(nodes.map((n) => n.id));
  const links = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ source: e.from, target: e.to }));
  const sim = forceSimulation(nodes)
    .force("link", forceLink<Placed, { source: string; target: string }>(links).id((d) => d.id).distance(110))
    .force("charge", forceManyBody().strength(-520))
    .force("collide", forceCollide(36))
    // Pages with no links would drift to the edge; a gentle pull keeps them in view.
    .force("x", forceX(width / 2).strength(0.05))
    .force("y", forceY(height / 2).strength(0.08))
    .force("center", forceCenter(width / 2, height / 2))
    .stop();
  for (let i = 0; i < 300; i++) sim.tick();
  // Keep everything inside the frame.
  for (const n of nodes) {
    n.x = Math.max(16, Math.min(width - 16, n.x ?? 0));
    n.y = Math.max(16, Math.min(height - 16, n.y ?? 0));
  }
  return nodes;
}

export function LinkGraph({ graph, navigate, width = 1000, height = 560 }: { graph: Graph; navigate: Navigate; width?: number; height?: number }) {
  const placed = useMemo(() => layout(graph, width, height), [graph, width, height]);
  const at = new Map(placed.map((n) => [n.id, n]));
  const colors = teamColors(graph.nodes.map((n) => n.owner_team));
  return (
    <div>
      <div class="dw-legend">
        {[...colors].map(([team, color]) => (
          <span key={team}>
            <span class="dw-swatch" style={{ background: color }} />
            {team}
          </span>
        ))}
        <span>dimmed: agents can't cite it</span>
        <span>dashed ring: links to a page you can't see</span>
      </div>
      <svg class="dw-graph" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${graph.nodes.length} pages, ${graph.edges.length} links`}>
        {graph.edges.map((e) => {
          const a = at.get(e.from);
          const b = at.get(e.to);
          return a && b ? <line key={`${e.from}>${e.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} /> : null;
        })}
        {placed.map((n) => (
          <g key={n.id}>
            <title>{`${n.title} (${n.owner_team})${n.citable ? "" : " · not citable"}`}</title>
            {n.has_restricted_links && <circle cx={n.x} cy={n.y} r={13} fill="none" stroke={colors.get(n.owner_team)} stroke-dasharray="3 3" />}
            <circle
              data-id={n.id}
              class={n.citable ? undefined : "dim"}
              cx={n.x}
              cy={n.y}
              r={8}
              fill={colors.get(n.owner_team)}
              onClick={() => navigate(`/p/${encodeURIComponent(n.id)}`)}
            />
            <text x={(n.x ?? 0) + 11} y={(n.y ?? 0) + 4}>
              {n.title.length > 28 ? `${n.title.slice(0, 27)}…` : n.title}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
