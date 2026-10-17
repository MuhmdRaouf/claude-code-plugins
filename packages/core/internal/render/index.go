// The render entry points: one exported name per user-facing view, over the renderers of the
// other files. Pure text: width-stable tables, no colour codes (Claude reads this output),
// ISO-free relative ages. Every name they print (CLI, slash commands, agents, models) comes from
// the provider.
package render

import (
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// RenderBoard is the live board: what runs on the provider right now.
func RenderBoard(provider domain.Provider, rows []app.ActivityRow, now int64) string {
	return Board(provider, rows, now)
}

// RenderReview is the review packet: header (id, title, model, mode, attempt n of m, verdict),
// report summary + open items, a gate table (failing tails inline), scope result, change list,
// usage line, then the three next actions as exact commands.
func RenderReview(provider domain.Provider, packet app.ReviewPacket) string {
	return Review(provider, packet)
}

// RenderReviewSummary is `review --summary`: the verdict and what failed, without the diff or the
// change list.
func RenderReviewSummary(provider domain.Provider, packet app.ReviewPacket) string {
	return ReviewSummary(provider, packet)
}

// RenderSummary is the compact one-screen summary the dispatcher subagent returns (verdict first,
// then what changed, then next actions).
func RenderSummary(provider domain.Provider, job domain.Job) string {
	return Summary(provider, job)
}

// RenderUsage is `usage`: the estimated total for today, 7 and 30 days (router and jobs together,
// from the dated price table), then the spool's per-model windows, then the job ledger, then one
// row per delegation engine that ran jobs.
func RenderUsage(provider domain.Provider, report UsageReport) string {
	return Usage(provider, report)
}

// RenderStarted is the first line `run` prints, before the job runs: the dispatcher reads the id
// from it.
func RenderStarted(provider domain.Provider, job domain.Job) string {
	return provider.Name + " job " + job.ID + " started: " + job.Brief.Title + " (" +
		ModelID(provider, job) + ", " + string(job.Brief.Mode) + ")"
}

// RenderHook is the SessionStart hook's line: jobs awaiting review or still running; empty when
// there are none.
func RenderHook(provider domain.Provider, rows []app.ActivityRow) string {
	return Hook(provider, rows)
}

// RenderJob is `show`: one job's state, attempts and live progress.
func RenderJob(provider domain.Provider, row app.BoardRow, now int64) string {
	return JobView(provider, row, now)
}

// RenderWaitLine is one compact line per job as it lands in a multi-follow (`wait a b c`,
// `batch --wait`).
func RenderWaitLine(provider domain.Provider, job domain.Job, landed bool) string {
	return WaitLine(provider, job, landed)
}

// RenderWaitTotals is the totals line after the last job of a multi-follow lands.
func RenderWaitTotals(provider domain.Provider, jobs []domain.Job) string {
	return WaitTotals(provider, jobs)
}
