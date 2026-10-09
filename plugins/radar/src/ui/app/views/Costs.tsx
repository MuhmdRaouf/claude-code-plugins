/**
 * The costs tab: the period's spend as one drill-down — repos expand to sessions, sessions to their agents
 * and the jobs they submitted, agents to models — every row with its tokens, estimated cost and a
 * model-mix bar, sortable at every level, exportable as one flat CSV. The total never mixes providers
 * silently: when more than one is priced, the subtitle splits it ("est. $41.20 (Claude $33.29 list price,
 * GLM $7.91)").
 */

import type { ComponentChildren } from "preact";
import { Fragment } from "preact";
import type { AttributionNode, AttributionRange } from "../../../cost/attribution.ts";
import { totalTokens } from "../../../shared/model.ts";
import { providerOf } from "../../../shared/provider.ts";
import { costText, ESTIMATE_NOTE, fmtCount, fmtNum, fmtTokens, fmtUsd } from "../../fmt.ts";
import { modelColor } from "../../palette.ts";
import { type AttributionSortKey, sortTree } from "../../state.ts";
import { StackedBar } from "../Chart.tsx";
import { useApp } from "../context.ts";
import { Icon } from "../Icon.tsx";
import { EmptyState, Panel, Segmented, shortModelName } from "../kit.tsx";
import { type Column, ExportButton, Table, TableHead } from "../table.tsx";

const RANGE_LABEL: Record<AttributionRange, string> = { day: "Today", week: "7 days", month: "30 days" };

const ATTRIBUTION_COLUMNS: Column<AttributionSortKey>[] = [
  { key: "requests", label: "Requests", numeric: true, width: "w-24" },
  { key: "input", label: "Input", numeric: true, width: "w-28" },
  { key: "output", label: "Output", numeric: true, width: "w-28" },
  { key: "cacheRead", label: "Cache read", numeric: true, width: "w-28" },
  { key: "cacheWrite", label: "Cache write", numeric: true, width: "w-28" },
  { key: "cost", label: "Est. cost", numeric: true, width: "w-28" },
];

/** What a provider's spend is called in the total: the family the reader knows, not the company. */
const FAMILY: Record<string, string> = {
  Anthropic: "Claude",
  "Z.ai": "GLM",
  Moonshot: "Kimi",
  DeepSeek: "DeepSeek",
  MiniMax: "MiniMax",
  Qwen: "Qwen",
};

/** One provider's priced share of the period. */
export type ProviderSpend = { family: string; usd: number };

/** The priced parts behind a tree's total, per family, summed from its model rows. */
export function providerSpend(nodes: AttributionNode[]): ProviderSpend[] {
  const byModel = new Map<string, number>();
  const walk = (rows: AttributionNode[]): void => {
    for (const node of rows) {
      if (node.kind === "model" && node.costUsd !== null)
        byModel.set(node.key, (byModel.get(node.key) ?? 0) + node.costUsd);
      walk(node.children);
    }
  };
  walk(nodes);
  const byFamily = new Map<string, number>();
  for (const [model, usd] of byModel) {
    const family = FAMILY[providerOf(model)] ?? "other";
    byFamily.set(family, (byFamily.get(family) ?? 0) + usd);
  }
  return [...byFamily]
    .map(([family, usd]) => ({ family, usd }))
    .sort((a, b) => b.usd - a.usd || a.family.localeCompare(b.family));
}

/** The period's total with its parts named once more than one provider is priced: a quiet "est. $7.00"
 *  turns into "est. $41.20 (Claude $33.29 list price, GLM $7.91)" instead of mixing them silently. */
export function totalText(cost: number | null, parts: ProviderSpend[]): string {
  if (cost === null || parts.length <= 1) return costText(cost);
  const named = parts.map(
    (part, index) => `${part.family} ${fmtUsd(part.usd)}${index === 0 ? " list price" : ""}`,
  );
  return `${costText(cost)} (${named.join(", ")})`;
}

/** Sums the tree's cost (null while no row is priced), request count and token count. */
export function costTotals(nodes: AttributionNode[]): {
  cost: number | null;
  requests: number;
  tokens: number;
} {
  let cost: number | null = null;
  for (const node of nodes) if (node.costUsd !== null) cost = (cost ?? 0) + node.costUsd;
  return {
    cost,
    requests: nodes.reduce((a, n) => a + n.requests, 0),
    tokens: nodes.reduce((a, n) => a + totalTokens(n.tokens), 0),
  };
}

/** The collapse key of one row: the kind first, so a repo and a session can never share one. */
const collapseKey = (node: AttributionNode): string => `${node.kind}:${node.key}`;

/** The row's model mix as one thin stacked bar: a segment per model, coloured by model. */
function ModelMix({ mix }: { mix: AttributionNode["mix"] }) {
  if (mix.length === 0) return null;
  const total = mix.reduce((acc, part) => acc + part.tokens, 0);
  return (
    <span
      class="attr-mix w-24 shrink-0"
      title={mix.map((part) => `${part.model} ${Math.round((part.tokens / total) * 100)}%`).join(" · ")}
    >
      <StackedBar
        max={total}
        segments={mix.map((part) => ({ value: part.tokens, color: modelColor(part.model) }))}
      />
    </span>
  );
}

/** The six numeric cells every row shows: requests, tokens by kind, then the estimate. */
function ValueCells({ node }: { node: AttributionNode }): ComponentChildren {
  return (
    <>
      <td class="num text-right">{fmtNum(node.requests)}</td>
      <td class="num text-right">{fmtNum(node.tokens.input)}</td>
      <td class="num text-right">{fmtNum(node.tokens.output)}</td>
      <td class="num text-right">{fmtNum(node.tokens.cacheRead)}</td>
      <td class="num text-right">{fmtNum(node.tokens.cacheWrite)}</td>
      <td class="num text-right">
        {node.costUsd === null ? (
          <span class="text-base-content/60" title="No price for these models">
            tokens only
          </span>
        ) : (
          <span
            class="strong"
            title={
              node.unpriced > 0 ? `${fmtCount(node.unpriced, "request")} unpriced, not included` : "Estimate"
            }
          >
            {fmtUsd(node.costUsd)}
          </span>
        )}
      </td>
    </>
  );
}

/** One row of the drill-down, then — while it is open — its children one depth further in. */
function NodeRows({ node, depth }: { node: AttributionNode; depth: number }): ComponentChildren {
  const { state, act } = useApp();
  const key = collapseKey(node);
  const collapsed = state.costsCollapsed.has(key);
  return (
    <Fragment key={key}>
      <tr class="attr-row">
        <td class="attr-label min-w-0" style={`padding-left:${depth * 22 + 4}px`}>
          <div class="flex items-center gap-2">
            {node.children.length > 0 ? (
              <button
                type="button"
                class="tree-toggle"
                data-action="costs-collapse"
                data-value={key}
                aria-expanded={collapsed ? "false" : "true"}
                aria-label={`${collapsed ? "Expand" : "Collapse"} ${node.label}`}
                onClick={() => act("costs-collapse", key)}
              >
                <Icon name={collapsed ? "chevronRight" : "chevronDown"} class="icon" />
              </button>
            ) : (
              <span class="tree-toggle tree-leaf" aria-hidden="true" />
            )}
            <span class="attr-name min-w-0 truncate font-medium" title={node.key}>
              {node.kind === "model" ? shortModelName(node.label) : node.label}
            </span>
            {node.note !== null && (
              <span class="attr-note badge badge-ghost badge-sm shrink-0">{node.note}</span>
            )}
            <ModelMix mix={node.mix} />
          </div>
        </td>
        <ValueCells node={node} />
      </tr>
      {!collapsed &&
        node.children.map((child) => <NodeRows key={child.key} node={child} depth={depth + 1} />)}
    </Fragment>
  );
}

/** The whole costs panel: the period control, the drill-down tree, and the estimate note. */
export function CostsView() {
  const { state } = useApp();
  const tree = state.attributionTree;
  const nodes = tree === null ? [] : sortTree(tree, state.attributionSort);
  const totals = costTotals(nodes);
  const total = totalText(totals.cost, providerSpend(nodes));
  const subtitle =
    tree === null
      ? "Loading"
      : `${RANGE_LABEL[state.attributionRange]}: ${total}, ${fmtCount(totals.requests, "request")}, ${fmtTokens(totals.tokens)} tokens`;
  const columns: Column<AttributionSortKey>[] = [
    { key: "label", label: "Breakdown", numeric: false },
    ...ATTRIBUTION_COLUMNS,
  ];
  return (
    <div class="grid gap-5">
      <Panel
        icon="coins"
        flush
        title="Cost attribution"
        subtitle={subtitle}
        actions={
          <>
            <Segmented
              action="attribution-range"
              label="Period"
              segments={(["day", "week", "month"] as AttributionRange[]).map((range) => ({
                label: RANGE_LABEL[range],
                value: range,
                on: state.attributionRange === range,
              }))}
            />
            <ExportButton kind="attribution" count={nodes.length} />
          </>
        }
      >
        {tree === null ? (
          <p class="px-5 py-4 text-sm text-base-content/60">Adding up the usage ledger…</p>
        ) : tree.length === 0 ? (
          <EmptyState
            title="Nothing spent in this period"
            hint="Every model request lands here under the repo that ran it: expand a repo into its sessions, agents and models."
            icon="coins"
          />
        ) : (
          <Table dataKey="attribution-table">
            <TableHead columns={columns} sort={state.attributionSort} action="sort-attribution" />
            <tbody>
              {nodes.map((node) => (
                <NodeRows key={node.key} node={node} depth={0} />
              ))}
            </tbody>
          </Table>
        )}
        <p class="border-t border-base-content/8 px-5 py-3 text-meta text-base-content/60">{ESTIMATE_NOTE}</p>
      </Panel>
    </div>
  );
}
