package app

import (
	"context"
	"errors"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// Step is one state change of a job, computed from the job as stored.
type Step func(job domain.Job) (domain.Job, error)

// Move is the job moved through the lifecycle by event; everything else unchanged.
func Move(job domain.Job, event domain.JobEvent) (domain.Job, error) {
	to, err := domain.NextState(job.State, event)
	if err != nil {
		// NextState's only failure is a lifecycle error naming the state and the event.
		return domain.Job{}, &AppError{Kind: AppErrorLifecycle, LifecycleError: err.(domain.LifecycleError)}
	}
	moved := job
	moved.State = to
	return moved, nil
}

// Persist applies step to job and writes the result (optimistic version). On a version conflict the
// stored job is re-read and the step re-applied once, but only while it is still in the state job
// was in: someone else moved it on.
func Persist(ctx context.Context, deps Deps, job domain.Job, step Step) (domain.Job, error) {
	first, err := writeStep(ctx, deps, job, step)
	if err == nil {
		return first, nil
	}
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Kind != AppErrorStore ||
		appErr.StoreError == nil || appErr.StoreError.Kind != ports.StoreErrorVersionConflict {
		return first, err
	}
	current, getErr := deps.Store.Get(ctx, job.ID)
	if getErr != nil {
		return domain.Job{}, &AppError{Kind: AppErrorStore, StoreError: asStoreError(getErr)}
	}
	if current.State != job.State {
		return domain.Job{}, &AppError{
			Kind:    AppErrorWrongState,
			ID:      job.ID,
			State:   current.State,
			Allowed: []domain.JobState{job.State},
		}
	}
	return writeStep(ctx, deps, current, step)
}

// writeStep applies step and stores the result with the clock's timestamp.
func writeStep(ctx context.Context, deps Deps, job domain.Job, step Step) (domain.Job, error) {
	next, err := step(job)
	if err != nil {
		return domain.Job{}, err
	}
	next.UpdatedAt = deps.Clock.Iso()
	stored, err := deps.Store.Update(ctx, next)
	if err != nil {
		return domain.Job{}, &AppError{Kind: AppErrorStore, StoreError: asStoreError(err)}
	}
	return stored, nil
}

// asStoreError pulls the store error out of a JobStore failure; nil when it is not one.
func asStoreError(err error) *ports.StoreError {
	var storeErr *ports.StoreError
	if errors.As(err, &storeErr) {
		return storeErr
	}
	return nil
}
