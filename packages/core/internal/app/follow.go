package app

import (
	"context"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// FollowedKind is how a follow ended: landed (in review or decided), stale (no live driver will
// finish it) or detached (the follower was asked to let go).
type FollowedKind string

const (
	FollowedLanded   FollowedKind = "landed"
	FollowedStale    FollowedKind = "stale"
	FollowedDetached FollowedKind = "detached"
)

// Followed is how following a job ended, with the job as the follower last saw it.
type Followed struct {
	Kind FollowedKind
	Job  domain.Job
}

// FollowJob follows a job that a detached driver works, by polling the store (1 s doubling to
// 5 s), until it lands or goes stale. Read-only: aborting ctx only ends the follow; the job and
// its driver are never touched.
func FollowJob(ctx context.Context, deps Deps, id string) (Followed, error) {
	pollMs := domain.FirstPollMs
	var unclaimedSince *int64
	for {
		row, err := JobRow(ctx, deps, id)
		if err != nil {
			return Followed{}, err
		}
		job, live := row.Job, row.Live
		if live {
			unclaimedSince = nil
		} else if unclaimedSince == nil {
			firstUnclaimed := deps.Clock.Now()
			unclaimedSince = &firstUnclaimed
		}
		watch := domain.WatchJob(job.State, live, sinceMs(deps, unclaimedSince))
		if watch != domain.WatchActive {
			return Followed{Kind: FollowedKind(watch), Job: job}, nil
		}
		if ctx.Err() != nil {
			return Followed{Kind: FollowedDetached, Job: job}, nil
		}
		// A sleep that gives up because the follow was aborted detaches it; any other failure is
		// the clock's own.
		if err := deps.Clock.Sleep(ctx, pollMs); err != nil {
			if ctx.Err() != nil {
				return Followed{Kind: FollowedDetached, Job: job}, nil
			}
			return Followed{}, err
		}
		pollMs = domain.NextPollMs(pollMs)
	}
}

// sinceMs is how long ago since was, 0 when it never happened.
func sinceMs(deps Deps, since *int64) int64 {
	if since == nil {
		return 0
	}
	return deps.Clock.Now() - *since
}
