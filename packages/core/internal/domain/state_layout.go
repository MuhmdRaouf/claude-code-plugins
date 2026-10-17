package domain

import (
	"fmt"
	"path/filepath"
)

// JobPaths is one job's files: its directory under `jobs/`, the sidecars beside job.json, and its
// worktree.
type JobPaths struct {
	Dir string
	// The job record, written only by the job store.
	Record string
	Brief  string
	// The attempt's artifacts directory.
	Artifacts string
	// The detached driver's stdout and stderr.
	DriverLog string
	// Present while a stop was requested and not yet acted on.
	Stop string
	// The driver's progress snapshot, for readers that are not the driver.
	Progress string
	// Held by the job's driver; holds its pid.
	DriverLock string
	// The delegation engine's process group leader, while it runs.
	EnginePid string
	Worktree  string
	// The fresh detached checkout an accept verifies the commit to land in; it exists only while
	// the accept runs.
	Checkout string
}

// AttemptLog is attempt n's event log beside job.json.
func (p JobPaths) AttemptLog(n int) string {
	return filepath.Join(p.Dir, fmt.Sprintf("attempt-%d.jsonl", n))
}

// GateLog is gate `gate` of attempt n's log.
func (p JobPaths) GateLog(n, gate int) string {
	return filepath.Join(p.Dir, fmt.Sprintf("gate-%d-%d.log", n, gate))
}

// RegenerateLog is a brief's `regenerate` rule's output while landing, and a gate's in the
// landing check.
func (p JobPaths) RegenerateLog(n int) string {
	return filepath.Join(p.Dir, fmt.Sprintf("regenerate-%d.log", n))
}

// LandCheckLog is the landing check's log for attempt n.
func (p JobPaths) LandCheckLog(n int) string {
	return filepath.Join(p.Dir, fmt.Sprintf("land-check-%d.log", n))
}

// StateLayout names every file and directory a plugin keeps under its state root, named once.
// Nothing else in the codebase spells a state file's name; the router's uninstall cleanup and the
// setup ledger read the same names here. Pure paths (path/filepath only), so the ensure hook and
// the emergency passthrough may use it without pulling more in.
type StateLayout struct {
	Root string
	// Setup ran (and was not removed); the hooks act only once it exists.
	SetupDone string
	// The `route: provider` mark an older install carries in place of `setup-done`; read, then
	// removed.
	LegacyRouteMark string
	// Which delegation engines are enabled and who watches each.
	Engines string
	// Every change setup made outside the plugin, so the router can undo exactly those on
	// uninstall.
	Ledger string
	// The ledger of a disabled plugin, kept for its re-enable.
	DisabledLedger string
	// The router's copied bundles, its package.json and its log.
	RouterDir string
	RouterLog string
	// What the starter knows about the running router (pid, port, version, control token).
	RouterPid string
	// The retired router's pid record, moved here from `routerPid` when setup --remove retires
	// it: the hooks then treat the plugin as not set up, and a later setup still finds the token
	// to take the port over.
	RouterRetired string
	// The running silence episode against the router (unix ms of its first silent probe): a
	// front of ours is replaced only once its silence is sustained, never on one probe.
	RouterSilent string
	// The logged-exit marker: the pid of the router process whose exit left its line in
	// router.log. The next start compares it with the pid record — a holder that is gone while
	// no marker vouches for it died with no line (SIGKILL, the OS), and the next start names it.
	RouterExit string
	// Held by whoever is starting or stopping the router.
	RouterLock string
	// Why the router last crashed, appended and rotated.
	CrashLog string
	// What an uninstall could not remove, for the user to read.
	LeftBehind string
	// The CLAUDE_CONFIG_DIR the claude worker runs with.
	ClaudeHome string
	// The adaptive concurrency limiter's shared state.
	Limiter string
	// The semaphore's slot and ticket files.
	Slots string
	Jobs  string
	// The accepts' temporary checkouts, one per job id.
	Checkouts string
}

const enginePidFilename = "engine.pid"

// EnginePidBeside finds the job's engine.pid from one of its attempt logs (a worker knows its
// log, not its job).
func EnginePidBeside(attemptLog string) string {
	return filepath.Join(filepath.Dir(attemptLog), enginePidFilename)
}

// NewStateLayout lays out every file a plugin keeps under root.
func NewStateLayout(root string) StateLayout {
	routerDir := filepath.Join(root, "router")
	jobs := filepath.Join(root, "jobs")
	checkouts := filepath.Join(root, "checkouts")
	return StateLayout{
		Root:            root,
		SetupDone:       filepath.Join(root, "setup-done"),
		LegacyRouteMark: filepath.Join(root, "route"),
		Engines:         filepath.Join(root, "engines.json"),
		Ledger:          filepath.Join(root, "ledger.json"),
		DisabledLedger:  filepath.Join(root, "ledger.disabled.json"),
		RouterDir:       routerDir,
		RouterLog:       filepath.Join(routerDir, "router.log"),
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
		Jobs:            jobs,
		Checkouts:       checkouts,
	}
}

// Job lays out one job's files under jobs/.
func (l StateLayout) Job(id string) JobPaths {
	dir := filepath.Join(l.Jobs, id)
	return JobPaths{
		Dir:        dir,
		Record:     filepath.Join(dir, "job.json"),
		Brief:      filepath.Join(dir, "brief.md"),
		Artifacts:  filepath.Join(dir, "artifacts"),
		DriverLog:  filepath.Join(dir, "driver.log"),
		Stop:       filepath.Join(dir, "stop"),
		Progress:   filepath.Join(dir, "progress.json"),
		DriverLock: filepath.Join(dir, "driver.lock"),
		EnginePid:  filepath.Join(dir, enginePidFilename),
		Worktree:   filepath.Join(l.Root, "worktrees", id),
		Checkout:   filepath.Join(l.Checkouts, id),
	}
}
