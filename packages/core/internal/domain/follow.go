package domain

// How a follower (`run --wait`, `wait`) polls a job that a detached driver works.
const (
	// FirstPollMs is the delay before the first poll.
	FirstPollMs int64 = 1000
	// MaxPollMs caps the doubling backoff.
	MaxPollMs int64 = 5000
	// UnclaimedGraceMs: a queued job nobody has locked this long has lost its driver (it died
	// before claiming the job).
	UnclaimedGraceMs int64 = 30000
)

// Watch is what a follower does with a job: landed (in review or decided, report it), active
// (keep polling) or stale (no driver will finish it).
type Watch string

const (
	WatchLanded Watch = "landed"
	WatchActive Watch = "active"
	WatchStale  Watch = "stale"
)

// landedStates is the set a follower reports instead of polling.
var landedStates = map[JobState]bool{
	JobStateAwaitingReview: true,
	JobStateAccepted:       true,
	JobStateDiscarded:      true,
}

// WatchJob classifies a job for a follower. unclaimedMs is how long the follower has seen the job
// without a live driver (0 when it has one).
func WatchJob(state JobState, live bool, unclaimedMs int64) Watch {
	if landedStates[state] {
		return WatchLanded
	}
	if live {
		return WatchActive
	}
	if state != JobStateQueued {
		return WatchStale
	}
	if unclaimedMs < UnclaimedGraceMs {
		return WatchActive
	}
	return WatchStale
}

// NextPollMs is the doubling backoff, capped.
func NextPollMs(current int64) int64 {
	return min(current*2, MaxPollMs)
}
