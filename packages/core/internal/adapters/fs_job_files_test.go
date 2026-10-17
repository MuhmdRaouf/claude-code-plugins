package adapters

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"syscall"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// The app suites exercise fs_job_files.go through their own paths; these direct tests cover
// every function of the file.

func TestFsJobFilesBriefAndStop(t *testing.T) {
	root := t.TempDir()
	files := CreateFsJobFiles(root)
	paths := domain.NewStateLayout(root).Job("261006-files1")

	if err := files.WriteBrief(t.Context(), paths, "# The brief\n"); err != nil {
		t.Fatalf("writeBrief: %v", err)
	}
	if _, err := os.Stat(paths.Artifacts); err != nil {
		t.Fatalf("the artifacts dir: %v", err)
	}
	if text, err := files.ReadText(t.Context(), paths.Brief); err != nil || text != "# The brief\n" {
		t.Fatalf("readText = %q, %v", text, err)
	}

	if files.StopRequested(t.Context(), paths) {
		t.Fatal("a stop was requested before any was written")
	}
	if err := files.RequestStop(t.Context(), paths); err != nil {
		t.Fatalf("requestStop: %v", err)
	}
	if !files.StopRequested(t.Context(), paths) {
		t.Fatal("the stop request did not land")
	}
	if err := files.ClearStop(t.Context(), paths); err != nil {
		t.Fatalf("clearStop: %v", err)
	}
	if files.StopRequested(t.Context(), paths) {
		t.Fatal("the stop request stood after the clear")
	}

	if _, err := files.ReadText(t.Context(), filepath.Join(paths.Dir, "absent.txt")); err == nil ||
		!errors.Is(err, os.ErrNotExist) {
		t.Fatalf("readText of a missing file = %v, want a not-exist error", err)
	}
}

func TestFsJobFilesProgress(t *testing.T) {
	root := t.TempDir()
	files := CreateFsJobFiles(root)
	paths := domain.NewStateLayout(root).Job("261006-files2")
	if err := os.MkdirAll(paths.Dir, 0o755); err != nil {
		t.Fatalf("mkdir the job dir: %v", err)
	}

	progress := domain.Progress{
		Phase: domain.ProgressPhaseTool, Turns: 3,
		LastTool: strPtr("Bash"), LastText: "half a line",
		RateLimitRetries: 1, ToolCalls: 7, ToolErrors: 2,
	}
	if err := files.WriteProgress(t.Context(), paths, 1, progress); err != nil {
		t.Fatalf("writeProgress: %v", err)
	}
	raw, err := os.ReadFile(paths.Progress)
	if err != nil {
		t.Fatalf("read progress.json: %v", err)
	}
	want := `{"attempt":1,"progress":{"phase":"tool","turns":3,"lastTool":"Bash",` +
		`"lastText":"half a line","rateLimitRetries":1,"toolCalls":7,"toolErrors":2}}` + "\n"
	if string(raw) != want {
		t.Fatalf("progress.json = %q, want %q", raw, want)
	}

	read := files.ReadProgress(t.Context(), paths, 1)
	if read == nil || !reflect.DeepEqual(*read, progress) {
		t.Fatalf("readProgress = %+v, want %+v", read, progress)
	}
	if files.ReadProgress(t.Context(), paths, 2) != nil {
		t.Fatal("another attempt's snapshot read back")
	}

	withSession := progress
	withSession.SessionID = strPtr("00000000-0000-4000-8000-000000000001")
	if err := files.WriteProgress(t.Context(), paths, 1, withSession); err != nil {
		t.Fatalf("writeProgress: %v", err)
	}
	if read := files.ReadProgress(t.Context(), paths, 1); read == nil || !reflect.DeepEqual(*read, withSession) {
		t.Fatalf("readProgress = %+v, want %+v", read, withSession)
	}

	for name, body := range map[string]string{
		"missing":       "",
		"torn":          "{not json",
		"null":          "null",
		"no-attempt":    `{"progress":{"phase":"thinking","turns":1,"lastText":"","rateLimitRetries":0,"toolCalls":0,"toolErrors":0}}`,
		"no-turns":      `{"attempt":1,"progress":{"phase":"thinking","lastText":"","rateLimitRetries":0,"toolCalls":0,"toolErrors":0}}`,
		"foreign-phase": `{"attempt":1,"progress":{"phase":"dreaming","turns":1,"lastText":"","rateLimitRetries":0,"toolCalls":0,"toolErrors":0}}`,
	} {
		if name == "missing" {
			if err := os.Remove(paths.Progress); err != nil {
				t.Fatalf("remove: %v", err)
			}
		} else if err := os.WriteFile(paths.Progress, []byte(body), 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		if got := files.ReadProgress(t.Context(), paths, 1); got != nil {
			t.Fatalf("readProgress of the %s snapshot = %+v, want none", name, got)
		}
	}
}

func TestFsJobFilesPids(t *testing.T) {
	root := t.TempDir()
	files := CreateFsJobFiles(root)
	paths := domain.NewStateLayout(root).Job("261006-files3")
	if err := os.MkdirAll(paths.Dir, 0o755); err != nil {
		t.Fatalf("mkdir the job dir: %v", err)
	}

	if _, ok := files.DriverPid(t.Context(), paths); ok {
		t.Fatal("a driver holds the lock before any was written")
	}
	if err := os.WriteFile(paths.DriverLock, []byte("202\n"), 0o600); err != nil {
		t.Fatalf("write the driver lock: %v", err)
	}
	if pid, ok := files.DriverPid(t.Context(), paths); !ok || pid != 202 {
		t.Fatalf("driverPid = %d, %v, want 202, true", pid, ok)
	}
	if err := os.WriteFile(paths.DriverLock, []byte("not a pid"), 0o600); err != nil {
		t.Fatalf("write the driver lock: %v", err)
	}
	if _, ok := files.DriverPid(t.Context(), paths); ok {
		t.Fatal("garbage in the driver lock counts as a holder")
	}

	if _, ok := files.EnginePid(paths); ok {
		t.Fatal("the engine runs before any pid was written")
	}
	WriteEnginePid(paths.EnginePid, 303)
	if pid, ok := files.EnginePid(paths); !ok || pid != 303 {
		t.Fatalf("enginePid = %d, %v, want 303, true", pid, ok)
	}
	info, err := os.Stat(paths.EnginePid)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("engine.pid mode = %v, %v, want 0600", info, err)
	}
	if pid, ok := ReadEnginePid(paths.EnginePid); !ok || pid != 303 {
		t.Fatalf("readEnginePid = %d, %v, want 303, true", pid, ok)
	}
	ClearEnginePid(paths.EnginePid)
	if _, ok := ReadEnginePid(paths.EnginePid); ok {
		t.Fatal("the engine pid stood after the clear")
	}
	if err := os.WriteFile(paths.EnginePid, []byte("nope"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, ok := ReadEnginePid(paths.EnginePid); ok {
		t.Fatal("garbage in engine.pid counts as a pid")
	}
}

// A read the OS answers busy (EBUSY) is waited out, not read as no driver; the first call is
// injected.
func TestFsJobFilesDriverPidBusyRead(t *testing.T) {
	root := t.TempDir()
	files := CreateFsJobFiles(root)
	paths := domain.NewStateLayout(root).Job("261006-files6")
	if err := os.MkdirAll(paths.Dir, 0o755); err != nil {
		t.Fatalf("mkdir the job dir: %v", err)
	}
	if err := os.WriteFile(paths.DriverLock, []byte("202\n"), 0o600); err != nil {
		t.Fatalf("write the driver lock: %v", err)
	}

	calls := 0
	readLockFile = func(file string) ([]byte, error) {
		calls++
		if calls == 1 {
			return nil, &fs.PathError{Op: "read", Path: file, Err: syscall.EBUSY}
		}
		return os.ReadFile(file)
	}
	t.Cleanup(func() { readLockFile = os.ReadFile })

	pid, ok := files.DriverPid(t.Context(), paths)
	if !ok || pid != 202 {
		t.Fatalf("driverPid = %d, %v, want 202, true", pid, ok)
	}
}

func TestFsJobFilesCheckouts(t *testing.T) {
	root := t.TempDir()
	files := CreateFsJobFiles(root)

	if got := files.CheckoutIds(); len(got) != 0 {
		t.Fatalf("checkoutIds = %v, want none", got)
	}
	if _, ok := files.CheckoutRepo(filepath.Join(root, "checkouts", "261006-files4")); ok {
		t.Fatal("a missing checkout has a repo")
	}

	checkout := filepath.Join(root, "checkouts", "261006-files4")
	if err := os.MkdirAll(checkout, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if got := files.CheckoutIds(); len(got) != 1 || got[0] != "261006-files4" {
		t.Fatalf("checkoutIds = %v, want [261006-files4]", got)
	}
	if _, ok := files.CheckoutRepo(checkout); ok {
		t.Fatal("a checkout without a .git file has a repo")
	}

	gitdir := filepath.Join(root, ".git", "worktrees", "261006-files4")
	if err := os.WriteFile(filepath.Join(checkout, ".git"), []byte("gitdir: "+gitdir+"\n"), 0o600); err != nil {
		t.Fatalf("write .git: %v", err)
	}
	if repo, ok := files.CheckoutRepo(checkout); !ok || repo != filepath.Dir(filepath.Dir(gitdir)) {
		t.Fatalf("checkoutRepo = %q, %v, want %q", repo, ok, filepath.Dir(filepath.Dir(gitdir)))
	}
	if err := os.WriteFile(filepath.Join(checkout, ".git"), []byte("not a gitdir"), 0o600); err != nil {
		t.Fatalf("write .git: %v", err)
	}
	if _, ok := files.CheckoutRepo(checkout); ok {
		t.Fatal("a foreign .git file has a repo")
	}

	if !files.Exists(checkout) {
		t.Fatal("exists lost the checkout")
	}
	files.RemoveTree(checkout)
	if files.Exists(checkout) {
		t.Fatal("removeTree left the checkout behind")
	}
	files.RemoveTree(checkout) // a missing tree is fine
}

func TestFsJobFilesUnwritablePaths(t *testing.T) {
	files := CreateFsJobFiles(t.TempDir())
	blocked := filepath.Join(t.TempDir(), "a-file")
	if err := os.WriteFile(blocked, []byte("a file"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := files.WriteBrief(t.Context(), domain.JobPaths{
		Brief: filepath.Join(blocked, "brief.md"), Artifacts: filepath.Join(blocked, "artifacts"),
	}, "text"); err == nil {
		t.Fatal("writeBrief under a file succeeded")
	}
	if err := files.WriteProgress(t.Context(), domain.JobPaths{
		Progress: filepath.Join(t.TempDir(), "no-dir", "progress.json"),
	}, 1, domain.Progress{Phase: domain.ProgressPhaseStarting}); err == nil {
		t.Fatal("writeProgress into a missing directory succeeded")
	}
}

func TestFsJobFilesClearEnginePidThroughThePort(t *testing.T) {
	root := t.TempDir()
	files := CreateFsJobFiles(root)
	paths := domain.NewStateLayout(root).Job("261006-files5")
	if err := os.MkdirAll(paths.Dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	WriteEnginePid(paths.EnginePid, 404)
	files.ClearEnginePid(paths)
	if _, ok := files.EnginePid(paths); ok {
		t.Fatal("the engine pid stood after the clear")
	}
}
