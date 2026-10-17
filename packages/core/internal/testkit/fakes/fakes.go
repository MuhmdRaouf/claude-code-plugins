// Package fakes holds the in-memory and scripted stand-ins for every port. Unit tests of app/ and
// cli/ run on these; the job directories (stop file, progress.json, attempt logs) live under a
// real temp dir so the app's file sidecars work.
package fakes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// ── store ───────────────────────────────────────────────────────────────────────────────────

// JobPathsUnder is the fs store's own layout, so the driver lock file and sidecars land where the
// app looks for them.
func JobPathsUnder(root, id string) domain.JobPaths {
	return domain.NewStateLayout(root).Job(id)
}

// MemoryStore is the in-memory job store.
type MemoryStore struct {
	// FailCreate makes the next Create fail with this error.
	FailCreate *ports.StoreError
	// BeforeUpdate runs before each update (after the version check passes it would write): lets a
	// test race a concurrent writer.
	BeforeUpdate func(job domain.Job)

	mu   sync.Mutex
	root string
	jobs map[string]domain.Job
	// writes is every successfully stored version, in write order.
	writes []domain.Job
	locks  map[string]int64
}

var _ ports.JobStore = (*MemoryStore)(nil)

// NewMemoryStore keeps jobs under root's layout.
func NewMemoryStore(root string) *MemoryStore {
	return &MemoryStore{root: root, jobs: map[string]domain.Job{}, locks: map[string]int64{}}
}

// Put stores a job as-is (test setup), returning the stored copy.
func (s *MemoryStore) Put(job domain.Job) domain.Job {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.makeDir(job.ID)
	s.jobs[job.ID] = job
	return job
}

// Create stores a job the way the fs store does: only once, at version+1.
func (s *MemoryStore) Create(ctx context.Context, job domain.Job) (domain.Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	failure := s.FailCreate
	s.FailCreate = nil
	if failure != nil {
		return domain.Job{}, failure
	}
	if _, exists := s.jobs[job.ID]; exists {
		return domain.Job{}, &ports.StoreError{
			Kind:    ports.StoreErrorIO,
			Message: "job " + job.ID + " already exists",
		}
	}
	return s.store(job), nil
}

// Get reads a stored job.
func (s *MemoryStore) Get(ctx context.Context, id string) (domain.Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	job, ok := s.jobs[id]
	if !ok {
		return domain.Job{}, &ports.StoreError{Kind: ports.StoreErrorNotFound, ID: id}
	}
	return job, nil
}

// Find resolves a unique id prefix too.
func (s *MemoryStore) Find(ctx context.Context, idOrPrefix string) (domain.Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if job, ok := s.jobs[idOrPrefix]; ok {
		return job, nil
	}
	var only string
	matches := 0
	for id := range s.jobs {
		if idOrPrefix != "" && strings.HasPrefix(id, idOrPrefix) {
			only = id
			matches++
		}
	}
	if matches == 1 {
		return s.jobs[only], nil
	}
	return domain.Job{}, &ports.StoreError{Kind: ports.StoreErrorNotFound, ID: idOrPrefix}
}

// Update writes only if the stored version equals job's; it returns the job with Version+1.
func (s *MemoryStore) Update(ctx context.Context, job domain.Job) (domain.Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.BeforeUpdate != nil {
		s.BeforeUpdate(job)
	}
	current, ok := s.jobs[job.ID]
	if !ok {
		return domain.Job{}, &ports.StoreError{Kind: ports.StoreErrorNotFound, ID: job.ID}
	}
	if current.Version != job.Version {
		return domain.Job{}, &ports.StoreError{
			Kind:     ports.StoreErrorVersionConflict,
			ID:       job.ID,
			Expected: job.Version,
			Actual:   current.Version,
		}
	}
	return s.store(job), nil
}

// List returns the stored jobs, newest first (code-unit order, then by id), as the fs store does.
func (s *MemoryStore) List(ctx context.Context, filter ports.ListFilter) []domain.Job {
	s.mu.Lock()
	defer s.mu.Unlock()
	jobs := make([]domain.Job, 0, len(s.jobs))
	for _, job := range s.jobs {
		if filter.RepoRoot == "" || job.Workspace.RepoRoot == filter.RepoRoot {
			jobs = append(jobs, job)
		}
	}
	slices.SortFunc(jobs, func(a, b domain.Job) int {
		if order := strings.Compare(b.CreatedAt, a.CreatedAt); order != 0 {
			return order
		}
		return strings.Compare(b.ID, a.ID)
	})
	return jobs
}

// Paths is the job's files under the store's root.
func (s *MemoryStore) Paths(id string) domain.JobPaths {
	return JobPathsUnder(s.root, id)
}

// Lock takes the exclusive driver lock and returns the release function.
func (s *MemoryStore) Lock(ctx context.Context, id string, pid int64) (func(), error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.jobs[id]; !ok {
		return nil, &ports.StoreError{Kind: ports.StoreErrorNotFound, ID: id}
	}
	if holder, held := s.locks[id]; held {
		return nil, &ports.StoreError{Kind: ports.StoreErrorLocked, ID: id, HolderPid: holder}
	}
	s.holdLocked(id, pid)
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.locks[id] != pid {
			return
		}
		delete(s.locks, id)
		if err := os.Remove(s.Paths(id).DriverLock); err != nil && !os.IsNotExist(err) {
			panic(err)
		}
	}, nil
}

// HoldLock simulates another driver holding the lock (its pid in the lock file, like the fs store).
func (s *MemoryStore) HoldLock(id string, pid int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.holdLocked(id, pid)
}

// States is the states the job went through, in write order (consecutive repeats collapsed).
func (s *MemoryStore) States(id string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	states := []string{}
	for _, job := range s.writes {
		if job.ID != id {
			continue
		}
		if len(states) > 0 && states[len(states)-1] == string(job.State) {
			continue
		}
		states = append(states, string(job.State))
	}
	return states
}

// store writes the job at version+1 and records the write.
func (s *MemoryStore) store(job domain.Job) domain.Job {
	stored := job
	stored.Version = job.Version + 1
	s.makeDir(stored.ID)
	s.jobs[stored.ID] = stored
	s.writes = append(s.writes, stored)
	return stored
}

// makeDir creates the job's directory, where the sidecars live.
func (s *MemoryStore) makeDir(id string) {
	if err := os.MkdirAll(s.Paths(id).Dir, 0o755); err != nil {
		panic(err)
	}
}

// holdLocked records the holder and writes its pid to the lock file, as the fs lock does.
func (s *MemoryStore) holdLocked(id string, pid int64) {
	s.locks[id] = pid
	s.makeDir(id)
	if err := os.WriteFile(s.Paths(id).DriverLock, []byte(strconv.FormatInt(pid, 10)+"\n"), 0o644); err != nil {
		panic(err)
	}
}

// ── worker ──────────────────────────────────────────────────────────────────────────────────

// EVENT_FIXTURES is where the reference worker's recorded runs live: WorkerEvents, one JSON event
// per line (testdata/events, the recorded fixtures).
var EVENT_FIXTURES = filepath.Join(moduleRoot(), "testdata", "events")

// moduleRoot is the core module's root: a test binary runs in its package's directory, under
// the module root, so walking up from the working directory finds go.mod.
func moduleRoot() string {
	dir, err := os.Getwd()
	if err != nil {
		panic("EVENT_FIXTURES: " + err.Error())
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			panic("EVENT_FIXTURES: no go.mod above " + dir)
		}
		dir = parent
	}
}

// ToolArg is one tool-call input field, in order: the wire's tool summary is the input's first
// string value, and a Go map would lose that order.
type ToolArg struct {
	Key   string
	Value any
}

// ResultFields are the parts of a result line a script sets; an unset field takes the wire's
// default (is_error false, text "done", report null).
type ResultFields struct {
	Report  json.RawMessage
	IsError bool
	Text    string
}

// wireHelpers is the reference worker's wire: each line is one WorkerEvent as JSON, shaped like a
// live run's events.
type wireHelpers struct{}

// Wire is the reference worker's wire.
var Wire = wireHelpers{}

// Init is the line announcing the session (the model defaults to glm-5.3).
func (wireHelpers) Init(sessionKey string, model ...string) string {
	modelID := "glm-5.3"
	if len(model) > 0 {
		modelID = model[0]
	}
	return wireLine(domain.WorkerEvent{
		Kind:      domain.WorkerEventInit,
		SessionID: sessionKey,
		Model:     &modelID,
	})
}

// Text is one assistant message.
func (wireHelpers) Text(text string) string {
	return wireLine(domain.WorkerEvent{Kind: domain.WorkerEventAssistantText, Text: text})
}

// Tool is a tool call; the input's first string value is its summary.
func (wireHelpers) Tool(name string, input ...ToolArg) string {
	summary := ""
	for _, arg := range input {
		if text, ok := arg.Value.(string); ok {
			summary = text
			break
		}
	}
	return wireLine(domain.WorkerEvent{Kind: domain.WorkerEventToolUse, Name: name, Summary: summary})
}

// Retry is one API retry; status nil when the failure had no HTTP status.
func (wireHelpers) Retry(status *int64, attempt ...int64) string {
	n := int64(1)
	if len(attempt) > 0 {
		n = attempt[0]
	}
	return wireLine(domain.WorkerEvent{
		Kind:       domain.WorkerEventAPIRetry,
		Attempt:    n,
		MaxRetries: 10,
		Status:     status,
	})
}

// Result is the run's last line: the report, whether it errored, and its text.
func (wireHelpers) Result(fields ...ResultFields) string {
	field := ResultFields{}
	if len(fields) > 0 {
		field = fields[0]
	}
	text := field.Text
	if text == "" {
		text = "done"
	}
	return wireLine(domain.WorkerEvent{
		Kind:             domain.WorkerEventResult,
		IsError:          field.IsError,
		Text:             text,
		StructuredOutput: field.Report,
		Turns:            2,
		DurationMs:       1500,
		CostUSD:          0.01,
		Usage: domain.ResultUsage{
			InputTokens:      100,
			OutputTokens:     20,
			CacheReadTokens:  50,
			CacheWriteTokens: 10,
		},
		APIErrorStatus: nil,
	})
}

// wireLine is one event as the wire carries it, without HTML escaping (JSON.stringify leaves <,
// > and & alone).
func wireLine(event domain.WorkerEvent) string {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(event); err != nil {
		panic(err)
	}
	return strings.TrimSuffix(buf.String(), "\n")
}

// ParseEventLine turns a reference wire line into its event; a torn or blank line, or one without
// a string type, reads as none, as a worker skips what it cannot read.
func ParseEventLine(text string) []domain.WorkerEvent {
	var probe struct {
		Type *string `json:"type"`
	}
	if err := json.Unmarshal([]byte(text), &probe); err != nil || probe.Type == nil {
		return nil
	}
	var event domain.WorkerEvent
	if err := json.Unmarshal([]byte(text), &event); err != nil {
		// A well-formed line whose type the core does not track still parses, the way JSON.parse
		// leaves it; the fold ignores what it does not know.
		return []domain.WorkerEvent{{Kind: domain.WorkerEventKind(*probe.Type)}}
	}
	return []domain.WorkerEvent{event}
}

// WorkerDialect is how a scripted worker reads its script: a worker's wire, its terms, and how it
// tells a missing session.
type WorkerDialect struct {
	Caps      ports.WorkerCapabilities
	ParseLine func(line string) []domain.WorkerEvent
	// Init is the line announcing the session, streamed first unless the script is Bare.
	Init func(sessionKey, modelID string) string
	// SessionMissing says a resume found no session under its key.
	SessionMissing func(session ports.WorkerSession, stderrTail string) bool
	// Fixtures is the directory a script's Fixture lives in.
	Fixtures string
}

// EVENT_DIALECT is the reference worker: the event wire above and the claude worker's terms. It
// never loses a session by itself; a script says so with Exit.SessionMissing.
var EVENT_DIALECT = WorkerDialect{
	Caps:      testkit.ReferenceCaps,
	ParseLine: ParseEventLine,
	Init:      func(sessionKey, modelID string) string { return Wire.Init(sessionKey, modelID) },
	SessionMissing: func(ports.WorkerSession, string) bool {
		return false
	},
	Fixtures: EVENT_FIXTURES,
}

// VALID_CHANGE_REPORT is a change report that satisfies the change contract.
var VALID_CHANGE_REPORT = json.RawMessage(`{"summary":"Renamed foo to bar","files":[{"path":"src/a.ts","why":"rename"}],"tests_added":[],"open_items":[]}`)

// WorkerScript is one scripted run of the worker.
type WorkerScript struct {
	// Lines are the wire lines to stream (each also appended to the attempt log).
	Lines []string
	// Fixture is a file in the dialect's Fixtures dir, streamed instead of Lines.
	Fixture string
	// Exit overrides the default end: each set field replaces the default exit's.
	Exit *ports.WorkerExit
	// Hang keeps the run going until TerminateGroup(pid); the exit then reports SIGTERM.
	Hang bool
	// Bare streams no init line first (a run that fails before its session starts).
	Bare       bool
	StartError *ports.WorkerError
	// OnStart runs at start, e.g. to edit files the way the real worker would.
	OnStart func(spec ports.WorkerSpec)
}

// Completes is a completed run with a valid change report, its session announced by init.
func Completes(report ...json.RawMessage) WorkerScript {
	theReport := VALID_CHANGE_REPORT
	if len(report) > 0 {
		theReport = report[0]
	}
	return WorkerScript{Lines: []string{
		Wire.Text("working"),
		Wire.Result(ResultFields{Report: theReport}),
	}}
}

// ScriptedWorker plays scripts in its dialect, so it reads them, and tells a missing session, the
// way that worker does.
type ScriptedWorker struct {
	mu        sync.Mutex
	scripts   []WorkerScript
	processes *FakeProcess
	dialect   WorkerDialect
	nextPid   int64
	specs     []ports.WorkerSpec
	disposed  int

	// stopped ends every run the fake started; wg waits for their goroutines, so no line lands
	// after the owner's cleanup and the test's temp dirs go away quietly.
	stopOnce sync.Once
	stopped  chan struct{}
	wg       sync.WaitGroup
}

var _ ports.Worker = (*ScriptedWorker)(nil)

// NewScriptedWorker plays the scripts on the reference dialect. Create it after the temp dir its
// logs live in: t.Cleanup runs LIFO, so the fake's Stop (registered here) then runs before that
// dir's removal.
func NewScriptedWorker(t testing.TB, processes *FakeProcess, scripts ...WorkerScript) *ScriptedWorker {
	return newScriptedWorker(EVENT_DIALECT, t, processes, scripts)
}

// NewScriptedWorkerInDialect plays the scripts in the given dialect. Create it after the temp dir
// its logs live in: t.Cleanup runs LIFO, so the fake's Stop (registered here) then runs before
// that dir's removal.
func NewScriptedWorkerInDialect(dialect WorkerDialect, t testing.TB, processes *FakeProcess, scripts ...WorkerScript) *ScriptedWorker {
	return newScriptedWorker(dialect, t, processes, scripts)
}

func newScriptedWorker(dialect WorkerDialect, t testing.TB, processes *FakeProcess, scripts []WorkerScript) *ScriptedWorker {
	worker := &ScriptedWorker{
		scripts:   scripts,
		processes: processes,
		dialect:   dialect,
		nextPid:   50_000,
		stopped:   make(chan struct{}),
	}
	t.Cleanup(worker.Stop)
	return worker
}

// Stop ends every run the fake started and waits for their goroutines: streaming runs drop the
// lines nobody will read, hung runs end as if terminated. After Stop a late start (a driver still
// looping in the background of a test that already failed) streams nothing and writes nothing.
func (w *ScriptedWorker) Stop() {
	w.stopOnce.Do(func() { close(w.stopped) })
	w.wg.Wait()
}

// Caps is the dialect's.
func (w *ScriptedWorker) Caps() ports.WorkerCapabilities {
	return w.dialect.Caps
}

// Preflight is cheap readiness; the scripted worker is always ready.
func (w *ScriptedWorker) Preflight(ctx context.Context) error {
	return nil
}

// Start plays the next script: with several queued, one is consumed per start; the last one
// repeats; with none left it panics (a test bug).
func (w *ScriptedWorker) Start(ctx context.Context, spec ports.WorkerSpec) (ports.WorkerRun, error) {
	w.mu.Lock()
	w.specs = append(w.specs, spec)
	var script WorkerScript
	switch {
	case len(w.scripts) > 1:
		script, w.scripts = w.scripts[0], w.scripts[1:]
	case len(w.scripts) == 1:
		script = w.scripts[0]
	default:
		w.mu.Unlock()
		panic("ScriptedWorker: no script left")
	}
	w.mu.Unlock()

	if script.StartError != nil {
		return nil, script.StartError
	}
	if script.OnStart != nil {
		script.OnStart(spec)
	}
	w.mu.Lock()
	pid := w.nextPid
	w.nextPid++
	w.mu.Unlock()
	w.processes.markAlive(pid)
	terminated := make(chan struct{})
	// Terminating twice is the same end; closing the channel twice would panic.
	var endTerminated sync.Once
	w.processes.setOnTerminate(pid, func() { endTerminated.Do(func() { close(terminated) }) })
	lines := w.linesOf(script, spec)

	run := &scriptedRun{
		events: make(chan domain.WorkerEvent),
		exit:   make(chan ports.WorkerExit, 1),
	}
	run.interrupt = func(ctx context.Context) error {
		return w.processes.TerminateGroup(ctx, pid, 0)
	}
	if script.Hang {
		// The process ends only when terminated (or the fake is stopped); the exit then reports
		// SIGTERM, forced null.
		w.wg.Add(1)
		run.wg.Add(1)
		go func() {
			defer w.wg.Done()
			defer run.wg.Done()
			select {
			case <-terminated:
			case <-w.stopped:
			}
			signal := "SIGTERM"
			exit := ports.WorkerExit{Signal: &signal}
			exit.SessionMissing = w.dialect.SessionMissing(spec.Session, exit.StderrTail)
			w.processes.markDead(pid)
			run.exit <- exit
		}()
	} else {
		// The process ends as the run starts; only its events are still to come.
		w.processes.markDead(pid)
		code := int64(0)
		exit := ports.WorkerExit{Code: &code}
		mergeExit(&exit, script.Exit)
		sessionMissing := w.dialect.SessionMissing(spec.Session, exit.StderrTail)
		if script.Exit != nil && script.Exit.SessionMissing {
			sessionMissing = true
		}
		exit.SessionMissing = sessionMissing
		run.exit <- exit
	}
	w.wg.Add(1)
	run.wg.Add(1)
	go func() {
		defer w.wg.Done()
		defer run.wg.Done()
		defer close(run.events)
		select {
		case <-w.stopped:
			return
		default:
		}
		if err := os.MkdirAll(filepath.Dir(spec.LogPath), 0o755); err != nil {
			panic(err)
		}
		for _, text := range lines {
			// A stopped fake drops the lines nobody will read instead of writing into (or
			// recreating) a log directory its owner may have removed.
			select {
			case <-w.stopped:
				return
			default:
			}
			appendLine(spec.LogPath, text)
			for _, event := range w.dialect.ParseLine(text) {
				select {
				case run.events <- event:
				case <-w.stopped:
					return
				}
			}
		}
		if script.Hang {
			select {
			case <-terminated:
			case <-w.stopped:
			}
		}
	}()
	return run, nil
}

// ParseLine reads a line the way the dialect's worker does.
func (w *ScriptedWorker) ParseLine(line string) []domain.WorkerEvent {
	return w.dialect.ParseLine(line)
}

// Dispose releases long-lived processes once the driver is done.
func (w *ScriptedWorker) Dispose(ctx context.Context) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.disposed++
	return nil
}

// Specs is every spec Start received, in order.
func (w *ScriptedWorker) Specs() []ports.WorkerSpec {
	w.mu.Lock()
	defer w.mu.Unlock()
	return slices.Clone(w.specs)
}

// Disposed counts Dispose calls.
func (w *ScriptedWorker) Disposed() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.disposed
}

// linesOf is the script's wire lines: a fixture's, or the init line (unless bare) plus the
// script's own.
func (w *ScriptedWorker) linesOf(script WorkerScript, spec ports.WorkerSpec) []string {
	if script.Fixture != "" {
		raw, err := os.ReadFile(filepath.Join(w.dialect.Fixtures, script.Fixture))
		if err != nil {
			panic("ScriptedWorker: read fixture " + script.Fixture + ": " + err.Error())
		}
		return strings.Split(string(raw), "\n")
	}
	lines := []string{}
	if !script.Bare {
		lines = append(lines, w.dialect.Init(spec.Session.Key, spec.Model.ID))
	}
	return append(lines, script.Lines...)
}

// mergeExit applies the parts of a scripted exit that are set to the default exit; a nil Code or
// Signal means "keep the default".
func mergeExit(exit *ports.WorkerExit, override *ports.WorkerExit) {
	if override == nil {
		return
	}
	if override.Code != nil {
		exit.Code = override.Code
	}
	if override.Signal != nil {
		exit.Signal = override.Signal
	}
	if override.StderrTail != "" {
		exit.StderrTail = override.StderrTail
	}
	if override.Forced != nil {
		exit.Forced = override.Forced
	}
}

// appendLine appends one wire line to the attempt log, as the real worker's stdout is; a failure
// to write panics, so a broken log fails the test, not the run.
func appendLine(logPath, line string) {
	if err := appendText(logPath, line+"\n"); err != nil {
		panic(err)
	}
}

func appendText(logPath, text string) error {
	// The log directory is created once, before the first line; a removed one is never recreated
	// (a late line is dropped by the streaming goroutine instead), so a finished test's temp dir
	// stays gone.
	file, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.WriteString(text)
	return err
}

// scriptedRun is one scripted worker run: its events, its exit, and its interrupt.
type scriptedRun struct {
	events chan domain.WorkerEvent
	exit   chan ports.WorkerExit
	// waitOnce keeps the first Wait's answer for the next one, as a resolved promise would.
	waitOnce sync.Once
	theExit  ports.WorkerExit
	// wg covers the run's goroutines, so once Wait returns the run has written its last line.
	wg sync.WaitGroup

	interrupt func(context.Context) error
}

var _ ports.WorkerRun = (*scriptedRun)(nil)

// Events yields the script's events in order and is closed when its output ends.
func (r *scriptedRun) Events() <-chan domain.WorkerEvent {
	return r.events
}

// Wait returns how the run ended, after the run's goroutines have finished writing.
func (r *scriptedRun) Wait() ports.WorkerExit {
	r.waitOnce.Do(func() { r.theExit = <-r.exit })
	r.wg.Wait()
	return r.theExit
}

// Interrupt terminates the run's process group.
func (r *scriptedRun) Interrupt(ctx context.Context, reason ports.InterruptReason) error {
	return r.interrupt(ctx)
}

// ── git ─────────────────────────────────────────────────────────────────────────────────────

// BASE_SHA is the fake repository's base commit; COMMIT_SHA what a commit or amend makes.
const BASE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const COMMIT_SHA = "cccccccccccccccccccccccccccccccccccccccc"

// GitCall is one call FakeGit recorded: the method and its arguments.
type GitCall struct {
	Method string
	Args   []any
}

// FakeGit answers every method from overridable fields and records the calls under the Git
// interface's method names. Defaults: /repo is the repository, everything succeeds.
type FakeGit struct {
	// Calls is every recorded call, in order.
	Calls []GitCall
	// ChangeSet is reported for every directory (default: none).
	ChangeSet domain.ChangeSet
	// Fingerprints are the successive status answers; the last repeats.
	Fingerprints []string
	DiffText     string
	DiffStat     string
	WorktreeHead string
	CommitSha    string
	CommitErr    *ports.GitError
	// TrailerSetting is the trailer answer.
	TrailerSetting ports.TrailerSetting
	TrailerErr     *ports.GitError
	// Ancestor is the isAncestor answer.
	Ancestor    bool
	AncestorErr *ports.GitError
	RebaseErr   *ports.GitError
	AmendSha    string
	AmendErr    *ports.GitError
	// Landing is the fastForward answer.
	Landing    ports.FastForwardOutcome
	LandingErr *ports.GitError

	AddWorktreeErr    *ports.GitError
	RemoveWorktreeErr *ports.GitError
	AddDetachedErr    *ports.GitError
	RemoveDetachedErr *ports.GitError
	ApplyErr          *ports.GitError
}

var _ ports.Git = (*FakeGit)(nil)

// NewFakeGit answers the defaults: /repo is the repository, everything succeeds.
func NewFakeGit() *FakeGit {
	return &FakeGit{
		ChangeSet:      testkit.AChangeSet(),
		Fingerprints:   []string{"fp-0"},
		DiffText:       "diff --git a/src/a.ts b/src/a.ts\n+bar\n",
		DiffStat:       " src/a.ts | 2 +-\n 1 file changed\n",
		WorktreeHead:   BASE_SHA,
		CommitSha:      COMMIT_SHA,
		TrailerSetting: ports.TrailerSettingWorkedBy,
		Ancestor:       true,
		AmendSha:       COMMIT_SHA,
		Landing:        ports.FastForwardLanded,
	}
}

// record notes one call.
func (g *FakeGit) record(method string, args ...any) {
	g.Calls = append(g.Calls, GitCall{Method: method, Args: args})
}

// gitError returns the scripted failure, or a plain nil: a typed nil pointer in the error
// interface would read as an error to callers' err != nil.
func gitError(err *ports.GitError) error {
	if err == nil {
		return nil
	}
	return err
}

// Called is the recorded argument lists of one method, in call order.
func (g *FakeGit) Called(method string) [][]any {
	calls := [][]any{}
	for _, call := range g.Calls {
		if call.Method == method {
			calls = append(calls, call.Args)
		}
	}
	return calls
}

// Root says which repository cwd sits in.
func (g *FakeGit) Root(ctx context.Context, cwd string) (string, error) {
	g.record("root", cwd)
	if fakeRepoPath(cwd) {
		return "/repo", nil
	}
	return "", &ports.GitError{Kind: ports.GitErrorNotARepo, Path: cwd}
}

// fakeRepoPath says whether path is the fake repository.
func fakeRepoPath(path string) bool {
	return path == "/repo" || strings.HasPrefix(path, "/repo/")
}

// Resolve answers a ref; HEAD in a worktree is the worktree's own head.
func (g *FakeGit) Resolve(ctx context.Context, repo string, ref string) (string, error) {
	g.record("resolve", repo, ref)
	if ref == "HEAD" && !fakeRepoPath(repo) {
		return g.WorktreeHead, nil
	}
	if ref == "missing" {
		return "", &ports.GitError{Kind: ports.GitErrorBadRef, Ref: ref}
	}
	return BASE_SHA, nil
}

// CurrentBranch is the repository's branch.
func (g *FakeGit) CurrentBranch(ctx context.Context, repo string) (string, error) {
	g.record("currentBranch", repo)
	return "main", nil
}

// AddWorktree makes a worktree.
func (g *FakeGit) AddWorktree(ctx context.Context, repo, path, branch, baseSha string) error {
	g.record("addWorktree", repo, path, branch, baseSha)
	return gitError(g.AddWorktreeErr)
}

// RemoveWorktree removes a worktree.
func (g *FakeGit) RemoveWorktree(ctx context.Context, repo, path, branch string) error {
	g.record("removeWorktree", repo, path, branch)
	return gitError(g.RemoveWorktreeErr)
}

// Changes is the scripted change set.
func (g *FakeGit) Changes(ctx context.Context, dir, baseSha string) (domain.ChangeSet, error) {
	g.record("changes", dir, baseSha)
	return g.ChangeSet, nil
}

// StatusFingerprint answers the successive fingerprints, the last repeating.
func (g *FakeGit) StatusFingerprint(ctx context.Context, dir string) (string, error) {
	g.record("statusFingerprint", dir)
	next := "fp-0"
	if len(g.Fingerprints) > 1 {
		next, g.Fingerprints = g.Fingerprints[0], g.Fingerprints[1:]
	} else if len(g.Fingerprints) == 1 {
		next = g.Fingerprints[0]
	}
	return next, nil
}

// Diff is the scripted text or stat.
func (g *FakeGit) Diff(ctx context.Context, dir, baseSha string, opts ports.DiffOptions) (string, error) {
	g.record("diff", dir, baseSha, opts)
	if opts.Stat {
		return g.DiffStat, nil
	}
	return g.DiffText, nil
}

// CommitAll commits and moves the worktree head.
func (g *FakeGit) CommitAll(ctx context.Context, dir, message string, opts ports.CommitOptions) (string, error) {
	g.record("commitAll", dir, message, opts)
	if g.CommitErr == nil {
		g.WorktreeHead = g.CommitSha
	}
	return g.CommitSha, gitError(g.CommitErr)
}

// Trailer is the repository's trailer setting.
func (g *FakeGit) Trailer(ctx context.Context, repo string) (ports.TrailerSetting, error) {
	g.record("trailer", repo)
	return g.TrailerSetting, gitError(g.TrailerErr)
}

// IsAncestor is the scripted answer.
func (g *FakeGit) IsAncestor(ctx context.Context, repo, ancestor, descendant string) (bool, error) {
	g.record("isAncestor", repo, ancestor, descendant)
	return g.Ancestor, gitError(g.AncestorErr)
}

// RebaseJobBranch is the scripted answer.
func (g *FakeGit) RebaseJobBranch(ctx context.Context, worktree, onto string, regenerate []string) error {
	g.record("rebaseJobBranch", worktree, onto, regenerate)
	return gitError(g.RebaseErr)
}

// AmendAll amends and moves the worktree head.
func (g *FakeGit) AmendAll(ctx context.Context, dir string, opts ports.CommitOptions) (string, error) {
	g.record("amendAll", dir, opts)
	if g.AmendErr == nil {
		g.WorktreeHead = g.AmendSha
	}
	return g.AmendSha, gitError(g.AmendErr)
}

// AddDetachedWorktree is the scripted answer.
func (g *FakeGit) AddDetachedWorktree(ctx context.Context, repo, path, sha string) error {
	g.record("addDetachedWorktree", repo, path, sha)
	return gitError(g.AddDetachedErr)
}

// RemoveDetachedWorktree is the scripted answer.
func (g *FakeGit) RemoveDetachedWorktree(ctx context.Context, repo, path string) error {
	g.record("removeDetachedWorktree", repo, path)
	return gitError(g.RemoveDetachedErr)
}

// FastForward is the scripted answer.
func (g *FakeGit) FastForward(ctx context.Context, repo, sha, expectedTip string) (ports.FastForwardOutcome, error) {
	g.record("fastForward", repo, sha, expectedTip)
	return g.Landing, gitError(g.LandingErr)
}

// ApplyToWorkingTree is the scripted answer.
func (g *FakeGit) ApplyToWorkingTree(ctx context.Context, repo, worktree, baseSha string) error {
	g.record("applyToWorkingTree", repo, worktree, baseSha)
	return gitError(g.ApplyErr)
}

// ── gates, limiter, semaphore ───────────────────────────────────────────────────────────────

// GateCall is one gate run FakeGates recorded.
type GateCall struct {
	Cwd     string
	Run     string
	PassEnv map[string]string
	LogPath string
}

// GateAnswer is the part of a gate result a test scripts; an unset field takes AGateResult's
// defaults.
type GateAnswer struct {
	ExitCode   *int64
	TimedOut   bool
	DurationMs int64
	Tail       string
}

// FakeGates runs gates from a scripted queue; unlisted commands pass.
type FakeGates struct {
	// Calls is every recorded gate run, in order.
	Calls []GateCall
	// Results is each command's successive answers; the last repeats.
	Results map[string][]GateAnswer
}

var _ ports.GateRunner = (*FakeGates)(nil)

// NewFakeGates passes every gate.
func NewFakeGates() *FakeGates {
	return &FakeGates{Results: map[string][]GateAnswer{}}
}

// FailOnce makes run fail once with tail (default "1 failing test"), then pass again.
func (g *FakeGates) FailOnce(run string, tail ...string) {
	theTail := "1 failing test"
	if len(tail) > 0 {
		theTail = tail[0]
	}
	failed, passed := int64(1), int64(0)
	g.Results[run] = []GateAnswer{{ExitCode: &failed, Tail: theTail}, {ExitCode: &passed}}
}

// Run answers from the queue: the first queued answer shifts off, the last repeats.
func (g *FakeGates) Run(ctx context.Context, cwd string, gate domain.Gate, passEnv map[string]string, logPath string) domain.GateResult {
	g.Calls = append(g.Calls, GateCall{Cwd: cwd, Run: gate.Run, PassEnv: passEnv, LogPath: logPath})
	queue := g.Results[gate.Run]
	answer := GateAnswer{}
	if len(queue) > 1 {
		answer, g.Results[gate.Run] = queue[0], queue[1:]
	} else if len(queue) == 1 {
		answer = queue[0]
	}
	durationMs := int64(10)
	if answer.DurationMs != 0 {
		durationMs = answer.DurationMs
	}
	return testkit.AGateResult(func(result *domain.GateResult) {
		result.Run = gate.Run
		result.DurationMs = durationMs
		if answer.ExitCode != nil {
			result.ExitCode = answer.ExitCode
		}
		result.TimedOut = answer.TimedOut
		if answer.Tail != "" {
			result.Tail = answer.Tail
		}
	})
}

// FakeLimiter is the in-memory limiter store.
type FakeLimiter struct {
	Cap int
	Max int
	// SavedMax is the last saved ceiling, nil before one.
	SavedMax *int

	mu            sync.Mutex
	rateLimitedAt []int64
	endedAttempts []int64
}

var _ ports.LimiterStore = (*FakeLimiter)(nil)

// NewFakeLimiter answers the defaults: cap 4, the config's default ceiling.
func NewFakeLimiter() *FakeLimiter {
	return &FakeLimiter{Cap: 4, Max: domain.DEFAULT_LIMITER.DefaultMax}
}

// Capacity is the current cap.
func (f *FakeLimiter) Capacity(ctx context.Context, now int64) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Cap
}

// Limit is the cap and the ceiling.
func (f *FakeLimiter) Limit(ctx context.Context, now int64) ports.LimiterLevels {
	f.mu.Lock()
	defer f.mu.Unlock()
	return ports.LimiterLevels{Cap: f.Cap, Max: f.Max}
}

// RateLimited records a notice.
func (f *FakeLimiter) RateLimited(ctx context.Context, now int64, options ports.RateLimitOptions) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rateLimitedAt = append(f.rateLimitedAt, now)
	if options.EndedAttempt {
		f.endedAttempts = append(f.endedAttempts, now)
	}
	return nil
}

// SaveMax persists the ceiling, clamping the cap down to it but never up.
func (f *FakeLimiter) SaveMax(ctx context.Context, max int, now int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.SavedMax = &max
	f.Max = max
	f.Cap = min(f.Cap, max)
	return nil
}

// RateLimitedAt is every notice's timestamp, in order.
func (f *FakeLimiter) RateLimitedAt() []int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.rateLimitedAt)
}

// EndedAttempts is the notices that reported a rate limit ending the attempt (a terminal 429).
func (f *FakeLimiter) EndedAttempts() []int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.endedAttempts)
}

// FakeSemaphore is the scripted slot queue.
type FakeSemaphore struct {
	mu       sync.Mutex
	blocked  bool
	waiting  int
	acquired []string
	released []string
	holders  []ports.SemaphoreHolder
}

var _ ports.Semaphore = (*FakeSemaphore)(nil)

// NewFakeSemaphore admits everyone.
func NewFakeSemaphore() *FakeSemaphore {
	return &FakeSemaphore{}
}

// Acquire enqueues the holder, waiting while blocked until its context is cancelled (an acquire
// that gives up holds nothing).
func (s *FakeSemaphore) Acquire(ctx context.Context, holder ports.SemaphoreHolder) (func(), error) {
	s.mu.Lock()
	blocked := s.blocked
	if blocked {
		s.waiting++
	}
	s.mu.Unlock()
	if blocked {
		<-ctx.Done()
		s.mu.Lock()
		s.waiting--
		s.mu.Unlock()
		return nil, ctx.Err()
	}
	s.mu.Lock()
	s.holders = append(s.holders, holder)
	s.acquired = append(s.acquired, holder.JobID)
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.released = append(s.released, holder.JobID)
	}, nil
}

// Held is always empty.
func (s *FakeSemaphore) Held(ctx context.Context) []ports.HeldSlot {
	return nil
}

// SetBlocked makes acquires wait until their context is cancelled.
func (s *FakeSemaphore) SetBlocked(blocked bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.blocked = blocked
}

// Waiting is how many acquires are waiting on the block right now.
func (s *FakeSemaphore) Waiting() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.waiting
}

// Acquired is the job ids acquire was called for, in call order.
func (s *FakeSemaphore) Acquired() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.acquired)
}

// Released is the job ids release ran for, in call order.
func (s *FakeSemaphore) Released() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.released)
}

// Holders is every holder acquire was called with, priority included, in call order.
func (s *FakeSemaphore) Holders() []ports.SemaphoreHolder {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.holders)
}

// ── small things ────────────────────────────────────────────────────────────────────────────

// T0 is where ManualClock starts: 2026-10-06T00:00:00.000Z, the shared test moment.
var T0 = time.Date(2026, time.October, 6, 0, 0, 0, 0, time.UTC).UnixMilli()

// ManualClock moves time only when someone sleeps (or a test advances it); a sleep still yields to
// real timers for a moment.
type ManualClock struct {
	mu      sync.Mutex
	current int64
}

var _ ports.Clock = (*ManualClock)(nil)

// NewManualClock starts at T0.
func NewManualClock() *ManualClock {
	return &ManualClock{current: T0}
}

// Now is the current epoch ms.
func (c *ManualClock) Now() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.current
}

// Iso is the current moment as UTC ISO.
func (c *ManualClock) Iso() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.UnixMilli(c.current).UTC().Format("2006-01-02T15:04:05.000Z")
}

// Advance moves the clock.
func (c *ManualClock) Advance(ms int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.current += ms
}

// Sleep waits a real moment (so real timers fire), then moves the clock; a cancelled context
// errors without moving it.
func (c *ManualClock) Sleep(ctx context.Context, ms int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	time.Sleep(time.Millisecond)
	c.Advance(ms)
	return ctx.Err()
}

// FakeIds counts out the shared test ids.
type FakeIds struct {
	mu       sync.Mutex
	jobs     int
	sessions int
}

var _ ports.Ids = (*FakeIds)(nil)

// NewFakeIds starts both sequences at one.
func NewFakeIds() *FakeIds {
	return &FakeIds{}
}

// JobID is the next job id, counting from 261006-job001.
func (i *FakeIds) JobID() string {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.jobs++
	return fmt.Sprintf("261006-job00%d", i.jobs)
}

// SessionID is the next session id, a padded counter in the shared shape.
func (i *FakeIds) SessionID() string {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.sessions++
	return fmt.Sprintf("00000000-0000-4000-8000-%012d", i.sessions)
}

// FakeProcess is the scripted process control.
type FakeProcess struct {
	mu          sync.Mutex
	alive       map[int64]bool
	terminated  []int64
	spawned     []string
	onTerminate map[int64]func()
	onSpawn     func(jobID string)
}

var _ ports.ProcessControl = (*FakeProcess)(nil)

// NewFakeProcess starts with the test process itself alive.
func NewFakeProcess() *FakeProcess {
	alive := map[int64]bool{int64(os.Getpid()): true}
	return &FakeProcess{alive: alive, onTerminate: map[int64]func(){}}
}

// IsAlive says whether a pid is in the alive set.
func (p *FakeProcess) IsAlive(pid int64) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.alive[pid]
}

// TerminateGroup records the pid and fires its onTerminate callback.
func (p *FakeProcess) TerminateGroup(ctx context.Context, pid int64, graceMs int64) error {
	p.mu.Lock()
	p.terminated = append(p.terminated, pid)
	delete(p.alive, pid)
	callback := p.onTerminate[pid]
	p.mu.Unlock()
	if callback != nil {
		callback()
	}
	return nil
}

// SpawnDriver records the spawn and returns a sequential pid from 70001.
func (p *FakeProcess) SpawnDriver(jobID string) int64 {
	p.mu.Lock()
	p.spawned = append(p.spawned, jobID)
	count := len(p.spawned)
	onSpawn := p.onSpawn
	p.mu.Unlock()
	if onSpawn != nil {
		onSpawn(jobID)
	}
	return 70_000 + int64(count)
}

// Terminated is the terminated pids, in order.
func (p *FakeProcess) Terminated() []int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.terminated)
}

// Spawned is the spawned job ids, in order.
func (p *FakeProcess) Spawned() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return slices.Clone(p.spawned)
}

// SetOnSpawn runs the callback on every spawn; it stands in for the detached driver a spawn would
// start.
func (p *FakeProcess) SetOnSpawn(onSpawn func(jobID string)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.onSpawn = onSpawn
}

// SetAlive adds a pid to the alive set, or removes it, as a test simulating a spawned driver's
// life does.
func (p *FakeProcess) SetAlive(pid int64, alive bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if alive {
		p.alive[pid] = true
	} else {
		delete(p.alive, pid)
	}
}

func (p *FakeProcess) markAlive(pid int64) { p.SetAlive(pid, true) }

func (p *FakeProcess) markDead(pid int64) { p.SetAlive(pid, false) }

func (p *FakeProcess) setOnTerminate(pid int64, callback func()) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.onTerminate[pid] = callback
}

// RecordingOutput keeps every line and error a command wrote. A multi-follow prints from several
// goroutines as its jobs land, so the record carries its own lock.
type RecordingOutput struct {
	mu     sync.Mutex
	Lines  []string
	Errors []string
}

var _ ports.Output = (*RecordingOutput)(nil)

// Line records an output line.
func (o *RecordingOutput) Line(text string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.Lines = append(o.Lines, text)
}

// Error records an error line.
func (o *RecordingOutput) Error(text string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.Errors = append(o.Errors, text)
}

// Text is every line joined by \n.
func (o *RecordingOutput) Text() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return strings.Join(o.Lines, "\n")
}
