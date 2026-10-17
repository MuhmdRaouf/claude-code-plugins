package app_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakedeps"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// The land suite, end to end on real temporary git repositories: one test per landing case. The
// adapters are real, the gates really run, and every failure asserts the repository was left
// exactly as it was.

// landOptions is the commit-mode landing the suite runs.
var landOptions = app.LandOptions{Mode: app.AcceptModeCommit, Verify: true}

// landGate is a gate with the domain's timeout default filled in.
func landGate(run string) domain.Gate {
	return domain.Gate{Run: run, TimeoutMs: domain.DefaultGateTimeoutMs}
}

// landWhere is where the world's repositories live, for a brief that names them (a gate may commit
// to the user's).
type landWhere struct {
	repo      string
	stateRoot string
}

// landWorld is a real repository with a real job worktree under zai's state root — the world an
// accept lands in.
type landWorld struct {
	deps      app.Deps
	repo      testkit.TestRepo
	stateRoot string
	job       domain.Job
	worktree  testkit.TestRepo
	base      string
}

// newLandWorld builds the world: a repo with the given files committed as the base, the trailer
// setting, and a job worktree on zai/j1 carrying the brief.
func newLandWorld(t *testing.T, files map[string]string, brief func(where landWhere) func(*domain.Brief), trailer string) landWorld {
	t.Helper()
	testkit.IsolateGitConfig(t)
	stateRoot := testkit.TempDir(t, "zai-land-state-")
	repo := testkit.MakeRepo(t)
	base := repo.Head()
	for path, content := range files {
		repo.Write(path, content)
	}
	if len(files) > 0 {
		base = repo.CommitAll("base")
	}
	if trailer != "" {
		repo.Git("config", "zai.trailer", trailer)
	}
	worktree := testkit.RepoAt(t, filepath.Join(stateRoot, "worktrees", "j1"))
	repo.Git("worktree", "add", "-q", "-b", "zai/j1", "--", worktree.Dir, base)
	briefValue := testkit.ABrief()
	if brief != nil {
		if override := brief(landWhere{repo: repo.Dir, stateRoot: stateRoot}); override != nil {
			override(&briefValue)
		}
	}
	job := testkit.AJob(func(j *domain.Job) {
		j.ID = "j1"
		j.State = domain.JobStateAwaitingReview
		j.Brief = briefValue
		j.Workspace = domain.Workspace{
			RepoRoot:     repo.Dir,
			BaseSha:      base,
			Worktree:     &worktree.Dir,
			Branch:       strPtr("zai/j1"),
			ArtifactsDir: filepath.Join(stateRoot, "jobs", "j1", "artifacts"),
		}
	})
	world := fakedeps.FakeDeps(t)
	deps := world.Deps
	deps.Git = adapters.CreateGitCli("zai")
	deps.Store = adapters.CreateFsStore(stateRoot, func(pid int64) bool {
		return testkit.IsPidAlive(int(pid))
	})
	deps.Gates = adapters.CreateShellGates("zai")
	deps.Out = &fakes.RecordingOutput{}
	deps.Host = fakedeps.NewFakeHost(stateRoot).HostInfo()
	return landWorld{deps: deps, repo: repo, stateRoot: stateRoot, job: job, worktree: worktree, base: base}
}

// strPtr boxes a string.
func strPtr(text string) *string { return &text }

// pathExists says whether the path is on disk.
func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// wantLandErr fails unless err is exactly the wanted app error.
func wantLandErr(t *testing.T, err error, want *app.AppError) {
	t.Helper()
	var appErr *app.AppError
	if !errors.As(err, &appErr) || !reflect.DeepEqual(appErr, want) {
		t.Fatalf("error = %+v, want %+v", err, want)
	}
}

func TestLand(t *testing.T) {
	ctx := context.Background()

	t.Run("fast-forwards the repository onto the job's commit when the base is still the tip", func(t *testing.T) {
		world := newLandWorld(t, nil, nil, "")
		world.worktree.Write("feature.txt", "the change\n")

		landed, err := app.Land(ctx, world.deps, world.job, landOptions)

		if err != nil {
			t.Fatal(err)
		}
		if landed == nil || world.repo.Head() != *landed {
			t.Errorf("landed = %v, want the repository's new head", landed)
		}
		if sha := world.repo.Git("rev-parse", "HEAD~1"); strings.TrimSpace(sha) != world.base {
			t.Errorf("HEAD~1 = %s, want the base %s", sha, world.base)
		}
		if subject := world.repo.Git("log", "-1", "--format=%s"); strings.TrimSpace(subject) != "Rename the helper" {
			t.Errorf("subject = %q, want the brief title", subject)
		}
		if body := world.repo.Git("log", "-1", "--format=%B"); !strings.Contains(body, "Worked-by: glm-5.3 via zai") {
			t.Errorf("body = %q, want the Worked-by trailer", body)
		}
	})

	t.Run("rebases onto a moved tip when nothing overlaps and lands both changes", func(t *testing.T) {
		world := newLandWorld(t, map[string]string{"user.txt": "base\n"}, nil, "")
		world.repo.Write("user.txt", "user edited\n")
		tip := world.repo.CommitAll("user edits user.txt")
		world.worktree.Write("worker.txt", "worker edited\n")

		landed, err := app.Land(ctx, world.deps, world.job, landOptions)

		if err != nil {
			t.Fatal(err)
		}
		if landed == nil {
			t.Fatal("nothing landed")
		}
		if text := world.repo.Read("user.txt"); text != "user edited\n" {
			t.Errorf("user.txt = %q, want the user's edit", text)
		}
		if text := world.repo.Read("worker.txt"); text != "worker edited\n" {
			t.Errorf("worker.txt = %q, want the worker's edit", text)
		}
		if sha := world.repo.Git("rev-parse", "HEAD~1"); strings.TrimSpace(sha) != tip {
			t.Errorf("HEAD~1 = %s, want the moved tip %s", sha, tip)
		}
	})

	t.Run("regenerates a file that conflicts with the tip instead of failing", func(t *testing.T) {
		world := newLandWorld(t, map[string]string{"generated.txt": "base\n"}, func(where landWhere) func(*domain.Brief) {
			return func(b *domain.Brief) {
				// The regenerate rules are the domain's own unexported shape; only its JSON reaches in.
				if err := json.Unmarshal([]byte(
					`{"regenerate":[{"paths":["generated.txt"],"run":"echo regenerated > generated.txt"}]}`,
				), b); err != nil {
					t.Fatal(err)
				}
				b.Gates = []domain.Gate{landGate(`test "$(cat generated.txt)" = regenerated`)}
			}
		}, "")
		world.repo.Write("generated.txt", "user edited\n")
		tip := world.repo.CommitAll("user edits generated.txt")
		world.worktree.Write("generated.txt", "worker edited\n")
		world.worktree.Write("code.txt", "the code\n")

		landed, err := app.Land(ctx, world.deps, world.job, landOptions)

		if err != nil {
			t.Fatal(err)
		}
		if landed == nil {
			t.Fatal("nothing landed")
		}
		if text := world.repo.Read("generated.txt"); text != "regenerated\n" {
			t.Errorf("generated.txt = %q, want the regenerated file", text)
		}
		if text := world.repo.Read("code.txt"); text != "the code\n" {
			t.Errorf("code.txt = %q, want the worker's file", text)
		}
		if sha := world.repo.Git("rev-parse", "HEAD~1"); strings.TrimSpace(sha) != tip {
			t.Errorf("HEAD~1 = %s, want the moved tip %s", sha, tip)
		}
	})

	t.Run("fails with land_conflict and changes nothing when the conflict is in code", func(t *testing.T) {
		world := newLandWorld(t, map[string]string{"code.txt": "base\n"}, nil, "")
		world.repo.Write("code.txt", "user edited\n")
		tip := world.repo.CommitAll("user edits code.txt")
		world.worktree.Write("code.txt", "worker edited\n")

		_, err := app.Land(ctx, world.deps, world.job, landOptions)

		wantLandErr(t, err, &app.AppError{Kind: app.AppErrorLandConflict, Paths: []string{"code.txt"}})
		// Nothing changed: the repository is where it was, and the job's work survives untouched for a retry.
		if world.repo.Head() != tip {
			t.Errorf("head = %s, want the tip %s", world.repo.Head(), tip)
		}
		if text := world.repo.Read("code.txt"); text != "user edited\n" {
			t.Errorf("code.txt = %q, want the user's edit", text)
		}
		if text := world.worktree.Read("code.txt"); text != "worker edited\n" {
			t.Errorf("worktree code.txt = %q, want the worker's edit", text)
		}
		if status := world.worktree.Git("status", "--porcelain"); status != "" {
			t.Errorf("worktree status = %q, want it clean", status)
		}
		if pathExists(filepath.Join(world.stateRoot, "checkouts", "j1")) {
			t.Error("a checkout was left behind")
		}
	})

	t.Run("fails with land_verify_failed when a gate needs a file the commit does not carry", func(t *testing.T) {
		world := newLandWorld(t, map[string]string{".gitignore": "ignored.txt\n"}, func(where landWhere) func(*domain.Brief) {
			return func(b *domain.Brief) { b.Gates = []domain.Gate{landGate("cat ignored.txt")} }
		}, "")
		world.worktree.Write("code.txt", "the code\n")
		world.worktree.Write("ignored.txt", "git refuses to commit me\n")

		_, err := app.Land(ctx, world.deps, world.job, landOptions)

		var appErr *app.AppError
		if !errors.As(err, &appErr) || appErr.Kind != app.AppErrorLandVerifyFailed {
			t.Fatalf("error = %+v, want land_verify_failed", err)
		}
		if appErr.Command != "cat ignored.txt" {
			t.Errorf("command = %q, want the failing gate", appErr.Command)
		}
		if !strings.Contains(appErr.Tail, "No such file") {
			t.Errorf("tail = %q, want the missing file", appErr.Tail)
		}
		// Nothing landed; the failing gate's log says why, and no checkout is left behind.
		if world.repo.Head() != world.base {
			t.Errorf("head = %s, want the base %s", world.repo.Head(), world.base)
		}
		if pathExists(filepath.Join(world.repo.Dir, "code.txt")) {
			t.Error("nothing should have landed in the repository")
		}
		if !pathExists(filepath.Join(world.stateRoot, "jobs", "j1", "land-check-0.log")) {
			t.Error("the failing gate's log should exist")
		}
		if pathExists(filepath.Join(world.stateRoot, "checkouts", "j1")) {
			t.Error("a checkout was left behind")
		}
	})

	t.Run("runs the brief's setup in the verification checkout before the gates", func(t *testing.T) {
		world := newLandWorld(t, map[string]string{"code.txt": "base\n"}, func(where landWhere) func(*domain.Brief) {
			return func(b *domain.Brief) {
				b.Setup = &[]string{"echo prepared > prepared.txt"}
				b.Gates = []domain.Gate{landGate(`test "$(cat prepared.txt)" = prepared`)}
			}
		}, "")
		world.worktree.Write("code.txt", "worker edited\n")

		landed, err := app.Land(ctx, world.deps, world.job, landOptions)

		// The gate only passes because setup prepared the file it reads — in the checkout, not in the
		// landed commit.
		if err != nil {
			t.Fatal(err)
		}
		if landed == nil {
			t.Fatal("nothing landed")
		}
		if pathExists(filepath.Join(world.repo.Dir, "prepared.txt")) {
			t.Error("setup must run in the checkout, never in the repository")
		}
		if !pathExists(filepath.Join(world.stateRoot, "jobs", "j1", "land-check-0.log")) {
			t.Error("the setup log should exist")
		}
		if pathExists(filepath.Join(world.stateRoot, "checkouts", "j1")) {
			t.Error("a checkout was left behind")
		}
	})

	t.Run("retries when the tip moves while the commit is being verified", func(t *testing.T) {
		world := newLandWorld(t, nil, func(where landWhere) func(*domain.Brief) {
			moved := filepath.Join(where.stateRoot, "moved-once")
			gate := `test -f "` + moved + `" || ` +
				`{ git -C "` + where.repo + `" commit --allow-empty -q -m "tip moved"; ` +
				`touch "` + moved + `"; }`
			return func(b *domain.Brief) { b.Gates = []domain.Gate{landGate(gate)} }
		}, "")
		world.worktree.Write("feature.txt", "the change\n")

		landed, err := app.Land(ctx, world.deps, world.job, landOptions)

		// The gate moved the tip once, mid-verification; the next round rebased onto it and landed.
		if err != nil {
			t.Fatal(err)
		}
		if landed == nil {
			t.Fatal("nothing landed")
		}
		subjects := strings.Split(strings.TrimSpace(world.repo.Git("log", "--format=%s")), "\n")
		if !reflect.DeepEqual(subjects, []string{"Rename the helper", "tip moved", "init"}) {
			t.Errorf("subjects = %v, want the rebase onto the moved tip", subjects)
		}
	})

	t.Run("refuses to land over a dirty user file the change set touches", func(t *testing.T) {
		world := newLandWorld(t, map[string]string{"code.txt": "base\n"}, nil, "")
		world.worktree.Write("code.txt", "worker edited\n")
		world.repo.Write("code.txt", "user is editing\n")

		_, err := app.Land(ctx, world.deps, world.job, landOptions)

		wantLandErr(t, err, &app.AppError{Kind: app.AppErrorGit, GitError: &ports.GitError{
			Kind: ports.GitErrorDirty, Paths: []string{"code.txt"},
		}})
		if world.repo.Head() != world.base {
			t.Errorf("head = %s, want the base %s", world.repo.Head(), world.base)
		}
		if text := world.repo.Read("code.txt"); text != "user is editing\n" {
			t.Errorf("code.txt = %q, want the user's edit kept", text)
		}
		if status := world.repo.Git("status", "--porcelain"); status != " M code.txt\n" {
			t.Errorf("status = %q, want the user's file still dirty", status)
		}
	})

	t.Run("omits the Worked-by trailer when the repository sets zai.trailer to none", func(t *testing.T) {
		world := newLandWorld(t, nil, nil, "none")
		world.worktree.Write("feature.txt", "the change\n")

		landed, err := app.Land(ctx, world.deps, world.job, landOptions)

		if err != nil {
			t.Fatal(err)
		}
		if landed == nil {
			t.Fatal("nothing landed")
		}
		message := world.repo.Git("log", "-1", "--format=%B")
		if strings.Contains(message, "Worked-by") {
			t.Errorf("message = %q, want no trailer", message)
		}
		if trimmed := strings.TrimSpace(message); trimmed != "Rename the helper" {
			t.Errorf("message = %q, want the title alone", trimmed)
		}
	})

	t.Run("leaves no worktree, branch, or checkout behind once the accept completes", func(t *testing.T) {
		world := newLandWorld(t, nil, func(where landWhere) func(*domain.Brief) {
			return func(b *domain.Brief) { b.Gates = []domain.Gate{landGate("true")} }
		}, "")
		world.worktree.Write("feature.txt", "the change\n")

		landed, err := app.Land(ctx, world.deps, world.job, landOptions)
		if err != nil {
			t.Fatal(err)
		}
		if landed == nil {
			t.Fatal("nothing landed")
		}
		// accept continues by recording the decision and removing the workspace
		app.RemoveWorkspace(ctx, world.deps, world.job)

		if paths := worktreePaths(t, world.repo); !reflect.DeepEqual(paths, []string{world.repo.Dir}) {
			t.Errorf("worktrees = %v, want only the repository", paths)
		}
		if names := branches(t, world.repo); !reflect.DeepEqual(names, []string{"main"}) {
			t.Errorf("branches = %v, want only main", names)
		}
		if pathExists(*world.job.Workspace.Worktree) {
			t.Error("the job's worktree directory was left behind")
		}
		if pathExists(filepath.Join(world.stateRoot, "checkouts", "j1")) {
			t.Error("a checkout was left behind")
		}
	})

	t.Run("keeps the job's worktree and branch for a retry when landing fails", func(t *testing.T) {
		world := newLandWorld(t, map[string]string{"code.txt": "base\n"}, nil, "")
		world.repo.Write("code.txt", "user edited\n")
		world.repo.CommitAll("user edits code.txt")
		world.worktree.Write("code.txt", "worker edited\n")

		_, err := app.Land(ctx, world.deps, world.job, landOptions)

		if err == nil {
			t.Fatal("landing should fail on the conflict")
		}
		if !containsPath(worktreePaths(t, world.repo), world.worktree.Dir) {
			t.Errorf("worktrees = %v, want the job's kept", worktreePaths(t, world.repo))
		}
		if !containsPath(branches(t, world.repo), "zai/j1") {
			t.Errorf("branches = %v, want the job branch kept", branches(t, world.repo))
		}
		if pathExists(filepath.Join(world.stateRoot, "checkouts", "j1")) {
			t.Error("a checkout was left behind")
		}
	})
}

// containsPath says whether list holds path.
func containsPath(list []string, path string) bool {
	for _, item := range list {
		if item == path {
			return true
		}
	}
	return false
}

// A landing whose commit is already the repository's tip (a previous accept landed it and failed
// only to record that) settles on the branch's own head without merging again — headToLand's
// already-landed branch, reached only through this round trip.
func TestLandSettlesOnTheTip(t *testing.T) {
	ctx := context.Background()
	world := newLandWorld(t, nil, nil, "")
	world.worktree.Write("feature.txt", "the change\n")
	first, err := app.Land(ctx, world.deps, world.job, landOptions)
	if err != nil {
		t.Fatal(err)
	}

	second, err := app.Land(ctx, world.deps, world.job, landOptions)

	if err != nil {
		t.Fatal(err)
	}
	if second == nil || *second != *first {
		t.Errorf("second landing = %v, want the commit already on the tip %v", second, first)
	}
	if head := world.repo.Head(); head != *first {
		t.Errorf("head = %s, want the landed commit %s", head, *first)
	}
	if log := world.repo.Git("log", "--format=%s"); strings.Count(strings.TrimSpace(log), "\n") != 1 {
		t.Errorf("subjects = %q, want no second commit", log)
	}
}
