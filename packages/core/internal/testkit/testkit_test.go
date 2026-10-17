package testkit

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/providers"
)

// Direct tests of the support files: builders return their defaults, MakeRepo makes a commit,
// FreePort returns a usable port, Until times out with an error.

func TestBuilders(t *testing.T) {
	t.Run("aBrief returns the defaults", func(t *testing.T) {
		brief := ABrief()
		if brief.Title != "Rename the helper" {
			t.Errorf("title = %q", brief.Title)
		}
		if brief.Body != "Rename `foo` to `bar` everywhere." {
			t.Errorf("body = %q", brief.Body)
		}
		if brief.Model != domain.ModelTierMain {
			t.Errorf("model = %q", brief.Model)
		}
		if brief.Effort != nil {
			t.Errorf("effort = %v", *brief.Effort)
		}
		if brief.Mode != domain.ModeEdit {
			t.Errorf("mode = %q", brief.Mode)
		}
		if brief.Priority != nil {
			t.Errorf("priority = %v", *brief.Priority)
		}
		if brief.Cwd != "/repo" || brief.Base != "HEAD" {
			t.Errorf("cwd/base = %q/%q", brief.Cwd, brief.Base)
		}
		if !slices.Equal(brief.Scope, []string{"**"}) {
			t.Errorf("scope = %v", brief.Scope)
		}
		if brief.Forbid == nil || len(brief.Forbid) != 0 {
			t.Errorf("forbid = %v", brief.Forbid)
		}
		if brief.Gates == nil || len(brief.Gates) != 0 {
			t.Errorf("gates = %v", brief.Gates)
		}
		if brief.TimeoutMs != 2*60*60*1000 {
			t.Errorf("timeoutMs = %d", brief.TimeoutMs)
		}
		if brief.Retries != (domain.Retries{Fix: 1, Infra: 2}) {
			t.Errorf("retries = %+v", brief.Retries)
		}
		if brief.Report.Kind != domain.ReportKindBuiltin || brief.Report.Name != domain.BuiltinReportChange {
			t.Errorf("report = %+v", brief.Report)
		}
		for name, list := range map[string][]string{"addDirs": brief.AddDirs, "env": brief.Env, "tags": brief.Tags} {
			if list == nil || len(list) != 0 {
				t.Errorf("%s = %v", name, list)
			}
		}
		if brief.BudgetUSD != nil || brief.Engine != nil || brief.Setup != nil || brief.Regenerate != nil {
			t.Errorf("optional fields not nil: %+v", brief)
		}
	})

	t.Run("aBrief applies shallow overrides", func(t *testing.T) {
		brief := ABrief(func(b *domain.Brief) {
			b.Title = "Sweep the docs"
			b.Mode = domain.ModeReadonly
			b.Scope = []string{"docs/**"}
		})
		if brief.Title != "Sweep the docs" || brief.Mode != domain.ModeReadonly {
			t.Fatalf("overrides not applied: %+v", brief)
		}
		if !slices.Equal(brief.Scope, []string{"docs/**"}) {
			t.Errorf("scope = %v", brief.Scope)
		}
		if brief.Body != "Rename `foo` to `bar` everywhere." {
			t.Errorf("unrelated default lost: body = %q", brief.Body)
		}
	})

	t.Run("aChangeSet lists four empty buckets", func(t *testing.T) {
		changes := AChangeSet()
		for name, list := range map[string][]string{
			"added": changes.Added, "modified": changes.Modified,
			"deleted": changes.Deleted, "untracked": changes.Untracked,
		} {
			if list == nil || len(list) != 0 {
				t.Errorf("%s = %v", name, list)
			}
		}
	})

	t.Run("aGateResult defaults to a passing gate", func(t *testing.T) {
		gate := AGateResult()
		if gate.Run != "npm test" {
			t.Errorf("run = %q", gate.Run)
		}
		if gate.ExitCode == nil || *gate.ExitCode != 0 {
			t.Errorf("exitCode = %v", gate.ExitCode)
		}
		if gate.TimedOut || gate.DurationMs != 1000 || gate.Tail != "" {
			t.Errorf("gate = %+v", gate)
		}
	})

	t.Run("aScopeCheck and aReportCheck default clean", func(t *testing.T) {
		scope := AScopeCheck()
		if scope.OutOfScope == nil || scope.Forbidden == nil || scope.RepoChanged {
			t.Errorf("scope = %+v", scope)
		}
		report := AReportCheck()
		if !report.Present || !report.Valid || report.Problems == nil {
			t.Errorf("report = %+v", report)
		}
	})

	t.Run("aVerification composes the empty checks", func(t *testing.T) {
		verification := AVerification()
		if verification.Gates == nil || len(verification.Gates) != 0 {
			t.Errorf("gates = %v", verification.Gates)
		}
		if !reflect.DeepEqual(verification.Changes, AChangeSet()) {
			t.Errorf("changes = %+v", verification.Changes)
		}
		if !reflect.DeepEqual(verification.Scope, AScopeCheck()) {
			t.Errorf("scope = %+v", verification.Scope)
		}
		if !reflect.DeepEqual(verification.Report, AReportCheck()) {
			t.Errorf("report = %+v", verification.Report)
		}
	})

	t.Run("anAttempt defaults to attempt 1 initial", func(t *testing.T) {
		attempt := AnAttempt()
		if attempt.N != 1 || attempt.Kind != domain.AttemptKindInitial {
			t.Errorf("n/kind = %d/%q", attempt.N, attempt.Kind)
		}
		if attempt.Prompt != "Rename `foo` to `bar` everywhere." {
			t.Errorf("prompt = %q", attempt.Prompt)
		}
		if attempt.SessionID != "00000000-0000-4000-8000-000000000001" {
			t.Errorf("sessionId = %q", attempt.SessionID)
		}
		if attempt.StartedAt != "2026-10-06T00:00:00.000Z" {
			t.Errorf("startedAt = %q", attempt.StartedAt)
		}
	})

	t.Run("aJob defaults id j1 queued with an edit workspace", func(t *testing.T) {
		job := AJob()
		if job.ID != "j1" || job.State != domain.JobStateQueued {
			t.Errorf("id/state = %q/%q", job.ID, job.State)
		}
		workspace := job.Workspace
		if workspace.RepoRoot != "/repo" || workspace.BaseSha != "0000000000000000000000000000000000000000" {
			t.Errorf("repoRoot/baseSha = %q/%q", workspace.RepoRoot, workspace.BaseSha)
		}
		if workspace.Worktree == nil || *workspace.Worktree != "/state/worktrees/j1" {
			t.Errorf("worktree = %v", workspace.Worktree)
		}
		if workspace.Branch == nil || *workspace.Branch != "zai/j1" {
			t.Errorf("branch = %v", workspace.Branch)
		}
		if workspace.ArtifactsDir != "/state/jobs/j1/artifacts" {
			t.Errorf("artifactsDir = %q", workspace.ArtifactsDir)
		}
		if job.Attempts == nil || len(job.Attempts) != 0 {
			t.Errorf("attempts = %v", job.Attempts)
		}
		if job.CreatedAt != "2026-10-06T00:00:00.000Z" || job.UpdatedAt != "2026-10-06T00:00:00.000Z" {
			t.Errorf("createdAt/updatedAt = %q/%q", job.CreatedAt, job.UpdatedAt)
		}
		if job.Version != 0 || job.Decision != nil || job.Origin != nil {
			t.Errorf("version/decision/origin = %d/%v/%v", job.Version, job.Decision, job.Origin)
		}
		if job.Brief.Title != "Rename the helper" {
			t.Errorf("brief not the aBrief default: %q", job.Brief.Title)
		}
	})

	t.Run("every builder applies shallow overrides", func(t *testing.T) {
		changes := AChangeSet(func(c *domain.ChangeSet) { c.Added = []string{"a.txt"} })
		if !slices.Equal(changes.Added, []string{"a.txt"}) || changes.Modified == nil {
			t.Errorf("changeSet = %+v", changes)
		}
		exit := int64(1)
		gate := AGateResult(func(g *domain.GateResult) { g.ExitCode = &exit })
		if gate.ExitCode == nil || *gate.ExitCode != 1 || gate.Run != "npm test" {
			t.Errorf("gateResult = %+v", gate)
		}
		scope := AScopeCheck(func(s *domain.ScopeCheck) { s.OutOfScope = []string{"x"} })
		if !slices.Equal(scope.OutOfScope, []string{"x"}) || scope.Forbidden == nil {
			t.Errorf("scopeCheck = %+v", scope)
		}
		report := AReportCheck(func(r *domain.ReportCheck) { r.Valid = false })
		if report.Valid || !report.Present {
			t.Errorf("reportCheck = %+v", report)
		}
		verification := AVerification(func(v *domain.Verification) { v.Gates = []domain.GateResult{AGateResult()} })
		if len(verification.Gates) != 1 || verification.Changes.Added == nil {
			t.Errorf("verification = %+v", verification)
		}
		attempt := AnAttempt(func(a *domain.Attempt) { a.N = 2 })
		if attempt.N != 2 || attempt.Kind != domain.AttemptKindInitial {
			t.Errorf("attempt = %+v", attempt)
		}
	})

	t.Run("aJob applies shallow overrides", func(t *testing.T) {
		branch := "acme/j2"
		job := AJob(func(j *domain.Job) {
			j.ID = "j2"
			j.State = domain.JobStateRunning
			j.Workspace.Branch = &branch
			j.Attempts = []domain.Attempt{AnAttempt()}
		})
		if job.ID != "j2" || job.State != domain.JobStateRunning {
			t.Fatalf("overrides not applied: %+v", job)
		}
		if job.Workspace.Branch == nil || *job.Workspace.Branch != "acme/j2" {
			t.Errorf("branch = %v", job.Workspace.Branch)
		}
		if job.Workspace.RepoRoot != "/repo" {
			t.Errorf("unrelated default lost: repoRoot = %q", job.Workspace.RepoRoot)
		}
		if len(job.Attempts) != 1 || job.Attempts[0].N != 1 {
			t.Errorf("attempts = %+v", job.Attempts)
		}
	})
}

func TestReferenceProvider(t *testing.T) {
	t.Run("equals zai's shipped provider", func(t *testing.T) {
		if !reflect.DeepEqual(ReferenceProvider, providers.Zai) {
			t.Fatal("the reference provider drifted from the zai plugin's provider")
		}
	})

	t.Run("caps are the claude worker's terms", func(t *testing.T) {
		if ReferenceCaps.Name != ports.WorkerNameClaudeHeadless {
			t.Errorf("name = %q", ReferenceCaps.Name)
		}
		if ReferenceCaps.SessionKey != ports.SessionKeyCaller {
			t.Errorf("sessionKey = %q", ReferenceCaps.SessionKey)
		}
		if !ReferenceCaps.NativeSchema {
			t.Error("nativeSchema = false")
		}
		if !ReferenceCaps.Budget {
			t.Error("budget = false")
		}
		if !slices.Equal(ReferenceCaps.Efforts, []string{"low", "high", "max"}) {
			t.Errorf("efforts = %v", ReferenceCaps.Efforts)
		}
		notes := ReferenceCaps.BriefNotes
		if notes.Effort != "passed to claude --effort" ||
			notes.AddDirs != "passed as --add-dir" ||
			notes.BudgetUSD != "passed as --max-budget-usd" ||
			notes.Readonly != "plan mode, read tools only" {
			t.Errorf("briefNotes = %+v", notes)
		}
	})

	t.Run("acme shares no name with zai and derives its agents", func(t *testing.T) {
		if AcmeProvider.Name == ReferenceProvider.Name {
			t.Errorf("acme shares zai's name: %q", AcmeProvider.Name)
		}
		if AcmeProvider.Agents[domain.ModelTierMain] != "big-model-9" ||
			AcmeProvider.Agents[domain.ModelTierFlash] != "small-model-9" {
			t.Errorf("agents = %v", AcmeProvider.Agents)
		}
		if !slices.Equal(AcmeProvider.Strip, []string{"trace"}) {
			t.Errorf("strip = %v", AcmeProvider.Strip)
		}
		if !slices.Equal(AcmeProvider.Caveats, []string{"acme ignores the trace field"}) {
			t.Errorf("caveats = %v", AcmeProvider.Caveats)
		}
		if AcmeProvider.Router.Port != 18800 {
			t.Errorf("router port = %d", AcmeProvider.Router.Port)
		}
	})

	t.Run("acme worker shares no term with the claude worker", func(t *testing.T) {
		if AcmeWorker.Budget {
			t.Error("acme worker claims a budget")
		}
		if !slices.Equal(AcmeWorker.Efforts, []string{"gentle", "firm", "fierce"}) {
			t.Errorf("efforts = %v", AcmeWorker.Efforts)
		}
		notes := AcmeWorker.BriefNotes
		if notes.Effort != "sent as acmebot --zeal" ||
			notes.AddDirs != "mounted read-only" ||
			notes.BudgetUSD != "refused: acmebot has no spending cap" ||
			notes.Readonly != "answered from the repo, nothing written" {
			t.Errorf("briefNotes = %+v", notes)
		}
	})

	t.Run("zai names match every zai spelling and no acme one", func(t *testing.T) {
		for _, text := range []string{"zai", "Z.ai", "GLM-5.3", "/zai:board", "claude-headless"} {
			if !ZaiNames.MatchString(text) {
				t.Errorf("ZaiNames does not match %q", text)
			}
		}
		for _, text := range []string{"acme", "Acme Models", "big-model-9", "acmebot --zeal"} {
			if ZaiNames.MatchString(text) {
				t.Errorf("ZaiNames matches %q", text)
			}
		}
	})
}

func TestTempDir(t *testing.T) {
	t.Run("returns an existing dir named by the prefix with symlinks resolved", func(t *testing.T) {
		dir := TempDir(t, "zai-test-")
		if filepath.Base(dir) != "zai-test-" {
			t.Errorf("dir = %q", dir)
		}
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			t.Fatalf("stat %s: %v", dir, err)
		}
		resolved, err := filepath.EvalSymlinks(dir)
		if err != nil {
			t.Fatalf("eval symlinks: %v", err)
		}
		if dir != resolved {
			t.Errorf("dir %q is not the resolved path %q", dir, resolved)
		}
	})

	t.Run("stopProcessesUnder leaves the caller alone", func(t *testing.T) {
		StopProcessesUnder(t.TempDir())
		if !IsPidAlive(os.Getpid()) {
			t.Fatal("the test process itself was stopped")
		}
	})

	t.Run("stopProcessesUnder stays silent when ps cannot run", func(t *testing.T) {
		t.Setenv("PATH", "")
		StopProcessesUnder(t.TempDir())
	})

	t.Run("isolateGitConfig stubs every variable", func(t *testing.T) {
		IsolateGitConfig(t)
		for name, want := range ISOLATED_GIT_ENV {
			if got := os.Getenv(name); got != want {
				t.Errorf("%s = %q, want %q", name, got, want)
			}
		}
	})
}

func TestMakeRepo(t *testing.T) {
	t.Run("inits a repo on main with one commit", func(t *testing.T) {
		repo := MakeRepo(t)
		if branch := strings.TrimSpace(repo.Git("rev-parse", "--abbrev-ref", "HEAD")); branch != "main" {
			t.Errorf("branch = %q", branch)
		}
		if count := strings.TrimSpace(repo.Git("rev-list", "--count", "HEAD")); count != "1" {
			t.Errorf("commit count = %q", count)
		}
		if head := repo.Head(); !isSha(head) {
			t.Errorf("head = %q", head)
		}
		if got := repo.Read("README.md"); got != "# test repo\n" {
			t.Errorf("README.md = %q", got)
		}
	})

	t.Run("write, commitAll and head move the repo forward", func(t *testing.T) {
		repo := MakeRepo(t)
		first := repo.Head()
		repo.Write("notes.txt", "first\n")
		second := repo.CommitAll("add notes")
		if second == first || !isSha(second) {
			t.Fatalf("commitAll returned %q after %q", second, first)
		}
		if count := strings.TrimSpace(repo.Git("rev-list", "--count", "HEAD")); count != "2" {
			t.Errorf("commit count = %q", count)
		}
		if status := repo.Git("status", "--porcelain"); strings.TrimSpace(status) != "" {
			t.Errorf("working tree not clean: %q", status)
		}
		if got := repo.Read("notes.txt"); got != "first\n" {
			t.Errorf("notes.txt = %q", got)
		}
	})

	t.Run("write creates nested directories and read returns the bytes", func(t *testing.T) {
		repo := MakeRepo(t)
		repo.Write(filepath.Join("deep", "nested", "file.txt"), "x\n")
		if got := repo.Read(filepath.Join("deep", "nested", "file.txt")); got != "x\n" {
			t.Errorf("file.txt = %q", got)
		}
	})

	t.Run("remove deletes a path", func(t *testing.T) {
		repo := MakeRepo(t)
		repo.Write("gone.txt", "bye\n")
		repo.CommitAll("add gone")
		repo.Remove("gone.txt")
		repo.CommitAll("drop gone")
		if _, err := os.Stat(filepath.Join(repo.Dir, "gone.txt")); !os.IsNotExist(err) {
			t.Errorf("gone.txt still there: %v", err)
		}
	})

	t.Run("repoAt wraps an existing directory", func(t *testing.T) {
		dir := t.TempDir()
		repo := RepoAt(t, dir)
		repo.Git("init", "-q")
		if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
			t.Fatalf(".git missing: %v", err)
		}
	})

	t.Run("git ignores the developer's global config", func(t *testing.T) {
		global := filepath.Join(t.TempDir(), "gitconfig")
		if err := os.WriteFile(global, []byte("[testkit]\n\tmarker = yes\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Setenv("GIT_CONFIG_GLOBAL", global)
		if _, err := Git(t.TempDir(), "config", "--get", "testkit.marker"); err == nil {
			t.Fatal("git read the developer's global config")
		}
	})
}

func TestFreePort(t *testing.T) {
	t.Run("returns a port a listener can take", func(t *testing.T) {
		port := FreePort(t)
		if port == 0 {
			t.Fatal("freePort returned 0")
		}
		listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err != nil {
			t.Fatalf("port %d unusable: %v", port, err)
		}
		listener.Close()
	})
}

func TestUntil(t *testing.T) {
	t.Run("resolves once the condition holds", func(t *testing.T) {
		tries := 0
		err := Until(t, func() bool {
			tries++
			return tries >= 3
		}, UntilOptions{TimeoutMs: 2000, IntervalMs: 1})
		if err != nil {
			t.Fatalf("until: %v", err)
		}
		if tries < 3 {
			t.Errorf("tries = %d", tries)
		}
	})

	t.Run("times out with an error", func(t *testing.T) {
		err := Until(t, func() bool { return false }, UntilOptions{TimeoutMs: 60, IntervalMs: 5})
		if err == nil {
			t.Fatal("until resolved a condition that never holds")
		}
		if err.Error() != "condition not met within 60 ms" {
			t.Errorf("error = %q", err.Error())
		}
	})

	t.Run("says the message given", func(t *testing.T) {
		err := Until(t, func() bool { return false },
			UntilOptions{TimeoutMs: 40, IntervalMs: 5, Message: "frame did not arrive"})
		if err == nil || err.Error() != "frame did not arrive within 40 ms" {
			t.Errorf("error = %v", err)
		}
	})

	t.Run("resolves with the default timeout and interval when a probe already holds", func(t *testing.T) {
		if err := Until(t, func() bool { return true }, UntilOptions{}); err != nil {
			t.Fatalf("until: %v", err)
		}
	})

	t.Run("sleep waits the asked time", func(t *testing.T) {
		start := time.Now()
		if err := Sleep(t.Context(), 25); err != nil {
			t.Fatalf("sleep: %v", err)
		}
		if elapsed := time.Since(start); elapsed < 25*time.Millisecond {
			t.Errorf("slept %s", elapsed)
		}
	})

	t.Run("sleep returns the context error when it is cancelled first", func(t *testing.T) {
		ctx, cancel := context.WithCancel(t.Context())
		cancel()
		if err := Sleep(ctx, 10_000); err != context.Canceled {
			t.Errorf("sleep error = %v", err)
		}
	})
}

func TestIsPidAlive(t *testing.T) {
	t.Run("a live pid is alive", func(t *testing.T) {
		if !IsPidAlive(os.Getpid()) {
			t.Fatal("this process reports dead")
		}
	})

	t.Run("a reaped pid is not", func(t *testing.T) {
		if IsPidAlive(DeadPid(t)) {
			t.Fatal("a reaped pid reports alive")
		}
	})

	t.Run("untilGone returns once the process is gone", func(t *testing.T) {
		if err := UntilGone(t, DeadPid(t), UntilOptions{TimeoutMs: 2000, IntervalMs: 5}); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("untilGone times out naming the pid", func(t *testing.T) {
		err := UntilGone(t, os.Getpid(), UntilOptions{TimeoutMs: 40, IntervalMs: 5})
		want := fmt.Sprintf("process %d still alive within 40 ms", os.Getpid())
		if err == nil || err.Error() != want {
			t.Errorf("error = %v, want %q", err, want)
		}
	})
}

func TestPidMatches(t *testing.T) {
	own := int64(os.Getpid())

	t.Run("a gone pid matches nothing", func(t *testing.T) {
		if PidMatches(int64(DeadPid(t)), "", 0) {
			t.Fatal("a reaped pid matched")
		}
	})

	t.Run("a live pid matches its command line and its parent", func(t *testing.T) {
		if !PidMatches(own, os.Args[0], 0) {
			t.Fatal("this process did not match its own command line")
		}
		table, err := ParentTable()
		if err != nil {
			t.Fatal(err)
		}
		parent, ok := table[os.Getpid()]
		if !ok || parent == 0 {
			t.Skipf("ps carries no parent row for %d", os.Getpid())
		}
		if !PidMatches(own, "", parent) {
			t.Fatal("this process did not match its own parent")
		}
		if PidMatches(own, "no such command line anywhere", 0) {
			t.Fatal("this process matched a command line it does not have")
		}
		if parent != 1 && PidMatches(own, "", 1) {
			t.Fatal("this process matched a parent it does not have")
		}
	})
}

func TestStopProcessesUnder(t *testing.T) {
	dir := TempDir(t, "zai-stop-")
	script := filepath.Join(dir, "linger.sh")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nwhile :; do sleep 1; done\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(script)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if err := Until(t, func() bool { return IsPidAlive(cmd.Process.Pid) },
		UntilOptions{TimeoutMs: 2000, IntervalMs: 5}); err != nil {
		t.Fatal(err)
	}
	StopProcessesUnder(dir)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatalf("the process under %s was not stopped", dir)
	}
	if IsPidAlive(cmd.Process.Pid) {
		t.Fatal("the stopped pid reports alive")
	}

	t.Run("a sweep without ps counts as nothing left to stop", func(t *testing.T) {
		t.Setenv("PATH", "")
		if stopProcessesSweep(t.TempDir()) {
			t.Fatal("the sweep wanted another round without ps")
		}
	})

	t.Run("a ps that fails every time ends the sweep at once", func(t *testing.T) {
		// A ps that rejects the flags on every run must not be retried to the deadline.
		bin := t.TempDir()
		script := filepath.Join(bin, "ps")
		usage := "#!/bin/sh\necho 'Usage: ps [-aefls] [-u UID] [-p PID]' >&2\nexit 1\n"
		if err := os.WriteFile(script, []byte(usage), 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", bin)
		start := time.Now()
		StopProcessesUnder(t.TempDir())
		if elapsed := time.Since(start); elapsed > time.Second {
			t.Fatalf("the sweep ran %s behind a ps that always fails", elapsed)
		}
	})

	t.Run("a ps whose output names no process under the dir leaves nothing to stop", func(t *testing.T) {
		bin := t.TempDir()
		script := filepath.Join(bin, "ps")
		rows := "#!/bin/sh\necho '      PID    PPID    PGID     TTY         UID STIME COMMAND'\n" +
			"echo '     1916       1    1916   con 401100 Oct 13 /usr/bin/mintty'\n"
		if err := os.WriteFile(script, []byte(rows), 0o755); err != nil {
			t.Fatal(err)
		}
		t.Setenv("PATH", bin)
		if stopProcessesSweep(t.TempDir()) {
			t.Fatal("the sweep wanted another round behind output it cannot parse")
		}
	})
}

func TestParentTable(t *testing.T) {
	t.Run("maps this process to its parent", func(t *testing.T) {
		table, err := ParentTable()
		if err != nil {
			t.Skipf("ps unavailable: %v", err)
		}
		if _, ok := table[os.Getpid()]; !ok {
			t.Fatalf("pid %d missing from the table", os.Getpid())
		}
		if slices.Contains(Descendants(os.Getpid(), table), os.Getpid()) {
			t.Error("the root is its own descendant")
		}
	})

	t.Run("reports a failed ps", func(t *testing.T) {
		t.Setenv("PATH", "")
		if _, err := ParentTable(); err == nil {
			t.Fatal("parentTable succeeded without ps")
		}
	})

	t.Run("descendants walk the ppid chain, root excluded, cycles safe", func(t *testing.T) {
		table := map[int]int{1: 0, 2: 1, 3: 2, 4: 2, 5: 1, 7: 8, 8: 7}
		if got := Descendants(1, table); !slices.Equal(got, []int{2, 3, 4, 5}) {
			t.Errorf("descendants(1) = %v", got)
		}
		if got := Descendants(2, table); !slices.Equal(got, []int{3, 4}) {
			t.Errorf("descendants(2) = %v", got)
		}
		// A ppid cycle (ps never reports one) terminates the walk; the cycle's members are each
		// other's ancestors, so both are descendants of 7.
		if got := Descendants(7, table); !slices.Equal(got, []int{7, 8}) {
			t.Errorf("descendants(7) = %v", got)
		}
		if got := Descendants(3, table); len(got) != 0 {
			t.Errorf("descendants(3) = %v", got)
		}
	})
}

func TestFakeRunner(t *testing.T) {
	t.Run("records every call and answers exit 0 by default", func(t *testing.T) {
		runner := NewFakeRunner()
		stdin := TEST_KEY
		first := runner.Run(t.Context(), "security", []string{"-i"}, &stdin)
		second := runner.Run(t.Context(), "secret-tool", nil, nil)
		if first.Code == nil || *first.Code != 0 || first.Stdout != "" || first.Stderr != "" {
			t.Errorf("first = %+v", first)
		}
		if second.Code == nil || *second.Code != 0 {
			t.Errorf("second = %+v", second)
		}
		if len(runner.Calls) != 2 {
			t.Fatalf("calls = %+v", runner.Calls)
		}
		if runner.Calls[0].Cmd != "security" || !slices.Equal(runner.Calls[0].Args, []string{"-i"}) {
			t.Errorf("call 0 = %+v", runner.Calls[0])
		}
		if runner.Calls[0].Stdin == nil || *runner.Calls[0].Stdin != TEST_KEY {
			t.Errorf("call 0 stdin = %v", runner.Calls[0].Stdin)
		}
		if runner.Calls[1].Stdin != nil {
			t.Errorf("call 1 stdin = %v", *runner.Calls[1].Stdin)
		}
	})

	t.Run("argv flattens command and args", func(t *testing.T) {
		runner := NewFakeRunner()
		runner.Run(t.Context(), "security", []string{"-i", "find"}, nil)
		runner.Run(t.Context(), "secret-tool", []string{"lookup"}, nil)
		if want := []string{"security", "-i", "find", "secret-tool", "lookup"}; !slices.Equal(runner.Argv(), want) {
			t.Errorf("argv = %v", runner.Argv())
		}
	})

	t.Run("answer decides the result", func(t *testing.T) {
		runner := NewFakeRunner()
		runner.Answer = func(call RunCall) RunResult {
			return RunResult{Stderr: "boom", Missing: true}
		}
		got := runner.Run(t.Context(), "security", []string{"-i"}, nil)
		if got.Code != nil || got.Missing != true || got.Stderr != "boom" {
			t.Errorf("result = %+v", got)
		}
	})
}

func TestMemoryKeyStore(t *testing.T) {
	t.Run("defaults to the macOS Keychain", func(t *testing.T) {
		store := NewMemoryKeyStore("", "", "")
		if store.Kind() != ports.KeyStoreMacOS {
			t.Errorf("kind = %q", store.Kind())
		}
		if store.Label() != "macOS Keychain" {
			t.Errorf("label = %q", store.Label())
		}
		if !store.Available(t.Context()) {
			t.Error("available = false")
		}
	})

	t.Run("round-trips a key", func(t *testing.T) {
		store := NewMemoryKeyStore("", "", "")
		if value, ok := store.Get(t.Context()); ok || value != "" {
			t.Fatalf("get = %q, %v", value, ok)
		}
		if err := store.Set(t.Context(), TEST_KEY); err != nil {
			t.Fatal(err)
		}
		if store.Sets != 1 {
			t.Errorf("sets = %d", store.Sets)
		}
		if value, ok := store.Get(t.Context()); !ok || value != TEST_KEY {
			t.Errorf("get = %q, %v", value, ok)
		}
	})

	t.Run("set failure names the store and the exit", func(t *testing.T) {
		store := NewMemoryKeyStore(ports.KeyStoreFile, "the key file", "")
		store.FailSet = true
		err := store.Set(t.Context(), TEST_KEY)
		if err == nil || err.Error() != "could not store the key in the key file (exit 1)" {
			t.Errorf("error = %v", err)
		}
		if store.Sets != 0 {
			t.Errorf("sets = %d", store.Sets)
		}
	})

	t.Run("remove clears the key", func(t *testing.T) {
		store := NewMemoryKeyStore("", "", TEST_KEY)
		if err := store.Remove(t.Context()); err != nil {
			t.Fatal(err)
		}
		if store.Removes != 1 {
			t.Errorf("removes = %d", store.Removes)
		}
		if value, ok := store.Get(t.Context()); ok || value != "" {
			t.Errorf("get = %q, %v", value, ok)
		}
	})

	t.Run("starts with a given kind, label and value", func(t *testing.T) {
		store := NewMemoryKeyStore(ports.KeyStoreFile, "the key file", TEST_KEY)
		if store.Kind() != ports.KeyStoreFile || store.Label() != "the key file" {
			t.Errorf("kind/label = %q/%q", store.Kind(), store.Label())
		}
		if value, ok := store.Get(t.Context()); !ok || value != TEST_KEY {
			t.Errorf("get = %q, %v", value, ok)
		}
	})
}

// shaPattern matches a sha1 commit id, git's default in tests.
var shaPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

func isSha(text string) bool {
	return shaPattern.MatchString(text)
}
