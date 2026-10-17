package cli

import (
	"context"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/render"
)

// WaitCommand is `wait`: follow jobs a detached driver works, until they land.
type WaitCommand struct{}

var _ Command = WaitCommand{}

func (WaitCommand) Name() string       { return "wait" }
func (WaitCommand) Synopsis() []string { return []string{"wait <id> [<id>…] [--json]"} }
func (WaitCommand) Options() map[string]OptionSpec {
	return map[string]OptionSpec{}
}
func (WaitCommand) Hidden() bool { return false }

func (WaitCommand) Run(ctx context.Context, call Invocation) (ExitCode, error) {
	positionals := call.Positionals()
	if len(positionals) == 0 {
		return call.Usage("wait needs a job id"), nil
	}
	if len(positionals) == 1 {
		return FollowAndReport(ctx, call, positionals[0])
	}
	return FollowAll(call, positionals)
}

// FollowAndReport follows a job a detached driver works until it lands, then prints its summary
// (exit 0 on pass, 3 otherwise). SIGINT/SIGTERM only end the follow (exit 130); a job no live
// driver will finish exits 6 (not ready: it needs stop or discard). The job itself is never
// touched.
func FollowAndReport(ctx context.Context, call Invocation, id string) (ExitCode, error) {
	followed, err := UntilInterrupted(func(signal context.Context) (app.Followed, error) {
		return app.FollowJob(signal, call.Deps(), id)
	})
	if err != nil {
		return appFail(call, err)
	}
	deps := call.Deps()
	if call.Flag("json") {
		_ = call.JSON(followed.Job)
	}
	switch followed.Kind {
	case app.FollowedLanded:
		if !call.Flag("json") {
			deps.Out.Line(render.RenderSummary(deps.Provider, followed.Job))
		}
		if lastAttemptPass(followed.Job) {
			return ExitOK, nil
		}
		return ExitNotPass, nil
	case app.FollowedStale:
		deps.Out.Error(staleJobLine(deps.Provider, followed.Job))
		return ExitNotReady, nil
	default:
		deps.Out.Error(detachedJobLine(deps.Provider, followed.Job))
		return ExitInterrupted, nil
	}
}

// FollowAll follows many jobs at once (one `wait` beats one watcher per job): each prints its
// compact line as it lands, then one totals line. Exit 0 only when every landed verdict is pass;
// an interrupt detaches them all (exit 130, no totals).
//
// The follows share one poll loop: a round polls every unsettled job in input order, so jobs
// that land in the same round print their lines in input order, and a job that landed in an
// earlier round has already printed.
func FollowAll(call Invocation, ids []string) (ExitCode, error) {
	deps := call.Deps()
	type landing struct {
		followed app.Followed
		settled  bool
	}
	results := make([]landing, len(ids))
	unclaimedSince := make([]*int64, len(ids))
	sinceMs := func(at *int64) int64 {
		if at == nil {
			return 0
		}
		return deps.Clock.Now() - *at
	}
	detachRest := func() {
		for i := range results {
			if !results[i].settled {
				row, err := app.JobRow(context.Background(), deps, ids[i])
				job := domain.Job{}
				if err == nil {
					job = row.Job
				}
				results[i] = landing{followed: app.Followed{Kind: app.FollowedDetached, Job: job}, settled: true}
			}
		}
	}
	_, err := UntilInterrupted(func(signal context.Context) ([]landing, error) {
		pollMs := domain.FirstPollMs
		for {
			working := false
			for i, id := range ids {
				if results[i].settled {
					continue
				}
				row, err := app.JobRow(signal, deps, id)
				if err != nil {
					return nil, err
				}
				if row.Live {
					unclaimedSince[i] = nil
				} else if unclaimedSince[i] == nil {
					first := deps.Clock.Now()
					unclaimedSince[i] = &first
				}
				watch := domain.WatchJob(row.Job.State, row.Live, sinceMs(unclaimedSince[i]))
				if watch == domain.WatchActive {
					working = true
					continue
				}
				followed := app.Followed{Kind: app.FollowedKind(watch), Job: row.Job}
				results[i] = landing{followed: followed, settled: true}
				if followed.Kind != app.FollowedDetached && !call.Flag("json") {
					deps.Out.Line(render.RenderWaitLine(deps.Provider, followed.Job,
						followed.Kind == app.FollowedLanded))
				}
			}
			if !working {
				return results, nil
			}
			if signal.Err() != nil {
				detachRest()
				return results, nil
			}
			if err := deps.Clock.Sleep(signal, pollMs); err != nil {
				if signal.Err() != nil {
					detachRest()
					return results, nil
				}
				return nil, err
			}
			pollMs = domain.NextPollMs(pollMs)
		}
	})
	if err != nil {
		return appFail(call, err)
	}
	jobs := make([]domain.Job, 0, len(ids))
	for _, one := range results {
		switch one.followed.Kind {
		case app.FollowedDetached:
			deps.Out.Error(detachedJobLine(deps.Provider, one.followed.Job))
			return ExitInterrupted, nil
		case app.FollowedStale:
			deps.Out.Error(staleJobLine(deps.Provider, one.followed.Job))
		}
		jobs = append(jobs, one.followed.Job)
	}
	if call.Flag("json") {
		_ = call.JSON(jobs)
	} else {
		deps.Out.Line(render.RenderWaitTotals(deps.Provider, jobs))
	}
	for _, job := range jobs {
		if !lastAttemptPass(job) {
			return ExitNotPass, nil
		}
	}
	return ExitOK, nil
}

// lastAttemptPass says whether the job's last attempt has the pass verdict.
func lastAttemptPass(job domain.Job) bool {
	if len(job.Attempts) == 0 {
		return false
	}
	verdict := job.Attempts[len(job.Attempts)-1].Verdict
	return verdict != nil && *verdict == domain.VerdictPass
}

// staleJobLine reports a job no live driver will finish, with the way out of it.
func staleJobLine(provider domain.Provider, job domain.Job) string {
	return provider.Name + ": job " + job.ID + " is " + string(job.State) +
		" but has no live driver; " + provider.Slash + "board stops it (it moves to review), " +
		provider.Slash + "review " + job.ID + " then discards it."
}

// detachedJobLine reports a job that keeps running after its follower was interrupted.
func detachedJobLine(provider domain.Provider, job domain.Job) string {
	return provider.Name + " job " + job.ID + " keeps running detached: " +
		provider.Slash + "board shows it and can stop it, " + provider.Slash +
		"review " + job.ID + " once it awaits review."
}
