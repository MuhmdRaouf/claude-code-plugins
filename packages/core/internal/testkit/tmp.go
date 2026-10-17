package testkit

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Temp directories and throwaway git repositories for adapter integration tests. Everything lives
// under the test's temp root and is removed when the current test finishes. Git never sees the
// developer's global/system config or hooks.

// ISOLATED_GIT_ENV is the process env for git: no global or system config, so the developer's
// settings and hooks cannot leak in.
var ISOLATED_GIT_ENV = map[string]string{
	"GIT_CONFIG_GLOBAL":   "/dev/null",
	"GIT_CONFIG_NOSYSTEM": "1",
}

// TempDir returns a fresh directory named by prefix (a real path, so it compares equal to what git
// reports), removed when the current test finishes together with every process still running from
// inside it: a router a test removed retires and would otherwise wait for the developer's own
// Claude Code sessions to close.
func TempDir(t testing.TB, prefix string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), prefix)
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatalf("resolve %s: %v", dir, err)
	}
	t.Cleanup(func() {
		StopProcessesUnder(resolved)
		_ = os.RemoveAll(resolved)
	})
	return resolved
}

// StopProcessesUnder SIGTERMs every process whose command line names a file under dir (only
// test-made dirs are ever passed), re-sweeping until a snapshot shows none left. One snapshot is
// not enough under load: a ps taken milliseconds after a process started can miss it (kill(pid, 0)
// already says alive), and the missed row would run on past its dir's removal.
func StopProcessesUnder(dir string) {
	deadline := time.Now().Add(5 * time.Second)
	for {
		if !stopProcessesSweep(dir) {
			return
		}
		if !time.Now().Before(deadline) {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// stopProcessesSweep runs one ps snapshot and SIGTERMs every process under dir, reporting whether
// any was still seen.
func stopProcessesSweep(dir string) bool {
	ps, err := exec.Command("ps", "-axo", "pid=,args=").Output()
	if err != nil {
		// A snapshot that failed gives the sweep nothing to act on, so it ends at once: the ps
		// that fails every time it runs (msys ps) must not cost every cleanup its whole deadline.
		return false
	}
	seen := false
	for _, line := range strings.Split(string(ps), "\n") {
		trimmed := strings.TrimSpace(line)
		pidText, args, found := strings.Cut(trimmed, " ")
		if !found {
			continue
		}
		pid, err := strconv.Atoi(pidText)
		if err != nil || pid == os.Getpid() || !strings.Contains(args, dir+"/") {
			continue
		}
		seen = true
		// already gone: ignore the error
		_ = signalPid(pid)
	}
	return seen
}

// IsolateGitConfig applies ISOLATED_GIT_ENV to the process env (which Git inherits) until the
// current test finishes.
func IsolateGitConfig(t testing.TB) {
	t.Helper()
	for name, value := range ISOLATED_GIT_ENV {
		t.Setenv(name, value)
	}
}

// safeGit keeps the developer's signing, hooks and quoting out of test repos.
var safeGit = []string{"-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "core.quotepath=off"}

// Git runs git in cwd with the isolated git env, returning stdout; stderr and a non-zero exit are
// the error.
func Git(cwd string, args ...string) (string, error) {
	full := append(append([]string{}, safeGit...), args...)
	cmd := exec.Command("git", full...)
	cmd.Dir = cwd
	env := os.Environ()
	for name, value := range ISOLATED_GIT_ENV {
		env = append(env, name+"="+value)
	}
	cmd.Env = env
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// TestRepo is a throwaway git repository with helpers.
type TestRepo struct {
	Dir string

	t testing.TB
}

// RepoAt wraps dir as a TestRepo.
func RepoAt(t testing.TB, dir string) TestRepo {
	return TestRepo{Dir: dir, t: t}
}

// Git runs git in the repo, failing the test when it fails.
func (r TestRepo) Git(args ...string) string {
	r.t.Helper()
	out, err := Git(r.Dir, args...)
	if err != nil {
		r.t.Fatal(err)
	}
	return out
}

// Write writes content at path in the repo, creating the parent directories.
func (r TestRepo) Write(path, content string) {
	r.t.Helper()
	file := filepath.Join(r.Dir, path)
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		r.t.Fatalf("mkdir %s: %v", filepath.Dir(file), err)
	}
	if err := os.WriteFile(file, []byte(content), 0o644); err != nil {
		r.t.Fatalf("write %s: %v", file, err)
	}
}

// Read reads a file in the repo.
func (r TestRepo) Read(path string) string {
	r.t.Helper()
	content, err := os.ReadFile(filepath.Join(r.Dir, path))
	if err != nil {
		r.t.Fatalf("read %s: %v", path, err)
	}
	return string(content)
}

// Remove deletes a path in the repo, a missing one included.
func (r TestRepo) Remove(path string) {
	if err := os.RemoveAll(filepath.Join(r.Dir, path)); err != nil {
		r.t.Fatalf("remove %s: %v", path, err)
	}
}

// CommitAll runs `git add -A && git commit` and returns the new HEAD sha.
func (r TestRepo) CommitAll(message string) string {
	r.Git("add", "-A")
	r.Git("commit", "-q", "-m", message)
	return r.Head()
}

// Head is the current HEAD sha.
func (r TestRepo) Head() string {
	return strings.TrimSpace(r.Git("rev-parse", "HEAD"))
}

// MakeRepo inits a git repo on branch main with a local identity, signing and hooks off, and one
// initial commit (README.md).
func MakeRepo(t testing.TB) TestRepo {
	repo := RepoAt(t, filepath.Join(TempDir(t, "zai-repo-"), "repo"))
	if err := os.Mkdir(repo.Dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", repo.Dir, err)
	}
	repo.Git("init", "-q", "-b", "main")
	repo.Git("config", "user.name", "Zai Test")
	repo.Git("config", "user.email", "zai-test@example.invalid")
	repo.Git("config", "commit.gpgsign", "false")
	repo.Git("config", "core.hooksPath", "/dev/null")
	repo.Write("README.md", "# test repo\n")
	repo.CommitAll("init")
	return repo
}

// DeadPid is the pid of a process that has already exited (and been reaped): the test binary
// itself, run with a filter that matches no test.
func DeadPid(t testing.TB) int {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run", "^$")
	if err := cmd.Run(); err != nil {
		t.Fatalf("could not spawn a short-lived process: %v", err)
	}
	return cmd.Process.Pid
}
