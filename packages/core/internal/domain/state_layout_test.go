package domain

import (
	"path/filepath"
	"reflect"
	"testing"
)

// The names are the on-disk contract: an installed plugin, its router and an older version of
// either read the same files, so renaming one is a migration, not a refactor.
func TestStateLayout(t *testing.T) {
	root := "/state"
	layout := NewStateLayout(root)

	t.Run("names the setup, engine, ledger and router files", func(t *testing.T) {
		want := StateLayout{
			Root:            root,
			SetupDone:       filepath.Join(root, "setup-done"),
			LegacyRouteMark: filepath.Join(root, "route"),
			Engines:         filepath.Join(root, "engines.json"),
			Ledger:          filepath.Join(root, "ledger.json"),
			DisabledLedger:  filepath.Join(root, "ledger.disabled.json"),
			RouterDir:       filepath.Join(root, "router"),
			RouterLog:       filepath.Join(root, "router", "router.log"),
			RouterPid:       filepath.Join(root, "router.pid"),
			RouterRetired:   filepath.Join(root, "router.retired"),
			RouterSilent:    filepath.Join(root, "router.silent"),
			RouterExit:      filepath.Join(root, "router.exit"),
			RouterLock:      filepath.Join(root, "router.lock"),
			CrashLog:        filepath.Join(root, "router-crash.log"),
			LeftBehind:      filepath.Join(root, "LEFT-BEHIND.md"),
			ClaudeHome:      filepath.Join(root, "claude-home"),
			Limiter:         filepath.Join(root, "limiter.json"),
			Slots:           filepath.Join(root, "slots"),
			Jobs:            filepath.Join(root, "jobs"),
			Checkouts:       filepath.Join(root, "checkouts"),
			CA:              filepath.Join(filepath.Dir(root), "ca"),
		}
		if !reflect.DeepEqual(layout, want) {
			t.Fatalf("stateLayout(%q) = %#v, want %#v", root, layout, want)
		}
	})

	t.Run("puts a job's record and sidecars in its directory and its worktree beside the jobs", func(t *testing.T) {
		job := layout.Job("261008-abc123")
		dir := filepath.Join(root, "jobs", "261008-abc123")
		want := JobPaths{
			Dir:        dir,
			Record:     filepath.Join(dir, "job.json"),
			Brief:      filepath.Join(dir, "brief.md"),
			Artifacts:  filepath.Join(dir, "artifacts"),
			DriverLog:  filepath.Join(dir, "driver.log"),
			Stop:       filepath.Join(dir, "stop"),
			Progress:   filepath.Join(dir, "progress.json"),
			DriverLock: filepath.Join(dir, "driver.lock"),
			EnginePid:  filepath.Join(dir, "engine.pid"),
			Worktree:   filepath.Join(root, "worktrees", "261008-abc123"),
			Checkout:   filepath.Join(root, "checkouts", "261008-abc123"),
		}
		if !reflect.DeepEqual(job, want) {
			t.Fatalf("layout.job = %#v, want %#v", job, want)
		}
		if got := job.AttemptLog(2); got != filepath.Join(dir, "attempt-2.jsonl") {
			t.Fatalf("attemptLog(2) = %q, want %q", got, filepath.Join(dir, "attempt-2.jsonl"))
		}
		if got := job.GateLog(2, 1); got != filepath.Join(dir, "gate-2-1.log") {
			t.Fatalf("gateLog(2, 1) = %q, want %q", got, filepath.Join(dir, "gate-2-1.log"))
		}
		if got := job.RegenerateLog(0); got != filepath.Join(dir, "regenerate-0.log") {
			t.Fatalf("regenerateLog(0) = %q, want %q", got, filepath.Join(dir, "regenerate-0.log"))
		}
		if got := job.LandCheckLog(1); got != filepath.Join(dir, "land-check-1.log") {
			t.Fatalf("landCheckLog(1) = %q, want %q", got, filepath.Join(dir, "land-check-1.log"))
		}
		if got := EnginePidBeside(job.AttemptLog(3)); got != job.EnginePid {
			t.Fatalf("enginePidBeside(attemptLog(3)) = %q, want %q", got, job.EnginePid)
		}
	})
}
