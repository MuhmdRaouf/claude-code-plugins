package adapters

import (
	"bytes"
	"context"
	"encoding/json"
	"maps"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// ClaudeCaps is what the claude worker can do.
var ClaudeCaps = ports.WorkerCapabilities{
	WorkerTerms: domain.WorkerTerms{
		Efforts: []string{"low", "high", "max"},
		Budget:  true,
		BriefNotes: domain.BriefNotes{
			Effort:    "passed to claude --effort",
			AddDirs:   "passed as --add-dir",
			BudgetUSD: "passed as --max-budget-usd",
			Readonly:  "plan mode, read tools only",
		},
	},
	Name:         ports.WorkerNameClaudeHeadless,
	SessionKey:   ports.SessionKeyCaller,
	NativeSchema: true,
}

// headlessModelArg is the `--model` value per tier: main runs on Claude Code's `sonnet` alias
// mapped to the provider's main model through ANTHROPIC_DEFAULT_SONNET_MODEL, because a raw
// provider id makes Claude Code log `unrecognized_model`. flash passes its full id: plan mode
// (readonly) resolves the `haiku` alias to sonnet, so `--model haiku --permission-mode plan` runs
// every assistant message on the main model, while `--model <flash id>` runs on flash. That argv
// also logs `unrecognized_model` on stderr; the run succeeds.
func headlessModelArg(model domain.ModelRef) string {
	if model.Tier == domain.ModelTierMain {
		return "sonnet"
	}
	return model.ID
}

// headlessAliasEnv is the alias mapping, from the provider's catalog: every alias Claude Code may
// pick lands on one of its models.
func headlessAliasEnv(provider domain.Provider) map[string]string {
	return map[string]string{
		"ANTHROPIC_DEFAULT_OPUS_MODEL":   provider.Catalog[domain.ModelTierMain].ID,
		"ANTHROPIC_DEFAULT_SONNET_MODEL": provider.Catalog[domain.ModelTierMain].ID,
		"ANTHROPIC_DEFAULT_HAIKU_MODEL":  provider.Catalog[domain.ModelTierFlash].ID,
	}
}

// headlessPermissionMode: read-only work runs in plan mode; edit and exec may change and run
// anything (the plugin verifies afterwards).
var headlessPermissionMode = map[ports.Access]string{
	ports.AccessWrite:    "bypassPermissions",
	ports.AccessExec:     "bypassPermissions",
	ports.AccessReadonly: "plan",
}

// headlessNoConversation is what Claude Code prints when `--resume` names a session it does not
// have.
var headlessNoConversation = regexp.MustCompile(`(?i)no conversation found`)

// ClaudeSessionMissing reports a resume whose session Claude Code does not have: it says so on
// stderr and exits.
func ClaudeSessionMissing(session ports.WorkerSession, stderrTail string) bool {
	return session.Kind == ports.SessionKindResume && headlessNoConversation.MatchString(stderrTail)
}

// ClaudeEnvDenylist is every CLAUDE* name a worker must never inherit, from the parent or from a
// brief's `env`, grouped by why. An entry ending in `*` denies that prefix; credential-shaped
// names are denied by rule (headlessCredentialWords), not listed. The plugin's own values, applied
// after everything else, win regardless.
var ClaudeEnvDenylist = []string{
	// The isolated per-worker config dir; the worker always sets it.
	"CLAUDE_CONFIG_DIR",
	// The orchestrator's credentials must never reach a worker routed to the provider.
	"CLAUDE_CODE_OAUTH_TOKEN",
	// These would route the worker away from the provider.
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_SKIP_BEDROCK_AUTH",
	"CLAUDE_CODE_SKIP_VERTEX_AUTH",
	// The orchestrator's plugin and project context (Claude Code leaks these into Bash calls).
	"CLAUDE_PLUGIN_ROOT",
	"CLAUDE_PLUGIN_DATA",
	"CLAUDE_PROJECT_DIR",
	// Marks of the orchestrator's own session and its IDE connection.
	"CLAUDECODE",
	"CLAUDE_CODE_ENTRYPOINT",
	"CLAUDE_CODE_SSE_PORT",
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDE_CODE_SESSION_*",
	// The worker sets this itself.
	"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
}

// headlessCredentialWords, matched as whole `_`-separated segments: CLAUDE_CODE_OAUTH_TOKEN is
// denied while CLAUDE_CODE_MAX_OUTPUT_TOKENS (a size, not a credential) passes.
var headlessCredentialWords = []string{"TOKEN", "KEY", "SECRET"}

// headlessKillGraceMs is how long after SIGTERM Claude Code gets to stop its tools before the
// group is killed.
const headlessKillGraceMs int64 = 5_000

// BuildClaudeArgs is the argv for `claude` (the prompt goes to stdin, never argv).
func BuildClaudeArgs(spec ports.WorkerSpec) []string {
	args := []string{
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--model",
		headlessModelArg(spec.Model),
	}
	if spec.Session.Kind == ports.SessionKindNew {
		args = append(args, "--session-id")
	} else {
		args = append(args, "--resume")
	}
	args = append(args,
		spec.Session.Key,
		"--permission-mode",
		headlessPermissionMode[spec.Access],
		"--json-schema",
		headlessCompactJSON(spec.Report.JSONSchema),
	)
	if spec.Effort != nil {
		args = append(args, "--effort", *spec.Effort)
	}
	if spec.BudgetUSD != nil {
		args = append(args, "--max-budget-usd", headlessNumberString(*spec.BudgetUSD))
	}
	// Last: `--add-dir` is variadic in Claude Code, so nothing that follows may be mistaken for
	// another directory.
	for _, dir := range spec.AddDirs {
		args = append(args, "--add-dir", dir)
	}
	return args
}

// BuildWorkerEnv layers allowlisted parent env + the parent's CLAUDE* settings + spec.PassEnv +
// provider routing + alias mapping + isolated CLAUDE_CONFIG_DIR + the key. Later layers win, so
// the plugin's own values always beat anything passed through.
func BuildWorkerEnv(
	provider domain.Provider,
	spec ports.WorkerSpec,
	key string,
	parent domain.EnvLookup,
	configDir string,
) map[string]string {
	env := PickAllowlisted(parent)
	maps.Copy(env, PickClaudeSettings(parent))
	maps.Copy(env, WithoutReserved(spec.PassEnv, headlessReservedName(provider)))
	env["ANTHROPIC_BASE_URL"] = provider.BaseURL
	env["ANTHROPIC_AUTH_TOKEN"] = key
	maps.Copy(env, headlessAliasEnv(provider))
	env["API_TIMEOUT_MS"] = "3000000"
	env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
	env["CLAUDE_CONFIG_DIR"] = configDir
	return env
}

// headlessIsDeniedClaudeName is true for a CLAUDE* name on ClaudeEnvDenylist (exact entry, or a
// `PREFIX_*` entry) or a credential-shaped one.
func headlessIsDeniedClaudeName(name string) bool {
	if !strings.HasPrefix(name, "CLAUDE") {
		return false
	}
	denied := slices.ContainsFunc(ClaudeEnvDenylist, func(entry string) bool {
		if strings.HasSuffix(entry, "*") {
			return strings.HasPrefix(name, strings.TrimSuffix(entry, "*"))
		}
		return entry == name
	})
	if denied {
		return true
	}
	segments := strings.Split(name, "_")
	return slices.ContainsFunc(headlessCredentialWords, func(word string) bool {
		return slices.Contains(segments, word)
	})
}

// PickClaudeSettings is the orchestrator's CLAUDE* settings (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, …),
// minus the denylist. Nothing is defaulted: a variable the parent did not set stays unset in the
// worker.
func PickClaudeSettings(parent domain.EnvLookup) map[string]string {
	env := make(map[string]string)
	for name, value := range parent {
		if strings.HasPrefix(name, "CLAUDE") && !headlessIsDeniedClaudeName(name) {
			env[name] = value
		}
	}
	return env
}

// headlessReservedName: brief `env` names are orchestrator-written, so a typo like
// `env: [ANTHROPIC_API_KEY]` must not be able to send the orchestrator's Anthropic credentials to
// the provider, nor re-route or re-configure the worker. CLAUDE* settings may be named, except
// ClaudeEnvDenylist, credential-shaped ones and the provider's own key names.
func headlessReservedName(provider domain.Provider) func(name string) bool {
	keyNames := make(map[string]bool, len(provider.KeyEnv))
	for _, name := range provider.KeyEnv {
		keyNames[name] = true
	}
	return func(name string) bool {
		return strings.HasPrefix(name, "ANTHROPIC_") ||
			headlessIsDeniedClaudeName(name) ||
			name == "API_TIMEOUT_MS" ||
			keyNames[name]
	}
}

// ClaudeHeadlessOptions is how the claude worker is started.
type ClaudeHeadlessOptions struct {
	// Provider is whose models the worker runs and how it is reached: routing, alias mapping and
	// reserved names come from it.
	Provider domain.Provider
	// Bin is `claude` by default; tests point it at the fake claude.
	Bin       string
	ConfigDir string
	// LoadKey is the provider key loader's result; the worker uses the value, the host reports
	// the source.
	LoadKey   func(ctx context.Context) (ports.ProviderKey, *ports.WorkerError)
	ParentEnv domain.EnvLookup
	// StopGraceMs is between SIGTERM and SIGKILL when the run is stopped.
	StopGraceMs int64
	// Parse is the stream-json line parser; domain.ParseStreamLine by default. Injectable so the
	// process plumbing can be tested on its own.
	Parse func(line string) ([]domain.WorkerEvent, error)
}

// ClaudeHeadlessWorker spawns detached (own process group), writes the prompt to stdin, tees
// stdout to spec.LogPath, yields parsed events, enforces spec.TimeoutMs by terminating the group.
// One process per attempt, so there is nothing to dispose.
type ClaudeHeadlessWorker struct {
	options ClaudeHeadlessOptions
}

var _ ports.Worker = (*ClaudeHeadlessWorker)(nil)

// NewClaudeHeadlessWorker builds the worker from its options.
func NewClaudeHeadlessWorker(options ClaudeHeadlessOptions) *ClaudeHeadlessWorker {
	return &ClaudeHeadlessWorker{options: options}
}

// Caps is what the claude worker can do.
func (w *ClaudeHeadlessWorker) Caps() ports.WorkerCapabilities { return ClaudeCaps }

// Preflight: the key loads; the binary is only found by starting it.
func (w *ClaudeHeadlessWorker) Preflight(ctx context.Context) error {
	_, keyErr := w.options.LoadKey(ctx)
	if keyErr != nil {
		return keyErr
	}
	return nil
}

// Start spawns one run of the worker.
func (w *ClaudeHeadlessWorker) Start(ctx context.Context, spec ports.WorkerSpec) (ports.WorkerRun, error) {
	key, keyErr := w.options.LoadKey(ctx)
	if keyErr != nil {
		return nil, keyErr
	}
	graceMs := headlessKillGraceMs
	maxLineBytes := int64(math.MaxInt64)
	timeoutMs := spec.TimeoutMs
	prompt := spec.Prompt
	logPath := spec.LogPath
	proc, err := process.StartStreaming(ctx, process.StreamCommand{
		Command:   w.options.Bin,
		Args:      BuildClaudeArgs(spec),
		Cwd:       spec.Cwd,
		Env:       headlessEnvPairs(BuildWorkerEnv(w.options.Provider, spec, key.Value, w.options.ParentEnv, w.options.ConfigDir)),
		Stdin:     &prompt,
		LogPath:   &logPath,
		TimeoutMs: &timeoutMs,
		GraceMs:   &graceMs,
		// Its stream-json lines carry whole tool results: no line is too long to keep.
		MaxLineBytes: &maxLineBytes,
		// Background shells it started would outlive it and hold stdout open: the group goes with
		// its leader.
		ReapGroupOnExit: true,
	}, nil)
	if err != nil {
		return nil, &ports.WorkerError{Kind: ports.WorkerErrorSpawnFailed, Message: err.Error()}
	}
	run := &headlessClaudeRun{
		proc:        proc,
		spec:        spec,
		parse:       w.lineParser(),
		stopGraceMs: w.options.StopGraceMs,
		events:      make(chan domain.WorkerEvent),
	}
	go run.pump()
	return run, nil
}

// ParseLine turns one stream-json line into its events (none for a line it cannot read).
func (w *ClaudeHeadlessWorker) ParseLine(line string) []domain.WorkerEvent {
	return w.lineParser()(line)
}

// Dispose has nothing to release: one process per attempt.
func (w *ClaudeHeadlessWorker) Dispose(ctx context.Context) error { return nil }

// lineParser resolves the injected parser, defaulting to the domain one; a line it rejects yields
// no events.
func (w *ClaudeHeadlessWorker) lineParser() func(line string) []domain.WorkerEvent {
	parse := w.options.Parse
	if parse == nil {
		parse = domain.ParseStreamLine
	}
	return func(line string) []domain.WorkerEvent {
		events, err := parse(line)
		if err != nil {
			return nil
		}
		return events
	}
}

// headlessClaudeRun is one started claude worker process.
type headlessClaudeRun struct {
	proc        *process.StreamingProcess
	spec        ports.WorkerSpec
	parse       func(line string) []domain.WorkerEvent
	stopGraceMs int64
	events      chan domain.WorkerEvent

	waitOnce sync.Once
	exit     ports.WorkerExit
}

var _ ports.WorkerRun = (*headlessClaudeRun)(nil)

// Pid is the worker process's pid.
func (r *headlessClaudeRun) Pid() int64 { return r.proc.Pid }

// Events yields the worker's parsed events in order and is closed when its output ends.
func (r *headlessClaudeRun) Events() <-chan domain.WorkerEvent { return r.events }

// Wait blocks until the worker process has exited and reports how, a resume Claude Code did not
// have included.
func (r *headlessClaudeRun) Wait() ports.WorkerExit {
	r.waitOnce.Do(func() {
		ended := <-r.proc.Exit
		exit := ports.WorkerExit{StderrTail: ended.StderrTail}
		if ended.Code != nil {
			code := int64(*ended.Code)
			exit.Code = &code
		}
		if ended.Signal != "" {
			exit.Signal = &ended.Signal
		}
		if ended.Forced != "" {
			forced := domain.ForcedEnd(ended.Forced)
			exit.Forced = &forced
		}
		exit.SessionMissing = ClaudeSessionMissing(r.spec.Session, ended.StderrTail)
		r.exit = exit
	})
	return r.exit
}

// Interrupt stops the run: Claude Code has no stop request, so SIGTERM lets it stop its tools,
// then the group is killed.
func (r *headlessClaudeRun) Interrupt(ctx context.Context, reason ports.InterruptReason) error {
	grace := headlessKillGraceMs
	if reason == ports.InterruptStopped {
		grace = r.stopGraceMs
	}
	r.proc.Interrupt(ctx, process.ForcedReason(reason), grace)
	return nil
}

// pump forwards the parsed events of every stdout line; lines the parser rejects are skipped:
// they stay in the raw log, and one bad line must not end the stream.
func (r *headlessClaudeRun) pump() {
	defer close(r.events)
	for line := range r.proc.Lines {
		for _, event := range r.parse(line) {
			r.events <- event
		}
	}
}

// headlessEnvPairs is env as the exec layer takes it: "name=value", by name so a run is
// reproducible.
func headlessEnvPairs(env map[string]string) []string {
	pairs := make([]string, 0, len(env))
	for _, name := range slices.Sorted(maps.Keys(env)) {
		pairs = append(pairs, name+"="+env[name])
	}
	return pairs
}

// headlessCompactJSON is the schema as compact JSON — same key order, no whitespace outside
// strings.
func headlessCompactJSON(raw json.RawMessage) string {
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		return string(raw)
	}
	return compact.String()
}

// headlessNumberString formats a number the way JavaScript's String() does: plain decimal between
// 1e-6 and 1e21, exponent notation outside it, the exponent without its leading zero.
func headlessNumberString(value float64) string {
	if value == 0 {
		return "0"
	}
	format := byte('f')
	if abs := math.Abs(value); abs < 1e-6 || abs >= 1e21 {
		format = 'e'
	}
	text := strconv.AppendFloat(make([]byte, 0, 32), value, format, -1, 64)
	if format == 'e' {
		if n := len(text); n >= 4 && text[n-4] == 'e' && text[n-3] == '-' && text[n-2] == '0' {
			text[n-2] = text[n-1]
			text = text[:n-1]
		}
	}
	return string(text)
}
