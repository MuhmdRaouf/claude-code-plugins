package shared

import (
	"context"
	"encoding/json"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// The RPC engines' turns for one run: the prompt with the report contract, then up to
// domain.MaxReportCorrections more turns while the report does not check (domain/report_capture).

// Turn is one prompt's turn as the engine's client reports it.
type Turn interface {
	// PromptSentAt is when the prompt went out (epoch ms).
	PromptSentAt() int64
	// EndedAt is when the turn ended (epoch ms).
	EndedAt() int64
}

// ReportTurns is how one run's report turns went.
type ReportTurns[T Turn] struct {
	// StartedAt is the first turn's start to the last one's end.
	StartedAt int64
	// EndedAt is the last turn's end.
	EndedAt int64
	// Last is the last turn.
	Last T
	// Value is the accepted report, or the last extracted value (nil when nothing parsed) for the
	// core to check itself: raw JSON bytes, so the key order the worker wrote survives.
	Value json.RawMessage
}

// TurnDriver is the engine client RunReportTurns drives.
type TurnDriver[T Turn] interface {
	// Prompt sends one prompt and waits for its turn to end; ok is false when the turn failed (the
	// exit tells the story).
	Prompt(ctx context.Context, text string) (T, bool)
	// FinalText is the final assistant text so far.
	FinalText() string
	// Failed says a turn ended in a way no correction can fix (the engine's own failure).
	Failed(turn T) bool
}

// RunReportTurns runs the prompt with the report contract in words, then up to
// domain.MaxReportCorrections correction turns while the extracted report does not check. ok is
// false when a turn itself failed; the turns come back for the core to judge either way.
func RunReportTurns[T Turn](
	ctx context.Context,
	driver TurnDriver[T],
	prompt string,
	report ports.ReportContract,
) (ReportTurns[T], bool) {
	first, ok := driver.Prompt(ctx, domain.ReportInstructions(prompt, report.JSONSchema))
	if !ok {
		return ReportTurns[T]{}, false
	}
	turns := ReportTurns[T]{
		StartedAt: first.PromptSentAt(),
		EndedAt:   first.EndedAt(),
		Last:      first,
		Value:     domain.ExtractReport(driver.FinalText()),
	}
	for range domain.MaxReportCorrections {
		if driver.Failed(turns.Last) {
			return turns, true
		}
		// Nil (nothing parsed) reads the same as absent: the check's own first problem.
		check := report.Validate(turns.Value)
		if check.Valid {
			return turns, true
		}
		again, ok := driver.Prompt(ctx, domain.CorrectionPrompt(check.Problems))
		if !ok {
			return ReportTurns[T]{}, false
		}
		turns.EndedAt = again.EndedAt()
		turns.Last = again
		turns.Value = domain.ExtractReport(driver.FinalText())
	}
	return turns, true
}
