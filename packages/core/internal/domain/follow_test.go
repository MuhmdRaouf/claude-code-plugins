package domain

import "testing"

func TestWatchJob(t *testing.T) {
	t.Run("a job in review or decided has landed, whether or not a driver is alive", func(t *testing.T) {
		for _, state := range []JobState{JobStateAwaitingReview, JobStateAccepted, JobStateDiscarded} {
			if got := WatchJob(state, false, 0); got != WatchLanded {
				t.Errorf("%s: WatchJob(false, 0) = %q, want landed", state, got)
			}
			if got := WatchJob(state, true, UnclaimedGraceMs); got != WatchLanded {
				t.Errorf("%s: WatchJob(true, grace) = %q, want landed", state, got)
			}
		}
	})

	t.Run("an active job with a live driver is still being worked", func(t *testing.T) {
		for _, state := range []JobState{JobStateQueued, JobStateRunning, JobStateVerifying} {
			if got := WatchJob(state, true, UnclaimedGraceMs*10); got != WatchActive {
				t.Errorf("%s: WatchJob(true, 10x grace) = %q, want active", state, got)
			}
		}
	})

	t.Run("running or verifying without a live driver is stale at once (the board's stale)", func(t *testing.T) {
		for _, state := range []JobState{JobStateRunning, JobStateVerifying} {
			if got := WatchJob(state, false, 0); got != WatchStale {
				t.Errorf("%s: WatchJob(false, 0) = %q, want stale", state, got)
			}
		}
	})

	t.Run("queued without a driver waits for one to claim it, then turns stale after the grace period", func(t *testing.T) {
		assertWatch := func(unclaimedMs int64, want Watch) {
			t.Helper()
			if got := WatchJob(JobStateQueued, false, unclaimedMs); got != want {
				t.Errorf("WatchJob(queued, false, %d) = %q, want %q", unclaimedMs, got, want)
			}
		}
		assertWatch(0, WatchActive)
		assertWatch(UnclaimedGraceMs-1, WatchActive)
		assertWatch(UnclaimedGraceMs, WatchStale)
	})
}

func TestNextPollMs(t *testing.T) {
	t.Run("starts at 1 s and doubles up to 5 s, then stays there", func(t *testing.T) {
		if FirstPollMs != 1000 {
			t.Errorf("FirstPollMs = %d, want 1000", FirstPollMs)
		}
		if UnclaimedGraceMs != 30000 {
			t.Errorf("UnclaimedGraceMs = %d, want 30000", UnclaimedGraceMs)
		}
		seen := []int64{FirstPollMs}
		for i := 0; i < 5; i++ {
			seen = append(seen, NextPollMs(seen[len(seen)-1]))
		}
		want := []int64{1000, 2000, 4000, 5000, 5000, 5000}
		for i := range want {
			if seen[i] != want[i] {
				t.Fatalf("poll series = %v, want %v", seen, want)
			}
		}
	})
}
