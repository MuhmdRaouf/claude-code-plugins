package cli

import (
	"context"
	"os"
	"os/signal"
	"syscall"
)

// UntilInterrupted runs fn under a context that SIGINT or SIGTERM cancels while fn runs; the
// signal handlers are removed afterwards.
func UntilInterrupted[T any](fn func(ctx context.Context) (T, error)) (T, error) {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return fn(ctx)
}
