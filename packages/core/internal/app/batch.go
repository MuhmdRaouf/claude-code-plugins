package app

import (
	"context"
	"errors"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// BatchItem is one brief file of a batch: its path and its text.
type BatchItem struct {
	Path string
	Text string
}

// BatchRejection is one brief the batch could not submit, with its failure.
type BatchRejection struct {
	Path  string
	Error *AppError
}

// BatchOutcome is what a batch run did: the jobs it submitted and the briefs it rejected.
type BatchOutcome struct {
	Submitted []domain.Job
	Rejected  []BatchRejection
}

// Batch submits every brief (all-or-report: invalid ones are listed, valid ones still go) and
// spawns one detached driver each; the semaphore + limiter pace them.
func Batch(ctx context.Context, deps Deps, items []BatchItem, cwd string) BatchOutcome {
	normal := domain.PriorityNormal
	outcome := BatchOutcome{Submitted: []domain.Job{}, Rejected: []BatchRejection{}}
	for _, item := range items {
		source := item.Path
		job, err := Submit(ctx, deps, SubmitInput{
			Text:            item.Text,
			SourcePath:      &source,
			Cwd:             cwd,
			DefaultPriority: &normal,
		})
		if err == nil {
			deps.Process.SpawnDriver(job.ID)
			outcome.Submitted = append(outcome.Submitted, job)
			continue
		}
		var appErr *AppError
		if errors.As(err, &appErr) {
			outcome.Rejected = append(outcome.Rejected, BatchRejection{Path: item.Path, Error: appErr})
		}
	}
	return outcome
}
