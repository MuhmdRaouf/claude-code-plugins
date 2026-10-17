package domain

import (
	"fmt"
	"reflect"
	"testing"
)

// usageAttempt builds an attempt: n, kind, an optional verdict and optional usage.
func usageAttempt(n int64, kind AttemptKind, verdict *Verdict, usage *Usage) Attempt {
	return Attempt{
		N:         n,
		Kind:      kind,
		Prompt:    "do it",
		SessionID: fmt.Sprintf("session-%d", n),
		StartedAt: "2026-10-06T08:00:00.000Z",
		Verdict:   verdict,
		Usage:     usage,
	}
}

func usageVerdict(verdict Verdict) *Verdict { return &verdict }

// usageNextID gives each job a distinct id and title. The package's tests run one at a time.
var usageNextID int64

// usageJob builds a job: a brief on the tier, the state and the attempts.
func usageJob(model ModelTier, state JobState, attempts ...Attempt) Job {
	usageNextID++
	setup := []string{}
	return Job{
		ID: fmt.Sprintf("job-%d", usageNextID),
		Brief: Brief{
			Title:     fmt.Sprintf("job %d", usageNextID),
			Body:      "Fix it.",
			Model:     model,
			Mode:      ModeEdit,
			Cwd:       "/work/repo",
			Base:      "HEAD",
			Scope:     []string{"**"},
			Forbid:    []string{},
			Gates:     []Gate{},
			Setup:     &setup,
			TimeoutMs: 7_200_000,
			Retries:   Retries{Fix: 1, Infra: 2},
			Report:    Report{Kind: ReportKindBuiltin, Name: BuiltinReportChange},
			AddDirs:   []string{},
			Env:       []string{},
			Tags:      []string{},
		},
		State:     state,
		Workspace: Workspace{RepoRoot: "/work/repo", BaseSha: "abc123", ArtifactsDir: "/state/artifacts"},
		Attempts:  attempts,
		CreatedAt: "2026-10-06T08:00:00.000Z",
		UpdatedAt: "2026-10-06T08:00:00.000Z",
		Version:   1,
	}
}

// usagePartial is the zero usage with the given fields overridden.
func usagePartial(override func(*Usage)) *Usage {
	usage := Usage{}
	if override != nil {
		override(&usage)
	}
	return &usage
}

func TestSummarizeUsage(t *testing.T) {
	t.Run("returns one row per tier that has jobs, glm first", func(t *testing.T) {
		flashOnly := SummarizeUsage([]Job{usageJob(ModelTierFlash, JobStateQueued)})
		both := SummarizeUsage([]Job{
			usageJob(ModelTierFlash, JobStateRunning),
			usageJob(ModelTierMain, JobStateQueued),
			usageJob(ModelTierFlash, JobStateQueued),
		})

		if got := SummarizeUsage(nil); len(got) != 0 {
			t.Errorf("no jobs: got %v, want no rows", got)
		}
		if len(flashOnly) != 1 || flashOnly[0].Tier != ModelTierFlash {
			t.Errorf("flashOnly: got %+v, want one flash row", flashOnly)
		}
		if len(both) != 2 ||
			both[0].Tier != ModelTierMain || both[0].Jobs != 1 ||
			both[1].Tier != ModelTierFlash || both[1].Jobs != 2 {
			t.Errorf("both: got %+v, want main (1 job) then flash (2 jobs)", both)
		}
	})
	t.Run("counts jobs, decided, accepted, discarded", func(t *testing.T) {
		jobs := []Job{
			usageJob(ModelTierMain, JobStateQueued),
			usageJob(ModelTierMain, JobStateRunning),
			usageJob(ModelTierMain, JobStateVerifying),
			usageJob(ModelTierMain, JobStateAwaitingReview),
			usageJob(ModelTierMain, JobStateAccepted),
			usageJob(ModelTierMain, JobStateAccepted),
			usageJob(ModelTierMain, JobStateDiscarded),
		}

		rows := SummarizeUsage(jobs)

		if len(rows) != 1 {
			t.Fatalf("got %d rows, want one", len(rows))
		}
		row := rows[0]
		if row.Jobs != 7 || row.Decided != 3 || row.Accepted != 2 || row.Discarded != 1 {
			t.Errorf("counts: got jobs %d, decided %d, accepted %d, discarded %d; want 7, 3, 2, 1",
				row.Jobs, row.Decided, row.Accepted, row.Discarded)
		}
	})
	t.Run("firstTryPassRate uses the first attempt's verdict over decided jobs", func(t *testing.T) {
		jobs := []Job{
			usageJob(ModelTierMain, JobStateAccepted, usageAttempt(1, AttemptKindInitial, usageVerdict(VerdictPass), nil)),
			usageJob(ModelTierMain, JobStateAccepted,
				usageAttempt(1, AttemptKindInitial, usageVerdict(VerdictGateFail), nil),
				usageAttempt(2, AttemptKindAutoFix, usageVerdict(VerdictPass), nil)),
			usageJob(ModelTierMain, JobStateDiscarded,
				usageAttempt(1, AttemptKindInitial, usageVerdict(VerdictPass), nil),
				usageAttempt(2, AttemptKindReviewFix, usageVerdict(VerdictGateFail), nil)),
			usageJob(ModelTierMain, JobStateDiscarded),
			// Undecided jobs do not count, even with a passing first attempt.
			usageJob(ModelTierMain, JobStateAwaitingReview, usageAttempt(1, AttemptKindInitial, usageVerdict(VerdictPass), nil)),
		}

		rows := SummarizeUsage(jobs)

		if len(rows) != 1 || rows[0].FirstTryPassRate == nil || *rows[0].FirstTryPassRate != 0.5 {
			t.Errorf("firstTryPassRate: got %+v, want 0.5", rows)
		}
	})
	t.Run("acceptRate = accepted / decided; meanAttemptsToAccept over accepted jobs", func(t *testing.T) {
		jobs := []Job{
			usageJob(ModelTierFlash, JobStateAccepted, usageAttempt(1, AttemptKindInitial, usageVerdict(VerdictPass), nil)),
			usageJob(ModelTierFlash, JobStateAccepted,
				usageAttempt(1, AttemptKindInitial, usageVerdict(VerdictGateFail), nil),
				usageAttempt(2, AttemptKindAutoFix, usageVerdict(VerdictPass), nil)),
			usageJob(ModelTierFlash, JobStateAccepted,
				usageAttempt(1, AttemptKindInitial, usageVerdict(VerdictWorkerError), nil),
				usageAttempt(2, AttemptKindInfraRetry, usageVerdict(VerdictGateFail), nil),
				usageAttempt(3, AttemptKindAutoFix, usageVerdict(VerdictPass), nil)),
			usageJob(ModelTierFlash, JobStateDiscarded,
				usageAttempt(1, AttemptKindInitial, nil, nil),
				usageAttempt(2, AttemptKindAutoFix, nil, nil),
				usageAttempt(3, AttemptKindReviewFix, nil, nil)),
			usageJob(ModelTierFlash, JobStateRunning, usageAttempt(1, AttemptKindInitial, nil, nil)),
		}

		rows := SummarizeUsage(jobs)

		if len(rows) != 1 {
			t.Fatalf("got %d rows, want one", len(rows))
		}
		row := rows[0]
		if row.AcceptRate == nil || *row.AcceptRate != 0.75 {
			t.Errorf("acceptRate: got %v, want 0.75", row.AcceptRate)
		}
		if row.MeanAttemptsToAccept == nil || *row.MeanAttemptsToAccept != 2 {
			t.Errorf("meanAttemptsToAccept: got %v, want 2", row.MeanAttemptsToAccept)
		}
	})
	t.Run("reviewReturns counts review_fix attempts", func(t *testing.T) {
		// A return is a reviewer event that has already happened, so jobs still in flight count too.
		jobs := []Job{
			usageJob(ModelTierMain, JobStateAccepted,
				usageAttempt(1, AttemptKindInitial, nil, nil),
				usageAttempt(2, AttemptKindReviewFix, nil, nil),
				usageAttempt(3, AttemptKindReviewFix, nil, nil)),
			usageJob(ModelTierMain, JobStateRunning,
				usageAttempt(1, AttemptKindInitial, nil, nil),
				usageAttempt(2, AttemptKindAutoFix, nil, nil),
				usageAttempt(3, AttemptKindReviewFix, nil, nil)),
			usageJob(ModelTierMain, JobStateDiscarded,
				usageAttempt(1, AttemptKindInitial, nil, nil),
				usageAttempt(2, AttemptKindInfraRetry, nil, nil)),
		}

		rows := SummarizeUsage(jobs)

		if len(rows) != 1 || rows[0].ReviewReturns != 3 {
			t.Errorf("reviewReturns: got %+v, want 3", rows)
		}
	})
	t.Run("sums tokens, cost, rate-limit retries and duration over all attempts", func(t *testing.T) {
		jobs := []Job{
			usageJob(ModelTierMain, JobStateAccepted,
				usageAttempt(1, AttemptKindInitial, usageVerdict(VerdictGateFail), usagePartial(func(usage *Usage) {
					usage.InputTokens = 100
					usage.OutputTokens = 10
					usage.CacheReadTokens = 1000
					usage.CacheWriteTokens = 7
					usage.CostUSD = 0.25
					usage.RateLimitRetries = 2
					usage.DurationMs = 60_000
				})),
				usageAttempt(2, AttemptKindAutoFix, usageVerdict(VerdictPass), usagePartial(func(usage *Usage) {
					usage.InputTokens = 50
					usage.OutputTokens = 5
					usage.CostUSD = 0.5
					usage.DurationMs = 30_000
				}))),
			usageJob(ModelTierMain, JobStateRunning,
				usageAttempt(1, AttemptKindInitial, nil, usagePartial(func(usage *Usage) {
					usage.InputTokens = 1
					usage.RateLimitRetries = 10
				}))),
			// An attempt that never produced usage (still running) contributes nothing.
			usageJob(ModelTierMain, JobStateQueued, usageAttempt(1, AttemptKindInitial, nil, nil)),
			usageJob(ModelTierFlash, JobStateAccepted,
				usageAttempt(1, AttemptKindInitial, usageVerdict(VerdictPass), usagePartial(func(usage *Usage) {
					usage.InputTokens = 999
					usage.CostUSD = 9
				}))),
		}

		rows := SummarizeUsage(jobs)

		if len(rows) != 2 || rows[0].Tier != ModelTierMain {
			t.Fatalf("got %d rows %+v, want the main row first", len(rows), rows)
		}
		row := rows[0]
		want := TierUsage{
			Tier:             ModelTierMain,
			Jobs:             3,
			InputTokens:      151,
			OutputTokens:     15,
			CacheReadTokens:  1000,
			CostUSD:          0.75,
			RateLimitRetries: 12,
			DurationMs:       90_000,
		}
		if row.InputTokens != want.InputTokens || row.OutputTokens != want.OutputTokens ||
			row.CacheReadTokens != want.CacheReadTokens || row.CostUSD != want.CostUSD ||
			row.RateLimitRetries != want.RateLimitRetries || row.DurationMs != want.DurationMs {
			t.Errorf("sums: got %+v, want %+v", row, want)
		}
	})
	t.Run("rates are null with a zero denominator", func(t *testing.T) {
		undecidedRows := SummarizeUsage([]Job{usageJob(ModelTierMain, JobStateRunning, usageAttempt(1, AttemptKindInitial, nil, nil))})
		noneAcceptedRows := SummarizeUsage([]Job{usageJob(ModelTierMain, JobStateDiscarded, usageAttempt(1, AttemptKindInitial, usageVerdict(VerdictGateFail), nil))})

		if len(undecidedRows) != 1 {
			t.Fatalf("undecided: got %d rows, want one", len(undecidedRows))
		}
		undecided := undecidedRows[0]
		if undecided.FirstTryPassRate != nil || undecided.AcceptRate != nil || undecided.MeanAttemptsToAccept != nil {
			t.Errorf("undecided rates: got %+v, want all nil", undecided)
		}
		if len(noneAcceptedRows) != 1 {
			t.Fatalf("noneAccepted: got %d rows, want one", len(noneAcceptedRows))
		}
		noneAccepted := noneAcceptedRows[0]
		if noneAccepted.FirstTryPassRate == nil || *noneAccepted.FirstTryPassRate != 0 ||
			noneAccepted.AcceptRate == nil || *noneAccepted.AcceptRate != 0 ||
			noneAccepted.MeanAttemptsToAccept != nil {
			t.Errorf("noneAccepted rates: got %+v, want 0, 0 and nil", noneAccepted)
		}
	})
}

// Direct domain rows for SummarizeEngines; the app-layer usage query reaches it only end to end.
func TestSummarizeEngines(t *testing.T) {
	withEngine := func(job Job, engine EngineTool) Job {
		job.Brief.Engine = &engine
		return job
	}
	attemptUsage := func(model string, turns, input, output, cacheRead, cacheWrite int64, cost float64) *Usage {
		return &Usage{
			Turns:            turns,
			InputTokens:      input,
			OutputTokens:     output,
			CacheReadTokens:  cacheRead,
			CacheWriteTokens: cacheWrite,
			CostUSD:          cost,
			Model:            &model,
		}
	}
	omp := EngineToolOmp
	pi := EngineToolPi
	jobs := []Job{
		withEngine(usageJob(ModelTierMain, JobStateAccepted,
			usageAttempt(1, AttemptKindInitial, nil, attemptUsage("glm-5.3", 3, 100, 10, 1000, 7, 0.25)),
			usageAttempt(2, AttemptKindAutoFix, nil, attemptUsage("gpt-5.1", 2, 50, 5, 0, 0, 0.5)),
		), omp),
		withEngine(usageJob(ModelTierMain, JobStateRunning,
			usageAttempt(1, AttemptKindInitial, nil, attemptUsage("glm-5.3", 1, 1, 0, 0, 0, 0)),
		), omp),
		withEngine(usageJob(ModelTierFlash, JobStateAccepted,
			usageAttempt(1, AttemptKindInitial, nil, nil),
		), pi),
		// claude jobs (no engine) and engines without jobs have no row.
		usageJob(ModelTierMain, JobStateAccepted, usageAttempt(1, AttemptKindInitial, usageVerdict(VerdictPass), nil)),
	}

	rows := SummarizeEngines(jobs)

	want := []EngineUsage{
		{
			Engine:           EngineToolOmp,
			Models:           []string{"glm-5.3", "gpt-5.1"},
			Jobs:             2,
			Accepted:         1,
			Requests:         6,
			InputTokens:      151,
			OutputTokens:     15,
			CacheReadTokens:  1000,
			CacheWriteTokens: 7,
			CostUSD:          0.75,
		},
		{
			Engine:   EngineToolPi,
			Models:   []string{},
			Jobs:     1,
			Accepted: 1,
		},
	}
	if !reflect.DeepEqual(rows, want) {
		t.Errorf("got %+v, want %+v", rows, want)
	}
}
