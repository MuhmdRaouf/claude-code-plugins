package ports

import (
	"context"
	"encoding/json"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// Access is what the worker may do to the workspace: brief mode edit → write, exec → exec,
// readonly → readonly.
type Access string

const (
	AccessWrite    Access = "write"
	AccessExec     Access = "exec"
	AccessReadonly Access = "readonly"
)

// ReportContract is the structured report the run must end with.
type ReportContract struct {
	// A builtin's name (change, sweep, notes) or the schema file's path.
	Name string
	// Draft-07, for every worker. Raw JSON, so the exact bytes the schema file carries reach the
	// worker's --json-schema unchanged.
	JSONSchema json.RawMessage
	// The core's own check; a worker without native schema enforcement calls it before it accepts
	// a report. Raw JSON keeps the report's key order, as domain.CheckReport takes it.
	Validate func(report json.RawMessage) domain.ReportCheck
}

// SessionKind says whether a run starts a new worker session or resumes one.
type SessionKind string

const (
	SessionKindNew    SessionKind = "new"
	SessionKindResume SessionKind = "resume"
)

// WorkerSession is the plugin-assigned session key (Attempt.SessionID): a new session under that
// key, or the one to resume. Each worker maps it to its own storage.
type WorkerSession struct {
	Kind SessionKind
	Key  string
}

// WorkerSpec is one run of the worker: everything the adapter needs to start it.
type WorkerSpec struct {
	Cwd   string
	Model domain.ModelRef
	// One of Caps().Efforts (checked when the brief is parsed).
	Effort  *string
	Access  Access
	Prompt  string
	Session WorkerSession
	Report  ReportContract
	AddDirs []string
	// Honoured only when Caps().Budget.
	BudgetUSD *float64
	// Extra environment for the worker: values already resolved from the brief's env names.
	PassEnv   map[string]string
	TimeoutMs int64
	// The worker's raw output is appended here (one file per attempt); ParseLine reads it back.
	LogPath string
}

// WorkerExit is how a worker run ended: the process's own exit, or the end the core forced on it.
type WorkerExit struct {
	// Null when a signal killed the worker.
	Code *int64
	// The signal's name, null when the worker exited on its own.
	Signal     *string
	StderrTail string
	// Null when the worker was not forced to end.
	Forced *domain.ForcedEnd
	// A resume found no session under its key; the core then starts a new session with a
	// self-contained prompt.
	SessionMissing bool
}

// InterruptReason is why the core interrupts a running worker.
type InterruptReason string

const (
	InterruptStopped InterruptReason = "stopped"
	InterruptTimeout InterruptReason = "timeout"
)

// WorkerRun is one started worker: its events, how it ended, and how to stop it early.
type WorkerRun interface {
	// Events yields the worker's events in order and is closed when its output ends.
	Events() <-chan domain.WorkerEvent
	// Wait blocks until the worker process has exited (after Events is closed) and returns how.
	Wait() WorkerExit
	// Interrupt asks the worker to stop, then kills its process group if it does not; Wait then
	// reports the forced reason.
	Interrupt(ctx context.Context, reason InterruptReason) error
}

// WorkerName is the engine a worker adapter runs, one per engine the core knows.
type WorkerName string

const (
	WorkerNameClaudeHeadless WorkerName = "claude-headless"
	WorkerNameOmpRPC         WorkerName = "omp-rpc"
	WorkerNamePiRPC          WorkerName = "pi-rpc"
	WorkerNameOpencode       WorkerName = "opencode"
	WorkerNameZcode          WorkerName = "zcode"
)

// SessionKeyOwner says who owns the session id.
type SessionKeyOwner string

const (
	// The plugin assigns the session id and passes it in.
	SessionKeyCaller SessionKeyOwner = "caller"
	// The engine assigns it and the adapter announces it as a session event.
	SessionKeyEngine SessionKeyOwner = "engine"
	// No session to resume.
	SessionKeyNone SessionKeyOwner = "none"
)

// WorkerCapabilities is what a worker can do, for the core to adapt to; the brief-facing part
// (efforts, budget) is domain.WorkerTerms.
type WorkerCapabilities struct {
	domain.WorkerTerms
	// The engine this adapter runs, one per engine the core knows.
	Name WorkerName
	// Who owns the session id: the plugin, the engine, or no one.
	SessionKey SessionKeyOwner
	// The worker enforces ReportContract.JSONSchema itself; when false, the report is checked by
	// ReportContract.Validate.
	NativeSchema bool
}

// WorkerErrorKind is how a worker failed before or during a run.
type WorkerErrorKind string

const (
	WorkerErrorNoKey WorkerErrorKind = "no_key"
	// Label names the file in the provider's own terms; the plugin supplies it.
	WorkerErrorInsecureKeyFile WorkerErrorKind = "insecure_key_file"
	WorkerErrorSpawnFailed     WorkerErrorKind = "spawn_failed"
	// The worker answered, but not as its protocol says (handshake, version).
	WorkerErrorProtocol WorkerErrorKind = "protocol"
	// The spec asks for something this worker cannot do.
	WorkerErrorUnsupported WorkerErrorKind = "unsupported"
)

// WorkerError is a worker failure the core reports. It never carries the key itself.
type WorkerError struct {
	Kind    WorkerErrorKind
	Message string
	// InsecureKeyFile: the file's label in the provider's own terms, its path and its mode.
	Label string
	Path  string
	Mode  string
}

// Error returns the one-line description, the same words the app layer gives each kind, with
// "the worker" where that text names the provider's own worker label.
func (e *WorkerError) Error() string {
	switch e.Kind {
	case WorkerErrorNoKey:
		return e.Message
	case WorkerErrorInsecureKeyFile:
		return e.Label + " " + e.Path + " has mode " + e.Mode + ": run chmod 600 on it"
	case WorkerErrorSpawnFailed:
		return "cannot start the worker: " + e.Message
	case WorkerErrorProtocol:
		return "the worker does not speak the expected protocol: " + e.Message
	case WorkerErrorUnsupported:
		return "the worker cannot do this: " + e.Message
	}
	return "worker error: " + string(e.Kind)
}

// Worker is what the core needs from whatever runs the model (headless Claude Code on the
// provider's endpoint, or a delegation tool: omp or pi over RPC, opencode over its event stream).
// Everything worker-specific (argv, wire format, session storage, auth) stays behind it.
type Worker interface {
	Caps() WorkerCapabilities
	// Preflight is cheap, offline readiness (binary resolvable, key present).
	Preflight(ctx context.Context) error
	Start(ctx context.Context, spec WorkerSpec) (WorkerRun, error)
	// ParseLine turns one line of an attempt log into its events (none for a line it cannot
	// read); folds logs for show and the board.
	ParseLine(line string) []domain.WorkerEvent
	// Dispose releases long-lived processes once the driver is done.
	Dispose(ctx context.Context) error
}
