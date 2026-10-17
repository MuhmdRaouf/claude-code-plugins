package shared

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// The omp and pi worker tests cover the report turns through whole runs; these direct tests
// cover the turns themselves.

// fakeTurn is one turn of the fake driver below.
type fakeTurn struct {
	sent  int64
	ended int64
}

func (t fakeTurn) PromptSentAt() int64 { return t.sent }
func (t fakeTurn) EndedAt() int64      { return t.ended }

// fakeStep is how one Prompt call goes: the turn it returns, the final text after it, and whether
// the driver calls that turn unfixable.
type fakeStep struct {
	turn     fakeTurn
	text     string
	failed   bool
	promptOK bool
}

type fakeDriver struct {
	steps   []fakeStep
	done    []fakeStep
	prompts []string

	checks        []domain.ReportCheck
	validateCalls int
}

func (d *fakeDriver) Prompt(ctx context.Context, text string) (fakeTurn, bool) {
	d.prompts = append(d.prompts, text)
	if len(d.steps) == 0 {
		return fakeTurn{}, false
	}
	step := d.steps[0]
	d.steps = d.steps[1:]
	if !step.promptOK {
		return fakeTurn{}, false
	}
	d.done = append(d.done, step)
	return step.turn, true
}

func (d *fakeDriver) FinalText() string {
	if len(d.done) == 0 {
		return ""
	}
	return d.done[len(d.done)-1].text
}

func (d *fakeDriver) Failed(turn fakeTurn) bool {
	if len(d.done) == 0 {
		return false
	}
	return d.done[len(d.done)-1].failed
}

func (d *fakeDriver) validate(report json.RawMessage) domain.ReportCheck {
	d.validateCalls++
	check := d.checks[0]
	d.checks = d.checks[1:]
	return check
}

var reportSchema = []byte(`{"type":"object"}`)

func reportSpec(d *fakeDriver) ports.ReportContract {
	return ports.ReportContract{
		Name:       "change",
		JSONSchema: reportSchema,
		Validate:   d.validate,
	}
}

func TestRunReportTurns(t *testing.T) {
	ctx := context.Background()
	instructions := domain.ReportInstructions("do it", reportSchema)

	t.Run("returns the first turn once its report checks", func(t *testing.T) {
		driver := &fakeDriver{
			steps:  []fakeStep{{turn: fakeTurn{sent: 10, ended: 20}, text: `{"summary":"done"}`, promptOK: true}},
			checks: []domain.ReportCheck{{Present: true, Valid: true}},
		}

		turns, ok := RunReportTurns(ctx, driver, "do it", reportSpec(driver))

		if !ok {
			t.Fatal("RunReportTurns() = not ok on a valid first report")
		}
		if turns.StartedAt != 10 || turns.EndedAt != 20 {
			t.Errorf("span = (%d, %d), want (10, 20)", turns.StartedAt, turns.EndedAt)
		}
		if turns.Last.ended != 20 {
			t.Errorf("last turn ended at %d, want 20", turns.Last.ended)
		}
		if string(turns.Value) != `{"summary":"done"}` {
			t.Errorf("value = %s, want the extracted report's raw bytes", turns.Value)
		}
		if len(driver.prompts) != 1 || driver.prompts[0] != instructions {
			t.Errorf("prompts = %#v, want the one instruction prompt", driver.prompts)
		}
		if driver.validateCalls != 1 {
			t.Errorf("validate called %d times, want 1", driver.validateCalls)
		}
	})

	t.Run("sends one correction turn while the report does not check", func(t *testing.T) {
		driver := &fakeDriver{
			steps: []fakeStep{
				{turn: fakeTurn{sent: 10, ended: 20}, text: "not json", promptOK: true},
				{turn: fakeTurn{sent: 30, ended: 40}, text: `{"summary":"fixed"}`, promptOK: true},
			},
			checks: []domain.ReportCheck{
				{Present: false, Valid: false, Problems: []string{"no structured report"}},
				{Present: true, Valid: true},
			},
		}

		turns, ok := RunReportTurns(ctx, driver, "do it", reportSpec(driver))

		if !ok {
			t.Fatal("RunReportTurns() = not ok after a corrected report")
		}
		if turns.EndedAt != 40 || turns.Last.ended != 40 {
			t.Errorf("the span did not move to the correction turn: %+v", turns)
		}
		if string(turns.Value) != `{"summary":"fixed"}` {
			t.Errorf("value = %s, want the corrected report's raw bytes", turns.Value)
		}
		want := []string{
			instructions,
			"Your report was invalid: no structured report. Reply with only the corrected JSON object.",
		}
		if len(driver.prompts) != 2 || driver.prompts[1] != want[1] || driver.prompts[0] != want[0] {
			t.Errorf("prompts = %#v, want %v", driver.prompts, want)
		}
	})

	t.Run("stops at a turn no correction can fix, without checking the report", func(t *testing.T) {
		driver := &fakeDriver{
			steps:  []fakeStep{{turn: fakeTurn{sent: 10, ended: 20}, text: "not json", failed: true, promptOK: true}},
			checks: []domain.ReportCheck{{Present: false, Valid: false}},
		}

		turns, ok := RunReportTurns(ctx, driver, "do it", reportSpec(driver))

		if !ok {
			t.Fatal("RunReportTurns() = not ok on the engine's own failure")
		}
		if turns.EndedAt != 20 || driver.validateCalls != 0 || len(driver.prompts) != 1 {
			t.Errorf("the run went past a failed turn: turns=%+v validate=%d prompts=%d",
				turns, driver.validateCalls, len(driver.prompts))
		}
	})

	t.Run("fails when the first prompt's turn fails", func(t *testing.T) {
		driver := &fakeDriver{steps: []fakeStep{{promptOK: false}}}

		if _, ok := RunReportTurns(ctx, driver, "do it", reportSpec(driver)); ok {
			t.Error("RunReportTurns() = ok after a failed first turn")
		}
		if len(driver.prompts) != 1 {
			t.Errorf("prompts = %#v, want one attempt", driver.prompts)
		}
	})

	t.Run("fails when a correction prompt's turn fails", func(t *testing.T) {
		driver := &fakeDriver{
			steps: []fakeStep{
				{turn: fakeTurn{sent: 10, ended: 20}, text: "not json", promptOK: true},
				{promptOK: false},
			},
			checks: []domain.ReportCheck{{Present: false, Valid: false, Problems: []string{"p"}}},
		}

		if _, ok := RunReportTurns(ctx, driver, "do it", reportSpec(driver)); ok {
			t.Error("RunReportTurns() = ok after a failed correction turn")
		}
		if len(driver.prompts) != 2 {
			t.Errorf("prompts = %#v, want two attempts", driver.prompts)
		}
	})

	t.Run("gives up after MaxReportCorrections corrections and hands the last value over", func(t *testing.T) {
		steps := []fakeStep{{turn: fakeTurn{sent: 1, ended: 2}, text: "no", promptOK: true}}
		for i := 1; i <= domain.MaxReportCorrections; i++ {
			steps = append(steps, fakeStep{
				turn:     fakeTurn{sent: int64(2 * i), ended: int64(2*i + 1)},
				text:     "still no",
				promptOK: true,
			})
		}
		invalid := domain.ReportCheck{Present: false, Valid: false, Problems: []string{"no structured report"}}
		driver := &fakeDriver{
			steps:  steps,
			checks: []domain.ReportCheck{invalid, invalid},
		}

		turns, ok := RunReportTurns(ctx, driver, "do it", reportSpec(driver))

		if !ok {
			t.Fatal("RunReportTurns() = not ok after exhausting the corrections")
		}
		wantPrompts := 1 + domain.MaxReportCorrections
		if len(driver.prompts) != wantPrompts {
			t.Errorf("prompts = %d, want %d", len(driver.prompts), wantPrompts)
		}
		if driver.validateCalls != domain.MaxReportCorrections {
			t.Errorf("validate called %d times, want %d", driver.validateCalls, domain.MaxReportCorrections)
		}
		if turns.Value != nil {
			t.Errorf("value = %#v, want nil (nothing parsed)", turns.Value)
		}
		if turns.Last.ended != int64(2*domain.MaxReportCorrections+1) {
			t.Errorf("last turn ended at %d, want the last correction", turns.Last.ended)
		}
	})

	t.Run("keeps a multi-key report's written key order", func(t *testing.T) {
		report := `{"zeta":1,"alpha":2}`
		driver := &fakeDriver{
			steps:  []fakeStep{{turn: fakeTurn{sent: 10, ended: 20}, text: report, promptOK: true}},
			checks: []domain.ReportCheck{{Present: true, Valid: true}},
		}

		turns, ok := RunReportTurns(ctx, driver, "do it", reportSpec(driver))

		if !ok {
			t.Fatal("RunReportTurns() = not ok on a valid first report")
		}
		// Byte for byte, as JSON.stringify wrote it: a decoded map would re-render it sorted.
		if string(turns.Value) != report {
			t.Errorf("value = %s, want %s", turns.Value, report)
		}
	})
}
