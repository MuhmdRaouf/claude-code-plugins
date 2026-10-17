package render

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

const waitTitleChars = 60

// WaitLine is one compact line per job as it lands in a multi-follow (`wait a b c`,
// `batch --wait`): id, verdict, title, gates (or sweep counts), cost.
func WaitLine(provider domain.Provider, job domain.Job, landed bool) string {
	verdict := "stale"
	if landed {
		verdict = VerdictOf(job)
	}
	price := "unpriced"
	if _, ok := PriceOf(ModelID(provider, job)); ok {
		price = "est. " + Usd(JobCostUsd(provider, job))
	}
	return strings.Join([]string{
		job.ID,
		verdict,
		OneLine(job.Brief.Title, waitTitleChars),
		verifiedText(job),
		price,
	}, " ")
}

// WaitTotals is the one line after the last job lands: how many jobs, how many passed, what they
// cost.
func WaitTotals(provider domain.Provider, jobs []domain.Job) string {
	pass := 0
	var cost float64
	for _, job := range jobs {
		if len(job.Attempts) > 0 {
			last := job.Attempts[len(job.Attempts)-1]
			if last.Verdict != nil && *last.Verdict == domain.VerdictPass {
				pass++
			}
		}
		cost += JobCostUsd(provider, job)
	}
	return Plural(int64(len(jobs)), "job") + ": " + strconv.Itoa(pass) + " pass, " +
		strconv.Itoa(len(jobs)-pass) + " not pass · est. " + Usd(cost)
}

// verifiedText is what the verification column says: `gates n/m`, a sweep's `ok/fail/gap` counts,
// or `?` when nothing ran.
func verifiedText(job domain.Job) string {
	last := LastAttempt(job)
	if domain.IsSweepBrief(job.Brief) {
		var report json.RawMessage
		if last != nil {
			report = last.Report
		}
		items, ok := app.SweepItems(report)
		if !ok {
			return "sweep ?"
		}
		var okCount, fail, gap int
		for _, item := range items {
			switch item.Status {
			case app.SweepStatusOK:
				okCount++
			case app.SweepStatusFail:
				fail++
			case app.SweepStatusGap:
				gap++
			}
		}
		return "sweep " + strconv.Itoa(okCount) + "/" + strconv.Itoa(fail) + "/" + strconv.Itoa(gap)
	}
	if last == nil || last.Verification == nil {
		return "gates ?"
	}
	gates := last.Verification.Gates
	if len(gates) == 0 {
		return "gates none"
	}
	passed := 0
	for _, gate := range gates {
		if !domain.GateFailed(gate) {
			passed++
		}
	}
	return "gates " + strconv.Itoa(passed) + "/" + strconv.Itoa(len(gates))
}
