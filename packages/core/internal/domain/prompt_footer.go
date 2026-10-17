package domain

import "strings"

const footerNoCommits = "Do not commit, stage, stash or switch branches."
const footerNoSecrets = "Never print, log or write secrets: API keys, tokens, passwords, private keys."

// ContractFooter is the fixed contract appended to every fresh prompt, written for GLM:
// imperative, one rule per line.
func ContractFooter(brief Brief, artifactsDir string, provider Provider) string {
	content := []string{"## " + provider.Name + " contract", ""}
	content = append(content, workspaceRules(brief, artifactsDir, provider.ArtifactsEnv)...)
	content = append(content, footerNoCommits, footerNoSecrets, "", "## Gates", "")
	content = append(content, gateRules(brief)...)
	content = append(content, "", "## Finish", "")
	content = append(content, finishRules(brief)...)
	return Lines(content)
}

func finishRules(brief Brief) []string {
	rules := make([]string, 0, 2)
	if len(brief.Gates) > 0 {
		rules = append(rules, "Run the gates yourself before you finish. Fix what fails.")
	}
	rules = append(rules,
		"End your run with the structured report ("+reportName(brief.Report)+"). Report only what you did and checked.")
	return rules
}

func reportName(report Report) string {
	if report.Kind == ReportKindBuiltin {
		return "schema: " + string(report.Name)
	}
	return "schema file: " + report.Path
}

func gateRules(brief Brief) []string {
	if len(brief.Gates) == 0 {
		return []string{"No gates: the plugin runs no checks after you finish."}
	}
	runs := make([]string, 0, len(brief.Gates))
	for _, gate := range brief.Gates {
		runs = append(runs, gate.Run)
	}
	return []string{
		"After you finish, the plugin runs these commands in your workspace. Each must exit 0.",
		Fenced(strings.Join(runs, "\n"), "sh"),
	}
}

func workspaceRules(brief Brief, artifactsDir, artifactsEnv string) []string {
	switch brief.Mode {
	case ModeEdit:
		return footerEditRules(brief)
	case ModeExec:
		return []string{
			"You work directly in the repository. The repository must stay unchanged.",
			"Do not create, edit or delete files in it.",
			"Write every output file to " + artifactsDir + " (also in $" + artifactsEnv + ").",
		}
	default:
		// readonly, the only mode left.
		return []string{
			"This is a read-only investigation. Read and search; run only commands that change nothing.",
			"Do not create, edit or delete any file.",
		}
	}
}

func footerEditRules(brief Brief) []string {
	rules := []string{
		"You work in an isolated git worktree of the repository. Edit files only there.",
		"Change only files matching these globs:",
	}
	for _, glob := range brief.Scope {
		rules = append(rules, footerBullet(glob))
	}
	if len(brief.Forbid) > 0 {
		rules = append(rules, "Never touch files matching these globs, even inside scope:")
		for _, glob := range brief.Forbid {
			rules = append(rules, footerBullet(glob))
		}
	}
	return append(rules, "Leave your changes in the working tree. The plugin reviews and commits them.")
}

func footerBullet(glob string) string {
	return "- `" + glob + "`"
}
