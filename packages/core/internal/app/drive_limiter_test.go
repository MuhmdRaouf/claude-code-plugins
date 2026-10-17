package app

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// The drive-limiter suite: rate limits reach the limiter whatever wire the worker speaks.

// plainDialect is a worker that is not claude and not omp: a plain-text wire, one verb per line.
// Anything that folds into WorkerEvents is a worker as far as the driver is concerned — this
// dialect exists to prove the limiter hears it too.
var plainDialect = fakes.WorkerDialect{
	Caps: ports.WorkerCapabilities{
		WorkerTerms: domain.WorkerTerms{
			Efforts: []string{"none"},
			Budget:  false,
			BriefNotes: domain.BriefNotes{
				Effort:    "not supported",
				AddDirs:   "not supported",
				BudgetUSD: "not supported",
				Readonly:  "not supported",
			},
		},
		Name:         ports.WorkerNameOpencode,
		SessionKey:   ports.SessionKeyCaller,
		NativeSchema: false,
	},
	ParseLine:      parsePlainLine,
	Init:           func(sessionKey, _ string) string { return "SESSION " + sessionKey },
	SessionMissing: func(ports.WorkerSession, string) bool { return false },
	Fixtures:       fakes.EVENT_FIXTURES,
}

// parsePlainLine reads one verb per line: SESSION, THROTTLED, FAILED or DONE; anything else yields
// no events.
func parsePlainLine(text string) []domain.WorkerEvent {
	verb, rest, _ := strings.Cut(text, " ")
	switch verb {
	case "SESSION":
		return []domain.WorkerEvent{{Kind: domain.WorkerEventInit, SessionID: rest, Model: strPtr("plain-1")}}
	case "THROTTLED":
		status, _ := strconv.ParseInt(rest, 10, 64)
		return []domain.WorkerEvent{{Kind: domain.WorkerEventAPIRetry, Attempt: 1, MaxRetries: 10, Status: &status}}
	case "FAILED":
		statusText, message, _ := strings.Cut(rest, " ")
		status, _ := strconv.ParseInt(statusText, 10, 64)
		return []domain.WorkerEvent{{
			Kind: domain.WorkerEventResult, IsError: true, Text: message,
			Turns: 1, DurationMs: 10, APIErrorStatus: &status,
		}}
	case "DONE":
		return []domain.WorkerEvent{{
			Kind: domain.WorkerEventResult, IsError: false, Text: "done",
			StructuredOutput: []byte(rest), Turns: 1, DurationMs: 10,
		}}
	default:
		return nil
	}
}

// queuedPlain is a queued edit job over the plain worker.
func queuedPlain(w *driveWorld, id string) {
	paths := w.store.Paths(id)
	w.store.Put(testkit.AJob(func(j *domain.Job) {
		j.ID = id
		j.Brief = testkit.ABrief(func(b *domain.Brief) { b.Retries = domain.Retries{Fix: 0, Infra: 0} })
		worktree, branch := paths.Worktree, "zai/"+id
		j.Workspace = domain.Workspace{
			RepoRoot: "/repo", BaseSha: strings.Repeat("b", 40),
			Worktree: &worktree, Branch: &branch, ArtifactsDir: paths.Artifacts,
		}
	}))
}

func TestDriveWithAWorkerThatIsNotClaude(t *testing.T) {
	t.Run("rate limits on any wire: three 429 retries and one terminal 429 reach the limiter, whatever the worker", func(t *testing.T) {
		quorum := fakes.WorkerScript{Lines: []string{
			"THROTTLED 429",
			"THROTTLED 529",
			"THROTTLED 429",
			`DONE {"summary":"done"}`,
		}}
		terminal := fakes.WorkerScript{Lines: []string{"THROTTLED 429", "FAILED 429 quota exhausted"}}
		deps, w := newDriveWorld(t, []fakes.WorkerScript{quorum, terminal}, nil,
			workerWorld{dialect: &plainDialect})
		w.git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		queuedPlain(w, "261006-throt1")
		queuedPlain(w, "261006-throt2")

		if _, err := Drive(context.Background(), deps, "261006-throt1"); err != nil {
			t.Fatal(err)
		}
		if _, err := Drive(context.Background(), deps, "261006-throt2"); err != nil {
			t.Fatal(err)
		}

		// The quorum path: both 429 retries of the first run and the one of the second reach the
		// limiter — the 529 does not. The terminal call reports too, so it is four in total.
		if notices := w.limiter.RateLimitedAt(); len(notices) != 4 {
			t.Errorf("limiter notices = %d, want four", len(notices))
		}
		// The terminal path: the 429 that ended the second attempt is flagged, so the cap drops
		// without waiting for a quorum.
		if ended := w.limiter.EndedAttempts(); len(ended) != 1 {
			t.Errorf("ended attempts = %d, want the one terminal 429", len(ended))
		}
	})
}
