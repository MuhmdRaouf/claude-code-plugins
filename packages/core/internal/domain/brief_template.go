package domain

import (
	"encoding/json"
	"strings"
)

// RenderBriefTemplate renders a front-matter template for `brief new`: every field documented,
// mode-specific defaults written out.
func RenderBriefTemplate(title string, mode Mode, provider Provider, worker WorkerTerms) string {
	tiers := make([]string, 0, 2)
	for _, tier := range []ModelTier{ModelTierMain, ModelTierFlash} {
		tiers = append(tiers, provider.TierNames[tier]+" ("+provider.Catalog[tier].ID+")")
	}
	efforts := worker.Efforts
	lines := []string{
		"---",
		"# Short name shown on the board and in commit messages.",
		"title: " + jsonText(title),
		"# edit: own git worktree and branch " + provider.BranchPrefix + "<id>; the worker may change files inside scope.",
		"# exec: may run commands but must not change the repository; outputs go to $" + provider.ArtifactsEnv + ".",
		"# readonly: " + worker.BriefNotes.Readonly + ".",
		"mode: " + string(mode),
		"# " + strings.Join(tiers, " or ") + ". Default: " + defaultTiers(provider.DefaultTier, provider.TierNames) + ".",
		"model: " + provider.TierNames[provider.DefaultTier[mode]],
	}
	if len(provider.Caveats) > 0 {
		lines = append(lines, "# Caveats: "+strings.Join(provider.Caveats, " "))
	}
	lines = append(lines,
		"# "+strings.Join(efforts, " | ")+", "+worker.BriefNotes.Effort+". Default: unset.",
		"# effort: "+efforts[len(efforts)/2],
		"# Repository the job works on; a relative path resolves against the default, the current git root.",
		"# cwd: .",
		"# Ref the worktree starts from.",
		"base: HEAD",
		"# Globs the change set may touch (picomatch, dotfiles included). Default: everything for edit, nothing otherwise.",
		"scope: "+jsonText(DefaultScope[mode]),
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
		"report: "+string(DefaultReport[mode]),
		"# Extra readable paths, "+worker.BriefNotes.AddDirs+".",
		"addDirs: []",
		"# Names of orchestrator environment variables passed to the worker and gates; values are never stored.",
		"env: []",
		"# Spending cap in USD, "+worker.BriefNotes.BudgetUSD+". Default: unset.",
		"# budgetUsd: 2",
		"# high or normal: among jobs waiting for a free slot, high goes first. Default: high (run), normal (batch).",
		"# priority: normal",
		"# Free labels for batches and board filters.",
		"tags: []",
		"---",
		"TODO: describe the task for the worker: what to change, where, and what done looks like.",
		"",
	)
	return strings.Join(lines, "\n")
}

// defaultTiers spells "glm for edit, flash otherwise" when exec and readonly share a tier, else
// each mode's tier.
func defaultTiers(tiers map[Mode]ModelTier, names map[ModelTier]string) string {
	if tiers[ModeExec] == tiers[ModeReadonly] {
		return names[tiers[ModeEdit]] + " for edit, " + names[tiers[ModeExec]] + " otherwise"
	}
	return names[tiers[ModeEdit]] + " for edit, " + names[tiers[ModeExec]] + " for exec, " +
		names[tiers[ModeReadonly]] + " for readonly"
}

// jsonText renders a string or array the way JSON.stringify does, which is how the template
// quotes titles and scopes.
func jsonText(value any) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
