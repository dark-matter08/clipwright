// The persona's knowledge graph, live from SQLite.
//
// What a persona has learned and what it has worked on, as nodes: the
// persona at the centre, a hub per memory kind, entries hanging off
// their hub, and edges between entries that came from the same source
// — which is what makes a run of lessons from one series cluster
// visibly instead of scattering by date.
//
// Layout is a small force simulation written here rather than pulled
// from d3-force. The graph is tens of nodes, not thousands; the whole
// simulation is ~40 lines, and it avoids a dependency whose bundle is
// larger than the feature. If these graphs ever reach thousands of
// nodes, swap this for d3-force and keep the same data shape.

import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { personaGraph, type PersonaGraph, type PersonaGraphNode } from "../lib/tauri";
import { cn } from "../lib/cn";

interface Positioned extends PersonaGraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const KIND_COLOR: Record<string, string> = {
  persona: "hsl(var(--accent))",
  kind: "hsl(var(--fg-muted))",
  note: "hsl(var(--success))",
  edit: "hsl(var(--accent))",
  reference: "hsl(var(--info))",
  video: "hsl(var(--fg-subtle))",
};

const RADIUS: Record<string, number> = { persona: 13, kind: 9 };

export function PersonaGraphView({ personaId }: { personaId: string }) {
  const [graph, setGraph] = useState<PersonaGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<PersonaGraphNode | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!personaId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    personaGraph(personaId)
      .then((g) => !cancelled && setGraph(g))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [personaId, tick]);

  const laid = useMemo(() => (graph ? layout(graph) : null), [graph]);

  if (!personaId) {
    return <Empty text="Select a persona to see its knowledge graph." />;
  }
  if (loading && !graph) {
    return (
      <div className="flex h-full items-center justify-center text-fg-muted">
        <Loader2 size={16} strokeWidth={2} className="mr-2 animate-spin" />
        Building graph…
      </div>
    );
  }
  if (error) return <Empty text={error} tone="warn" />;
  if (!laid || laid.nodes.length <= 1) {
    return (
      <Empty text="Nothing learned yet. Add a note, feed a reference, or render a video — the graph fills in as the persona works." />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between px-1 pb-2">
        <span className="text-[11px] text-fg-muted">
          {laid.nodes.length - 1} nodes · {laid.edges.length} links
        </span>
        <button
          type="button"
          onClick={() => setTick((t) => t + 1)}
          title="Rebuild from the database"
          className="flex items-center gap-1 rounded border border-border-subtle px-1.5 py-0.5 text-[11px] text-fg-subtle transition-colors hover:border-accent/50 hover:text-fg"
        >
          <RefreshCw size={10} strokeWidth={2} />
          Refresh
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded border border-border-subtle bg-bg-inset">
        <svg viewBox="0 0 400 400" className="h-full w-full" role="img" aria-label="Persona knowledge graph">
          {laid.edges.map((e, i) => (
            <line
              key={i}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              stroke={
                e.relation === "same-source"
                  ? "hsl(var(--accent) / 0.35)"
                  : "hsl(var(--border) / 0.8)"
              }
              strokeWidth={e.relation === "same-source" ? 1.2 : 0.7}
              strokeDasharray={e.relation === "same-source" ? "3 2" : undefined}
            />
          ))}
          {laid.nodes.map((n) => {
            const r = RADIUS[n.kind] ?? 5 + (n.weight ?? 0.5) * 4;
            const isSel = selected?.id === n.id;
            return (
              <g key={n.id} onClick={() => setSelected(n)} className="cursor-pointer">
                <circle
                  cx={n.x}
                  cy={n.y}
                  r={r}
                  fill={KIND_COLOR[n.kind] ?? "hsl(var(--fg-subtle))"}
                  stroke={isSel ? "hsl(var(--fg))" : "transparent"}
                  strokeWidth={2}
                  opacity={n.kind === "kind" ? 0.75 : 1}
                />
                {(n.kind === "persona" || n.kind === "kind") && (
                  <text
                    x={n.x}
                    y={n.y - r - 4}
                    textAnchor="middle"
                    className="fill-fg-muted"
                    style={{ fontSize: 9 }}
                  >
                    {n.label}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Click-to-inspect rather than hover tooltips: entries are
       *  paragraphs, and a tooltip that long is unreadable. */}
      <div className="mt-2 min-h-[64px] shrink-0 rounded border border-border-subtle bg-bg-inset px-2.5 py-2">
        {selected ? (
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-accent">
              {selected.kind}
            </span>
            <span className="text-xs text-fg">{selected.body || selected.label}</span>
            {selected.source && (
              <span className="truncate font-mono text-[10px] text-fg-muted">
                {selected.source}
              </span>
            )}
          </div>
        ) : (
          <span className="text-[11px] text-fg-muted">
            Click a node to read it. Dashed links join entries that came from
            the same project or reference.
          </span>
        )}
      </div>
    </div>
  );
}

function Empty({ text, tone }: { text: string; tone?: "warn" }) {
  return (
    <div
      className={cn(
        "flex h-full items-center justify-center px-6 text-center text-[11px]",
        tone === "warn" ? "text-warn" : "text-fg-muted",
      )}
    >
      {text}
    </div>
  );
}

/** Force-directed layout: repulsion between all nodes, springs along
 *  edges, and a weak pull toward the centre so nothing drifts off the
 *  viewBox. Runs to a fixed iteration count rather than animating —
 *  a settled graph is easier to read than one that's still moving, and
 *  it keeps this a pure function of the data. */
function layout(graph: PersonaGraph) {
  const W = 400;
  const H = 400;
  const nodes: Positioned[] = graph.nodes.map((n, i) => {
    // Seed on a circle rather than at random: deterministic output, so
    // a refresh doesn't reshuffle a graph the user was reading.
    const a = (i / Math.max(1, graph.nodes.length)) * Math.PI * 2;
    return {
      ...n,
      x: W / 2 + Math.cos(a) * 120,
      y: H / 2 + Math.sin(a) * 120,
      vx: 0,
      vy: 0,
    };
  });
  const index = new Map(nodes.map((n) => [n.id, n]));
  const edges = graph.edges
    .map((e) => ({ ...e, a: index.get(e.source), b: index.get(e.target) }))
    .filter((e) => e.a && e.b);

  for (let iter = 0; iter < 220; iter++) {
    // Repulsion — O(n²), fine at this size.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          // Exactly coincident nodes produce NaN; nudge them apart.
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = 0.01;
        }
        const force = 900 / d2;
        const d = Math.sqrt(d2);
        a.vx -= (dx / d) * force;
        a.vy -= (dy / d) * force;
        b.vx += (dx / d) * force;
        b.vy += (dy / d) * force;
      }
    }
    // Springs.
    for (const e of edges) {
      const a = e.a as Positioned;
      const b = e.b as Positioned;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const target = e.relation === "same-source" ? 34 : 52;
      const force = (d - target) * 0.02;
      a.vx += (dx / d) * force;
      a.vy += (dy / d) * force;
      b.vx -= (dx / d) * force;
      b.vy -= (dy / d) * force;
    }
    // Centre pull + damping.
    for (const n of nodes) {
      n.vx += (W / 2 - n.x) * 0.004;
      n.vy += (H / 2 - n.y) * 0.004;
      n.vx *= 0.82;
      n.vy *= 0.82;
      n.x += n.vx;
      n.y += n.vy;
      n.x = Math.max(18, Math.min(W - 18, n.x));
      n.y = Math.max(18, Math.min(H - 18, n.y));
    }
  }

  return {
    nodes,
    edges: edges.map((e) => ({
      relation: e.relation,
      x1: (e.a as Positioned).x,
      y1: (e.a as Positioned).y,
      x2: (e.b as Positioned).x,
      y2: (e.b as Positioned).y,
    })),
  };
}
