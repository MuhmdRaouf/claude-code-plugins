package domain

import "strings"

// PromptLimits bounds how much of a failed attempt a follow-up prompt quotes back.
type PromptLimits struct {
	// Max characters of one gate tail quoted back to the worker.
	GateTailChars int
	// Max number of out-of-scope paths listed.
	PathsListed int
}

// DefaultLimits is what every follow-up prompt uses when its caller passes none.
var DefaultLimits = PromptLimits{GateTailChars: 4000, PathsListed: 50}

const promptStillBound = "The contract from your first message still applies. End your run with the structured report."

// InitialPrompt is the first prompt: brief body + the contract footer. The footer states the
// mode's workspace rules, scope and forbid globs, the exact gates the plugin will run, "do not
// commit", "never print secrets", the artifacts dir for exec mode, and that the run must end with
// the structured report.
func InitialPrompt(brief Brief, artifactsDir string, provider Provider) string {
	return withNewline(brief.Body) + "\n" + ContractFooter(brief, artifactsDir, provider)
}

func withNewline(text string) string {
	if strings.HasSuffix(text, "\n") {
		return text
	}
	return text + "\n"
}

// AutoFixPrompt is the follow-up prompt for a resumed session after a failed verdict: it names the
// verdict, quotes each failing gate (command, exit code or timeout, bounded tail), lists
// out-of-scope/forbidden paths, and asks for the smallest change that fixes exactly that, keeping
// the rest. It never repeats the brief (the session has it).
func AutoFixPrompt(_ Brief, failed Attempt, limits ...PromptLimits) string {
	bound := limitOrDefault(limits)
	parts := []string{"Verification failed: " + verdictName(failed.Verdict) + "."}
	parts = append(parts, FailureSections(failed, bound)...)
	parts = append(parts, Lines([]string{
		"Make the smallest change that fixes exactly these failures. Keep everything else as it is.",
		promptStillBound,
	}))
	return Paragraphs(parts)
}

// ReviewFixPrompt is the follow-up prompt carrying the reviewer's feedback verbatim plus the last
// verification summary.
func ReviewFixPrompt(_ Brief, last Attempt, feedback string, limits ...PromptLimits) string {
	bound := limitOrDefault(limits)
	parts := []string{
		"The reviewer returned your work with this feedback:",
		Fenced(feedback, "text"),
		"Last attempt " + AttemptSummary(last),
	}
	parts = append(parts, FailureSections(last, bound)...)
	parts = append(parts, Lines([]string{
		"Address the feedback with the smallest change that satisfies it. Keep everything else as it is.",
		promptStillBound,
	}))
	return Paragraphs(parts)
}

// SelfContainedPrompt is for when the previous session cannot be resumed: brief + the history
// condensed (each attempt's verdict and failures) + the new instruction, so the fresh session is
// self-contained. artifactsDir is named in the footer, as in InitialPrompt.
func SelfContainedPrompt(brief Brief, history []Attempt, instruction, artifactsDir string, provider Provider) string {
	parts := []string{brief.Body}
	parts = append(parts, historySection(history)...)
	parts = append(parts, Lines([]string{"## Now", "", instruction}))
	parts = append(parts, ContractFooter(brief, artifactsDir, provider))
	return Paragraphs(parts)
}

func historySection(history []Attempt) []string {
	if len(history) == 0 {
		return nil
	}
	content := make([]string, 0, len(history)+3)
	content = append(content, "## Earlier attempts", "",
		"This task was attempted before in another session. Results:")
	for _, attempt := range history {
		content = append(content, "- "+AttemptSummary(attempt))
	}
	return []string{Lines(content)}
}

// limitOrDefault reads the first limits the caller gives, else DefaultLimits.
func limitOrDefault(limits []PromptLimits) PromptLimits {
	if len(limits) > 0 {
		return limits[0]
	}
	return DefaultLimits
}
