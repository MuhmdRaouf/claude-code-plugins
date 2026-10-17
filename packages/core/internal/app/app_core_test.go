package app

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// Local stand-ins for the ports (internal/testkit/fakes lands in a later card): only the methods
// this package calls do anything; the rest panic through the embedded nil interface if reached.

// ── fakes ────────────────────────────────────────────────────────────────────────────────────

type fakeClock struct {
	mu       sync.Mutex
	sleepers []chan struct{}
}

func (c *fakeClock) Now() int64  { return 0 }
func (c *fakeClock) Iso() string { return "2026-10-13T00:00:00.000Z" }
func (c *fakeClock) Sleep(ctx context.Context, ms int64) error {
	wake := make(chan struct{})
	c.mu.Lock()
	c.sleepers = append(c.sleepers, wake)
	c.mu.Unlock()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-wake:
		return nil
	}
}

// wakeAll ends every pending sleep; the poll loop then takes one more turn.
func (c *fakeClock) wakeAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, wake := range c.sleepers {
		close(wake)
	}
	c.sleepers = nil
}

type fakeJobFiles struct {
	ports.JobFiles
	mu         sync.Mutex
	enginePids map[string]int64
	driverPids map[string]int64
	stopped    map[string]bool
	texts      map[string]string
	readErrs   map[string]error
}

func newFakeJobFiles() *fakeJobFiles {
	return &fakeJobFiles{
		enginePids: map[string]int64{},
		driverPids: map[string]int64{},
		stopped:    map[string]bool{},
		texts:      map[string]string{},
		readErrs:   map[string]error{},
	}
}

func (f *fakeJobFiles) EnginePid(paths domain.JobPaths) (int64, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	pid, ok := f.enginePids[paths.Dir]
	return pid, ok
}

func (f *fakeJobFiles) ClearEnginePid(paths domain.JobPaths) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.enginePids, paths.Dir)
}

func (f *fakeJobFiles) DriverPid(_ context.Context, paths domain.JobPaths) (int64, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	pid, ok := f.driverPids[paths.Dir]
	return pid, ok
}

func (f *fakeJobFiles) StopRequested(_ context.Context, paths domain.JobPaths) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stopped[paths.Dir]
}

func (f *fakeJobFiles) ReadText(_ context.Context, path string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err, failed := f.readErrs[path]; failed {
		return "", err
	}
	return f.texts[path], nil
}

func (f *fakeJobFiles) requestStop(paths domain.JobPaths) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stopped[paths.Dir] = true
}

type fakeStore struct {
	ports.JobStore
	root      string
	jobs      map[string]domain.Job
	writes    []domain.Job
	getErr    error
	updateErr error
}

func (s *fakeStore) put(job domain.Job) domain.Job {
	s.jobs[job.ID] = job
	return job
}

func (s *fakeStore) Create(_ context.Context, job domain.Job) (domain.Job, error) {
	stored := job
	stored.Version = job.Version + 1
	s.jobs[job.ID] = stored
	return stored, nil
}

func (s *fakeStore) Get(_ context.Context, id string) (domain.Job, error) {
	if s.getErr != nil {
		return domain.Job{}, s.getErr
	}
	job, ok := s.jobs[id]
	if !ok {
		return domain.Job{}, &ports.StoreError{Kind: ports.StoreErrorNotFound, ID: id}
	}
	return job, nil
}

func (s *fakeStore) Find(ctx context.Context, idOrPrefix string) (domain.Job, error) {
	return s.Get(ctx, idOrPrefix)
}

func (s *fakeStore) Update(_ context.Context, job domain.Job) (domain.Job, error) {
	if s.updateErr != nil {
		failure := s.updateErr
		s.updateErr = nil
		return domain.Job{}, failure
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
	stored := job
	stored.Version = job.Version + 1
	s.jobs[job.ID] = stored
	s.writes = append(s.writes, stored)
	return stored, nil
}

func (s *fakeStore) List(context.Context, ports.ListFilter) []domain.Job { return nil }

func (s *fakeStore) Paths(id string) domain.JobPaths {
	return domain.NewStateLayout(s.root).Job(id)
}

func (s *fakeStore) Lock(context.Context, string, int64) (func(), error) {
	return func() {}, nil
}

type fakeProcessControl struct {
	alive      map[int64]bool
	terminated []int64
	graces     []int64
}

func (p *fakeProcessControl) IsAlive(pid int64) bool { return p.alive[pid] }

func (p *fakeProcessControl) TerminateGroup(_ context.Context, pid, graceMs int64) error {
	p.terminated = append(p.terminated, pid)
	p.graces = append(p.graces, graceMs)
	return nil
}

func (p *fakeProcessControl) SpawnDriver(string) int64 { return 0 }

type fakeEngineConfigStore struct{ config domain.EngineConfig }

func (s *fakeEngineConfigStore) Read() domain.EngineConfig        { return s.config }
func (s *fakeEngineConfigStore) Write(config domain.EngineConfig) { s.config = config }

type fakeIds struct{}

func (i *fakeIds) JobID() string     { return "job-new" }
func (i *fakeIds) SessionID() string { return "session-1" }

type fakeOutput struct {
	lines   []string
	errText []string
}

func (o *fakeOutput) Line(text string)  { o.lines = append(o.lines, text) }
func (o *fakeOutput) Error(text string) { o.errText = append(o.errText, text) }

type fakeRun struct {
	events chan domain.WorkerEvent
	exit   ports.WorkerExit
}

func (r fakeRun) Events() <-chan domain.WorkerEvent                      { return r.events }
func (r fakeRun) Wait() ports.WorkerExit                                 { return r.exit }
func (r fakeRun) Interrupt(context.Context, ports.InterruptReason) error { return nil }

type fakeWorker struct {
	caps     ports.WorkerCapabilities
	specs    []ports.WorkerSpec
	startErr error
	events   []domain.WorkerEvent
	exit     ports.WorkerExit
}

func (w *fakeWorker) Caps() ports.WorkerCapabilities  { return w.caps }
func (w *fakeWorker) Preflight(context.Context) error { return nil }

func (w *fakeWorker) Start(_ context.Context, spec ports.WorkerSpec) (ports.WorkerRun, error) {
	w.specs = append(w.specs, spec)
	if w.startErr != nil {
		return nil, w.startErr
	}
	events := make(chan domain.WorkerEvent, len(w.events))
	for _, event := range w.events {
		events <- event
	}
	close(events)
	return fakeRun{events: events, exit: w.exit}, nil
}

func (w *fakeWorker) ParseLine(string) []domain.WorkerEvent { return nil }
func (w *fakeWorker) Dispose(context.Context) error         { return nil }

type appFakes struct {
	store   *fakeStore
	files   *fakeJobFiles
	process *fakeProcessControl
	engines *fakeEngineConfigStore
	worker  *fakeWorker
	clock   *fakeClock
	ids     *fakeIds
	out     *fakeOutput
	root    string
}

func newAppDeps(t *testing.T) (Deps, *appFakes) {
	t.Helper()
	root := t.TempDir()
	f := &appFakes{
		store:   &fakeStore{root: root, jobs: map[string]domain.Job{}},
		files:   newFakeJobFiles(),
		process: &fakeProcessControl{alive: map[int64]bool{}},
		engines: &fakeEngineConfigStore{},
		worker:  &fakeWorker{caps: testkit.ReferenceCaps},
		clock:   &fakeClock{},
		ids:     &fakeIds{},
		out:     &fakeOutput{},
		root:    root,
	}
	deps := Deps{
		Worker:       f.worker,
		Store:        f.store,
		Files:        f.files,
		EngineConfig: f.engines,
		Process:      f.process,
		Clock:        f.clock,
		Ids:          f.ids,
		Out:          f.out,
		Host:         HostInfo{StateRoot: root},
		Provider:     testkit.ReferenceProvider,
		Env:          map[string]string{},
		Config:       Config{StopGraceMs: 5000},
	}
	return deps, f
}

// withEngines wires one scripted engine worker for every tool.
func withEngines(deps Deps, worker ports.Worker) Deps {
	deps.Engines = &EngineWorkers{
		Worker: func(domain.EngineTool) ports.Worker { return worker },
		Bin:    func(tool domain.EngineTool) string { return "/opt/" + string(tool) + "/bin/" + string(tool) },
	}
	return deps
}

func strPtr[T any](value T) *T { return &value }

func briefWith(front string) string {
	return "---\ntitle: Rename foo\n" + front + "\n---\nRename `foo` to `bar`.\n"
}

const plainBrief = "---\ntitle: Rename foo\n---\nRename `foo` to `bar`.\n"

// enabledConfig is an engines.json with omp and pi on, opencode and zcode off, no default engine.
func enabledConfig() domain.EngineConfig {
	return domain.EngineConfig{Engines: map[domain.EngineTool]domain.EngineSetting{
		domain.EngineToolOmp: {Watcher: domain.WatcherProvider, Version: "omp/18.6.3", Path: "/opt/omp/bin/omp"},
		domain.EngineToolPi:  {Watcher: domain.WatcherSonnet, Version: "pi 1.0.4", Path: "/opt/pi/bin/pi"},
	}}
}

// ── errors ───────────────────────────────────────────────────────────────────────────────────

func TestDescribeWorkerError(t *testing.T) {
	tests := []struct {
		name string
		err  ports.WorkerError
		want string
	}{
		{"no_key stands as the message", ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "acme: no key in the store"}, "acme: no key in the store"},
		{"insecure_key_file names the file and its mode", ports.WorkerError{
			Kind: ports.WorkerErrorInsecureKeyFile, Label: "the acme key file", Path: "~/.config/acme/env", Mode: "100644",
		}, "the acme key file ~/.config/acme/env has mode 100644: run chmod 600 on it"},
		{"spawn_failed names the provider's worker", ports.WorkerError{
			Kind: ports.WorkerErrorSpawnFailed, Message: "no binary at /opt/acme",
		}, "cannot start acmebot: no binary at /opt/acme"},
		{"protocol names the provider's worker", ports.WorkerError{
			Kind: ports.WorkerErrorProtocol, Message: "bad handshake",
		}, "acmebot does not speak the expected protocol: bad handshake"},
		{"unsupported names the provider's worker", ports.WorkerError{
			Kind: ports.WorkerErrorUnsupported, Message: "budget caps",
		}, "acmebot cannot do this: budget caps"},
		{"an unknown kind still renders", ports.WorkerError{Kind: "bogus"}, "acmebot error: bogus"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := DescribeWorkerError(testkit.AcmeProvider, test.err); got != test.want {
				t.Errorf("DescribeWorkerError() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestDescribeGitError(t *testing.T) {
	tests := []struct {
		name string
		err  ports.GitError
		want string
	}{
		{"not_a_repo names the directory", ports.GitError{Kind: ports.GitErrorNotARepo, Path: "/tmp/nope"}, "not a git repository: /tmp/nope"},
		{"bad_ref names the ref", ports.GitError{Kind: ports.GitErrorBadRef, Ref: "deadbeef"}, "unknown git ref: deadbeef"},
		{"conflict lists the paths", ports.GitError{Kind: ports.GitErrorConflict, Paths: []string{"a.ts", "b.ts"}}, "conflict in a.ts, b.ts"},
		{"dirty lists the paths", ports.GitError{Kind: ports.GitErrorDirty, Paths: []string{"a.ts", "b.ts"}}, "uncommitted changes in the way: a.ts, b.ts"},
		{"git_failed quotes the command and stderr", ports.GitError{Kind: ports.GitErrorGitFailed, Command: "git rebase main", Stderr: "boom"}, "git rebase main: boom"},
		{"an unknown kind still renders", ports.GitError{Kind: "bogus"}, "git error: bogus"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := DescribeGitError(test.err); got != test.want {
				t.Errorf("DescribeGitError() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestStringResultMarshalsLikeTheTSResult(t *testing.T) {
	ok, err := json.Marshal(StringResult{OK: true, Value: "ready"})
	if err != nil {
		t.Fatal(err)
	}
	if string(ok) != `{"ok":true,"value":"ready"}` {
		t.Errorf("ok result = %s, want the ok arm", ok)
	}
	failed, err := json.Marshal(StringResult{Error: "no key"})
	if err != nil {
		t.Fatal(err)
	}
	if string(failed) != `{"ok":false,"error":"no key"}` {
		t.Errorf("error result = %s, want the error arm", failed)
	}
}

// ── report facts ─────────────────────────────────────────────────────────────────────────────

func TestReportFacts(t *testing.T) {
	tests := []struct {
		name   string
		report string
		want   Facts
	}{
		{"keeps the trimmed summary, open items and added tests",
			`{"summary":"  done  ","open_items":["a"],"tests_added":["t1","t2"]}`,
			Facts{Summary: strPtr("done"), OpenItems: []string{"a"}, TestsAdded: []string{"t1", "t2"}}},
		{"a summary that trims to nothing is dropped",
			`{"summary":"   "}`, Facts{OpenItems: []string{}, TestsAdded: []string{}}},
		{"a malformed summary is dropped",
			`{"summary":42}`, Facts{OpenItems: []string{}, TestsAdded: []string{}}},
		{"a malformed open_items is dropped, not fatal",
			`{"open_items":"nope"}`, Facts{OpenItems: []string{}, TestsAdded: []string{}}},
		{"a non-string entry drops the whole array",
			`{"open_items":["a",5]}`, Facts{OpenItems: []string{}, TestsAdded: []string{}}},
		{"a non-object report has no facts",
			`["a report"]`, Facts{OpenItems: []string{}, TestsAdded: []string{}}},
		{"null has no facts",
			`null`, Facts{OpenItems: []string{}, TestsAdded: []string{}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := ReportFacts(json.RawMessage(test.report))
			if !reflect.DeepEqual(got, test.want) {
				t.Errorf("ReportFacts(%s) = %+v, want %+v", test.report, got, test.want)
			}
		})
	}
}

func TestSweepItems(t *testing.T) {
	t.Run("keeps every well-formed item", func(t *testing.T) {
		items, ok := SweepItems(json.RawMessage(
			`{"items":[{"id":"a","status":"ok","detail":"fine"},{"id":"b","status":"fail","detail":"broken"},{"id":"c","status":"gap","detail":"missing"}]}`))
		if !ok {
			t.Fatal("SweepItems() ok = false, want true")
		}
		want := []SweepItem{
			{ID: "a", Status: SweepStatusOK, Detail: "fine"},
			{ID: "b", Status: SweepStatusFail, Detail: "broken"},
			{ID: "c", Status: SweepStatusGap, Detail: "missing"},
		}
		if !reflect.DeepEqual(items, want) {
			t.Errorf("SweepItems() = %+v, want %+v", items, want)
		}
	})
	t.Run("an empty items array is a sweep report", func(t *testing.T) {
		items, ok := SweepItems(json.RawMessage(`{"items":[]}`))
		if !ok || len(items) != 0 {
			t.Errorf("SweepItems() = (%v with %d items), want ok with none", ok, len(items))
		}
	})
	t.Run("an extra field is fine, as zod strips unknown keys", func(t *testing.T) {
		items, ok := SweepItems(json.RawMessage(`{"items":[{"id":"a","status":"ok","detail":"d","extra":1}]}`))
		if !ok || len(items) != 1 || items[0].ID != "a" {
			t.Errorf("SweepItems() = (%+v, %v), want the stripped item", items, ok)
		}
	})
	tests := []struct {
		name   string
		report string
	}{
		{"a report without items is not a sweep report", `{"summary":"done"}`},
		{"a malformed items field is not a sweep report", `{"items":"nope"}`},
		{"an unknown status is not a sweep report", `{"items":[{"id":"a","status":"weird","detail":"d"}]}`},
		{"a missing field is not a sweep report", `{"items":[{"id":"a","status":"ok"}]}`},
		{"a non-object report is not a sweep report", `["a report"]`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if items, ok := SweepItems(json.RawMessage(test.report)); ok {
				t.Errorf("SweepItems(%s) = (%+v, true), want (_, false)", test.report, items)
			}
		})
	}
}

// ── submit overrides ─────────────────────────────────────────────────────────────────────────

func TestWithOverrides(t *testing.T) {
	provider := testkit.ReferenceProvider // tier names: main "glm", flash "flash"
	tests := []struct {
		name      string
		text      string
		overrides BriefOverrides
		want      string
	}{
		{"writes the provider's tier name for the model",
			"---\ntitle: T\n---\nB\n",
			BriefOverrides{Model: strPtr(domain.ModelTierFlash)},
			"---\ntitle: T\nmodel: flash\n---\nB\n"},
		{"replaces a field where it stood",
			"---\nmode: edit\ntitle: T\n---\nB\n",
			BriefOverrides{Mode: strPtr(domain.ModeExec)},
			"---\nmode: exec\ntitle: T\n---\nB\n"},
		{"appends model, mode and engine in that order",
			"---\ntitle: T\n---\nB\n",
			BriefOverrides{Model: strPtr(domain.ModelTierMain), Mode: strPtr(domain.ModeReadonly), Engine: strPtr(domain.EnginePi)},
			"---\ntitle: T\nmodel: glm\nmode: readonly\nengine: pi\n---\nB\n"},
		{"no overrides change nothing",
			"---\ntitle: T\n---\nB\n", BriefOverrides{}, "---\ntitle: T\n---\nB\n"},
		{"no front matter changes nothing",
			"Just a body.\n", BriefOverrides{Mode: strPtr(domain.ModeExec)}, "Just a body.\n"},
		{"front matter that does not parse changes nothing",
			"---\nfoo: [unclosed\n---\nB\n",
			BriefOverrides{Mode: strPtr(domain.ModeExec)},
			"---\nfoo: [unclosed\n---\nB\n"},
		{"front matter that is not a map changes nothing",
			"---\n- a\n- b\n---\nB\n",
			BriefOverrides{Mode: strPtr(domain.ModeExec)},
			"---\n- a\n- b\n---\nB\n"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := WithOverrides(test.text, test.overrides, provider); got != test.want {
				t.Errorf("WithOverrides() = %q, want %q", got, test.want)
			}
		})
	}
}

// ── report schema and contract ───────────────────────────────────────────────────────────────

func TestReportSchema(t *testing.T) {
	ctx := context.Background()
	files := newFakeJobFiles()

	t.Run("returns a built-in as draft-07", func(t *testing.T) {
		got, err := ReportSchema(ctx, files, domain.Report{Kind: domain.ReportKindBuiltin, Name: domain.BuiltinReportSweep})
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != string(domain.BuiltinJSONSchema(domain.BuiltinReportSweep)) {
			t.Errorf("ReportSchema(builtin) = %s, want the built-in schema", got)
		}
	})
	t.Run("accepts a schema file with no $schema or a draft-07 one", func(t *testing.T) {
		for _, schema := range []string{`{"type":"object"}`, `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}`} {
			files.texts["/schema/report.json"] = schema
			if _, err := ReportSchema(ctx, files, domain.Report{Kind: domain.ReportKindFile, Path: "/schema/report.json"}); err != nil {
				t.Errorf("ReportSchema(%s) failed: %v", schema, err)
			}
		}
	})
	t.Run("compacts a schema file to the bytes JSON.stringify would write", func(t *testing.T) {
		files.texts["/schema/report.json"] = "{\n  \"$schema\": \"http://json-schema.org/draft-07/schema#\",\n  \"type\": \"object\"\n}\n"
		got, err := ReportSchema(ctx, files, domain.Report{Kind: domain.ReportKindFile, Path: "/schema/report.json"})
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != `{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}` {
			t.Errorf("ReportSchema() = %s, want the compacted schema", got)
		}
	})
	t.Run("rejects a schema file declaring another draft, before any worker starts", func(t *testing.T) {
		files.texts["/schema/report.json"] = `{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object"}`
		_, err := ReportSchema(ctx, files, domain.Report{Kind: domain.ReportKindFile, Path: "/schema/report.json"})
		want := `/schema/report.json declares $schema "https://json-schema.org/draft/2020-12/schema"; ` +
			`a report schema must be draft-07 (http://json-schema.org/draft-07/schema#) or declare no $schema`
		if err == nil || err.Error() != want {
			t.Errorf("ReportSchema() error = %v, want %q", err, want)
		}
	})
	t.Run("a schema file that cannot be read says so", func(t *testing.T) {
		files.readErrs["/missing.json"] = errors.New("ENOENT: no such file")
		_, err := ReportSchema(ctx, files, domain.Report{Kind: domain.ReportKindFile, Path: "/missing.json"})
		if err == nil || err.Error() != "cannot read /missing.json: ENOENT: no such file" {
			t.Errorf("ReportSchema() error = %v, want the read failure", err)
		}
	})
	for name, text := range map[string]string{
		"a schema file holding an array": `["not","an","object"]`,
		"a schema file holding null":     `null`,
		"a schema file that is not JSON": `{oops`,
	} {
		t.Run(name+" is no schema", func(t *testing.T) {
			files.texts["/schema/report.json"] = text
			_, err := ReportSchema(ctx, files, domain.Report{Kind: domain.ReportKindFile, Path: "/schema/report.json"})
			if err == nil || err.Error() != "/schema/report.json must hold a JSON schema object" {
				t.Errorf("ReportSchema() error = %v, want the object rule", err)
			}
		})
	}
}

func TestReportContract(t *testing.T) {
	ctx := context.Background()
	files := newFakeJobFiles()

	t.Run("a schema file's contract is named by its path, carries the schema and checks only object-ness", func(t *testing.T) {
		files.texts["/schema/report.json"] = `{"type":"object","required":["answer"]}`
		contract, err := ReportContract(ctx, files, domain.Report{Kind: domain.ReportKindFile, Path: "/schema/report.json"})
		if err != nil {
			t.Fatal(err)
		}
		if contract.Name != "/schema/report.json" {
			t.Errorf("Name = %q, want the schema file's path", contract.Name)
		}
		if string(contract.JSONSchema) != `{"type":"object","required":["answer"]}` {
			t.Errorf("JSONSchema = %s, want the file's schema", contract.JSONSchema)
		}
		if got := contract.Validate(json.RawMessage(`{"anything":1}`)); !reflect.DeepEqual(got, domain.ReportCheck{Present: true, Valid: true, Problems: []string{}}) {
			t.Errorf("Validate(object) = %+v, want a valid present report", got)
		}
		if got := contract.Validate(json.RawMessage(`null`)); got.Present {
			t.Errorf("Validate(null) = %+v, want no report", got)
		}
	})
	t.Run("a schema the worker could not take is no contract", func(t *testing.T) {
		files.texts["/schema/report.json"] = `["not","an","object"]`
		_, err := ReportContract(ctx, files, domain.Report{Kind: domain.ReportKindFile, Path: "/schema/report.json"})
		if err == nil || err.Error() != "/schema/report.json must hold a JSON schema object" {
			t.Errorf("ReportContract() error = %v, want the object rule", err)
		}
	})
	t.Run("a builtin contract carries its name, its draft-07 schema and its check", func(t *testing.T) {
		contract := BuiltinContract(domain.BuiltinReportNotes)
		if contract.Name != "notes" {
			t.Errorf("Name = %q, want notes", contract.Name)
		}
		if string(contract.JSONSchema) != string(domain.BuiltinJSONSchema(domain.BuiltinReportNotes)) {
			t.Errorf("JSONSchema = %s, want the notes schema", contract.JSONSchema)
		}
		if got := contract.Validate(json.RawMessage(`{"summary":"pong","findings":[],"open_items":[]}`)); !got.Present || !got.Valid {
			t.Errorf("Validate(notes report) = %+v, want valid", got)
		}
		if got := contract.Validate(json.RawMessage(`{"summary":"pong"}`)); !got.Present || got.Valid {
			t.Errorf("Validate(partial notes report) = %+v, want invalid", got)
		}
	})
	t.Run("a builtin report asks for no file", func(t *testing.T) {
		contract, err := ReportContract(ctx, files, domain.Report{Kind: domain.ReportKindBuiltin, Name: domain.BuiltinReportSweep})
		if err != nil {
			t.Fatal(err)
		}
		if contract.Name != "sweep" || string(contract.JSONSchema) != string(domain.BuiltinJSONSchema(domain.BuiltinReportSweep)) {
			t.Errorf("contract = %q with %s, want the sweep builtin", contract.Name, contract.JSONSchema)
		}
	})
}

// ── engine selection ─────────────────────────────────────────────────────────────────────────

func TestResolveEngine(t *testing.T) {
	deps, f := newAppDeps(t)
	omp, claude := domain.EngineOmp, domain.EngineClaude
	f.engines.config = enabledConfig()

	t.Run("is --engine, then the brief's engine:, then the configured default, then claude", func(t *testing.T) {
		tests := []struct {
			name      string
			requested *domain.Engine
			brief     string
			want      domain.Engine
		}{
			{"nothing names an engine", nil, plainBrief, domain.EngineClaude},
			{"the brief names one", nil, briefWith("engine: pi"), domain.EnginePi},
			{"the run flag beats the brief", &omp, briefWith("engine: pi"), domain.EngineOmp},
			{"the run flag may name claude over the brief", &claude, briefWith("engine: pi"), domain.EngineClaude},
			{"the brief may name claude", nil, briefWith("engine: claude"), domain.EngineClaude},
		}
		for _, test := range tests {
			t.Run(test.name, func(t *testing.T) {
				got, err := ResolveEngine(deps, test.requested, test.brief)
				if err != nil {
					t.Fatal(err)
				}
				if got != test.want {
					t.Errorf("ResolveEngine() = %s, want %s", got, test.want)
				}
			})
		}
		t.Run("the configured default beats claude", func(t *testing.T) {
			f.engines.config = enabledConfig()
			f.engines.config.DefaultEngine = &omp
			got, err := ResolveEngine(deps, nil, plainBrief)
			if err != nil {
				t.Fatal(err)
			}
			if got != domain.EngineOmp {
				t.Errorf("ResolveEngine() = %s, want omp", got)
			}
		})
	})
	t.Run("an engine its setup command has not enabled is refused", func(t *testing.T) {
		opencode := domain.EngineOpencode
		_, err := ResolveEngine(deps, &opencode, plainBrief)
		var appErr *AppError
		if !errors.As(err, &appErr) {
			t.Fatalf("ResolveEngine() error = %v, want an AppError", err)
		}
		if appErr.Kind != AppErrorEngineNotEnabled || appErr.Engine != domain.EngineToolOpencode {
			t.Errorf("error = %+v, want engine_not_enabled for opencode", appErr)
		}
		if appErr.Error() != "engine_not_enabled" {
			t.Errorf("Error() = %q, want the kind", appErr.Error())
		}
	})
}

func TestJobEngine(t *testing.T) {
	t.Run("absent means claude", func(t *testing.T) {
		if got := JobEngine(testkit.AJob()); got != domain.EngineClaude {
			t.Errorf("JobEngine() = %s, want claude", got)
		}
	})
	t.Run("a stored engine stands", func(t *testing.T) {
		pi := domain.EngineToolPi
		job := testkit.AJob(func(j *domain.Job) { j.Brief.Engine = &pi })
		if got := JobEngine(job); got != domain.EnginePi {
			t.Errorf("JobEngine() = %s, want pi", got)
		}
	})
}

func TestWorkerOf(t *testing.T) {
	deps, _ := newAppDeps(t)
	engineWorker := &fakeWorker{}
	t.Run("claude's worker is the deps' own", func(t *testing.T) {
		if got := WorkerOf(deps, domain.EngineClaude); got != deps.Worker {
			t.Errorf("WorkerOf(claude) = %v, want the deps worker", got)
		}
	})
	t.Run("an engine's worker comes from the engines", func(t *testing.T) {
		wired := withEngines(deps, engineWorker)
		if got := WorkerOf(wired, domain.EngineOmp); got != ports.Worker(engineWorker) {
			t.Errorf("WorkerOf(omp) = %v, want the engine worker", got)
		}
	})
	t.Run("an engine this process wired none of has no worker", func(t *testing.T) {
		if got := WorkerOf(deps, domain.EngineOmp); got != nil {
			t.Errorf("WorkerOf(omp) = %v, want none", got)
		}
	})
}

func TestDepsForJob(t *testing.T) {
	omp := domain.EngineToolOmp
	onOmp := testkit.AJob(func(j *domain.Job) { j.Brief.Engine = &omp })

	t.Run("an engine this process cannot build fails the attempt visibly instead of running on claude", func(t *testing.T) {
		deps, _ := newAppDeps(t)
		wired := DepsForJob(deps, onOmp)

		if got := wired.Worker.Caps(); !reflect.DeepEqual(got, testkit.ReferenceCaps) {
			t.Errorf("Caps() = %+v, want the claude worker's", got)
		}
		refusal := &ports.WorkerError{Kind: ports.WorkerErrorUnsupported, Message: "the omp engine is not available here"}
		_, startErr := wired.Worker.Start(context.Background(), ports.WorkerSpec{})
		if !reflect.DeepEqual(startErr, refusal) {
			t.Errorf("Start() error = %v, want %v", startErr, refusal)
		}
		if preflightErr := wired.Worker.Preflight(context.Background()); !reflect.DeepEqual(preflightErr, refusal) {
			t.Errorf("Preflight() error = %v, want %v", preflightErr, refusal)
		}
		if events := wired.Worker.ParseLine("{}"); len(events) != 0 {
			t.Errorf("ParseLine() = %+v, want none", events)
		}
		if err := wired.Worker.Dispose(context.Background()); err != nil {
			t.Errorf("Dispose() error = %v", err)
		}
	})
	t.Run("the job's engine worker runs it when wired", func(t *testing.T) {
		deps, _ := newAppDeps(t)
		engineWorker := &fakeWorker{}
		wired := DepsForJob(withEngines(deps, engineWorker), onOmp)
		if wired.Worker != ports.Worker(engineWorker) {
			t.Errorf("Worker = %v, want the engine worker", wired.Worker)
		}
	})
	t.Run("a claude job keeps the deps as they are", func(t *testing.T) {
		deps, _ := newAppDeps(t)
		if wired := DepsForJob(deps, testkit.AJob()); wired.Worker != ports.Worker(deps.Worker) {
			t.Errorf("Worker = %v, want the deps worker", wired.Worker)
		}
	})
}

func TestBriefEngine(t *testing.T) {
	tests := []struct {
		name string
		text string
		want *domain.Engine
	}{
		{"reads the engine the brief names", briefWith("engine: pi"), strPtr(domain.EnginePi)},
		{"a brief without an engine names none", plainBrief, nil},
		{"no front matter names none", "Just a body.\n", nil},
		{"an unknown engine names none", briefWith("engine: cursor"), nil},
		{"a non-string engine names none", briefWith("engine: 42"), nil},
		{"front matter that is not a map names none", "---\n- a\n---\nB\n", nil},
		{"front matter that does not parse names none", "---\nfoo: [unclosed\n---\nB\n", nil},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := BriefEngine(test.text)
			if !reflect.DeepEqual(got, test.want) {
				t.Errorf("BriefEngine() = %v, want %v", got, test.want)
			}
		})
	}
}

// ── engine reaping ───────────────────────────────────────────────────────────────────────────

func TestReapEngines(t *testing.T) {
	t.Run("cleanup terminates the engine group of a job whose driver is dead, and forgets it", func(t *testing.T) {
		deps, f := newAppDeps(t)
		paths := f.store.Paths("j1")
		f.files.enginePids[paths.Dir] = 61234
		f.process.alive[61234] = true
		f.files.driverPids[paths.Dir] = 99999001

		ReapOrphanEngines(context.Background(), deps, []domain.Job{testkit.AJob()})

		if len(f.process.terminated) != 1 || f.process.terminated[0] != 61234 {
			t.Errorf("terminated = %v, want [61234]", f.process.terminated)
		}
		if len(f.process.graces) != 1 || f.process.graces[0] != deps.Config.StopGraceMs {
			t.Errorf("graces = %v, want the configured stop grace", f.process.graces)
		}
		if _, still := f.files.EnginePid(paths); still {
			t.Error("the engine pid was not forgotten")
		}
		ReapEngine(context.Background(), deps, "j1")
		if len(f.process.terminated) != 1 {
			t.Errorf("terminated = %v, want no second termination", f.process.terminated)
		}
	})
	t.Run("cleanup leaves the engine of a live driver alone", func(t *testing.T) {
		deps, f := newAppDeps(t)
		paths := f.store.Paths("j1")
		f.files.enginePids[paths.Dir] = 61235
		f.process.alive[61235] = true
		f.files.driverPids[paths.Dir] = 4242
		f.process.alive[4242] = true

		ReapOrphanEngines(context.Background(), deps, []domain.Job{testkit.AJob()})

		if len(f.process.terminated) != 0 {
			t.Errorf("terminated = %v, want none", f.process.terminated)
		}
	})
	t.Run("a job with no engine pid is skipped", func(t *testing.T) {
		deps, f := newAppDeps(t)
		ReapEngine(context.Background(), deps, "j1")
		ReapOrphanEngines(context.Background(), deps, []domain.Job{testkit.AJob()})
		if len(f.process.terminated) != 0 {
			t.Errorf("terminated = %v, want none", f.process.terminated)
		}
	})
	t.Run("a dead engine group is forgotten without a termination attempt", func(t *testing.T) {
		deps, f := newAppDeps(t)
		paths := f.store.Paths("j1")
		f.files.enginePids[paths.Dir] = 61236 // not alive

		ReapEngine(context.Background(), deps, "j1")

		if len(f.process.terminated) != 0 {
			t.Errorf("terminated = %v, want none", f.process.terminated)
		}
		if _, still := f.files.EnginePid(paths); still {
			t.Error("the engine pid was not forgotten")
		}
	})
}

// ── persist ──────────────────────────────────────────────────────────────────────────────────

func TestMove(t *testing.T) {
	t.Run("applies an event", func(t *testing.T) {
		job := testkit.AJob()
		moved, err := Move(job, domain.JobEvent{Type: domain.EventSlotAcquired})
		if err != nil {
			t.Fatal(err)
		}
		if moved.State != domain.JobStateRunning {
			t.Errorf("State = %s, want running", moved.State)
		}
		if moved.ID != job.ID || moved.UpdatedAt != job.UpdatedAt {
			t.Error("Move changed fields other than the state")
		}
	})
	t.Run("an illegal transition is a lifecycle error", func(t *testing.T) {
		job := testkit.AJob(func(j *domain.Job) { j.State = domain.JobStateAccepted })
		_, err := Move(job, domain.JobEvent{Type: domain.EventSlotAcquired})
		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorLifecycle {
			t.Fatalf("Move() error = %v, want a lifecycle AppError", err)
		}
		want := domain.LifecycleError{Kind: domain.IllegalTransition, From: domain.JobStateAccepted, Event: domain.EventSlotAcquired}
		if appErr.LifecycleError != want {
			t.Errorf("LifecycleError = %+v, want %+v", appErr.LifecycleError, want)
		}
	})
}

func TestPersist(t *testing.T) {
	acquireSlot := func(job domain.Job) (domain.Job, error) {
		return Move(job, domain.JobEvent{Type: domain.EventSlotAcquired})
	}
	t.Run("moves the job and stamps updatedAt", func(t *testing.T) {
		deps, f := newAppDeps(t)
		f.store.put(testkit.AJob())

		stored, err := Persist(context.Background(), deps, testkit.AJob(), acquireSlot)
		if err != nil {
			t.Fatal(err)
		}
		if stored.State != domain.JobStateRunning {
			t.Errorf("State = %s, want running", stored.State)
		}
		if stored.UpdatedAt != deps.Clock.Iso() {
			t.Errorf("UpdatedAt = %q, want the clock's iso time", stored.UpdatedAt)
		}
		if stored.Version != 1 {
			t.Errorf("Version = %d, want 1", stored.Version)
		}
	})
	t.Run("re-applies the step once after a version conflict, on the stored job", func(t *testing.T) {
		deps, f := newAppDeps(t)
		f.store.put(testkit.AJob(func(j *domain.Job) { j.Version = 2 }))

		stored, err := Persist(context.Background(), deps, testkit.AJob(), acquireSlot)
		if err != nil {
			t.Fatal(err)
		}
		if stored.State != domain.JobStateRunning || stored.Version != 3 {
			t.Errorf("stored = (%s, v%d), want (running, v3)", stored.State, stored.Version)
		}
	})
	t.Run("refuses when someone else moved the job on", func(t *testing.T) {
		deps, f := newAppDeps(t)
		f.store.put(testkit.AJob(func(j *domain.Job) {
			j.Version = 2
			j.State = domain.JobStateDiscarded
		}))

		_, err := Persist(context.Background(), deps, testkit.AJob(), acquireSlot)
		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorWrongState {
			t.Fatalf("Persist() error = %v, want a wrong_state AppError", err)
		}
		if appErr.ID != "j1" || appErr.State != domain.JobStateDiscarded {
			t.Errorf("error = %+v, want j1 discarded", appErr)
		}
		if !reflect.DeepEqual(appErr.Allowed, []domain.JobState{domain.JobStateQueued}) {
			t.Errorf("Allowed = %v, want [queued]", appErr.Allowed)
		}
	})
	t.Run("a failed re-read after a conflict is a store error", func(t *testing.T) {
		deps, f := newAppDeps(t)
		f.store.put(testkit.AJob(func(j *domain.Job) { j.Version = 2 }))
		f.store.getErr = &ports.StoreError{Kind: ports.StoreErrorIO, Message: "disk full"}

		_, err := Persist(context.Background(), deps, testkit.AJob(), acquireSlot)
		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorStore {
			t.Fatalf("Persist() error = %v, want a store AppError", err)
		}
		if appErr.StoreError == nil || appErr.StoreError.Kind != ports.StoreErrorIO {
			t.Errorf("StoreError = %+v, want the io failure", appErr.StoreError)
		}
	})
	t.Run("a failing step is returned as is and nothing is written", func(t *testing.T) {
		deps, f := newAppDeps(t)
		f.store.put(testkit.AJob())
		dead := testkit.AJob(func(j *domain.Job) { j.State = domain.JobStateAccepted })

		if _, err := Persist(context.Background(), deps, dead, acquireSlot); err == nil {
			t.Fatal("Persist() = nil error, want the lifecycle failure")
		}
		if len(f.store.writes) != 0 {
			t.Errorf("writes = %d, want none", len(f.store.writes))
		}
	})
	t.Run("an update failure the store did not explain is still a store error", func(t *testing.T) {
		deps, f := newAppDeps(t)
		f.store.put(testkit.AJob())
		f.store.updateErr = errors.New("the state root vanished")

		_, err := Persist(context.Background(), deps, testkit.AJob(), acquireSlot)
		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorStore || appErr.StoreError != nil {
			t.Fatalf("Persist() error = %v, want a store AppError with no store error", err)
		}
	})
}

// ── ping ─────────────────────────────────────────────────────────────────────────────────────

func TestPing(t *testing.T) {
	t.Run("runs one tiny notes-report request on the ping tier", func(t *testing.T) {
		deps, f := newAppDeps(t)
		report := json.RawMessage(`{"summary":"pong","findings":[],"open_items":[]}`)
		f.worker.events = []domain.WorkerEvent{
			{Kind: domain.WorkerEventInit, SessionID: "ping-session"},
			{Kind: domain.WorkerEventResult, Text: "done", StructuredOutput: report, Turns: 2,
				DurationMs: 1200, CostUSD: 0.01, Usage: domain.ResultUsage{InputTokens: 10, OutputTokens: 5}},
		}
		code := int64(0)
		f.worker.exit = ports.WorkerExit{Code: &code}

		result, err := Ping(context.Background(), deps)
		if err != nil {
			t.Fatal(err)
		}
		if result.Outcome.Kind != domain.WorkerOutcomeCompleted {
			t.Errorf("Outcome = %+v, want completed", result.Outcome)
		}
		if string(result.Report) != string(report) {
			t.Errorf("Report = %s, want the notes report", result.Report)
		}
		if result.SessionID == nil || *result.SessionID != "ping-session" {
			t.Errorf("SessionID = %v, want ping-session", result.SessionID)
		}
		if result.Usage.InputTokens != 10 || result.Usage.Turns != 2 || result.Usage.DurationMs != 1200 {
			t.Errorf("Usage = %+v, want the result event's numbers", result.Usage)
		}

		if len(f.worker.specs) != 1 {
			t.Fatalf("the worker started %d times, want once", len(f.worker.specs))
		}
		spec := f.worker.specs[0]
		provider := testkit.ReferenceProvider
		wantPrompt := `This is a connectivity check. Use no tools. End at once with a notes report whose summary is "pong", with no findings and no open items.`
		if spec.Prompt != wantPrompt {
			t.Errorf("Prompt = %q, want the connectivity check", spec.Prompt)
		}
		if spec.Cwd != f.root || spec.LogPath != f.root+"/setup-ping.jsonl" {
			t.Errorf("Cwd/LogPath = %q/%q, want the state root and its setup-ping log", spec.Cwd, spec.LogPath)
		}
		if spec.Model != provider.Catalog[provider.PingTier] {
			t.Errorf("Model = %+v, want the ping tier", spec.Model)
		}
		if spec.Access != ports.AccessReadonly {
			t.Errorf("Access = %s, want readonly", spec.Access)
		}
		if spec.Session != (ports.WorkerSession{Kind: ports.SessionKindNew, Key: "session-1"}) {
			t.Errorf("Session = %+v, want a new session under the ids key", spec.Session)
		}
		if spec.Report.Name != "notes" || string(spec.Report.JSONSchema) != string(domain.BuiltinJSONSchema(domain.BuiltinReportNotes)) {
			t.Errorf("Report = %q with %s, want the notes contract", spec.Report.Name, spec.Report.JSONSchema)
		}
		if spec.AddDirs == nil || len(spec.AddDirs) != 0 || spec.PassEnv == nil || len(spec.PassEnv) != 0 {
			t.Errorf("AddDirs/PassEnv = %v/%v, want empty but present", spec.AddDirs, spec.PassEnv)
		}
		if spec.TimeoutMs != 120_000 {
			t.Errorf("TimeoutMs = %d, want 120000", spec.TimeoutMs)
		}
	})
	t.Run("a worker that cannot start fails the ping", func(t *testing.T) {
		deps, f := newAppDeps(t)
		f.worker.startErr = &ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "zai: no key in the store"}

		_, err := Ping(context.Background(), deps)
		var workerErr *ports.WorkerError
		if !errors.As(err, &workerErr) || workerErr.Kind != ports.WorkerErrorNoKey {
			t.Fatalf("Ping() error = %v, want the no_key failure", err)
		}
		if workerErr.Message != "zai: no key in the store" {
			t.Errorf("Message = %q, want the worker's own", workerErr.Message)
		}
	})
}

// ── stop watch ───────────────────────────────────────────────────────────────────────────────

func awaitDone(t *testing.T, ctx context.Context) {
	t.Helper()
	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("the stop signal never fired")
	}
}

func awaitLive(t *testing.T, ctx context.Context) {
	t.Helper()
	select {
	case <-ctx.Done():
		t.Fatal("the stop signal fired")
	case <-time.After(50 * time.Millisecond):
	}
}

func TestWatchStop(t *testing.T) {
	t.Run("fires when the stop file appears", func(t *testing.T) {
		deps, f := newAppDeps(t)
		paths := deps.Store.Paths("j1")
		watch := WatchStop(context.Background(), deps, paths)
		defer watch.Close()

		awaitLive(t, watch.Ctx)
		f.files.requestStop(paths)
		f.clock.wakeAll()
		awaitDone(t, watch.Ctx)
	})
	t.Run("fires at once when the stop file is already there", func(t *testing.T) {
		deps, f := newAppDeps(t)
		paths := deps.Store.Paths("j1")
		f.files.requestStop(paths)

		watch := WatchStop(context.Background(), deps, paths)
		defer watch.Close()

		awaitDone(t, watch.Ctx)
	})
	t.Run("an aborted external context fires the signal", func(t *testing.T) {
		deps, _ := newAppDeps(t)
		external, cancel := context.WithCancel(context.Background())
		watch := WatchStop(external, deps, deps.Store.Paths("j1"))
		defer watch.Close()

		awaitLive(t, watch.Ctx)
		cancel()
		awaitDone(t, watch.Ctx)
	})
	t.Run("an already-aborted external context fires at once", func(t *testing.T) {
		deps, _ := newAppDeps(t)
		external, cancel := context.WithCancel(context.Background())
		cancel()

		watch := WatchStop(external, deps, deps.Store.Paths("j1"))
		defer watch.Close()

		awaitDone(t, watch.Ctx)
	})
	t.Run("close stops watching without firing", func(t *testing.T) {
		deps, _ := newAppDeps(t)
		watch := WatchStop(context.Background(), deps, deps.Store.Paths("j1"))

		watch.Close()
		deps.Clock.(*fakeClock).wakeAll()

		awaitLive(t, watch.Ctx)
	})
	t.Run("close detaches the external context", func(t *testing.T) {
		deps, _ := newAppDeps(t)
		external, cancel := context.WithCancel(context.Background())
		watch := WatchStop(external, deps, deps.Store.Paths("j1"))

		watch.Close()
		time.Sleep(20 * time.Millisecond) // let the watcher take the detached exit
		cancel()

		awaitLive(t, watch.Ctx)
	})
}
