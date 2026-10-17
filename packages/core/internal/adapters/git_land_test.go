package adapters

// readTrailer and isAncestor against real git: the quiet exit-1 conventions both lean on, and what
// lies outside them.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

func TestReadTrailer(t *testing.T) {
	testkit.IsolateGitConfig(t)

	t.Run("worked-by when the key is unset", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		setting, err := ReadTrailer(t.Context(), "zai", repo.Dir)
		if err != nil {
			t.Fatalf("readTrailer() = %v, want worked-by", err)
		}
		if setting != ports.TrailerSettingWorkedBy {
			t.Fatalf("readTrailer() = %q, want worked-by", setting)
		}
	})

	t.Run("worked-by when set to an empty value", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Git("config", "zai.trailer", "")
		setting, err := ReadTrailer(t.Context(), "zai", repo.Dir)
		if err != nil {
			t.Fatalf("readTrailer() = %v, want worked-by", err)
		}
		if setting != ports.TrailerSettingWorkedBy {
			t.Fatalf("readTrailer() = %q, want worked-by", setting)
		}
	})

	t.Run("none when set to none", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Git("config", "zai.trailer", "none")
		setting, err := ReadTrailer(t.Context(), "zai", repo.Dir)
		if err != nil {
			t.Fatalf("readTrailer() = %v, want none", err)
		}
		if setting != ports.TrailerSettingNone {
			t.Fatalf("readTrailer() = %q, want none", setting)
		}
	})

	t.Run("any other value is an error, not a guess", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Git("config", "zai.trailer", "maybe")
		setting, err := ReadTrailer(t.Context(), "zai", repo.Dir)
		if err == nil {
			t.Fatalf("readTrailer() = %q, want an error", setting)
		}
		gitErr := gitCliErr(t, err)
		if gitErr.Kind != ports.GitErrorGitFailed ||
			gitErr.Command != "git config --get zai.trailer" ||
			gitErr.Stderr != `"maybe" is not worked-by or none` {
			t.Fatalf("readTrailer() = %+v, want the maybe rejection", gitErr)
		}
	})

	t.Run("a config git itself rejects is a real failure, not a quiet exit 1", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		if err := os.WriteFile(filepath.Join(repo.Dir, ".git", "config"), []byte("[core\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		_, err := ReadTrailer(t.Context(), "zai", repo.Dir)
		gitErr := gitCliWantError(t, err, ports.GitErrorGitFailed)
		if gitErr.Command != "git config --get zai.trailer" {
			t.Fatalf("command = %q, want the config command line", gitErr.Command)
		}
	})
}

func TestIsAncestor(t *testing.T) {
	testkit.IsolateGitConfig(t)

	t.Run("true one way, false the other", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		first := repo.Head()
		repo.Git("commit", "--quiet", "--allow-empty", "-m", "second")
		second := repo.Head()

		if ok, err := IsAncestor(t.Context(), repo.Dir, first, second); err != nil || !ok {
			t.Fatalf("isAncestor(first, second) = %v, %v; want true", ok, err)
		}
		if ok, err := IsAncestor(t.Context(), repo.Dir, second, first); err != nil || ok {
			t.Fatalf("isAncestor(second, first) = %v, %v; want false", ok, err)
		}
	})

	t.Run("a ref that does not exist is an error", func(t *testing.T) {
		repo := testkit.MakeRepo(t)

		_, err := IsAncestor(t.Context(), repo.Dir, "no-such-ref", "HEAD")
		if err == nil {
			t.Fatal("isAncestor(no-such-ref, HEAD) = nil, want an error")
		}
		gitErr := gitCliErr(t, err)
		if gitErr.Kind != ports.GitErrorGitFailed ||
			gitErr.Command != "git merge-base --is-ancestor --end-of-options no-such-ref HEAD" ||
			gitErr.Stderr == "" {
			t.Fatalf("isAncestor(no-such-ref, HEAD) = %+v, want git_failed with git's message", gitErr)
		}
	})
}

// The rebase's own failure modes: the git CLI tests drive the two outcomes (settled and aborted);
// these are the paths around them.
func TestRebaseJobBranchFailures(t *testing.T) {
	testkit.IsolateGitConfig(t)

	t.Run("outside a repository reports not_a_repo", func(t *testing.T) {
		outside := testkit.TempDir(t, "outside-")
		err := RebaseJobBranch(t.Context(), outside, "HEAD", nil)
		gitCliWantNotARepo(t, err, outside)
	})

	t.Run("a rebase that fails without stopping is git's own failure", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		wt := gitApplyWorktree(t, repo, "zai/job", repo.Head())
		err := RebaseJobBranch(t.Context(), wt.Dir, strings.Repeat("0", 40), nil)
		gitCliWantError(t, err, ports.GitErrorGitFailed)
		if !strings.Contains(gitCliErr(t, err).Stderr, "fatal") {
			t.Fatalf("stderr = %q, want git's own complaint about the unknown upstream", gitCliErr(t, err).Stderr)
		}
	})

	t.Run("stops on each conflicting regenerated commit and settles one stop per round", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("gen.txt", "base\n")
		base := repo.CommitAll("base")
		wt := gitApplyWorktree(t, repo, "zai/job", base)
		// code*.txt keep the replayed commits from becoming empty: their only other change is the
		// regenerated file, whose conflicts all settle to the tip's side.
		wt.Write("gen.txt", "by job, first\n")
		wt.Write("code1.txt", "one\n")
		wt.CommitAll("first")
		wt.Write("gen.txt", "by job, second\n")
		wt.Write("code2.txt", "two\n")
		wt.CommitAll("second")
		repo.Write("gen.txt", "by user\n")
		tip := repo.CommitAll("user moved on")

		if err := RebaseJobBranch(t.Context(), wt.Dir, tip, []string{"gen.txt"}); err != nil {
			t.Fatalf("rebaseJobBranch() = %v, want nil", err)
		}
		if got := strings.TrimSpace(wt.Git("rev-parse", "HEAD~2")); got != tip {
			t.Fatalf("HEAD~2 = %q, want the tip %q (both job commits replayed onto it)", got, tip)
		}
		if got := strings.TrimSpace(wt.Git("log", "-1", "--format=%s")); got != "second" {
			t.Fatalf("the last subject = %q, want second", got)
		}
		if got := wt.Read("gen.txt"); got != "by user\n" {
			t.Fatalf("gen.txt = %q, want the tip's side at every stop", got)
		}
		for _, path := range []string{"code1.txt", "code2.txt"} {
			if _, statErr := os.Stat(filepath.Join(wt.Dir, path)); statErr != nil {
				t.Fatalf("%s is gone, want the job's own work kept: %v", path, statErr)
			}
		}
		if status := wt.Git("status", "--porcelain"); status != "" {
			t.Fatalf("status = %q, want empty", status)
		}
	})

	t.Run("a regenerated path with no ours-version fails the settle and aborts", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("gen.txt", "base\n")
		repo.CommitAll("base")
		repo.Git("branch", "zai/job")
		repo.Git("rm", "-q", "gen.txt")
		tip := repo.CommitAll("user deletes gen")
		repo.Git("checkout", "-q", "zai/job")
		repo.Write("gen.txt", "by job\n")
		jobHead := repo.CommitAll("job")

		err := RebaseJobBranch(t.Context(), repo.Dir, tip, []string{"gen.txt"})
		gitErr := gitCliWantError(t, err, ports.GitErrorGitFailed)
		if !strings.Contains(gitErr.Stderr, "does not have our version") {
			t.Fatalf("stderr = %q, want the checkout --ours complaint", gitErr.Stderr)
		}
		if repo.Head() != jobHead {
			t.Fatalf("HEAD = %q, want the aborted-back %q", repo.Head(), jobHead)
		}
		if status := repo.Git("status", "--porcelain"); status != "" {
			t.Fatalf("status = %q, want empty (the abort undid everything)", status)
		}
	})

	t.Run("an unmerged listing git cannot run is a real failure", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("gen.txt", "base\n")
		repo.CommitAll("base")
		repo.Git("branch", "zai/job")
		repo.Write("gen.txt", "by user\n")
		tip := repo.CommitAll("user moved on")
		repo.Git("checkout", "-q", "zai/job")
		repo.Write("gen.txt", "by job\n")
		repo.CommitAll("job")
		// Stop a rebase by hand, then break the one command the settlement reads first.
		_, _ = testkit.Git(repo.Dir, "rebase", "--quiet", tip)
		if err := os.WriteFile(filepath.Join(repo.Dir, ".git", "index"), []byte("garbage-not-an-index"), 0o644); err != nil {
			t.Fatal(err)
		}

		err := RebaseJobBranch(t.Context(), repo.Dir, tip, []string{"gen.txt"})
		gitErr := gitCliWantError(t, err, ports.GitErrorGitFailed)
		if !strings.Contains(gitErr.Stderr, "index") {
			t.Fatalf("stderr = %q, want the corrupt index complaint", gitErr.Stderr)
		}
	})

	t.Run("an abort that itself fails is the reported failure", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("gen.txt", "base\n")
		repo.CommitAll("base")
		repo.Git("branch", "zai/job")
		repo.Git("rm", "-q", "gen.txt")
		tip := repo.CommitAll("user deletes gen")
		repo.Git("checkout", "-q", "zai/job")
		repo.Write("gen.txt", "by job\n")
		repo.CommitAll("job")
		_, _ = testkit.Git(repo.Dir, "rebase", "--quiet", tip)
		// The rebase state no longer readable: settling fails and the abort cannot undo it.
		state := filepath.Join(repo.Dir, ".git", "rebase-merge")
		t.Cleanup(func() { _ = os.Chmod(state, 0o755) })
		if err := os.Chmod(state, 0o000); err != nil {
			t.Fatal(err)
		}

		err := RebaseJobBranch(t.Context(), repo.Dir, tip, []string{"gen.txt"})
		gitCliWantError(t, err, ports.GitErrorGitFailed)
	})
}
