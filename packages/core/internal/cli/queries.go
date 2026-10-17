package cli

import (
	"context"
	"encoding/json"
	"os"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/render"
)

// queriesMaxDiffChars bounds the diff `review --diff` prints.
const queriesMaxDiffChars int64 = 60_000

// queriesFollowPollMs is how often `show --follow` re-reads the job.
const queriesFollowPollMs int64 = 2000

// queriesWatchPollMs is how often `board --watch` redraws.
const queriesWatchPollMs int64 = 2000

// hookStdinMs is how long the SubagentStop hook waits for its input; the whole hook stays well
// under a second.
const hookStdinMs int64 = 300

// queriesActive are the states a followed job is still working in.
var queriesActive = map[domain.JobState]bool{
	domain.JobStateQueued:    true,
	domain.JobStateRunning:   true,
	domain.JobStateVerifying: true,
}

// StdoutIsTTY says whether stdout is a terminal (`board --watch` loops only on one). The entry
// point sets it from the real stream; tests swap it.
var StdoutIsTTY = func() bool {
	info, err := os.Stdout.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

// BoardCommand is `board`: what runs on the provider now.
type BoardCommand struct{}

var _ Command = BoardCommand{}

func (BoardCommand) Name() string       { return "board" }
func (BoardCommand) Synopsis() []string { return []string{"board [--all] [--watch] [--json]"} }
func (BoardCommand) Options() map[string]OptionSpec {
	return map[string]OptionSpec{
		"all":   {Type: OptionTypeBoolean},
		"hook":  {Type: OptionTypeBoolean},
		"watch": {Type: OptionTypeBoolean},
	}
}
func (BoardCommand) Hidden() bool { return false }

func (BoardCommand) Run(ctx context.Context, call Invocation) (ExitCode, error) {
	if call.Flag("hook") {
		return boardHook(ctx, call), nil
	}
	if call.Flag("watch") && StdoutIsTTY() {
		return UntilInterrupted(func(signal context.Context) (ExitCode, error) {
			return watchBoard(signal, call)
		})
	}
	return printBoard(ctx, call), nil
}

// boardScope is the repository the command lists, or everything with --all.
func boardScope(ctx context.Context, call Invocation) app.Scope {
	scope := app.Scope{All: call.Flag("all")}
	if !scope.All {
		if root, ok := RepoOf(ctx, call.Deps(), call.Cwd()); ok {
			scope.RepoRoot = &root
		}
	}
	return scope
}

// printBoard prints the board once.
func printBoard(ctx context.Context, call Invocation) ExitCode {
	deps := call.Deps()
	rows := app.ActivityBoard(ctx, deps, boardScope(ctx, call))
	if call.Flag("json") {
		_ = call.JSON(rows)
	} else {
		deps.Out.Line(render.RenderBoard(deps.Provider, rows, deps.Clock.Now()))
	}
	return ExitOK
}

// watchBoard redraws the board every 2 s until Ctrl-C (which ends the watch, exit 0). Off a TTY
// `board` prints once instead.
func watchBoard(ctx context.Context, call Invocation) (ExitCode, error) {
	for {
		printBoard(ctx, call)
		if err := call.Deps().Clock.Sleep(ctx, queriesWatchPollMs); err != nil {
			if ctx.Err() != nil {
				return ExitOK, nil
			}
			return ExitUnexpected, err
		}
	}
}

// boardHook is the SessionStart hook: one line or nothing, never an error, always exit 0.
func boardHook(ctx context.Context, call Invocation) (code ExitCode) {
	defer func() {
		// A hook must never disturb the session it starts.
		_ = recover()
	}()
	deps := call.Deps()
	line := render.RenderHook(deps.Provider, app.JobRows(deps.Provider, app.Board(ctx, deps, boardScope(ctx, call))))
	if line != "" {
		deps.Out.Line(line)
	}
	return ExitOK
}

// ShowCommand is `show`: one job, optionally followed while it runs.
type ShowCommand struct{}

var _ Command = ShowCommand{}

func (ShowCommand) Name() string       { return "show" }
func (ShowCommand) Synopsis() []string { return []string{"show <id> [--follow] [--json]"} }
func (ShowCommand) Options() map[string]OptionSpec {
	return map[string]OptionSpec{"follow": {Type: OptionTypeBoolean}}
}
func (ShowCommand) Hidden() bool { return false }

func (ShowCommand) Run(ctx context.Context, call Invocation) (ExitCode, error) {
	positionals := call.Positionals()
	if len(positionals) == 0 {
		return call.Usage("show needs a job id"), nil
	}
	deps := call.Deps()
	found, err := app.JobRow(ctx, deps, positionals[0])
	if err != nil {
		return appFail(call, err)
	}
	row := found
	if call.Flag("follow") {
		row = showFollow(ctx, call, found)
	}
	if call.Flag("json") {
		_ = call.JSON(row)
	} else {
		deps.Out.Line(render.RenderJob(deps.Provider, row, deps.Clock.Now()))
	}
	return ExitOK, nil
}

// showFollow prints one line per change of state or progress while a live driver works the job;
// it returns the settled row.
func showFollow(ctx context.Context, call Invocation, first app.BoardRow) app.BoardRow {
	deps := call.Deps()
	row := first
	shown := ""
	for queriesActive[row.Job.State] && row.Live {
		line := string(row.Job.State)
		if row.Progress != nil {
			line = string(row.Job.State) + " · " + render.ProgressText(*row.Progress)
		}
		if line != shown && !call.Flag("json") {
			deps.Out.Line(line)
		}
		shown = line
		if err := deps.Clock.Sleep(ctx, queriesFollowPollMs); err != nil {
			return row
		}
		next, err := app.JobRow(ctx, deps, row.Job.ID)
		if err != nil {
			return row
		}
		row = next
	}
	return row
}

// ReviewCommand is `review`: the packet a job's review reads.
type ReviewCommand struct{}

var _ Command = ReviewCommand{}

func (ReviewCommand) Name() string { return "review" }
func (ReviewCommand) Synopsis() []string {
	return []string{"review <id> [--diff] [--summary] [--json]"}
}
func (ReviewCommand) Options() map[string]OptionSpec {
	return map[string]OptionSpec{
		"diff":    {Type: OptionTypeBoolean},
		"summary": {Type: OptionTypeBoolean},
	}
}
func (ReviewCommand) Hidden() bool { return false }

func (ReviewCommand) Run(ctx context.Context, call Invocation) (ExitCode, error) {
	positionals := call.Positionals()
	if len(positionals) == 0 {
		return call.Usage("review needs a job id"), nil
	}
	if call.Flag("diff") && call.Flag("summary") {
		return call.Usage("--diff and --summary exclude each other"), nil
	}
	deps := call.Deps()
	packet, err := app.ReviewPacketOf(ctx, deps, positionals[0], app.ReviewOptions{
		Diff:         call.Flag("diff"),
		MaxDiffChars: queriesMaxDiffChars,
	})
	if err != nil {
		return appFail(call, err)
	}
	if call.Flag("json") {
		_ = call.JSON(packet)
	} else if call.Flag("summary") {
		deps.Out.Line(render.RenderReviewSummary(deps.Provider, packet))
	} else {
		deps.Out.Line(render.RenderReview(deps.Provider, packet))
	}
	return ExitOK, nil
}

// UsageCommand is `usage`: the estimate, the spool windows, the ledger, the health and the
// advisor. With --hook it is the SubagentStop hook.
type UsageCommand struct{}

var _ Command = UsageCommand{}

func (UsageCommand) Name() string       { return "usage" }
func (UsageCommand) Synopsis() []string { return []string{"usage [--json]"} }
func (UsageCommand) Options() map[string]OptionSpec {
	return map[string]OptionSpec{"hook": {Type: OptionTypeBoolean}}
}
func (UsageCommand) Hidden() bool { return false }

func (UsageCommand) Run(ctx context.Context, call Invocation) (ExitCode, error) {
	if call.Flag("hook") {
		return AgentStopHook(ctx, call, ReadStdinWithin(hookStdinMs, os.Stdin)), nil
	}
	deps := call.Deps()
	events := app.UsageEvents(deps)
	windows := app.UsageWindows(deps, events)
	scope := boardScope(ctx, call)
	jobs := app.Usage(ctx, deps, scope)
	engines := app.EngineUsage(ctx, deps, scope)
	allJobs := deps.Store.List(ctx, ports.ListFilter{})
	health := app.RouterHealth(deps, events)
	advice := app.ModelAdvice(deps, allJobs, events)
	now := deps.Clock.Now()
	if call.Flag("json") {
		_ = call.JSON(usageJSON(deps.Provider, windows, jobs, engines, allJobs, health, advice, now))
	} else {
		deps.Out.Line(render.RenderUsage(deps.Provider, render.UsageReport{
			Windows: windows,
			Jobs:    jobs,
			Engines: engines,
			AllJobs: allJobs,
			Now:     now,
			Health:  &health,
			Advice:  &advice,
		}))
	}
	return ExitOK, nil
}

// usageRowJSON is one spool row with its estimated cost: the usage members first, then costUsd.
type usageRowJSON struct {
	app.ModelUsage
	CostUsd float64 `json:"costUsd"`
}

// usageWindowJSON is one spool window under --json.
type usageWindowJSON struct {
	Label string         `json:"label"`
	Days  int            `json:"days"`
	Rows  []usageRowJSON `json:"rows"`
}

// usageJobJSON is one ledger row; JSON speaks the provider's tier names (zai's users read "glm",
// not "main").
type usageJobJSON struct {
	Tier                 string   `json:"tier"`
	Jobs                 int64    `json:"jobs"`
	Decided              int64    `json:"decided"`
	Accepted             int64    `json:"accepted"`
	Discarded            int64    `json:"discarded"`
	FirstTryPassRate     *float64 `json:"firstTryPassRate"`
	AcceptRate           *float64 `json:"acceptRate"`
	MeanAttemptsToAccept *float64 `json:"meanAttemptsToAccept"`
	ReviewReturns        int64    `json:"reviewReturns"`
	InputTokens          int64    `json:"inputTokens"`
	OutputTokens         int64    `json:"outputTokens"`
	CacheReadTokens      int64    `json:"cacheReadTokens"`
	CostUSD              float64  `json:"costUsd"`
	RateLimitRetries     int64    `json:"rateLimitRetries"`
	DurationMs           int64    `json:"durationMs"`
}

// usageJobJSONOf maps one ledger row to the JSON shape.
func usageJobJSONOf(provider domain.Provider, row domain.TierUsage) usageJobJSON {
	return usageJobJSON{
		Tier:                 provider.TierNames[row.Tier],
		Jobs:                 row.Jobs,
		Decided:              row.Decided,
		Accepted:             row.Accepted,
		Discarded:            row.Discarded,
		FirstTryPassRate:     row.FirstTryPassRate,
		AcceptRate:           row.AcceptRate,
		MeanAttemptsToAccept: row.MeanAttemptsToAccept,
		ReviewReturns:        row.ReviewReturns,
		InputTokens:          row.InputTokens,
		OutputTokens:         row.OutputTokens,
		CacheReadTokens:      row.CacheReadTokens,
		CostUSD:              row.CostUSD,
		RateLimitRetries:     row.RateLimitRetries,
		DurationMs:           row.DurationMs,
	}
}

// usageAdvisorJSON is the advisor's findings with its cautious estimate; the estimate is absent
// when the models are unpriced, the way JSON.stringify dropped the undefined key.
type usageAdvisorJSON struct {
	app.FlashAdvice
	EstSavingUsd *float64 `json:"estSavingUsd,omitempty"`
}

// usageJSON is the `usage --json` document: the estimate, the spool windows, the ledger, the
// engines (only once one ran jobs), the health counts and, only when it has enough data, the
// advisor.
func usageJSON(
	provider domain.Provider,
	windows []app.UsageWindow,
	jobs []domain.TierUsage,
	engines []domain.EngineUsage,
	allJobs []domain.Job,
	health app.RouterHealthCounts,
	advice app.FlashAdvice,
	now int64,
) setupJSONObject {
	spool := make([]usageWindowJSON, 0, len(windows))
	for _, window := range windows {
		rows := make([]usageRowJSON, 0, len(window.Rows))
		for _, row := range window.Rows {
			rows = append(rows, usageRowJSON{
				ModelUsage: row,
				CostUsd: render.CostUsdOf(row.Model, render.TokenCounts{
					InputTokens:      float64(row.InputTokens),
					OutputTokens:     float64(row.OutputTokens),
					CacheReadTokens:  float64(row.CacheReadTokens),
					CacheWriteTokens: float64(row.CacheWriteTokens),
				}),
			})
		}
		spool = append(spool, usageWindowJSON{Label: window.Label, Days: window.Days, Rows: rows})
	}
	jobRows := make([]usageJobJSON, 0, len(jobs))
	for _, row := range jobs {
		jobRows = append(jobRows, usageJobJSONOf(provider, row))
	}
	document := setupJSONObject{
		{"estimate", setupJSONObject{
			{"pricesRetrieved", render.PricesRetrieved},
			{"windows", render.WindowCosts(provider, windows, allJobs, now)},
		}},
		{"spool", spool},
		{"jobs", jobRows},
	}
	// Only once a delegation engine ran jobs, so a claude-only report reads as it always did.
	if len(engines) > 0 {
		document = append(document, setupJSONField{"engines", engines})
	}
	document = append(document, setupJSONField{"routerHealth", health})
	if render.AdviceWorthShowing(&advice) {
		document = append(document, setupJSONField{"advisor", usageAdvisorJSON{
			FlashAdvice:  advice,
			EstSavingUsd: render.AdvisorSaving(advice),
		}})
	}
	return document
}

// AgentStopHook is the SubagentStop hook (`usage --hook`, input JSON on stdin): one
// systemMessage for the user about what a model agent ran on, or nothing. Never an error, always
// exit 0.
func AgentStopHook(ctx context.Context, call Invocation, stdin string) (code ExitCode) {
	defer func() {
		// A hook never disturbs the session: bad input, a missing transcript, anything, is silence.
		_ = recover()
	}()
	deps := call.Deps()
	provider := deps.Provider
	input, err := parseAgentStopInput(stdin)
	if err != nil {
		return ExitOK
	}
	agent, isModelAgent := ModelAgentOf(provider, input)
	var text string
	var hasText bool
	if isModelAgent {
		if path, hasPath := TranscriptPathOf(input); hasPath {
			text, hasText = ReadTail(path, TranscriptTailBytes)
		}
	}
	if !isModelAgent || !hasText {
		return ExitOK
	}
	if message, ok := AgentStopMessage(provider, agent, AgentRunOf(text), ReadSetupDone(deps.Host.StateRoot)); ok {
		UserMessage(deps.Out, message)
	}
	return ExitOK
}

// parseAgentStopInput is the hook's input, or the error anything unreadable is silence.
func parseAgentStopInput(stdin string) (AgentStopInput, error) {
	var input AgentStopInput
	err := json.Unmarshal([]byte(stdin), &input)
	return input, err
}
