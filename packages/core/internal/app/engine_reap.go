package app

import (
	"context"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// An engine process never outlives its job: the plugin bridges a job to the engine, so it also reaps
// what the engine leaves. The engine runs in its own process group, apart from the driver's, so
// killing a driver does not reach it. While it runs, its group leader's pid sits in the job
// directory (engine.pid); whoever ends a job without its driver's help — stop and discard of a job
// whose driver is gone or was killed, and the cleanup every command runs for drivers that died —
// terminates that group.

// ReapEngine terminates the job's engine process group, if one is recorded, and forgets it.
func ReapEngine(ctx context.Context, deps Deps, jobID string) {
	paths := deps.Store.Paths(jobID)
	pid, recorded := deps.Files.EnginePid(paths)
	if !recorded {
		return
	}
	if deps.Process.IsAlive(pid) {
		// The group's end is awaited, but its failure is not the reaper's to report.
		_ = deps.Process.TerminateGroup(ctx, pid, deps.Config.StopGraceMs)
	}
	deps.Files.ClearEnginePid(paths)
}

// ReapOrphanEngines is the cleanup pass: an engine whose driver is gone has nobody left to stop it,
// so it is reaped here.
func ReapOrphanEngines(ctx context.Context, deps Deps, jobs []domain.Job) {
	for _, job := range jobs {
		paths := deps.Store.Paths(job.ID)
		if _, recorded := deps.Files.EnginePid(paths); !recorded {
			continue
		}
		driver, held := deps.Files.DriverPid(ctx, paths)
		if held && deps.Process.IsAlive(driver) {
			continue
		}
		ReapEngine(ctx, deps, job.ID)
	}
}
