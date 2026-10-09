// progress.tsx — the two progress pictures: the percentage ring on the Overview, and the phase diagram,
// the plan's phase body as layered boxes joined by curved arrows. Picking a box (click, Enter or Space)
// tells what it is in the line under the drawing. Port of app.js ring and work.js phaseDiagram/wireDiagram.

import type { JSX, VNode } from "preact";
import { useState } from "preact/hooks";

/**
 * The progress ring: a circle of circumference 100, so the dash is the percentage. At 0 the meter hides and
 * only the ring's number speaks.
 */
export function Ring({
  pct,
  class: c = "size-24",
}: {
  pct: number;
  class?: string | undefined;
}): JSX.Element {
  return (
    <svg class={`pct-ring ${c}`} viewBox="0 0 36 36" role="img" aria-label={`${pct}% of the tasks done`}>
      <circle class="track" cx="18" cy="18" r="15.9155" />
      <circle
        class="meter"
        data-ovring
        cx="18"
        cy="18"
        r="15.9155"
        stroke-dasharray={`${pct} 100`}
        transform="rotate(-90 18 18)"
        style={pct ? undefined : "display:none"}
      />
      <text x="18" y="21" text-anchor="middle" data-ovpct>
        {pct}%
      </text>
    </svg>
  );
}

/** One box of the diagram: [id, label, kind?, description?], kinds from NODEK, unknown kinds read as service. */
export type PhaseNode = readonly [id: string, label: string, kind?: string, desc?: string];

/** One arrow: [from id, to id, label?]. */
export type PhaseEdge = readonly [from: string, to: string, label?: string];

/** The phase body's graph: its boxes and the arrows between them. */
export type PhaseGraph = {
  nodes: readonly PhaseNode[];
  edges?: readonly PhaseEdge[] | undefined;
};

/** Kind → what the box's second line calls it, and the colour both its stroke and fill mix. */
const NODEK = {
  ext: ["external", "--sky"],
  net: ["network", "--blue"],
  host: ["host", "--peach"],
  svc: ["service", "--mauve"],
  store: ["storage", "--yellow"],
  lxc: ["container", "--green"],
  vm: ["vm", "--teal"],
} as const satisfies Record<string, readonly [string, string]>;

/** The table row for a node's kind; an unknown kind reads as a service. */
const nodeKind = (kind: string | undefined): readonly [string, string] => {
  if (kind !== undefined && kind in NODEK) return NODEK[kind as keyof typeof NODEK];
  return NODEK.svc;
};

const NW = 168;
const NH = 48;
const GX = 92;
const GY = 22;
const M = 14;

/** One box's place: its column's x and its row's y, centred in its column. */
type Pos = { x: number; y: number };

/** An edge resolved to node indexes with its label. */
type LaidEdge = [a: number, b: number, label: string];

/** The nodes' layer per edge, the long way: every edge pulls its target below its source, to a fixpoint. */
function levels(edgeList: readonly LaidEdge[], n: number): number[] {
  const lvl = new Array<number>(n).fill(0);
  for (let it = 0; it < n; it += 1) {
    let moved = false;
    for (const [a, b] of edgeList) {
      const la = lvl[a] ?? 0;
      const lb = lvl[b] ?? 0;
      if (lb < la + 1 && la < n) {
        lvl[b] = la + 1;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return lvl;
}

/** Resolve the graph's edges to index pairs, dropping edges that name nodes the graph does not have. */
function resolveEdges(g: PhaseGraph): LaidEdge[] {
  const idx = new Map(g.nodes.map((n, i) => [n[0], i] as const));
  const out: LaidEdge[] = [];
  for (const e of g.edges ?? []) {
    const a = idx.get(e[0]);
    const b = idx.get(e[1]);
    if (a !== undefined && b !== undefined) out.push([a, b, e[2] ?? ""]);
  }
  return out;
}

/** Layer the graph into columns and give every box its place; the shape the diagram draws from. */
function layout(g: PhaseGraph): {
  pos: Pos[];
  edges: LaidEdge[];
  /** The svg's size, from the box and gap sizes and the column count */
  H: number;
  W: number;
} {
  const edges = resolveEdges(g);
  const Nn = g.nodes.length;
  const lvl = levels(edges, Nn);
  const touched = new Set(edges.flatMap((e) => [e[0], e[1]] as const));
  const maxOf = (xs: readonly number[]): number => xs.reduce((m, x) => Math.max(m, x), 0);
  const maxL = maxOf(lvl);
  const cols = new Map<number, number[]>();
  for (let i = 0; i < Nn; i += 1) {
    const c = (touched.has(i) ? lvl[i] : maxL + 1) ?? 0;
    const col = cols.get(c) ?? [];
    col.push(i);
    cols.set(c, col);
  }
  const ncol = maxOf([...cols.keys()]) + 1;
  const H = maxOf([...cols.values()].map((a) => a.length)) * (NH + GY) - GY + M * 2;
  const W = M * 2 + ncol * NW + (ncol - 1) * GX;
  const pos: Pos[] = new Array(Nn);
  for (const [c, arr] of cols) {
    const x = M + c * (NW + GX);
    const tot = arr.length * (NH + GY) - GY;
    const y0 = (H - tot) / 2;
    arr.forEach((ni, k) => {
      pos[ni] = { x, y: y0 + k * (NH + GY) };
    });
  }
  return { pos, edges, H, W };
}

/**
 * The phase architecture: the graph as layered boxes (each box's label, cut at 22 characters, over its
 * kind) joined by curved labelled arrows, and the line under it that describes the picked box. A graph
 * without nodes draws nothing.
 */
export function PhaseDiagram({ g }: { g: PhaseGraph | null | undefined }): JSX.Element | null {
  const [sel, setSel] = useState<number | null>(null);
  if (!g || g.nodes.length === 0) return null;

  const { pos, edges, H, W } = layout(g);

  const arrow = (e: readonly [number, number, string], i: number): VNode => {
    const [a, b, l] = e;
    const A = pos[a];
    const B = pos[b];
    if (!A || !B) return <g key={i} />;
    const r = B.x >= A.x;
    const x = r ? A.x + NW : A.x;
    const y = A.y + NH / 2;
    const tx = r ? B.x : B.x + NW;
    const ty = B.y + NH / 2;
    const mx = (x + tx) / 2;
    const lw = l.length * 5.2 + 12;
    return (
      <g class="edge" key={i}>
        <path d={`M ${x} ${y} C ${mx} ${y}, ${mx} ${ty}, ${tx} ${ty}`} marker-end="url(#arr)" />
        {l ? (
          <g>
            <rect class="pillbg" x={mx - lw / 2} y={(y + ty) / 2 - 8} width={lw} height="16" rx="8" />
            <text x={mx} y={(y + ty) / 2 + 4} text-anchor="middle">
              {l}
            </text>
          </g>
        ) : null}
      </g>
    );
  };

  const chosen = sel !== null ? g.nodes[sel] : undefined;

  return (
    <div>
      <div class="overflow-x-auto rounded-lg border hairline bg-base-200/50">
        {/* biome-ignore lint/a11y/useSemanticElements: the legacy diagram's svg and its group role, kept word for word */}
        <svg
          class="pgraph"
          viewBox={`0 0 ${W} ${H}`}
          style={`min-width:${Math.min(W, 900)}px;max-height:420px;width:100%`}
          role="group"
          aria-label="How the phase fits together"
        >
          <defs>
            <marker
              id="arr"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto"
            >
              <path d="M0,0 L10,5 L0,10 z" fill="var(--border-2)" />
            </marker>
          </defs>
          {edges.map(arrow)}
          {g.nodes.map((n, i) => {
            const k = nodeKind(n[2]);
            const lab = n[1].length > 22 ? `${n[1].slice(0, 21)}…` : n[1];
            const p = pos[i];
            if (!p) return <g key={n[0]} />;
            return (
              // biome-ignore lint/a11y/useSemanticElements: a box is an svg node, not an html button; the legacy diagram read it the same way
              <g
                class={`node${sel === i ? " sel" : ""}`}
                data-i={i}
                key={n[0]}
                role="button"
                aria-label={n[1]}
                tabindex={0}
                transform={`translate(${p.x},${p.y})`}
                onClick={() => setSel(i)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  setSel(i);
                }}
              >
                <rect
                  width={NW}
                  height={NH}
                  rx="9"
                  style={`stroke:var(${k[1]});fill:color-mix(in srgb,var(${k[1]}) 12%,var(--panel))`}
                />
                <text x="10" y="20">
                  {lab}
                </text>
                <text x="10" y="36" class="k">
                  {k[0].charAt(0).toUpperCase() + k[0].slice(1)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p
        class="mt-2 rounded-lg border-l-2 border-base-content/15 bg-base-200/50 px-3 py-2 text-sm muted"
        aria-live="polite"
      >
        {chosen ? (
          <>
            <b class="text-base-content">{chosen[1]}</b>: {chosen[3] ?? ""}
          </>
        ) : (
          "Select a box to read what it is."
        )}
      </p>
    </div>
  );
}
