import type { Mode, WorkerTerms } from "./brief.ts";
import { DEFAULT_REPORT, DEFAULT_SCOPE } from "./brief-defaults.ts";
import type { Provider } from "./provider.ts";

/** A front-matter template for `brief new`: every field documented, mode-specific defaults written out. */
export function renderBriefTemplate(
  title: string,
  mode: Mode,
  provider: Provider,
  worker: WorkerTerms,
): string {
  const tiers = Object.values(provider.catalog).map(
    (model) => `${provider.tierNames[model.tier]} (${model.id})`,
  );
  const { efforts, briefNotes } = worker;
  return [
    "---",
    "# Short name shown on the board and in commit messages.",
    `title: ${JSON.stringify(title)}`,
    `# edit: own git worktree and branch ${provider.branchPrefix}<id>; the worker may change files inside scope.`,
    `# exec: may run commands but must not change the repository; outputs go to $${provider.artifactsEnv}.`,
    `# readonly: ${briefNotes.readonly}.`,
    `mode: ${mode}`,
    `# ${tiers.join(" or ")}. Default: ${defaultTiers(provider.defaultTier, provider.tierNames)}.`,
    `model: ${provider.tierNames[provider.defaultTier[mode]]}`,
    ...(provider.caveats.length === 0 ? [] : [`# Caveats: ${provider.caveats.join(" ")}`]),
    `# ${efforts.join(" | ")}, ${briefNotes.effort}. Default: unset.`,
    `# effort: ${efforts[Math.floor(efforts.length / 2)]}`,
    "# Repository the job works on; a relative path resolves against the default, the current git root.",
    "# cwd: .",
    "# Ref the worktree starts from.",
    "base: HEAD",
    "# Globs the change set may touch (picomatch, dotfiles included). Default: everything for edit, nothing otherwise.",
    `scope: ${JSON.stringify(DEFAULT_SCOPE[mode])}`,
    "# Globs that must stay untouched even inside scope.",
    "forbid: []",
    "# Shell commands the plugin runs in the workspace after the worker, each a string or {run, timeout} (default 10m).",
    "# Example: [npm test, { run: npm run lint, timeout: 5m }]",
    "gates: []",
    "# Per attempt: 90s, 15m, 2h, 1h30m or milliseconds.",
    "timeout: 2h",
    "# fix: auto-fix rounds after a failed verdict; infra: re-runs after infrastructure errors.",
    "retries: { fix: 1, infra: 2 }",
    "# Report contract: change, sweep, notes or a path to a JSON schema file. Default: by mode.",
    `report: ${DEFAULT_REPORT[mode]}`,
    `# Extra readable paths, ${briefNotes.addDirs}.`,
    "addDirs: []",
    "# Names of orchestrator environment variables passed to the worker and gates; values are never stored.",
    "env: []",
    `# Spending cap in USD, ${briefNotes.budgetUsd}. Default: unset.`,
    "# budgetUsd: 2",
    "# high or normal: among jobs waiting for a free slot, high goes first. Default: high (run), normal (batch).",
    "# priority: normal",
    "# Free labels for batches and board filters.",
    "tags: []",
    "---",
    "TODO: describe the task for the worker: what to change, where, and what done looks like.",
    "",
  ].join("\n");
}

/** "glm for edit, flash otherwise" when exec and readonly share a tier, else each mode's tier. */
function defaultTiers(tiers: Provider["defaultTier"], names: Provider["tierNames"]): string {
  if (tiers.exec === tiers.readonly) return `${names[tiers.edit]} for edit, ${names[tiers.exec]} otherwise`;
  return `${names[tiers.edit]} for edit, ${names[tiers.exec]} for exec, ${names[tiers.readonly]} for readonly`;
}
