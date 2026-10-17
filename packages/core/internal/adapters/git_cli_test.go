package adapters

// The Git adapter over the git CLI. Integration: every test builds a throwaway repo under the
// test's temp root, through the real git binary.

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// gitCliVerify is the commit options with the repository's hooks on.
var gitCliVerify = ports.CommitOptions{Verify: true}

// gitCliErr reads an error back as the git error it must be.
func gitCliErr(t *testing.T, err error) *ports.GitError {
	t.Helper()
	var gitErr *ports.GitError
	if !errors.As(err, &gitErr) {
		t.Fatalf("error %v is not a git error", err)
	}
	return gitErr
}

// gitCliWantError fails the test unless err is the wanted GitError kind (and carries paths, when
// given); it returns the error for further checks.
func gitCliWantError(t *testing.T, err error, want ports.GitErrorKind, paths ...string) *ports.GitError {
	t.Helper()
	if err == nil {
		t.Fatalf("error = nil, want %s", want)
	}
	gitErr := gitCliErr(t, err)
	if gitErr.Kind != want {
		t.Fatalf("error = %s (%s), want %s", gitErr.Kind, err, want)
	}
	if len(paths) > 0 && !reflect.DeepEqual(gitErr.Paths, paths) {
		t.Fatalf("error paths = %q, want %q", gitErr.Paths, paths)
	}
	return gitErr
}

// gitCliWantNotARepo fails the test unless err is the not_a_repo error for dir.
func gitCliWantNotARepo(t *testing.T, err error, dir string) {
	t.Helper()
	gitErr := gitCliWantError(t, err, ports.GitErrorNotARepo)
	if gitErr.Path != dir {
		t.Fatalf("error path = %q, want %q", gitErr.Path, dir)
	}
}

// gitCliWorktreePath is a not-yet-existing worktree path under a fresh temp root.
func gitCliWorktreePath(t *testing.T, name string) string {
	t.Helper()
	return filepath.Join(testkit.TempDir(t, "wt-root-"), name)
}

// gitCliInstallPreCommit points the repository at a hooks directory whose pre-commit hook prints and
// exits with code; it returns the hook's marker path.
func gitCliInstallPreCommit(t *testing.T, repo testkit.TestRepo, code int) string {
	t.Helper()
	hooks := filepath.Join(t.TempDir(), "hooks")
	if err := os.Mkdir(hooks, 0o755); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(hooks, "ran")
	script := "#!/bin/sh\ntouch \"" + marker + "\"\necho \"lint: 2 problems in README.md\" >&2\nexit " +
		strconv.Itoa(code) + "\n"
	if err := os.WriteFile(filepath.Join(hooks, "pre-commit"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	repo.Git("config", "core.hooksPath", hooks)
	return marker
}

// gitCliNameStatusLines is `show --name-status` as sorted non-empty lines.
func gitCliNameStatusLines(t *testing.T, repo testkit.TestRepo) []string {
	t.Helper()
	listed := strings.Split(repo.Git("show", "--name-status", "--format=", "HEAD"), "\n")
	lines := make([]string, 0, len(listed))
	for _, line := range listed {
		if line != "" {
			lines = append(lines, line)
		}
	}
	sort.Strings(lines)
	return lines
}

func TestGitCli(t *testing.T) {
	testkit.IsolateGitConfig(t)
	git := CreateGitCli(testkit.ReferenceProvider.Name)

	t.Run("root resolves the top level from a subdirectory; not_a_repo outside one", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		sub := filepath.Join(repo.Dir, "a", "b")
		if err := os.MkdirAll(sub, 0o755); err != nil {
			t.Fatal(err)
		}
		outside := testkit.TempDir(t, "outside-")

		top, err := git.Root(t.Context(), sub)
		if err != nil || filepath.Clean(top) != filepath.Clean(repo.Dir) {
			t.Fatalf("root(sub) = %q, %v; want %q", top, err, repo.Dir)
		}
		_, err = git.Root(t.Context(), outside)
		gitCliWantNotARepo(t, err, outside)
		_, err = git.Root(t.Context(), filepath.Join(outside, "missing"))
		gitCliWantNotARepo(t, err, filepath.Join(outside, "missing"))
	})

	t.Run("resolve returns the sha for HEAD/branch; bad_ref for nonsense", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		head := repo.Head()
		repo.Git("branch", "feature")

		for _, ref := range []string{"HEAD", "feature", head[:8]} {
			sha, err := git.Resolve(t.Context(), repo.Dir, ref)
			if err != nil || sha != head {
				t.Fatalf("resolve(%q) = %q, %v; want %q", ref, sha, err, head)
			}
		}
		for _, ref := range []string{"no-such-branch", "--output=/tmp/x", "HEAD~5"} {
			_, err := git.Resolve(t.Context(), repo.Dir, ref)
			if err == nil {
				t.Fatalf("resolve(%q) = nil, want bad_ref", ref)
			}
			gitErr := gitCliErr(t, err)
			if gitErr.Kind != ports.GitErrorBadRef || gitErr.Ref != ref {
				t.Fatalf("resolve(%q) = %s (ref %q), want bad_ref (ref %q)", ref, gitErr.Kind, gitErr.Ref, ref)
			}
		}
	})

	t.Run("currentBranch names the checked-out branch; a detached HEAD is an error", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		branch, err := git.CurrentBranch(t.Context(), repo.Dir)
		if err != nil || branch != "main" {
			t.Fatalf("currentBranch() = %q, %v; want main", branch, err)
		}

		repo.Git("switch", "-q", "--detach")
		_, err = git.CurrentBranch(t.Context(), repo.Dir)
		gitCliWantError(t, err, ports.GitErrorGitFailed)
	})

	t.Run("addWorktree creates the worktree on a new branch at baseSha; removeWorktree removes both", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		base := repo.Head()
		repo.Write("later.txt", "after base\n")
		repo.CommitAll("later")
		path := filepath.Join(gitCliWorktreePath(t, "root"), "nested dir", "wt-1")

		if err := git.AddWorktree(t.Context(), repo.Dir, path, "zai/job-1", base); err != nil {
			t.Fatalf("addWorktree() = %v, want nil", err)
		}
		if sha, err := git.Resolve(t.Context(), path, "HEAD"); err != nil || sha != base {
			t.Fatalf("resolve(HEAD) = %q, %v; want the base %q", sha, err, base)
		}
		if branch, err := git.CurrentBranch(t.Context(), path); err != nil || branch != "zai/job-1" {
			t.Fatalf("currentBranch() = %q, %v; want zai/job-1", branch, err)
		}
		if _, statErr := os.Stat(filepath.Join(path, "later.txt")); !os.IsNotExist(statErr) {
			t.Fatal("later.txt exists in the worktree, want the base tree")
		}
		if err := os.WriteFile(filepath.Join(path, "scratch.txt"), []byte("uncommitted work\n"), 0o644); err != nil {
			t.Fatal(err)
		}

		if err := git.RemoveWorktree(t.Context(), repo.Dir, path, "zai/job-1"); err != nil {
			t.Fatalf("removeWorktree() = %v, want nil", err)
		}
		if _, statErr := os.Stat(path); !os.IsNotExist(statErr) {
			t.Fatal("the worktree path still exists, want it removed")
		}
		if listed := repo.Git("branch", "--list", "zai/job-1"); listed != "" {
			t.Fatalf("branch --list = %q, want empty (the branch is gone too)", listed)
		}
		if listed := repo.Git("worktree", "list", "--porcelain"); strings.Contains(listed, "wt-1") {
			t.Fatalf("worktree list = %q, want it without the removed worktree", listed)
		}
		// Removing again (e.g. a retried discard) is a no-op.
		if err := git.RemoveWorktree(t.Context(), repo.Dir, path, "zai/job-1"); err != nil {
			t.Fatalf("removeWorktree(again) = %v, want nil", err)
		}
	})

	t.Run("addWorktree fails when the branch already exists", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Git("branch", "zai/taken")
		err := git.AddWorktree(t.Context(), repo.Dir, gitCliWorktreePath(t, "wt"), "zai/taken", repo.Head())
		gitCliWantError(t, err, ports.GitErrorGitFailed)
	})

	t.Run("changes lists added, modified, deleted and untracked paths against baseSha (rename = delete + add)", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("src/keep.ts", "keep\n")
		repo.Write("src/edit.ts", "v1\n")
		repo.Write("src/gone.ts", "gone\n")
		repo.Write("src/old-name.ts", "a file long enough to be detected as a rename by default\n")
		repo.Write(".gitignore", "build/\n")
		base := repo.CommitAll("base")
		repo.Write("src/edit.ts", "v2\n")
		repo.Remove("src/gone.ts")
		repo.Git("mv", "src/old-name.ts", "src/new-name.ts")
		repo.Write("src/staged-new.ts", "new\n")
		repo.Git("add", "src/staged-new.ts")
		repo.Write("notes/untracked.md", "fresh\n")
		repo.Write("build/out.js", "ignored\n")
		repo.Git("config", "diff.renames", "copies")

		changes, err := git.Changes(t.Context(), repo.Dir, base)
		if err != nil {
			t.Fatalf("changes() = %v, want the change set", err)
		}
		want := domain.ChangeSet{
			Added:     []string{"src/new-name.ts", "src/staged-new.ts"},
			Modified:  []string{"src/edit.ts"},
			Deleted:   []string{"src/gone.ts", "src/old-name.ts"},
			Untracked: []string{"notes/untracked.md"},
		}
		if !reflect.DeepEqual(changes, want) {
			t.Fatalf("changes() = %+v, want %+v", changes, want)
		}
	})

	t.Run("changes handles paths with spaces and unicode (NUL-separated parsing)", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		odd := []string{"with space.txt", "ünïcødé/日本語.md", "tab\there.txt", "new\nline.txt", `"quoted".txt`}
		untracked := "untracked dir/ça va?.txt"
		for _, path := range odd {
			repo.Write(path, "v1\n")
		}
		base := repo.CommitAll("odd names")
		for _, path := range odd {
			repo.Write(path, "v2\n")
		}
		repo.Write(untracked, "x\n")

		changes, err := git.Changes(t.Context(), repo.Dir, base)
		if err != nil {
			t.Fatalf("changes() = %v, want the change set", err)
		}
		sorted := append([]string{}, odd...)
		sort.Strings(sorted)
		want := domain.ChangeSet{
			Added:     []string{},
			Modified:  sorted,
			Deleted:   []string{},
			Untracked: []string{untracked},
		}
		if !reflect.DeepEqual(changes, want) {
			t.Fatalf("changes() = %+v, want %+v", changes, want)
		}
	})

	t.Run("changes reports a bad base as an error", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		_, err := git.Changes(t.Context(), repo.Dir, strings.Repeat("0", 40))
		gitCliWantError(t, err, ports.GitErrorGitFailed)
	})

	t.Run("statusFingerprint changes when a file changes and is stable otherwise", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("dirty.txt", "v1\n")
		repo.Write("gone.txt", "tracked\n")
		repo.CommitAll("dirty")
		repo.Write("dirty.txt", "v2\n")
		repo.Write("scratch.txt", "s1\n")
		repo.Remove("gone.txt")
		if err := os.Symlink("dirty.txt", filepath.Join(repo.Dir, "link")); err != nil {
			t.Fatal(err)
		}
		fingerprint := func() string {
			value, err := git.StatusFingerprint(t.Context(), repo.Dir)
			if err != nil {
				t.Fatalf("statusFingerprint() = %v", err)
			}
			return value
		}
		before := fingerprint()

		if again := fingerprint(); again != before {
			t.Fatal("the fingerprint changed with nothing changed")
		}
		// An already-modified file modified again keeps the same porcelain line: the content must still count.
		repo.Write("dirty.txt", "v3\n")
		edited := fingerprint()
		if edited == before {
			t.Fatal("the fingerprint ignored a second edit of an already-dirty file")
		}
		repo.Write("scratch.txt", "s2\n")
		scratched := fingerprint()
		if scratched == edited {
			t.Fatal("the fingerprint ignored an untracked file's new content")
		}
		repo.Remove("link")
		if err := os.Symlink("scratch.txt", filepath.Join(repo.Dir, "link")); err != nil {
			t.Fatal(err)
		}
		relinked := fingerprint()
		if relinked == scratched {
			t.Fatal("the fingerprint ignored the link's new target")
		}
		repo.Write("dirty.txt", "v1\n")
		repo.Write("gone.txt", "tracked\n")
		repo.Remove("scratch.txt")
		repo.Remove("link")
		clean := fingerprint()
		if clean == scratched {
			t.Fatal("the fingerprint ignored the cleanup")
		}
		// A commit leaves a clean status before and after: HEAD itself is part of the fingerprint.
		repo.Git("commit", "-q", "--allow-empty", "-m", "moved")
		moved := fingerprint()
		if moved == clean {
			t.Fatal("the fingerprint ignored the new HEAD")
		}
		repo.Git("switch", "-q", "--detach")
		if after := fingerprint(); after == moved {
			t.Fatal("the fingerprint ignored the detached HEAD")
		}
	})

	t.Run("statusFingerprint works before the first commit", func(t *testing.T) {
		dir := testkit.TempDir(t, "empty-repo-")
		testkit.Git(dir, "init", "-q", "-b", "main")
		empty, err := git.StatusFingerprint(t.Context(), dir)
		if err != nil {
			t.Fatalf("statusFingerprint() = %v, want a value", err)
		}
		if err := os.WriteFile(filepath.Join(dir, "first.txt"), []byte("x\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		one, err := git.StatusFingerprint(t.Context(), dir)
		if err != nil {
			t.Fatalf("statusFingerprint() = %v, want a value", err)
		}
		if one == empty {
			t.Fatal("the fingerprint ignored the first file")
		}
	})

	t.Run("statusFingerprint reports not_a_repo outside a repository", func(t *testing.T) {
		outside := testkit.TempDir(t, "outside-")
		_, err := git.StatusFingerprint(t.Context(), outside)
		gitCliWantNotARepo(t, err, outside)
	})

	t.Run("diff --stat and full diff include untracked files", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		base := repo.Head()
		repo.Write("README.md", "# test repo\nedited\n")
		repo.Write("docs/new file.md", "brand new line\n")

		stat, err := git.Diff(t.Context(), repo.Dir, base, ports.DiffOptions{Stat: true})
		if err != nil {
			t.Fatalf("diff(stat) = %v", err)
		}
		full, err := git.Diff(t.Context(), repo.Dir, base, ports.DiffOptions{})
		if err != nil {
			t.Fatalf("diff() = %v", err)
		}

		for _, want := range []string{"2 files changed, 2 insertions(+)", "docs/new file.md | 1 +", "README.md        | 1 +"} {
			if !strings.Contains(stat, want) {
				t.Fatalf("diff --stat = %q, want it to contain %q", stat, want)
			}
		}
		// git terminates a ---/+++ name that contains a space with a tab.
		for _, want := range []string{"+++ b/docs/new file.md\t\n@@ -0,0 +1 @@\n+brand new line\n", "+edited\n"} {
			if !strings.Contains(full, want) {
				t.Fatalf("diff = %q, want it to contain %q", full, want)
			}
		}
		// The worktree's own index is untouched: the new file is still untracked, not staged.
		changes, err := git.Changes(t.Context(), repo.Dir, base)
		if err != nil {
			t.Fatalf("changes() = %v", err)
		}
		want := domain.ChangeSet{
			Added:     []string{},
			Modified:  []string{"README.md"},
			Deleted:   []string{},
			Untracked: []string{"docs/new file.md"},
		}
		if !reflect.DeepEqual(changes, want) {
			t.Fatalf("changes() = %+v, want %+v", changes, want)
		}
	})

	t.Run("diff sees a same-size edit whose stat info matches the index (a racily clean entry stays racy in the snapshot)", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		past := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
		repo.Write("value.txt", "wrong\n")
		gitChtimes(t, filepath.Join(repo.Dir, "value.txt"), past)
		repo.CommitAll("value")
		base := repo.Head()
		// Same size, same mtime as recorded in the index, and the index itself no newer: only the
		// content differs, which git checks because the entry is racy (its mtime is not older than
		// the index file's).
		repo.Write("value.txt", "right\n")
		gitChtimes(t, filepath.Join(repo.Dir, "value.txt"), past)
		gitChtimes(t, filepath.Join(repo.Dir, ".git", "index"), past)

		full, err := git.Diff(t.Context(), repo.Dir, base, ports.DiffOptions{})
		if err != nil {
			t.Fatalf("diff() = %v", err)
		}
		if !strings.Contains(full, "-wrong\n+right\n") {
			t.Fatalf("diff = %q, want -wrong/+right (the racily clean entry must stay racy)", full)
		}
	})

	t.Run("commitAll stages everything including deletions and returns the new sha", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("doomed.txt", "bye\n")
		base := repo.CommitAll("base")
		worktree := gitCliWorktreePath(t, "wt")
		if err := git.AddWorktree(t.Context(), repo.Dir, worktree, "zai/commit", base); err != nil {
			t.Fatalf("addWorktree() = %v", err)
		}
		wt := testkit.RepoAt(t, worktree)
		wt.Write("README.md", "# changed\n")
		wt.Write("added/new.txt", "new\n")
		wt.Remove("doomed.txt")
		message := "Do the thing\n\n# Summary heading kept\n\nWorked-by: glm-5.3 via zai"

		sha, err := git.CommitAll(t.Context(), worktree, message, gitCliVerify)
		if err != nil {
			t.Fatalf("commitAll() = %v", err)
		}
		if sha != wt.Head() {
			t.Fatalf("commitAll() = %q, want the new HEAD %q", sha, wt.Head())
		}
		if sha == base {
			t.Fatal("commitAll() returned the base sha, want a new commit")
		}
		if got := strings.TrimRight(wt.Git("log", "-1", "--format=%B"), " \t\n"); got != message {
			t.Fatalf("the commit message = %q, want %q (the # heading kept)", got, message)
		}
		if got := gitCliNameStatusLines(t, wt); !reflect.DeepEqual(got, []string{"A\tadded/new.txt", "D\tdoomed.txt", "M\tREADME.md"}) {
			t.Fatalf("show --name-status = %q, want the addition, deletion and modification", got)
		}
		if status := wt.Git("status", "--porcelain"); status != "" {
			t.Fatalf("status = %q, want empty", status)
		}
		if repo.Head() != base {
			t.Fatalf("the main repo HEAD = %q, want the untouched %q", repo.Head(), base)
		}
	})

	t.Run("commitAll runs the repository's commit hooks: a failing hook is git_failed with its output, nothing committed", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		base := repo.Head()
		marker := gitCliInstallPreCommit(t, repo, 1)
		repo.Write("README.md", "# changed\n")

		_, err := git.CommitAll(t.Context(), repo.Dir, "change", gitCliVerify)
		gitErr := gitCliWantError(t, err, ports.GitErrorGitFailed)
		if !strings.Contains(gitErr.Command, "commit") {
			t.Fatalf("command = %q, want the commit command line", gitErr.Command)
		}
		if !strings.Contains(gitErr.Stderr, "lint: 2 problems in README.md") {
			t.Fatalf("stderr = %q, want the hook's output", gitErr.Stderr)
		}
		if _, statErr := os.Stat(marker); os.IsNotExist(statErr) {
			t.Fatal("the hook never ran")
		}
		if repo.Head() != base {
			t.Fatalf("HEAD = %q, want the unchanged %q (nothing committed)", repo.Head(), base)
		}
	})

	t.Run("commitAll with verify false skips the commit hooks", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		marker := gitCliInstallPreCommit(t, repo, 1)
		repo.Write("README.md", "# changed\n")

		sha, err := git.CommitAll(t.Context(), repo.Dir, "change", ports.CommitOptions{Verify: false})
		if err != nil {
			t.Fatalf("commitAll(verify false) = %v", err)
		}
		if sha != repo.Head() {
			t.Fatalf("commitAll() = %q, want the new HEAD %q", sha, repo.Head())
		}
		if _, statErr := os.Stat(marker); !os.IsNotExist(statErr) {
			t.Fatal("the hook ran, want it skipped")
		}
	})

	t.Run("commitAll with nothing to commit is an error", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		_, err := git.CommitAll(t.Context(), repo.Dir, "empty", gitCliVerify)
		gitErr := gitCliWantError(t, err, ports.GitErrorGitFailed)
		if !strings.Contains(gitErr.Command, "commit") || !strings.Contains(gitErr.Stderr, "nothing to commit") {
			t.Fatalf("error = %q / %q, want the commit command and nothing to commit", gitErr.Command, gitErr.Stderr)
		}
	})

	t.Run("trailer reads <provider>.trailer: worked-by unless set to none; an unknown value is an error, not a guess", func(t *testing.T) {
		repo := testkit.MakeRepo(t)

		setting, err := git.Trailer(t.Context(), repo.Dir)
		if err != nil || setting != ports.TrailerSettingWorkedBy {
			t.Fatalf("trailer() = %q, %v; want worked-by", setting, err)
		}
		repo.Git("config", "zai.trailer", "none")
		setting, err = git.Trailer(t.Context(), repo.Dir)
		if err != nil || setting != ports.TrailerSettingNone {
			t.Fatalf("trailer() = %q, %v; want none", setting, err)
		}
		repo.Git("config", "zai.trailer", "signed-off-by")
		setting, err = git.Trailer(t.Context(), repo.Dir)
		if err == nil {
			t.Fatalf("trailer() = %q, want an error", setting)
		}
		gitErr := gitCliErr(t, err)
		if gitErr.Kind != ports.GitErrorGitFailed ||
			gitErr.Command != "git config --get zai.trailer" ||
			gitErr.Stderr != `"signed-off-by" is not worked-by or none` {
			t.Fatalf("trailer() = %+v, want the signed-off-by rejection", gitErr)
		}
	})

	t.Run("isAncestor: true when the first commit contains the second's history, false the other way", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		base := repo.Head()
		repo.Write("later.txt", "later\n")
		tip := repo.CommitAll("later")

		if ok, err := git.IsAncestor(t.Context(), repo.Dir, base, tip); err != nil || !ok {
			t.Fatalf("isAncestor(base, tip) = %v, %v; want true", ok, err)
		}
		if ok, err := git.IsAncestor(t.Context(), repo.Dir, tip, base); err != nil || ok {
			t.Fatalf("isAncestor(tip, base) = %v, %v; want false", ok, err)
		}
	})

	t.Run("rebaseJobBranch replays the job branch onto the tip, taking the tip's side for regenerated paths", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("other.txt", "other\n")
		repo.Write("generated.txt", "base\n")
		repo.Write("code.txt", "base\n")
		base := repo.CommitAll("base")
		wt := testkit.RepoAt(t, gitCliWorktreePath(t, "wt"))
		if err := git.AddWorktree(t.Context(), repo.Dir, wt.Dir, "zai/job", base); err != nil {
			t.Fatalf("addWorktree() = %v", err)
		}
		wt.Write("job.txt", "by job\n")
		wt.Write("generated.txt", "regenerated by job\n")
		wt.Write("code.txt", "by job\n")
		wt.CommitAll("job")
		repo.Write("other.txt", "other, by user\n")
		repo.Write("generated.txt", "regenerated by user\n")
		tip := repo.CommitAll("user moved on")

		if err := git.RebaseJobBranch(t.Context(), wt.Dir, tip, []string{"generated.txt", "dist/**"}); err != nil {
			t.Fatalf("rebaseJobBranch() = %v, want nil", err)
		}

		if got := strings.TrimSpace(wt.Git("rev-parse", "HEAD~1")); got != tip {
			t.Fatalf("HEAD~1 = %q, want the tip %q (the job commit replayed onto it)", got, tip)
		}
		if got := strings.TrimSpace(wt.Git("log", "-1", "--format=%s")); got != "job" {
			t.Fatalf("the last subject = %q, want job", got)
		}
		if got := wt.Read("other.txt"); got != "other, by user\n" {
			t.Fatalf("other.txt = %q, want the tip's own file", got)
		}
		if got := wt.Read("generated.txt"); got != "regenerated by user\n" {
			t.Fatalf("generated.txt = %q, want the tip's side (it is regenerated before landing)", got)
		}
		if got := wt.Read("code.txt"); got != "by job\n" {
			t.Fatalf("code.txt = %q, want the job's side", got)
		}
		if status := wt.Git("status", "--porcelain"); status != "" {
			t.Fatalf("status = %q, want empty", status)
		}
	})

	t.Run("rebaseJobBranch aborts on a conflict outside the regenerated paths, listing every unmerged path", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("code.txt", "line\n")
		repo.Write("generated.txt", "base\n")
		base := repo.CommitAll("base")
		wt := testkit.RepoAt(t, gitCliWorktreePath(t, "wt"))
		if err := git.AddWorktree(t.Context(), repo.Dir, wt.Dir, "zai/job", base); err != nil {
			t.Fatalf("addWorktree() = %v", err)
		}
		wt.Write("code.txt", "line by job\n")
		wt.Write("generated.txt", "regenerated by job\n")
		jobHead := wt.CommitAll("job")
		repo.Write("code.txt", "line by user\n")
		repo.Write("generated.txt", "regenerated by user\n")
		tip := repo.CommitAll("user moved on")

		err := git.RebaseJobBranch(t.Context(), wt.Dir, tip, []string{"generated.txt"})
		gitCliWantError(t, err, ports.GitErrorConflict, "code.txt", "generated.txt")

		if wt.Head() != jobHead {
			t.Fatalf("HEAD = %q, want the aborted-back %q", wt.Head(), jobHead)
		}
		if status := wt.Git("status", "--porcelain"); status != "" {
			t.Fatalf("status = %q, want empty (the abort undid everything)", status)
		}
		if got := wt.Read("code.txt"); got != "line by job\n" {
			t.Fatalf("code.txt = %q, want the job's own version", got)
		}
		if got := wt.Read("generated.txt"); got != "regenerated by job\n" {
			t.Fatalf("generated.txt = %q, want the job's own version", got)
		}
	})

	t.Run("fastForward lands onto the expected tip; a moved tip or a dirty overlapping file lands nothing", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		base := repo.Head()
		wt := testkit.RepoAt(t, gitCliWorktreePath(t, "wt"))
		if err := git.AddWorktree(t.Context(), repo.Dir, wt.Dir, "zai/job", base); err != nil {
			t.Fatalf("addWorktree() = %v", err)
		}
		wt.Write("job.txt", "by job\n")
		sha, err := git.CommitAll(t.Context(), wt.Dir, "job", gitCliVerify)
		if err != nil {
			t.Fatalf("commitAll() = %v", err)
		}

		outcome, err := git.FastForward(t.Context(), repo.Dir, sha, base)
		if err != nil || outcome != ports.FastForwardLanded {
			t.Fatalf("fastForward() = %v, %v; want landed", outcome, err)
		}
		if repo.Head() != sha {
			t.Fatalf("HEAD = %q, want the landed %q", repo.Head(), sha)
		}
		if got := repo.Read("job.txt"); got != "by job\n" {
			t.Fatalf("job.txt = %q, want the landed file", got)
		}

		repo.Git("reset", "-q", "--hard", base)
		repo.Write("job.txt", "user's uncommitted file in the way\n")
		_, err = git.FastForward(t.Context(), repo.Dir, sha, base)
		gitCliWantError(t, err, ports.GitErrorDirty, "job.txt")
		if repo.Head() != base {
			t.Fatalf("HEAD = %q, want the un-landed %q", repo.Head(), base)
		}

		repo.Remove("job.txt")
		repo.Write("user.txt", "user moved on\n")
		moved := repo.CommitAll("user")
		outcome, err = git.FastForward(t.Context(), repo.Dir, sha, base)
		if err != nil || outcome != ports.FastForwardMoved {
			t.Fatalf("fastForward() = %v, %v; want moved", outcome, err)
		}
		if repo.Head() != moved {
			t.Fatalf("HEAD = %q, want the user's own %q", repo.Head(), moved)
		}
		if _, statErr := os.Stat(filepath.Join(repo.Dir, "job.txt")); !os.IsNotExist(statErr) {
			t.Fatal("job.txt exists, want nothing landed")
		}
		if status := repo.Git("status", "--porcelain"); status != "" {
			t.Fatalf("status = %q, want empty", status)
		}
	})

	t.Run("applyToWorkingTree applies changes without committing; dirty overlapping files → dirty error, nothing applied", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("edit.txt", "1\n2\n3\n4\n5\n6\n7\n8\n")
		repo.Write("delete.txt", "bye\n")
		repo.Write("old/deep/only.txt", "the only file in old/\n")
		repo.Write("mixed/stay.txt", "stays\n")
		repo.Write("mixed/go.txt", "goes\n")
		repo.Write("bin.dat", "\x00\x01binary\x02")
		base := repo.CommitAll("base")
		wt := testkit.RepoAt(t, gitCliWorktreePath(t, "wt"))
		if err := git.AddWorktree(t.Context(), repo.Dir, wt.Dir, "zai/apply", base); err != nil {
			t.Fatalf("addWorktree() = %v", err)
		}
		wt.Write("edit.txt", "1\n2\n3\n4\n5\n6\n7\n8 by job\n")
		wt.Remove("delete.txt")
		wt.Remove("old")
		wt.Remove("mixed/go.txt")
		wt.Write("new dir/ünï.txt", "from job\n")
		wt.Write("bin.dat", "\x00\x03binary by job\x04")
		// The user moved on with a non-overlapping edit to the same file: the 3-way merge keeps both.
		repo.Write("edit.txt", "1 by user\n2\n3\n4\n5\n6\n7\n8\n")
		userHead := repo.CommitAll("user")
		repo.Write("unrelated.txt", "user's own scratch\n")
		repo.Write("delete.txt", "user's uncommitted edit\n")

		err := git.ApplyToWorkingTree(t.Context(), repo.Dir, wt.Dir, base)
		gitCliWantError(t, err, ports.GitErrorDirty, "delete.txt")
		if got := repo.Read("edit.txt"); got != "1 by user\n2\n3\n4\n5\n6\n7\n8\n" {
			t.Fatalf("edit.txt = %q, want the user's own version untouched", got)
		}
		if _, statErr := os.Stat(filepath.Join(repo.Dir, "new dir")); !os.IsNotExist(statErr) {
			t.Fatal("new dir exists, want nothing applied")
		}

		repo.Git("checkout", "--", "delete.txt")
		if err := git.ApplyToWorkingTree(t.Context(), repo.Dir, wt.Dir, base); err != nil {
			t.Fatalf("applyToWorkingTree() = %v, want nil", err)
		}
		if repo.Head() != userHead {
			t.Fatalf("HEAD = %q, want the unchanged %q (nothing committed)", repo.Head(), userHead)
		}
		if got := repo.Read("edit.txt"); got != "1 by user\n2\n3\n4\n5\n6\n7\n8 by job\n" {
			t.Fatalf("edit.txt = %q, want both edits merged", got)
		}
		if got := repo.Read("new dir/ünï.txt"); got != "from job\n" {
			t.Fatalf("new dir/ünï.txt = %q, want from job\n", got)
		}
		if got := repo.Read("bin.dat"); got != "\x00\x03binary by job\x04" {
			t.Fatalf("bin.dat = %q, want the binary patch applied", got)
		}
		if _, statErr := os.Stat(filepath.Join(repo.Dir, "delete.txt")); !os.IsNotExist(statErr) {
			t.Fatal("delete.txt exists, want it deleted")
		}
		if _, statErr := os.Stat(filepath.Join(repo.Dir, "old")); !os.IsNotExist(statErr) {
			t.Fatal("old exists, want the emptied directory pruned")
		}
		if _, statErr := os.Stat(filepath.Join(repo.Dir, "mixed/go.txt")); !os.IsNotExist(statErr) {
			t.Fatal("mixed/go.txt exists, want it deleted")
		}
		if got := repo.Read("mixed/stay.txt"); got != "stays\n" {
			t.Fatalf("mixed/stay.txt = %q, want stays\n", got)
		}
		// Nothing staged: the real index still matches HEAD.
		if staged := repo.Git("diff", "--cached", "--name-only"); staged != "" {
			t.Fatalf("diff --cached = %q, want nothing staged", staged)
		}
		if got := repo.Read("unrelated.txt"); got != "user's own scratch\n" {
			t.Fatalf("unrelated.txt = %q, want the user's scratch untouched", got)
		}
	})

	t.Run("applyToWorkingTree on a conflicting change returns the conflict paths and touches nothing", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("clash.txt", "original\n")
		repo.Write("fine.txt", "original\n")
		base := repo.CommitAll("base")
		wt := testkit.RepoAt(t, gitCliWorktreePath(t, "wt"))
		if err := git.AddWorktree(t.Context(), repo.Dir, wt.Dir, "zai/clash", base); err != nil {
			t.Fatalf("addWorktree() = %v", err)
		}
		wt.Write("clash.txt", "job\n")
		wt.Write("fine.txt", "job\n")
		repo.Write("clash.txt", "user\n")
		repo.CommitAll("user")
		status := repo.Git("status", "--porcelain=v1", "--untracked-files=all")

		err := git.ApplyToWorkingTree(t.Context(), repo.Dir, wt.Dir, base)
		gitCliWantError(t, err, ports.GitErrorConflict, "clash.txt")
		if after := repo.Git("status", "--porcelain=v1", "--untracked-files=all"); after != status {
			t.Fatalf("status = %q, want the unchanged %q", after, status)
		}
		if got := repo.Read("fine.txt"); got != "original\n" {
			t.Fatalf("fine.txt = %q, want original\n (a conflict applies nothing)", got)
		}
	})

	t.Run("applyToWorkingTree applies a change set that only deletes", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("a.txt", "a\n")
		base := repo.CommitAll("base")
		wt := testkit.RepoAt(t, gitCliWorktreePath(t, "wt"))
		if err := git.AddWorktree(t.Context(), repo.Dir, wt.Dir, "zai/delete", base); err != nil {
			t.Fatalf("addWorktree() = %v", err)
		}
		wt.Remove("a.txt")

		if err := git.ApplyToWorkingTree(t.Context(), repo.Dir, wt.Dir, base); err != nil {
			t.Fatalf("applyToWorkingTree() = %v, want nil", err)
		}
		if got := repo.Git("status", "--porcelain"); got != " D a.txt\n" {
			t.Fatalf("status = %q, want  D a.txt", got)
		}
	})

	t.Run("applyToWorkingTree with no changes is a no-op", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		base := repo.Head()
		wt := testkit.RepoAt(t, gitCliWorktreePath(t, "wt"))
		if err := git.AddWorktree(t.Context(), repo.Dir, wt.Dir, "zai/noop", base); err != nil {
			t.Fatalf("addWorktree() = %v", err)
		}
		if err := git.ApplyToWorkingTree(t.Context(), repo.Dir, wt.Dir, base); err != nil {
			t.Fatalf("applyToWorkingTree() = %v, want nil", err)
		}
		if status := repo.Git("status", "--porcelain"); status != "" {
			t.Fatalf("status = %q, want empty", status)
		}
	})

	t.Run("amendAll folds the pending work into the last commit and returns its sha", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("a.txt", "v1\n")
		repo.Write("doomed.txt", "bye\n")
		first := repo.CommitAll("first")
		repo.Write("a.txt", "v2\n")
		repo.Write("added/new.txt", "new\n")
		repo.Remove("doomed.txt")

		sha, err := git.AmendAll(t.Context(), repo.Dir, gitCliVerify)
		if err != nil {
			t.Fatalf("amendAll() = %v", err)
		}
		if sha != repo.Head() {
			t.Fatalf("amendAll() = %q, want the amended HEAD %q", sha, repo.Head())
		}
		if sha == first {
			t.Fatal("amendAll() returned the old sha, want the amended commit")
		}
		if got := strings.TrimSpace(repo.Git("log", "-1", "--format=%s")); got != "first" {
			t.Fatalf("the subject = %q, want the kept first", got)
		}
		// Both a.txt and doomed.txt were introduced by the amended commit, so its diff against the
		// older parent is two additions with the final content — v2 and gone.
		if got := gitCliNameStatusLines(t, repo); !reflect.DeepEqual(got, []string{"A\ta.txt", "A\tadded/new.txt"}) {
			t.Fatalf("show --name-status = %q, want the two additions", got)
		}
		if got := repo.Read("a.txt"); got != "v2\n" {
			t.Fatalf("a.txt = %q, want v2\n", got)
		}
		if _, statErr := os.Stat(filepath.Join(repo.Dir, "doomed.txt")); !os.IsNotExist(statErr) {
			t.Fatal("doomed.txt exists, want the deletion folded in")
		}
		if status := repo.Git("status", "--porcelain"); status != "" {
			t.Fatalf("status = %q, want empty", status)
		}
	})

	t.Run("amendAll runs the repository's commit hooks unless verify is false", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("a.txt", "v1\n")
		repo.CommitAll("first")
		marker := gitCliInstallPreCommit(t, repo, 1)
		repo.Write("a.txt", "v2\n")

		_, err := git.AmendAll(t.Context(), repo.Dir, gitCliVerify)
		gitCliWantError(t, err, ports.GitErrorGitFailed)
		if _, statErr := os.Stat(marker); os.IsNotExist(statErr) {
			t.Fatal("the hook never ran")
		}
		if got := strings.TrimSpace(repo.Git("log", "-1", "--format=%s")); got != "first" {
			t.Fatalf("the subject = %q, want the un-amended first", got)
		}
		if _, err := git.AmendAll(t.Context(), repo.Dir, ports.CommitOptions{Verify: false}); err != nil {
			t.Fatalf("amendAll(verify false) = %v, want nil", err)
		}
		if got := repo.Read("a.txt"); got != "v2\n" {
			t.Fatalf("a.txt = %q, want v2\n", got)
		}
		if status := repo.Git("status", "--porcelain"); status != "" {
			t.Fatalf("status = %q, want empty", status)
		}
	})

	t.Run("addDetachedWorktree checks the sha out with no branch; removeDetachedWorktree removes it and its registration", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("a.txt", "v1\n")
		repo.CommitAll("base")
		repo.Write("a.txt", "v2\n")
		later := repo.CommitAll("later")
		checkout := gitCliWorktreePath(t, "land-checkout")

		if err := git.AddDetachedWorktree(t.Context(), repo.Dir, checkout, later); err != nil {
			t.Fatalf("addDetachedWorktree() = %v, want nil", err)
		}
		if sha, err := git.Resolve(t.Context(), checkout, "HEAD"); err != nil || sha != later {
			t.Fatalf("resolve(HEAD) = %q, %v; want %q", sha, err, later)
		}
		_, err := git.CurrentBranch(t.Context(), checkout)
		gitCliWantError(t, err, ports.GitErrorGitFailed)
		if got := testkit.RepoAt(t, checkout).Read("a.txt"); got != "v2\n" {
			t.Fatalf("a.txt = %q, want the checked-out v2\n", got)
		}

		if err := git.RemoveDetachedWorktree(t.Context(), repo.Dir, checkout); err != nil {
			t.Fatalf("removeDetachedWorktree() = %v, want nil", err)
		}
		if _, statErr := os.Stat(checkout); !os.IsNotExist(statErr) {
			t.Fatal("the checkout still exists, want it removed")
		}
		if listed := repo.Git("worktree", "list", "--porcelain"); strings.Contains(listed, "land-checkout") {
			t.Fatalf("worktree list = %q, want it without the removed checkout", listed)
		}
		// Removing again (a cleanup that lost the race) only prunes a stale registration.
		if err := git.RemoveDetachedWorktree(t.Context(), repo.Dir, checkout); err != nil {
			t.Fatalf("removeDetachedWorktree(again) = %v, want nil", err)
		}
	})

	t.Run("applyToWorkingTree with an unknown base fails", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		err := git.ApplyToWorkingTree(t.Context(), repo.Dir, repo.Dir, strings.Repeat("0", 40))
		gitCliWantError(t, err, ports.GitErrorGitFailed)
	})

	t.Run("operations outside a repository report not_a_repo; removeWorktree never deletes a non-worktree", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		outside := testkit.TempDir(t, "outside-")
		if err := os.WriteFile(filepath.Join(outside, "precious.txt"), []byte("keep\n"), 0o644); err != nil {
			t.Fatal(err)
		}

		_, err := git.Changes(t.Context(), outside, "HEAD")
		gitCliWantNotARepo(t, err, outside)
		_, err = git.Diff(t.Context(), outside, "HEAD", ports.DiffOptions{Stat: true})
		gitCliWantNotARepo(t, err, outside)
		_, err = git.CommitAll(t.Context(), outside, "message", gitCliVerify)
		gitCliWantNotARepo(t, err, outside)
		_, err = git.FastForward(t.Context(), outside, "HEAD", strings.Repeat("0", 40))
		gitCliWantNotARepo(t, err, outside)
		err = git.RemoveDetachedWorktree(t.Context(), outside, outside)
		gitCliWantNotARepo(t, err, outside)
		_, err = git.Resolve(t.Context(), outside, "HEAD")
		gitCliWantNotARepo(t, err, outside)
		_, err = git.CurrentBranch(t.Context(), outside)
		gitCliWantNotARepo(t, err, outside)
		err = git.ApplyToWorkingTree(t.Context(), repo.Dir, outside, repo.Head())
		gitCliWantNotARepo(t, err, outside)
		repo.Write("README.md", "changed so there is something to apply\n")
		err = git.ApplyToWorkingTree(t.Context(), outside, repo.Dir, repo.Head())
		gitCliWantNotARepo(t, err, outside)
		err = git.RemoveWorktree(t.Context(), repo.Dir, outside, "zai/none")
		gitCliWantError(t, err, ports.GitErrorGitFailed)
		if _, statErr := os.Stat(filepath.Join(outside, "precious.txt")); os.IsNotExist(statErr) {
			t.Fatal("precious.txt is gone, want a non-worktree never deleted")
		}
	})

	t.Run("diff with a bad base is an error", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		_, err := git.Diff(t.Context(), repo.Dir, strings.Repeat("0", 40), ports.DiffOptions{})
		gitCliWantError(t, err, ports.GitErrorGitFailed)
	})

	t.Run("amendAll outside a repository reports not_a_repo", func(t *testing.T) {
		outside := testkit.TempDir(t, "outside-")
		_, err := git.AmendAll(t.Context(), outside, gitCliVerify)
		gitCliWantNotARepo(t, err, outside)
	})

	t.Run("addDetachedWorktree outside a repository reports not_a_repo", func(t *testing.T) {
		outside := testkit.TempDir(t, "outside-")
		err := git.AddDetachedWorktree(t.Context(), outside, gitCliWorktreePath(t, "wt"), "HEAD")
		gitCliWantNotARepo(t, err, outside)
	})

	t.Run("addDetachedWorktree with an unknown sha fails", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		err := git.AddDetachedWorktree(t.Context(), repo.Dir, gitCliWorktreePath(t, "wt"), strings.Repeat("0", 40))
		gitCliWantError(t, err, ports.GitErrorGitFailed)
	})

	t.Run("removeWorktree reports the failure when another worktree holds the branch", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Git("branch", "zai/held")
		held := gitCliWorktreePath(t, "held")
		repo.Git("worktree", "add", "--quiet", held, "zai/held")
		missing := filepath.Join(testkit.TempDir(t, "gone-"), "wt")

		err := git.RemoveWorktree(t.Context(), repo.Dir, missing, "zai/held")
		gitErr := gitCliWantError(t, err, ports.GitErrorGitFailed)
		if !strings.Contains(gitErr.Command, "branch -D") {
			t.Fatalf("command = %q, want the branch deletion that git refused", gitErr.Command)
		}
	})

	t.Run("fastForward with a bad sha is an error", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		_, err := git.FastForward(t.Context(), repo.Dir, strings.Repeat("0", 40), repo.Head())
		gitCliWantError(t, err, ports.GitErrorGitFailed)
	})

	t.Run("fastForward onto a sha that does not descend from the tip is a real failure", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		// A parentless commit with the same tree: never a fast-forward of the current tip.
		side := strings.TrimSpace(repo.Git("commit-tree", "HEAD^{tree}", "-m", "side"))

		_, err := git.FastForward(t.Context(), repo.Dir, side, repo.Head())
		gitCliWantError(t, err, ports.GitErrorGitFailed)
		if repo.Head() == side {
			t.Fatal("HEAD moved to the side commit, want nothing landed")
		}
	})

	t.Run("fastForward with a status git cannot run is a real failure", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		base := repo.Head()
		repo.Write("later.txt", "later\n")
		tip := repo.CommitAll("later")
		if err := os.WriteFile(filepath.Join(repo.Dir, ".git", "index"), []byte("garbage-not-an-index"), 0o644); err != nil {
			t.Fatal(err)
		}

		_, err := git.FastForward(t.Context(), repo.Dir, base, tip)
		gitErr := gitCliWantError(t, err, ports.GitErrorGitFailed)
		if !strings.Contains(gitErr.Stderr, "index") {
			t.Fatalf("stderr = %q, want the corrupt index complaint", gitErr.Stderr)
		}
	})
}

func TestGitOutputParsing(t *testing.T) {
	t.Run("splitNul drops only the terminator; chompNewline drops only one trailing newline", func(t *testing.T) {
		if got := SplitNul(""); !reflect.DeepEqual(got, []string{}) {
			t.Fatalf("splitNul(\"\") = %q, want no records", got)
		}
		if got := SplitNul("a\x00b c\x00"); !reflect.DeepEqual(got, []string{"a", "b c"}) {
			t.Fatalf("splitNul() = %q, want [a b c]", got)
		}
		if got := SplitNul("a\x00unterminated"); !reflect.DeepEqual(got, []string{"a", "unterminated"}) {
			t.Fatalf("splitNul() = %q, want [a unterminated]", got)
		}
		if got := ChompNewline("/path/ends with space \n"); got != "/path/ends with space " {
			t.Fatalf("chompNewline() = %q, want the path's own trailing space", got)
		}
		if got := ChompNewline("no newline"); got != "no newline" {
			t.Fatalf("chompNewline() = %q, want no newline", got)
		}
	})

	t.Run("unmergedPaths lists each conflicted path once, sorted", func(t *testing.T) {
		stages := []string{
			"100644 aaa 1\tz.txt",
			"100644 bbb 2\tz.txt",
			"100644 ccc 3\tz.txt",
			"100644 ddd 2\ta\tb.txt",
		}
		got := UnmergedPaths(strings.Join(stages, "\x00") + "\x00")
		want := []string{"a\tb.txt", "z.txt"}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("unmergedPaths() = %q, want %q", got, want)
		}
	})
}
