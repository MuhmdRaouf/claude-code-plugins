// Package app_test holds the app tests that run on the real adapters: a real store, real job files
// and a real git, as a plugin run starts out.
package app_test

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// cleanupWorkspace against real git repositories and a real store: the leftovers a previous run
// can leave — a decided job whose worktree survived, a temporary checkout of an interrupted accept
// — are removed, and only the plugin's own directories and branch prefix are ever touched.

type cleanupWorld struct {
	deps      app.Deps
	repo      testkit.TestRepo
	stateRoot string
	store     ports.JobStore
}

// newCleanupWorld is a real repository and a real store rooted together, as a plugin run starts
// out.
func newCleanupWorld(t *testing.T) cleanupWorld {
	t.Helper()
	testkit.IsolateGitConfig(t)
	stateRoot := testkit.TempDir(t, "zai-cleanup-state-")
	repo := testkit.MakeRepo(t)
	process := fakes.NewFakeProcess()
	store := adapters.CreateFsStore(stateRoot, func(pid int64) bool {
		return testkit.IsPidAlive(int(pid))
	})
	deps := app.Deps{
		Worker:   fakes.NewScriptedWorker(t, process, fakes.Completes()),
		Git:      adapters.CreateGitCli("zai"),
		Store:    store,
		Files:    adapters.CreateFsJobFiles(stateRoot),
		Process:  process,
		Clock:    fakes.NewManualClock(),
		Ids:      fakes.NewFakeIds(),
		Out:      &fakes.RecordingOutput{},
		Host:     app.HostInfo{StateRoot: stateRoot},
		Provider: testkit.ReferenceProvider,
		Env:      map[string]string{"HOME": filepath.Join(stateRoot, "home")},
		Config:   app.Config{Limiter: domain.DEFAULT_LIMITER, Prompt: domain.DefaultLimits, StopGraceMs: 100},
	}
	return cleanupWorld{deps: deps, repo: repo, stateRoot: stateRoot, store: store}
}

// worktreePaths is every worktree the repository has registered, each cleaned to the platform's
// own spelling before it is compared.
func worktreePaths(t *testing.T, repo testkit.TestRepo) []string {
	t.Helper()
	paths := []string{}
	for _, line := range strings.Split(repo.Git("worktree", "list", "--porcelain"), "\n") {
		if rest, ok := strings.CutPrefix(line, "worktree "); ok {
			paths = append(paths, filepath.Clean(rest))
		}
	}
	return paths
}

// branches is the repository's branch names, sorted.
func branches(t *testing.T, repo testkit.TestRepo) []string {
	t.Helper()
	names := []string{}
	for _, line := range strings.Split(repo.Git("branch", "--format=%(refname:short)"), "\n") {
		if line != "" {
			names = append(names, line)
		}
	}
	return names
}

// jobWithWorkspace is a job whose workspace names the given worktree and branch.
func jobWithWorkspace(world cleanupWorld, state domain.JobState, worktree, branch string) domain.Job {
	return testkit.AJob(func(job *domain.Job) {
		job.State = state
		job.Workspace = domain.Workspace{
			RepoRoot:     world.repo.Dir,
			BaseSha:      world.repo.Head(),
			Worktree:     &worktree,
			Branch:       &branch,
			ArtifactsDir: filepath.Join(world.stateRoot, "jobs", "j1", "artifacts"),
		}
	})
}

// decidedJobWithWorktree is a decided job whose worktree and branch outlived the decision — the
// classic leftover.
func decidedJobWithWorktree(t *testing.T, world cleanupWorld, state domain.JobState) string {
	t.Helper()
	worktree := filepath.Join(world.stateRoot, "worktrees", "j1")
	world.repo.Git("worktree", "add", "-q", "-b", "zai/j1", "--", worktree, world.repo.Head())
	if _, err := world.store.Create(context.Background(), jobWithWorkspace(world, state, worktree, "zai/j1")); err != nil {
		t.Fatal(err)
	}
	return worktree
}

func TestCleanupWorkspace(t *testing.T) {
	ctx := context.Background()

	// A decided job whose worktree and branch outlived the decision.
	for _, state := range []domain.JobState{domain.JobStateAccepted, domain.JobStateDiscarded} {
		t.Run("removes the leftover worktree and branch of a "+string(state)+" job", func(t *testing.T) {
			world := newCleanupWorld(t)
			worktree := decidedJobWithWorktree(t, world, state)

			app.CleanupWorkspace(ctx, world.deps)

			if _, err := os.Stat(worktree); err == nil {
				t.Error("the worktree should be gone")
			}
			if got := worktreePaths(t, world.repo); !reflect.DeepEqual(got, []string{world.repo.Dir}) {
				t.Errorf("worktrees = %v, want only the repository itself", got)
			}
			if got := branches(t, world.repo); !reflect.DeepEqual(got, []string{"main"}) {
				t.Errorf("branches = %v, want only main", got)
			}
			// The job record itself is not cleanup's to remove.
			if _, err := os.Stat(filepath.Join(world.stateRoot, "jobs", "j1")); err != nil {
				t.Errorf("the job record should stay: %v", err)
			}
		})
	}

	t.Run("keeps the worktree of a job that is still running", func(t *testing.T) {
		world := newCleanupWorld(t)
		worktree := filepath.Join(world.stateRoot, "worktrees", "j1")
		world.repo.Git("worktree", "add", "-q", "-b", "zai/j1", "--", worktree, world.repo.Head())
		if _, err := world.store.Create(ctx, jobWithWorkspace(world, domain.JobStateRunning, worktree, "zai/j1")); err != nil {
			t.Fatal(err)
		}

		app.CleanupWorkspace(ctx, world.deps)

		if _, err := os.Stat(worktree); err != nil {
			t.Errorf("the worktree should stay: %v", err)
		}
		if !slices.Contains(branches(t, world.repo), "zai/j1") {
			t.Error("the branch should stay")
		}
	})

	t.Run("keeps a worktree it did not create, even on one of its branches", func(t *testing.T) {
		world := newCleanupWorld(t)
		worktree := filepath.Join(testkit.TempDir(t, "zai-user-"), "wt")
		world.repo.Git("worktree", "add", "-q", "-b", "zai/j1", "--", worktree, world.repo.Head())
		if _, err := world.store.Create(ctx, jobWithWorkspace(world, domain.JobStateAccepted, worktree, "zai/j1")); err != nil {
			t.Fatal(err)
		}

		app.CleanupWorkspace(ctx, world.deps)

		if _, err := os.Stat(worktree); err != nil {
			t.Errorf("the user's worktree should stay: %v", err)
		}
		if !slices.Contains(worktreePaths(t, world.repo), worktree) {
			t.Error("the worktree should stay registered")
		}
		if !slices.Contains(branches(t, world.repo), "zai/j1") {
			t.Error("the branch should stay")
		}
	})

	t.Run("keeps a worktree under its state root whose branch is not one of its own", func(t *testing.T) {
		world := newCleanupWorld(t)
		worktree := filepath.Join(world.stateRoot, "worktrees", "j1")
		world.repo.Git("worktree", "add", "-q", "-b", "feature", "--", worktree, world.repo.Head())
		if _, err := world.store.Create(ctx, jobWithWorkspace(world, domain.JobStateAccepted, worktree, "feature")); err != nil {
			t.Fatal(err)
		}

		app.CleanupWorkspace(ctx, world.deps)

		if _, err := os.Stat(worktree); err != nil {
			t.Errorf("the worktree should stay: %v", err)
		}
		if !slices.Contains(branches(t, world.repo), "feature") {
			t.Error("the branch should stay")
		}
	})

	t.Run("keeps a job whose worktree is a relative path (resolved against the working directory, as Node's resolve does)", func(t *testing.T) {
		world := newCleanupWorld(t)
		// "." exists and is relative, so it reaches the resolution and never matches the state
		// root's own path.
		if _, err := world.store.Create(ctx, jobWithWorkspace(world, domain.JobStateAccepted, ".", "zai/j1")); err != nil {
			t.Fatal(err)
		}

		app.CleanupWorkspace(ctx, world.deps)
	})

	t.Run("a decided job without a worktree is nothing to remove", func(t *testing.T) {
		world := newCleanupWorld(t)
		job := testkit.AJob(func(j *domain.Job) {
			j.State = domain.JobStateAccepted
			j.Workspace = domain.Workspace{
				RepoRoot:     world.repo.Dir,
				BaseSha:      world.repo.Head(),
				ArtifactsDir: filepath.Join(world.stateRoot, "jobs", "j9", "artifacts"),
			}
		})
		if _, err := world.store.Create(ctx, job); err != nil {
			t.Fatal(err)
		}

		app.CleanupWorkspace(ctx, world.deps)

		if got := worktreePaths(t, world.repo); !reflect.DeepEqual(got, []string{world.repo.Dir}) {
			t.Errorf("worktrees = %v, want only the repository itself", got)
		}
	})

	t.Run("ends the pass quietly when a leftover worktree cannot be removed", func(t *testing.T) {
		world := newCleanupWorld(t)
		// A plain directory where the state root's worktree would be: git refuses it, and the
		// directory still stands, so the removal fails.
		worktree := filepath.Join(world.stateRoot, "worktrees", "j1")
		if err := os.MkdirAll(worktree, 0o755); err != nil {
			t.Fatal(err)
		}
		if _, err := world.store.Create(ctx, jobWithWorkspace(world, domain.JobStateAccepted, worktree, "zai/j1")); err != nil {
			t.Fatal(err)
		}

		app.CleanupWorkspace(ctx, world.deps)

		if _, err := os.Stat(worktree); err != nil {
			t.Errorf("the unremovable worktree should still stand: %v", err)
		}
	})

	t.Run("removes the leftover checkout of a job the store no longer knows", func(t *testing.T) {
		world := newCleanupWorld(t)
		checkout := filepath.Join(world.stateRoot, "checkouts", "ghost")
		world.repo.Git("worktree", "add", "-q", "--detach", "--", checkout, world.repo.Head())

		app.CleanupWorkspace(ctx, world.deps)

		if _, err := os.Stat(checkout); err == nil {
			t.Error("the checkout should be gone")
		}
		if got := worktreePaths(t, world.repo); !reflect.DeepEqual(got, []string{world.repo.Dir}) {
			t.Errorf("worktrees = %v, want only the repository itself", got)
		}
	})

	t.Run("removes the leftover checkout of an idle job, and releases its lock", func(t *testing.T) {
		world := newCleanupWorld(t)
		if _, err := world.store.Create(ctx, jobWithWorkspace(
			world, domain.JobStateRunning,
			filepath.Join(world.stateRoot, "worktrees", "j1"), "zai/j1",
		)); err != nil {
			t.Fatal(err)
		}
		checkout := filepath.Join(world.stateRoot, "checkouts", "j1")
		world.repo.Git("worktree", "add", "-q", "--detach", "--", checkout, world.repo.Head())

		app.CleanupWorkspace(ctx, world.deps)

		if _, err := os.Stat(checkout); err == nil {
			t.Error("the checkout should be gone")
		}
		if got := worktreePaths(t, world.repo); !reflect.DeepEqual(got, []string{world.repo.Dir}) {
			t.Errorf("worktrees = %v, want only the repository itself", got)
		}
		// The lock was taken only to hold the slot while removing.
		if _, err := world.store.Lock(ctx, "j1", int64(os.Getpid())); err != nil {
			t.Errorf("the lock should be free again: %v", err)
		}
	})

	t.Run("leaves a checkout alone while an accept may still be in flight", func(t *testing.T) {
		world := newCleanupWorld(t)
		if _, err := world.store.Create(ctx, jobWithWorkspace(
			world, domain.JobStateRunning,
			filepath.Join(world.stateRoot, "worktrees", "j1"), "zai/j1",
		)); err != nil {
			t.Fatal(err)
		}
		checkout := filepath.Join(world.stateRoot, "checkouts", "j1")
		world.repo.Git("worktree", "add", "-q", "--detach", "--", checkout, world.repo.Head())
		holder := exec.Command("sleep", "30")
		if err := holder.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_ = holder.Process.Kill()
			_, _ = holder.Process.Wait()
		})
		release, err := world.store.Lock(ctx, "j1", int64(holder.Process.Pid))
		if err != nil {
			t.Fatalf("the accept could not take the lock: %v", err)
		}

		app.CleanupWorkspace(ctx, world.deps)
		if _, err := os.Stat(checkout); err != nil {
			t.Errorf("the in-flight accept's checkout should stay: %v", err)
		}
		release()

		// Once the accept is gone, the same cleanup takes it.
		app.CleanupWorkspace(ctx, world.deps)
		if _, err := os.Stat(checkout); err == nil {
			t.Error("the leftover checkout should be gone once the accept released it")
		}
	})

	t.Run("does nothing, quietly, when there is nothing to clean", func(t *testing.T) {
		world := newCleanupWorld(t)

		app.CleanupWorkspace(ctx, world.deps)

		if got := worktreePaths(t, world.repo); !reflect.DeepEqual(got, []string{world.repo.Dir}) {
			t.Errorf("worktrees = %v, want only the repository itself", got)
		}
	})

	t.Run("ends the pass quietly when a leftover checkout cannot be removed", func(t *testing.T) {
		world := newCleanupWorld(t)
		if _, err := world.store.Create(ctx, jobWithWorkspace(
			world, domain.JobStateRunning,
			filepath.Join(world.stateRoot, "worktrees", "j1"), "zai/j1",
		)); err != nil {
			t.Fatal(err)
		}
		checkout := unregisteredCheckout(t, world)

		app.CleanupWorkspace(ctx, world.deps)

		if _, err := os.Stat(checkout); err != nil {
			t.Errorf("the unremovable checkout should still stand: %v", err)
		}
		// The lock it took to try is free again.
		if _, err := world.store.Lock(ctx, "j1", int64(os.Getpid())); err != nil {
			t.Errorf("the lock should be free again: %v", err)
		}
	})

	t.Run("ends the pass quietly when an unknown job's leftover checkout cannot be removed", func(t *testing.T) {
		world := newCleanupWorld(t)
		checkout := unregisteredCheckout(t, world)

		app.CleanupWorkspace(ctx, world.deps)

		if _, err := os.Stat(checkout); err != nil {
			t.Errorf("the unremovable checkout should still stand: %v", err)
		}
	})
}

// unregisteredCheckout is a checkout directory whose .git file points at a worktree registration
// that does not exist, so git refuses to remove it while the directory stands.
func unregisteredCheckout(t *testing.T, world cleanupWorld) string {
	t.Helper()
	checkout := filepath.Join(world.stateRoot, "checkouts", "j1")
	if err := os.MkdirAll(checkout, 0o755); err != nil {
		t.Fatal(err)
	}
	gitFile := "gitdir: " + filepath.Join(world.repo.Dir, ".git", "worktrees", "never-registered")
	if err := os.WriteFile(filepath.Join(checkout, ".git"), []byte(gitFile), 0o644); err != nil {
		t.Fatal(err)
	}
	return checkout
}
