package app

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// The worker-neutral suite: the drive loop over a worker whose wire and terms share nothing
// with Claude Code's.

const neutralID = "261006-acme1"

// acmeKv is acmebot's wire: one `key=value` line per event, the value running to the end of the
// line.
func acmeKvInit(sessionKey, modelID string) string {
	return "session=" + sessionKey + " model=" + modelID
}

func acmeKvText(text string) string          { return "text=" + text }
func acmeKvTool(name, summary string) string { return "tool=" + name + " " + summary }

func acmeKvResultLine(report json.RawMessage) string { return "result=" + string(report) }

// acmeKvResultEvent is acmebot's result line as an event: the report is the line's, the rest of the
// run summary is fixed in this stand-in.
func acmeKvResultEvent(report json.RawMessage) domain.WorkerEvent {
	return domain.WorkerEvent{
		Kind: domain.WorkerEventResult, IsError: false, Text: "done", StructuredOutput: report,
		Turns: 2, DurationMs: 1500, CostUSD: 0.01,
		Usage:          domain.ResultUsage{InputTokens: 100, OutputTokens: 20, CacheReadTokens: 50, CacheWriteTokens: 10},
		APIErrorStatus: nil,
	}
}

var acmeKvModel = regexp.MustCompile(`model=(\S+)`)

// parseAcmeKvLine reads one kv line; a line acmebot cannot read yields no events, the way a worker
// skips what it cannot parse.
func parseAcmeKvLine(text string) []domain.WorkerEvent {
	key, value, found := strings.Cut(text, "=")
	if !found {
		return nil
	}
	switch key {
	case "session":
		sessionID, rest, _ := strings.Cut(value, " ")
		model := ""
		if match := acmeKvModel.FindStringSubmatch(rest); match != nil {
			model = match[1]
		}
		return []domain.WorkerEvent{{Kind: domain.WorkerEventInit, SessionID: sessionID, Model: &model}}
	case "engine-session":
		return []domain.WorkerEvent{{Kind: domain.WorkerEventSession, SessionID: value}}
	case "text":
		return []domain.WorkerEvent{{Kind: domain.WorkerEventAssistantText, Text: value}}
	case "tool":
		name, summary, _ := strings.Cut(value, " ")
		return []domain.WorkerEvent{{Kind: domain.WorkerEventToolUse, Name: name, Summary: summary}}
	case "result":
		var report json.RawMessage
		if json.Unmarshal([]byte(value), &report) != nil {
			return nil
		}
		return []domain.WorkerEvent{acmeKvResultEvent(report)}
	default:
		return nil
	}
}

// acmebotDialect is acmebot: a worker that stands in for an engine whose sessions the caller keys,
// like pi.
var acmebotDialect = fakes.WorkerDialect{
	Caps: ports.WorkerCapabilities{
		WorkerTerms:  testkit.AcmeWorker,
		Name:         ports.WorkerNamePiRPC,
		SessionKey:   ports.SessionKeyCaller,
		NativeSchema: false,
	},
	ParseLine:      parseAcmeKvLine,
	Init:           acmeKvInit,
	SessionMissing: func(ports.WorkerSession, string) bool { return false },
	Fixtures:       fakes.EVENT_FIXTURES,
}

// engineSession is the id an engine-keyed worker announces for the caller's `000…1` placeholder.
const engineSession = "01a11109-0000-7000-8000-000000000001"

// ompeDialect is the same kv wire, keyed the way omp keys its sessions: the engine assigns the id
// and announces it.
var ompeDialect = fakes.WorkerDialect{
	Caps: ports.WorkerCapabilities{
		WorkerTerms:  testkit.AcmeWorker,
		Name:         ports.WorkerNameOmpRPC,
		SessionKey:   ports.SessionKeyEngine,
		NativeSchema: false,
	},
	ParseLine:      parseAcmeKvLine,
	Init:           acmeKvInit,
	SessionMissing: func(ports.WorkerSession, string) bool { return false },
	Fixtures:       fakes.EVENT_FIXTURES,
}

// sessionlessDialect is the same kv wire, keyed the way opencode does: no session of its own to
// resume.
var sessionlessDialect = fakes.WorkerDialect{
	Caps: ports.WorkerCapabilities{
		WorkerTerms:  testkit.AcmeWorker,
		Name:         ports.WorkerNameOpencode,
		SessionKey:   ports.SessionKeyNone,
		NativeSchema: false,
	},
	ParseLine:      parseAcmeKvLine,
	Init:           acmeKvInit,
	SessionMissing: func(ports.WorkerSession, string) bool { return false },
	Fixtures:       fakes.EVENT_FIXTURES,
}

// acmeCompletes is a completed acmebot run with a valid change report.
func acmeCompletes() fakes.WorkerScript {
	return fakes.WorkerScript{Lines: []string{
		acmeKvText("working"),
		acmeKvResultLine(fakes.VALID_CHANGE_REPORT),
	}}
}

// engineCompletes is a completed omp-style run: the engine announces its session id before it
// finishes with the report.
func engineCompletes() fakes.WorkerScript {
	return fakes.WorkerScript{Lines: []string{
		"engine-session=" + engineSession,
		acmeKvText("working"),
		acmeKvResultLine(fakes.VALID_CHANGE_REPORT),
	}}
}

// newAcmeWorld is the whole world in acme's names: no zai, claude or GLM string reaches the engine
// from anywhere.
func newAcmeWorld(t *testing.T, scripts []fakes.WorkerScript, dialect fakes.WorkerDialect) (Deps, *driveWorld) {
	t.Helper()
	return newDriveWorld(t, scripts, nil, workerWorld{provider: &testkit.AcmeProvider, dialect: &dialect})
}

// queuedAcme is a queued edit job in the fake store, its workspace in the acme provider's names.
func queuedAcme(w *driveWorld, brief func(*domain.Brief)) domain.Job {
	paths := w.store.Paths(neutralID)
	return w.store.Put(testkit.AJob(func(j *domain.Job) {
		j.ID = neutralID
		j.Brief = testkit.ABrief()
		if brief != nil {
			brief(&j.Brief)
		}
		worktree, branch := paths.Worktree, "acme-jobs/"+neutralID
		j.Workspace = domain.Workspace{
			RepoRoot: "/repo", BaseSha: strings.Repeat("b", 40),
			Worktree: &worktree, Branch: &branch, ArtifactsDir: paths.Artifacts,
		}
	}))
}

func storedAcme(t *testing.T, w *driveWorld) domain.Job {
	t.Helper()
	job, err := w.store.Get(context.Background(), neutralID)
	if err != nil {
		t.Fatalf("job not stored: %v", err)
	}
	return job
}

func acmeAttempt(t *testing.T, w *driveWorld, n int) domain.Attempt {
	t.Helper()
	job := storedAcme(t, w)
	if n < 1 || n > len(job.Attempts) {
		t.Fatalf("no attempt %d", n)
	}
	return job.Attempts[n-1]
}

func TestTheEngineDrivesAWorkerThatIsNotClaude(t *testing.T) {
	t.Run("re-runs a resume whose session the worker reports missing — empty stderr and all — in a fresh session", func(t *testing.T) {
		// The middle script exits sessionMissing with nothing on stderr: only the worker's own
		// flag says so.
		deps, w := newAcmeWorld(t, []fakes.WorkerScript{
			acmeCompletes(),
			{Bare: true, Lines: []string{}, Exit: &ports.WorkerExit{Code: strPtr(int64(1)), SessionMissing: true}},
			acmeCompletes(),
		}, acmebotDialect)
		w.gates.FailOnce("npm test")
		job := queuedAcme(w, gated)

		result, err := Drive(context.Background(), deps, neutralID)

		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(result, storedAcme(t, w)) {
			t.Errorf("result = %+v, want the stored job", result)
		}
		specs := w.worker.Specs()
		if len(specs) != 3 {
			t.Fatalf("specs = %d, want three", len(specs))
		}
		first := ports.WorkerSession{Kind: ports.SessionKindNew, Key: "00000000-0000-4000-8000-000000000001"}
		if specs[0].Session != first {
			t.Errorf("initial session = %+v, want the first fake session", specs[0].Session)
		}
		if specs[1].Session != (ports.WorkerSession{Kind: ports.SessionKindResume, Key: first.Key}) {
			t.Errorf("resume session = %+v, want the initial's key", specs[1].Session)
		}
		// FakeIds burned one on the auto_fix attempt before the fresh session took the next.
		if specs[2].Session != (ports.WorkerSession{Kind: ports.SessionKindNew, Key: "00000000-0000-4000-8000-000000000003"}) {
			t.Errorf("fresh session = %+v, want the third fake session", specs[2].Session)
		}
		followUp := domain.AutoFixPrompt(job.Brief, acmeAttempt(t, w, 1))
		want := domain.SelfContainedPrompt(job.Brief, []domain.Attempt{acmeAttempt(t, w, 1)},
			followUp, job.Workspace.ArtifactsDir, testkit.AcmeProvider)
		if specs[2].Prompt != want {
			t.Errorf("fresh prompt = %q, want the self-contained one", specs[2].Prompt)
		}
		wantVerdicts := [][2]any{
			{domain.AttemptKindInitial, domain.Verdict(domain.VerdictGateFail)},
			{domain.AttemptKindAutoFix, domain.Verdict(domain.VerdictPass)},
		}
		if got := driveVerdicts(t, storedAcme(t, w)); !reflect.DeepEqual(got, wantVerdicts) {
			t.Errorf("attempts = %v, want %v", got, wantVerdicts)
		}
		if stored := storedAcme(t, w); stored.State != domain.JobStateAwaitingReview {
			t.Errorf("state = %s, want awaiting_review", stored.State)
		}
	})

	t.Run("the board folds a running attempt's log with the worker's own line reader", func(t *testing.T) {
		deps, w := newAcmeWorld(t, nil, acmebotDialect)
		paths := w.store.Paths(neutralID)
		w.store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = neutralID
			j.Brief = testkit.ABrief()
			j.State = domain.JobStateRunning
			worktree, branch := paths.Worktree, "acme-jobs/"+neutralID
			j.Workspace = domain.Workspace{
				RepoRoot: "/repo", BaseSha: strings.Repeat("b", 40),
				Worktree: &worktree, Branch: &branch, ArtifactsDir: paths.Artifacts,
			}
			j.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) {
				a.SessionID = "acme-session-1"
			})}
		}))
		// No driver snapshot for this attempt, so the fold of the raw log is the board's only
		// source.
		log := strings.Join([]string{
			acmeKvInit("acme-session-1", testkit.AcmeProvider.Catalog[domain.ModelTierMain].ID),
			acmeKvText("compiling the list"),
			acmeKvTool("Bash", "npm test"),
			acmeKvText("almost there"),
			"",
		}, "\n")
		if err := os.WriteFile(paths.AttemptLog(1), []byte(log), 0o644); err != nil {
			t.Fatal(err)
		}

		row, err := JobRow(context.Background(), deps, neutralID)

		if err != nil {
			t.Fatal(err)
		}
		want := domain.Progress{
			SessionID: strPtr("acme-session-1"), Phase: domain.ProgressPhaseThinking, Turns: 0,
			LastTool: strPtr("Bash npm test"), LastText: "almost there",
			RateLimitRetries: 0, ToolCalls: 1, ToolErrors: 0,
		}
		if row.Progress == nil || !reflect.DeepEqual(*row.Progress, want) {
			t.Errorf("progress = %+v, want %+v", row.Progress, want)
		}
	})

	t.Run("a stop asks the worker's run to interrupt itself; the engine never signals the process group", func(t *testing.T) {
		deps, w := newAcmeWorld(t, nil, acmebotDialect)
		// acmebot stops its own child when asked; it records the ask instead of anyone terminating
		// the group.
		worker := newSelfInterruptingWorker(acmebotDialect.Caps)
		deps.Worker = worker
		queuedAcme(w, nil)
		done, cancel := driveInBackground(deps, neutralID)

		if err := testkit.Until(t, func() bool { return len(worker.Specs()) == 1 },
			testkit.UntilOptions{Message: "worker never started"}); err != nil {
			t.Fatal(err)
		}
		cancel()
		result := <-done

		if result.err != nil {
			t.Fatal(result.err)
		}
		if interrupts := worker.Interrupts(); !reflect.DeepEqual(interrupts, []ports.InterruptReason{ports.InterruptStopped}) {
			t.Errorf("interrupts = %v, want one stopped", interrupts)
		}
		if terminated := w.process.Terminated(); len(terminated) != 0 {
			t.Errorf("terminated = %v, want nobody: the engine never signals the group", terminated)
		}
		attempt := acmeAttempt(t, w, 1)
		if attempt.Outcome == nil || attempt.Outcome.Kind != domain.WorkerOutcomeStopped {
			t.Errorf("outcome = %+v, want stopped", attempt.Outcome)
		}
		if attempt.Verdict == nil || *attempt.Verdict != domain.VerdictStopped {
			t.Errorf("verdict = %v, want stopped", attempt.Verdict)
		}
		if stored := storedAcme(t, w); stored.State != domain.JobStateAwaitingReview {
			t.Errorf("state = %s, want awaiting_review", stored.State)
		}
	})
}

func TestTheEngineDrivesAWorkerWhoseSessionsTheEngineKeys(t *testing.T) {
	t.Run("stores the engine's session id and resumes the fix attempt under it, not the caller's placeholder", func(t *testing.T) {
		deps, w := newAcmeWorld(t, []fakes.WorkerScript{engineCompletes(), engineCompletes()}, ompeDialect)
		w.gates.FailOnce("npm test")
		queuedAcme(w, gated)

		result, err := Drive(context.Background(), deps, neutralID)

		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(result, storedAcme(t, w)) {
			t.Errorf("result = %+v, want the stored job", result)
		}
		specs := w.worker.Specs()
		if len(specs) != 2 {
			t.Fatalf("specs = %d, want two", len(specs))
		}
		if specs[0].Session != (ports.WorkerSession{Kind: ports.SessionKindNew, Key: "00000000-0000-4000-8000-000000000001"}) {
			t.Errorf("initial session = %+v, want the caller's placeholder", specs[0].Session)
		}
		if specs[1].Session != (ports.WorkerSession{Kind: ports.SessionKindResume, Key: engineSession}) {
			t.Errorf("resume session = %+v, want the engine's id", specs[1].Session)
		}
		// Both stored attempts carry the engine's id: the announced one, then the one the fix
		// resumed.
		stored := storedAcme(t, w)
		ids := []string{stored.Attempts[0].SessionID, stored.Attempts[1].SessionID}
		if !reflect.DeepEqual(ids, []string{engineSession, engineSession}) {
			t.Errorf("session ids = %v, want the engine's for both", ids)
		}
	})
}

func TestTheEngineDrivesAWorkerWithNoSessionToResume(t *testing.T) {
	t.Run("a fix attempt runs as a self-contained fresh session instead of a resume the worker must refuse", func(t *testing.T) {
		deps, w := newAcmeWorld(t, []fakes.WorkerScript{acmeCompletes(), acmeCompletes()}, sessionlessDialect)
		w.gates.FailOnce("npm test")
		job := queuedAcme(w, gated)

		result, err := Drive(context.Background(), deps, neutralID)

		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(result, storedAcme(t, w)) {
			t.Errorf("result = %+v, want the stored job", result)
		}
		specs := w.worker.Specs()
		if len(specs) != 2 {
			t.Fatalf("specs = %d, want two", len(specs))
		}
		if specs[0].Session != (ports.WorkerSession{Kind: ports.SessionKindNew, Key: "00000000-0000-4000-8000-000000000001"}) {
			t.Errorf("initial session = %+v, want the first fake session", specs[0].Session)
		}
		if specs[1].Session != (ports.WorkerSession{Kind: ports.SessionKindNew, Key: "00000000-0000-4000-8000-000000000003"}) {
			t.Errorf("fix session = %+v, want the third fake session", specs[1].Session)
		}
		followUp := domain.AutoFixPrompt(job.Brief, acmeAttempt(t, w, 1))
		want := domain.SelfContainedPrompt(job.Brief, []domain.Attempt{acmeAttempt(t, w, 1)},
			followUp, job.Workspace.ArtifactsDir, testkit.AcmeProvider)
		if specs[1].Prompt != want {
			t.Errorf("fix prompt = %q, want the self-contained one", specs[1].Prompt)
		}
		wantVerdicts := [][2]any{
			{domain.AttemptKindInitial, domain.Verdict(domain.VerdictGateFail)},
			{domain.AttemptKindAutoFix, domain.Verdict(domain.VerdictPass)},
		}
		if got := driveVerdicts(t, storedAcme(t, w)); !reflect.DeepEqual(got, wantVerdicts) {
			t.Errorf("attempts = %v, want %v", got, wantVerdicts)
		}
	})
}

// selfInterruptingWorker is a scripted worker whose run ends only when its own interrupt is asked,
// the way a worker stops its own child.
type selfInterruptingWorker struct {
	caps ports.WorkerCapabilities
	mu   sync.Mutex
	// specs is every spec Start received, in order.
	specs []ports.WorkerSpec
	// interrupts is every reason it was asked to stop, in order.
	interrupts []ports.InterruptReason
	endOnce    sync.Once
	ended      chan struct{}
}

func newSelfInterruptingWorker(caps ports.WorkerCapabilities) *selfInterruptingWorker {
	return &selfInterruptingWorker{caps: caps, ended: make(chan struct{})}
}

func (w *selfInterruptingWorker) Caps() ports.WorkerCapabilities { return w.caps }

func (w *selfInterruptingWorker) Preflight(context.Context) error { return nil }

func (w *selfInterruptingWorker) ParseLine(line string) []domain.WorkerEvent {
	return parseAcmeKvLine(line)
}

func (w *selfInterruptingWorker) Dispose(context.Context) error { return nil }

func (w *selfInterruptingWorker) Start(ctx context.Context, spec ports.WorkerSpec) (ports.WorkerRun, error) {
	w.mu.Lock()
	w.specs = append(w.specs, spec)
	w.mu.Unlock()
	return &selfInterruptingRun{worker: w}, nil
}

// Specs is every spec Start received, in order.
func (w *selfInterruptingWorker) Specs() []ports.WorkerSpec {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.specs)
}

// Interrupts is every reason it was asked to stop, in order.
func (w *selfInterruptingWorker) Interrupts() []ports.InterruptReason {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.interrupts)
}

// end resolves the run's hang exactly once, as a stopped process would.
func (w *selfInterruptingWorker) end() {
	w.endOnce.Do(func() { close(w.ended) })
}

type selfInterruptingRun struct{ worker *selfInterruptingWorker }

func (r *selfInterruptingRun) Events() <-chan domain.WorkerEvent {
	events := make(chan domain.WorkerEvent)
	go func() {
		defer close(events)
		for _, event := range parseAcmeKvLine(acmeKvText("working")) {
			events <- event
		}
		// The run goes on until its worker stops it.
		<-r.worker.ended
	}()
	return events
}

func (r *selfInterruptingRun) Wait() ports.WorkerExit {
	<-r.worker.ended
	signal := "SIGTERM"
	return ports.WorkerExit{Signal: &signal}
}

func (r *selfInterruptingRun) Interrupt(ctx context.Context, reason ports.InterruptReason) error {
	r.worker.mu.Lock()
	r.worker.interrupts = append(r.worker.interrupts, reason)
	r.worker.mu.Unlock()
	r.worker.end()
	return nil
}
