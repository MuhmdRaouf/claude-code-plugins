package adapters

// Direct tests of the low-level git helpers (git-parse, git-run, git-snapshot, git-status,
// git-apply), which the Git adapter's own tests exercise only end to end: parsing from fixed
// strings, and every run, snapshot, status and apply against a throwaway testkit repo under the
// isolated git env.

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// gitWantError fails the test unless err is the wanted GitError shape (and carries paths, when
// given).
func gitWantError(t *testing.T, err *ports.GitError, want ports.GitErrorKind, paths ...string) {
	t.Helper()
	if err == nil {
		t.Fatalf("error = nil, want %s", want)
	}
	if err.Kind != want {
		t.Fatalf("error = %s (%s), want %s", err.Kind, err.Error(), want)
	}
	if len(paths) > 0 && !reflect.DeepEqual(err.Paths, paths) {
		t.Fatalf("error paths = %q, want %q", err.Paths, paths)
	}
}

// gitNotARepoDir is a directory no git repository contains, so git reports it as not a repo.
func gitNotARepoDir(t *testing.T) string {
	t.Helper()
	return testkit.TempDir(t, "outside-")
}

// gitApplyWorktree makes a worktree of repo at a path that does not exist yet, on a new branch at
// base (what the Git adapter's addWorktree does).
// gitLfRepo pins a repo to LF checkouts: the tests assert the LF bytes they wrote, untouched by
// any smudge.
func gitLfRepo(repo testkit.TestRepo) {
	repo.Git("config", "core.autocrlf", "false")
}

func gitApplyWorktree(t *testing.T, repo testkit.TestRepo, branch, base string) testkit.TestRepo {
	t.Helper()
	gitLfRepo(repo)
	path := filepath.Join(testkit.TempDir(t, "wt-root-"), "wt")
	testkit.Git(repo.Dir, "worktree", "add", "--quiet", "-b", branch, "--", path, base)
	return testkit.RepoAt(t, path)
}

func TestChompNewline(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"drops only one trailing newline, keeping a path's own trailing space", "/path/ends with space \n", "/path/ends with space "},
		{"keeps text without a newline", "no newline", "no newline"},
		{"drops exactly one of two trailing newlines", "sha\n\n", "sha\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ChompNewline(tc.in); got != tc.want {
				t.Fatalf("chompNewline(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestSplitNul(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
	}{
		{"empty output is no records", "", []string{}},
		{"drops only the terminator", "a\x00b c\x00", []string{"a", "b c"}},
		{"keeps an unterminated last record", "a\x00unterminated", []string{"a", "unterminated"}},
		{"an empty record is a record", "a\x00\x00b\x00", []string{"a", "", "b"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := SplitNul(tc.in); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("splitNul(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestUnmergedPaths(t *testing.T) {
	t.Run("lists each conflicted path once, sorted", func(t *testing.T) {
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
	t.Run("a record without a tab is its own path", func(t *testing.T) {
		if got := UnmergedPaths("no tab here\x00"); !reflect.DeepEqual(got, []string{"no tab here"}) {
			t.Fatalf("unmergedPaths() = %q, want [no tab here]", got)
		}
	})
}

func TestParseNameStatus(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want domain.ChangeSet
	}{
		{"empty output is an empty change set", "", domain.ChangeSet{Added: []string{}, Modified: []string{}, Deleted: []string{}}},
		{"sorts each bucket", "M\x00z.ts\x00A\x00b.ts\x00D\x00c.ts\x00A\x00a.ts\x00", domain.ChangeSet{
			Added: []string{"a.ts", "b.ts"}, Modified: []string{"z.ts"}, Deleted: []string{"c.ts"},
		}},
		{"every status but A and D is a modification", "T\x00type-change.txt\x00U\x00unmerged.txt\x00M\x00edited.txt\x00", domain.ChangeSet{
			Added: []string{}, Modified: []string{"edited.txt", "type-change.txt", "unmerged.txt"}, Deleted: []string{},
		}},
		{"keeps paths with spaces and unicode whole", "A\x00new dir/ünï.txt\x00D\x00gone file.txt\x00", domain.ChangeSet{
			Added: []string{"new dir/ünï.txt"}, Modified: []string{}, Deleted: []string{"gone file.txt"},
		}},
		{"a dangling status record is dropped", "A\x00x\x00M", domain.ChangeSet{Added: []string{"x"}, Modified: []string{}, Deleted: []string{}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ParseNameStatus(tc.in); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("parseNameStatus(%q) = %+v, want %+v", tc.in, got, tc.want)
			}
		})
	}
}

func TestParseStatus(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []StatusEntry
	}{
		{"unstaged changes and untracked files are not staged", " M mod.txt\x00?? untracked dir/ça va?.txt\x00", []StatusEntry{
			{Path: "mod.txt", Staged: false}, {Path: "untracked dir/ça va?.txt", Staged: false},
		}},
		{"a staged X column marks the entry staged", "M  staged.txt\x00MM both.txt\x00AM new then edited.txt\x00", []StatusEntry{
			{Path: "staged.txt", Staged: true}, {Path: "both.txt", Staged: true}, {Path: "new then edited.txt", Staged: true},
		}},
		{"an empty record is an unstaged empty path", "\x00", []StatusEntry{{Path: "", Staged: false}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ParseStatus(tc.in); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("parseStatus(%q) = %+v, want %+v", tc.in, got, tc.want)
			}
		})
	}
}

func TestStatusArgs(t *testing.T) {
	want := []string{"status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"}
	if !reflect.DeepEqual(StatusArgs, want) {
		t.Fatalf("STATUS_ARGS = %q, want %q", StatusArgs, want)
	}
}

func TestRunGit(t *testing.T) {
	t.Run("runs git in cwd through the tool runner and returns stdout", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		run := RunGit(t.Context(), repo.Dir, []string{"rev-parse", "HEAD"}, GitRunOptions{})
		if !run.Ok {
			t.Fatalf("run = %+v, want ok", run)
		}
		if got := string(run.Stdout); got != repo.Head()+"\n" {
			t.Fatalf("stdout = %q, want the HEAD sha and a newline", got)
		}
	})

	t.Run("prepends -c core.quotepath=off so a non-z output keeps unicode paths raw", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("ünïcødé/日本語.md", "v1\n")
		base := repo.CommitAll("odd names")
		repo.Write("ünïcødé/日本語.md", "v2\n")
		run := RunGit(t.Context(), repo.Dir, []string{"diff", "--name-only", "--end-of-options", base, "--"}, GitRunOptions{})
		if !run.Ok {
			t.Fatalf("run = %+v (%s), want ok", run, run.Stderr)
		}
		if got := ChompNewline(string(run.Stdout)); got != "ünïcødé/日本語.md" {
			t.Fatalf("path = %q, want the raw unicode path (core.quotepath=off was not passed)", got)
		}
	})

	t.Run("a failure carries the exit code and stderr", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		run := RunGit(t.Context(), repo.Dir, []string{"rev-parse", "--verify", "--end-of-options", "no-such-ref"}, GitRunOptions{})
		if run.Ok || run.Code == nil || *run.Code == 0 {
			t.Fatalf("run = %+v, want a non-zero exit", run)
		}
		if run.Stderr == "" {
			t.Fatal("stderr is empty, want git's own message")
		}
	})

	t.Run("a quiet failure with no output names the command", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		args := []string{"rev-parse", "--quiet", "--verify", "--end-of-options", "no-such-ref"}
		run := RunGit(t.Context(), repo.Dir, args, GitRunOptions{})
		want := "git " + strings.Join(args, " ") + " failed"
		if run.Ok {
			t.Fatalf("run = %+v, want a failure", run)
		}
		if run.Stderr != want {
			t.Fatalf("stderr = %q, want %q", run.Stderr, want)
		}
	})

	t.Run("stderr falls back to stdout, trimmed", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		run := RunGit(t.Context(), repo.Dir, []string{"commit", "-m", "empty"}, GitRunOptions{})
		if run.Ok {
			t.Fatalf("run = %+v, want a failure", run)
		}
		if !strings.Contains(run.Stderr, "nothing to commit") {
			t.Fatalf("stderr = %q, want the explanation git prints on stdout only", run.Stderr)
		}
		if run.Stderr != strings.TrimSpace(run.Stderr) {
			t.Fatalf("stderr = %q, want it trimmed", run.Stderr)
		}
	})

	t.Run("a git that cannot start is a value with no exit code", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		t.Setenv("PATH", t.TempDir())
		run := RunGit(t.Context(), repo.Dir, []string{"status"}, GitRunOptions{})
		if run.Ok || run.Code != nil {
			t.Fatalf("run = %+v, want a failure with no code", run)
		}
		if run.Stderr == "" {
			t.Fatal("stderr is empty, want the spawn message")
		}
	})

	t.Run("stdin is written and closed", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		input := "hello\n"
		run := RunGit(t.Context(), repo.Dir, []string{"hash-object", "--stdin"}, GitRunOptions{Stdin: &input})
		if !run.Ok {
			t.Fatalf("run = %+v (%s), want ok", run, run.Stderr)
		}
		// The blob sha of "hello\n": a fixed, version-independent content hash.
		if got := string(run.Stdout); got != "ce013625030ba8dba906f756967f9e9ca394464a\n" {
			t.Fatalf("stdout = %q, want the blob sha of %q", got, input)
		}
	})

	t.Run("the location env vars of the caller do not point git elsewhere", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		outside := gitNotARepoDir(t)
		t.Setenv("GIT_DIR", filepath.Join(outside, "nowhere"))
		t.Setenv("GIT_WORK_TREE", filepath.Join(outside, "elsewhere"))
		t.Setenv("GIT_INDEX_FILE", filepath.Join(outside, "missing-index"))
		status, err := GitText(t.Context(), repo.Dir, StatusArgs, GitRunOptions{})
		if err != nil {
			t.Fatalf("gitText(status) = %v, want the clean repo status", err)
		}
		if status != "" {
			t.Fatalf("status = %q, want empty (the repo is clean)", status)
		}
	})

	t.Run("the editor the caller set is forced back to true", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		t.Setenv("GIT_EDITOR", "vi")
		editor, err := GitValue(t.Context(), repo.Dir, []string{"var", "GIT_EDITOR"}, GitRunOptions{})
		if err != nil || editor != "true" {
			t.Fatalf("gitValue(var GIT_EDITOR) = %q, %v; want true (never open an editor)", editor, err)
		}
	})
}

func TestGitErrorMapping(t *testing.T) {
	one := 1
	cases := []struct {
		name string
		cwd  func(t *testing.T) string
		run  GitRun
		want ports.GitErrorKind
	}{
		{
			name: "a cwd that does not exist is not a repo",
			cwd:  func(t *testing.T) string { return filepath.Join(t.TempDir(), "missing") },
			run:  GitRun{Code: &one, Stderr: "anything at all"},
			want: ports.GitErrorNotARepo,
		},
		{
			name: "git's own not-a-repo message is not a repo whatever the cwd",
			cwd:  func(t *testing.T) string { return t.TempDir() },
			run:  GitRun{Code: &one, Stderr: "fatal: not a git repository (or any of the parent directories): .git"},
			want: ports.GitErrorNotARepo,
		},
		{
			name: "anything else is git_failed with the command line and stderr",
			cwd:  func(t *testing.T) string { return t.TempDir() },
			run:  GitRun{Code: &one, Stderr: "boom"},
			want: ports.GitErrorGitFailed,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cwd := tc.cwd(t)
			err := GitError(cwd, []string{"a", "b"}, tc.run)
			gitWantError(t, err, tc.want)
			switch tc.want {
			case ports.GitErrorNotARepo:
				if err.Path != cwd {
					t.Fatalf("error path = %q, want %q", err.Path, cwd)
				}
			case ports.GitErrorGitFailed:
				if err.Command != "git a b" || err.Stderr != "boom" {
					t.Fatalf("error = %q / %q, want git a b / boom", err.Command, err.Stderr)
				}
			}
		})
	}
}

func TestGitTextVoidValue(t *testing.T) {
	t.Run("text, value and void wrap one run", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		text, err := GitText(t.Context(), repo.Dir, []string{"rev-parse", "HEAD"}, GitRunOptions{})
		if err != nil || text != repo.Head()+"\n" {
			t.Fatalf("gitText(rev-parse HEAD) = %q, %v; want the sha and its newline", text, err)
		}
		value, err := GitValue(t.Context(), repo.Dir, []string{"rev-parse", "HEAD"}, GitRunOptions{})
		if err != nil || value != repo.Head() {
			t.Fatalf("gitValue(rev-parse HEAD) = %q, %v; want the chomped sha", value, err)
		}
		branch, err := GitValue(t.Context(), repo.Dir, []string{"symbolic-ref", "--quiet", "--short", "HEAD"}, GitRunOptions{})
		if err != nil || branch != "main" {
			t.Fatalf("gitValue(symbolic-ref) = %q, %v; want main", branch, err)
		}
		if err := GitVoid(t.Context(), repo.Dir, []string{"rev-parse", "HEAD"}, GitRunOptions{}); err != nil {
			t.Fatalf("gitVoid(rev-parse HEAD) = %v, want nil", err)
		}
	})

	t.Run("outside a repository every wrapper reports not_a_repo", func(t *testing.T) {
		outside := gitNotARepoDir(t)
		_, err := GitText(t.Context(), outside, []string{"status"}, GitRunOptions{})
		gitWantError(t, err, ports.GitErrorNotARepo)
		if err.Path != outside {
			t.Fatalf("error path = %q, want %q", err.Path, outside)
		}
		_, err = GitValue(t.Context(), outside, []string{"rev-parse", "HEAD"}, GitRunOptions{})
		gitWantError(t, err, ports.GitErrorNotARepo)
		err = GitVoid(t.Context(), outside, []string{"status"}, GitRunOptions{})
		gitWantError(t, err, ports.GitErrorNotARepo)
	})
}

func TestSnapshotTree(t *testing.T) {
	testkit.IsolateGitConfig(t)
	t.Run("sees tracked and untracked files, minus ignored, without staging anything", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("a.txt", "1\n")
		repo.Write("b.txt", "1\n")
		repo.Write(".gitignore", "build/\n")
		base := repo.CommitAll("base")
		repo.Write("a.txt", "2\n")
		repo.Write("new dir/c.txt", "fresh\n")
		repo.Write("build/out.js", "ignored\n")

		tree, err := SnapshotTree(t.Context(), repo.Dir, "zai")
		if err != nil {
			t.Fatalf("snapshotTree() = %v, want a tree sha", err)
		}
		listed := repo.Git("diff", "--name-status", "-z", "--no-renames",
			"--end-of-options", base, tree, "--")
		want := domain.ChangeSet{Added: []string{"new dir/c.txt"}, Modified: []string{"a.txt"}, Deleted: []string{}}
		if got := ParseNameStatus(listed); !reflect.DeepEqual(got, want) {
			t.Fatalf("diff base..tree = %+v, want %+v", got, want)
		}
		// The worktree's own index is untouched: the new file is still untracked, not staged.
		if staged := repo.Git("diff", "--cached", "--name-only"); staged != "" {
			t.Fatalf("diff --cached = %q, want nothing staged", staged)
		}
		status := ParseStatus(repo.Git("status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"))
		wantStatus := []StatusEntry{{Path: "a.txt", Staged: false}, {Path: "new dir/c.txt", Staged: false}}
		if !reflect.DeepEqual(status, wantStatus) {
			t.Fatalf("status = %+v, want %+v", status, wantStatus)
		}
	})

	t.Run("a racily clean entry stays racy: a same-size edit with matching stat info is seen", func(t *testing.T) {
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

		tree, err := SnapshotTree(t.Context(), repo.Dir, "zai")
		if err != nil {
			t.Fatalf("snapshotTree() = %v, want a tree sha", err)
		}
		diff := repo.Git("diff", "--end-of-options", base, tree, "--")
		if !strings.Contains(diff, "-wrong\n+right\n") {
			t.Fatalf("diff base..tree = %q, want -wrong/+right (the index copy must keep the entry racy)", diff)
		}
	})

	t.Run("an empty repository starts from an empty index", func(t *testing.T) {
		dir := testkit.TempDir(t, "empty-repo-")
		testkit.Git(dir, "init", "-q", "-b", "main")
		tree, err := SnapshotTree(t.Context(), dir, "zai")
		if err != nil {
			t.Fatalf("snapshotTree() = %v, want the empty tree", err)
		}
		if tree != "4b825dc642cb6eb9a060e54bf8d69288fbee4904" {
			t.Fatalf("tree = %q, want the empty tree sha", tree)
		}
	})

	t.Run("a failing add -A fails the snapshot", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		// A zlib level git itself refuses: pure git logic.
		repo.Git("config", "core.loosecompression", "99")
		repo.Write("new.txt", "to stage\n")

		_, err := SnapshotTree(t.Context(), repo.Dir, "zai")
		gitWantError(t, err, ports.GitErrorGitFailed)
		if !strings.Contains(err.Stderr, "bad zlib compression level") {
			t.Fatalf("stderr = %q, want the compression complaint", err.Stderr)
		}
	})

	t.Run("outside a repository reports not_a_repo", func(t *testing.T) {
		_, err := SnapshotTree(t.Context(), gitNotARepoDir(t), "zai")
		gitWantError(t, err, ports.GitErrorNotARepo)
	})
}

func TestGitCopyIndex(t *testing.T) {
	t.Run("copies the bytes and the timestamps", func(t *testing.T) {
		dir := t.TempDir()
		from := filepath.Join(dir, "index")
		past := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
		if err := os.WriteFile(from, []byte("index bytes\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		gitChtimes(t, from, past)
		to := filepath.Join(dir, "copy")

		if err := gitCopyIndex(t.Context(), from, to); err != nil {
			t.Fatalf("copyIndex() = %v, want nil", err)
		}
		copied, err := os.ReadFile(to)
		if err != nil || string(copied) != "index bytes\n" {
			t.Fatalf("copy = %q, %v; want the same bytes", copied, err)
		}
		info, err := os.Stat(to)
		if err != nil || !info.ModTime().Equal(past) {
			t.Fatalf("copy mtime = %v, %v; want the source's %v", info, err, past)
		}
	})

	t.Run("fails on a source that is missing or not a file, or a target that cannot be written", func(t *testing.T) {
		dir := t.TempDir()
		source := filepath.Join(dir, "index")
		if err := os.WriteFile(source, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		aDir := filepath.Join(dir, "a-dir")
		if err := os.Mkdir(aDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := gitCopyIndex(t.Context(), filepath.Join(dir, "missing"), filepath.Join(dir, "copy")); err == nil {
			t.Fatal("copyIndex(missing) = nil, want an error")
		}
		if err := gitCopyIndex(t.Context(), aDir, filepath.Join(dir, "copy")); err == nil {
			t.Fatal("copyIndex(a directory) = nil, want an error")
		}
		if err := gitCopyIndex(t.Context(), source, filepath.Join(dir, "no-such-dir", "copy")); err == nil {
			t.Fatal("copyIndex(into a missing dir) = nil, want an error")
		}
	})
}

func TestGitResolveWithin(t *testing.T) {
	if got := gitResolveWithin("/repo", ".git/index"); got != filepath.Join("/repo", ".git", "index") {
		t.Fatalf("gitResolveWithin(relative) = %q", got)
	}
	// An absolute path stands on its own.
	abs := "/abs/path/index"
	if got := gitResolveWithin("/repo", abs); got != abs {
		t.Fatalf("gitResolveWithin(absolute) = %q", got)
	}
}

// gitChtimes sets a file's timestamps (utimesSync): the racy-entry test pins the index's mtime.
func gitChtimes(t *testing.T, path string, at time.Time) {
	t.Helper()
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatalf("chtimes %s: %v", path, err)
	}
}

func TestWithTempIndex(t *testing.T) {
	t.Run("hands fn a timestamped copy of the index under <provider>-index-… and leaves the real one alone", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("late.txt", "uncommitted\n")
		realIndex := filepath.Join(repo.Dir, ".git", "index")
		var copyPath string

		result, err := WithTempIndex(t.Context(), repo.Dir, "zai", func(env map[string]string) (string, *ports.GitError) {
			copyPath = env["GIT_INDEX_FILE"]
			if copyPath == "" {
				t.Fatal("env has no GIT_INDEX_FILE")
			}
			if len(env) != 1 {
				t.Fatalf("env = %v, want only GIT_INDEX_FILE", env)
			}
			if dir := filepath.Base(filepath.Dir(copyPath)); !strings.HasPrefix(dir, "zai-index-") {
				t.Fatalf("scratch dir = %q, want a zai-index-… name", dir)
			}
			realData, readErr := os.ReadFile(realIndex)
			copyData, copyErr := os.ReadFile(copyPath)
			if copyErr != nil || !bytes.Equal(realData, copyData) {
				t.Fatalf("the index copy = %v, %v; want the real index's bytes", copyErr, readErr)
			}
			realInfo, _ := os.Stat(realIndex)
			copyInfo, statErr := os.Stat(copyPath)
			if statErr != nil || !realInfo.ModTime().Equal(copyInfo.ModTime()) {
				t.Fatal("the index copy does not keep the index's timestamps")
			}
			if gitErr := GitVoid(t.Context(), repo.Dir, []string{"add", "-A"}, GitRunOptions{Env: env}); gitErr != nil {
				t.Fatalf("add -A into the copy = %v, want nil", gitErr)
			}
			return "done", nil
		})
		if err != nil {
			t.Fatalf("withTempIndex() = %v, want nil", err)
		}
		if result != "done" {
			t.Fatalf("withTempIndex() = %q, want fn's own value", result)
		}
		if staged := repo.Git("diff", "--cached", "--name-only"); staged != "" {
			t.Fatalf("diff --cached = %q, want nothing staged in the real repo", staged)
		}
		status := ParseStatus(repo.Git("status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"))
		wantStatus := []StatusEntry{{Path: "late.txt", Staged: false}}
		if !reflect.DeepEqual(status, wantStatus) {
			t.Fatalf("status = %+v, want late.txt still untracked", status)
		}
		if _, statErr := os.Stat(copyPath); !os.IsNotExist(statErr) {
			t.Fatalf("the scratch dir survives: stat(%q) = %v, want not exist", copyPath, statErr)
		}
	})

	t.Run("returns fn's error unchanged", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		sentinel := &ports.GitError{Kind: ports.GitErrorConflict, Paths: []string{"x.txt"}}
		_, err := WithTempIndex(t.Context(), repo.Dir, "zai", func(env map[string]string) (string, *ports.GitError) {
			return "", sentinel
		})
		if err != sentinel {
			t.Fatalf("withTempIndex() = %v, want fn's own error", err)
		}
	})

	t.Run("a directory that is not a repository fails before fn runs", func(t *testing.T) {
		called := false
		_, err := WithTempIndex(t.Context(), gitNotARepoDir(t), "zai", func(env map[string]string) (string, *ports.GitError) {
			called = true
			return "", nil
		})
		gitWantError(t, err, ports.GitErrorNotARepo)
		if called {
			t.Fatal("fn ran, want the location to fail first")
		}
	})

	t.Run("a scratch dir that cannot be made is a git failure", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		// The temp root is a regular file: every temp dir under it fails, on every platform.
		notADir := filepath.Join(t.TempDir(), "not-a-dir")
		if err := os.WriteFile(notADir, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"TMPDIR", "TMP", "TEMP"} {
			t.Setenv(name, notADir)
		}
		called := false
		_, err := WithTempIndex(t.Context(), repo.Dir, "zai", func(env map[string]string) (string, *ports.GitError) {
			called = true
			return "", nil
		})
		gitWantError(t, err, ports.GitErrorGitFailed)
		if err.Command != "mkdtemp" {
			t.Fatalf("command = %q, want mkdtemp", err.Command)
		}
		if called {
			t.Fatal("fn ran, want the scratch dir to fail first")
		}
	})
}

func TestBlockingPaths(t *testing.T) {
	t.Run("clean paths do not block", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("keep.txt", "keep\n")
		repo.Write("mod.txt", "v1\n")
		repo.Write("staged.txt", "v1\n")
		repo.CommitAll("base")

		blocking, err := BlockingPaths(t.Context(), repo.Dir, []string{"keep.txt"}, BlockingOptions{})
		if err != nil {
			t.Fatalf("blockingPaths() = %v, want nil", err)
		}
		if len(blocking) != 0 {
			t.Fatalf("blockingPaths() = %q, want nothing", blocking)
		}

		repo.Write("mod.txt", "v2\n")
		repo.Write("scratch.txt", "scratch\n")
		blocking, err = BlockingPaths(t.Context(), repo.Dir, []string{"mod.txt", "scratch.txt", "keep.txt"}, BlockingOptions{})
		if err != nil {
			t.Fatalf("blockingPaths() = %v, want nil", err)
		}
		if want := []string{"mod.txt", "scratch.txt"}; !reflect.DeepEqual(blocking, want) {
			t.Fatalf("blockingPaths() = %q, want %q", blocking, want)
		}

		repo.Write("staged.txt", "v2\n")
		repo.Git("add", "staged.txt")
		blocking, err = BlockingPaths(t.Context(), repo.Dir, []string{"staged.txt"}, BlockingOptions{})
		if err != nil {
			t.Fatalf("blockingPaths() = %v, want nil", err)
		}
		if want := []string{"staged.txt"}; !reflect.DeepEqual(blocking, want) {
			t.Fatalf("blockingPaths() = %q, want %q", blocking, want)
		}

		blocking, err = BlockingPaths(t.Context(), repo.Dir, nil, BlockingOptions{StagedAnywhere: true})
		if err != nil {
			t.Fatalf("blockingPaths() = %v, want nil", err)
		}
		if want := []string{"staged.txt"}; !reflect.DeepEqual(blocking, want) {
			t.Fatalf("blockingPaths(staged anywhere) = %q, want %q", blocking, want)
		}
	})

	t.Run("outside a repository reports not_a_repo", func(t *testing.T) {
		_, err := BlockingPaths(t.Context(), gitNotARepoDir(t), []string{"a.txt"}, BlockingOptions{})
		gitWantError(t, err, ports.GitErrorNotARepo)
	})
}

func TestApplyToWorkingTree(t *testing.T) {
	testkit.IsolateGitConfig(t)
	t.Run("applies changes without committing; dirty overlapping files are a dirty error and nothing is applied", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("edit.txt", "1\n2\n3\n4\n5\n6\n7\n8\n")
		repo.Write("delete.txt", "bye\n")
		repo.Write("old/deep/only.txt", "the only file in old/\n")
		repo.Write("mixed/stay.txt", "stays\n")
		repo.Write("mixed/go.txt", "goes\n")
		repo.Write("bin.dat", "\x00\x01binary\x02")
		base := repo.CommitAll("base")
		wt := gitApplyWorktree(t, repo, "zai/apply", base)
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

		err := ApplyToWorkingTree(t.Context(), repo.Dir, wt.Dir, base, "zai")
		gitWantError(t, err, ports.GitErrorDirty, "delete.txt")
		if got := repo.Read("edit.txt"); got != "1 by user\n2\n3\n4\n5\n6\n7\n8\n" {
			t.Fatalf("edit.txt = %q, want the user's own version untouched", got)
		}
		if _, statErr := os.Stat(filepath.Join(repo.Dir, "new dir")); !os.IsNotExist(statErr) {
			t.Fatal("new dir exists, want nothing applied")
		}

		repo.Git("checkout", "--", "delete.txt")
		if err := ApplyToWorkingTree(t.Context(), repo.Dir, wt.Dir, base, "zai"); err != nil {
			t.Fatalf("applyToWorkingTree() = %v, want nil", err)
		}
		if repo.Head() != userHead {
			t.Fatalf("HEAD = %q, want %q (nothing committed)", repo.Head(), userHead)
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
		for _, gone := range []string{"delete.txt", "old", "mixed/go.txt"} {
			if _, statErr := os.Stat(filepath.Join(repo.Dir, gone)); !os.IsNotExist(statErr) {
				t.Fatalf("%s exists, want it deleted", gone)
			}
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

	t.Run("a conflicting change returns the conflict paths and touches nothing", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("clash.txt", "original\n")
		repo.Write("fine.txt", "original\n")
		base := repo.CommitAll("base")
		wt := gitApplyWorktree(t, repo, "zai/clash", base)
		wt.Write("clash.txt", "job\n")
		wt.Write("fine.txt", "job\n")
		repo.Write("clash.txt", "user\n")
		repo.CommitAll("user")
		status := repo.Git("status", "--porcelain=v1", "--untracked-files=all")

		err := ApplyToWorkingTree(t.Context(), repo.Dir, wt.Dir, base, "zai")
		gitWantError(t, err, ports.GitErrorConflict, "clash.txt")
		if after := repo.Git("status", "--porcelain=v1", "--untracked-files=all"); after != status {
			t.Fatalf("status = %q, want the unchanged %q", after, status)
		}
		if got := repo.Read("fine.txt"); got != "original\n" {
			t.Fatalf("fine.txt = %q, want original\n (a conflict applies nothing)", got)
		}
	})

	t.Run("applies a change set that only deletes", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("a.txt", "a\n")
		base := repo.CommitAll("base")
		wt := gitApplyWorktree(t, repo, "zai/delete", base)
		wt.Remove("a.txt")

		if err := ApplyToWorkingTree(t.Context(), repo.Dir, wt.Dir, base, "zai"); err != nil {
			t.Fatalf("applyToWorkingTree() = %v, want nil", err)
		}
		if got := repo.Git("status", "--porcelain"); got != " D a.txt\n" {
			t.Fatalf("status = %q, want  D a.txt", got)
		}
	})

	t.Run("with no changes is a no-op", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		base := repo.Head()
		wt := gitApplyWorktree(t, repo, "zai/noop", base)

		if err := ApplyToWorkingTree(t.Context(), repo.Dir, wt.Dir, base, "zai"); err != nil {
			t.Fatalf("applyToWorkingTree() = %v, want nil", err)
		}
		if got := repo.Git("status", "--porcelain"); got != "" {
			t.Fatalf("status = %q, want empty", got)
		}
	})

	t.Run("an unknown base fails", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		err := ApplyToWorkingTree(t.Context(), repo.Dir, repo.Dir, strings.Repeat("0", 40), "zai")
		gitWantError(t, err, ports.GitErrorGitFailed)
	})

	t.Run("outside a repository reports not_a_repo", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		outside := gitNotARepoDir(t)
		err := ApplyToWorkingTree(t.Context(), repo.Dir, outside, repo.Head(), "zai")
		gitWantError(t, err, ports.GitErrorNotARepo)
		if err.Path != outside {
			t.Fatalf("error path = %q, want %q", err.Path, outside)
		}
		repo.Write("README.md", "changed so there is something to apply\n")
		err = ApplyToWorkingTree(t.Context(), outside, repo.Dir, repo.Head(), "zai")
		gitWantError(t, err, ports.GitErrorNotARepo)
		if err.Path != outside {
			t.Fatalf("error path = %q, want %q", err.Path, outside)
		}
	})
}

func TestGitMergeIntoIndex(t *testing.T) {
	t.Run("a patch that applies is not an error", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		repo.Write("a.txt", "1\n")
		repo.CommitAll("base")
		repo.Write("a.txt", "1\n2\n")
		patch := repo.Git("diff", "--end-of-options", repo.Head(), "--")
		if err := gitMergeIntoIndex(t.Context(), repo.Dir, patch, nil); err != nil {
			t.Fatalf("mergeIntoIndex() = %v, want nil", err)
		}
	})

	t.Run("a patch that is not a patch is git_failed, not a conflict", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		err := gitMergeIntoIndex(t.Context(), repo.Dir, "this is not a diff\n", nil)
		gitWantError(t, err, ports.GitErrorGitFailed)
		if err.Command != "git apply --cached --3way --whitespace=nowarn" {
			t.Fatalf("command = %q, want the apply command line", err.Command)
		}
	})
}

func TestGitWriteMerged(t *testing.T) {
	testkit.IsolateGitConfig(t)
	t.Run("checks the written files out of the index and prunes the deleted ones' empty directories", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		gitLfRepo(repo)
		repo.Write("wrote.txt", "from the index\n")
		repo.Write("nest/deep/only.txt", "the only file in nest/deep\n")
		repo.Write("nest2/x.txt", "goes\n")
		repo.Write("nest2/keep.txt", "stays\n")
		repo.CommitAll("base")
		for _, path := range []string{"wrote.txt", "nest/deep/only.txt", "nest2/x.txt"} {
			if err := os.Remove(filepath.Join(repo.Dir, path)); err != nil {
				t.Fatal(err)
			}
		}

		if err := gitWriteMerged(t.Context(), repo.Dir, []string{"wrote.txt"}, []string{"nest/deep/only.txt", "nest2/x.txt"}, nil); err != nil {
			t.Fatalf("writeMerged() = %v, want nil", err)
		}
		if got := repo.Read("wrote.txt"); got != "from the index\n" {
			t.Fatalf("wrote.txt = %q, want it checked out of the index", got)
		}
		for _, gone := range []string{"nest/deep/only.txt", "nest", "nest2/x.txt"} {
			if _, statErr := os.Stat(filepath.Join(repo.Dir, gone)); !os.IsNotExist(statErr) {
				t.Fatalf("%s exists, want it gone", gone)
			}
		}
		if got := repo.Read("nest2/keep.txt"); got != "stays\n" {
			t.Fatalf("nest2/keep.txt = %q, want stays\n (pruning stops at a non-empty directory)", got)
		}
	})

	t.Run("a path the index does not hold fails the checkout", func(t *testing.T) {
		repo := testkit.MakeRepo(t)
		err := gitWriteMerged(t.Context(), repo.Dir, []string{"never-in-the-index.txt"}, nil, nil)
		gitWantError(t, err, ports.GitErrorGitFailed)
		if err.Command != "git checkout-index --force -z --stdin" {
			t.Fatalf("command = %q, want the checkout-index command line", err.Command)
		}
	})
}
