// The crash log and the router log: direct tests of every case.
package router

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// wantPrivateFile pins a file's 0600.
func wantPrivateFile(t *testing.T, path string) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("%s mode = %o, want 600", filepath.Base(path), info.Mode().Perm())
	}
}

// failingLogFs is a LogFs whose every operation fails, an ENOSPC stand-in.
type failingLogFs struct{}

func (failingLogFs) Append(string, string) error { return errors.New("no space") }
func (failingLogFs) Size(string) (int64, error)  { return 0, errors.New("no stat") }
func (failingLogFs) Read(string) ([]byte, error) { return nil, errors.New("no read") }
func (failingLogFs) Write(string, []byte) error  { return errors.New("no write") }
func (failingLogFs) Rename(string, string) error { return errors.New("no rename") }

func TestLogCrash(t *testing.T) {
	t.Parallel()
	t.Run("appends one JSON line per entry, never a header or body, and keeps only the last bytes", func(t *testing.T) {
		root := t.TempDir()
		event := "worker exited"
		LogCrash(root, CrashEntry{Role: RoleFront, Version: "v1", Event: &event}, nil, 0)
		first, err := os.ReadFile(domain.NewStateLayout(root).CrashLog)
		if err != nil {
			t.Fatal(err)
		}
		var line map[string]any
		if err := json.Unmarshal([]byte(strings.TrimSuffix(string(first), "\n")), &line); err != nil {
			t.Fatal(err)
		}
		if line["role"] != "front" || line["version"] != "v1" || line["event"] != "worker exited" {
			t.Fatalf("the crash line = %v, want the entry's own fields", line)
		}
		if line["pid"] != float64(os.Getpid()) {
			t.Fatalf("the crash line's pid = %v, want %d", line["pid"], os.Getpid())
		}
		wantPrivateFile(t, domain.NewStateLayout(root).CrashLog)
		for i := 0; i < 50; i++ {
			message := fmt.Sprintf("boom %d", i)
			LogCrash(root, CrashEntry{Role: RoleWorker, Version: "v1", Error: &message}, DiskFs, 400)
		}
		kept, err := os.ReadFile(domain.NewStateLayout(root).CrashLog)
		if err != nil {
			t.Fatal(err)
		}
		if len(kept) > 400 {
			t.Fatalf("the crash log kept %d bytes, want at most 400", len(kept))
		}
		if !strings.HasSuffix(string(kept), "\n") {
			t.Fatal("the crash log does not end at a line end")
		}
		if !strings.HasPrefix(strings.Split(string(kept), "\n")[0], "{") {
			t.Fatal("the crash log's first line is not a line start")
		}
		if !strings.Contains(string(kept), "boom 49") {
			t.Fatal("the crash log dropped the newest entry")
		}
		if CrashLogLimit != 1024*1024 {
			t.Fatalf("CRASH_LOG_LIMIT = %d, want %d", CrashLogLimit, 1024*1024)
		}
	})

	t.Run("swallows a full disk", func(t *testing.T) {
		LogCrash(t.TempDir(), CrashEntry{Role: RoleEmergency, Version: "x"}, failingLogFs{}, 0)
		// The disk half's own failure: a write into a directory that is not there.
		if err := DiskFs.Write(filepath.Join(t.TempDir(), "gone", "crash.log"), []byte("x")); err == nil {
			t.Fatal("DiskFs.Write into a missing directory succeeded")
		}
	})

	t.Run("logs an uncaught exception or rejection with its stack, then exits 1", func(t *testing.T) {
		root := t.TempDir()
		var exits []int
		crash := InstallCrashHandlers(RoleWorker, root, "v9", func(code int) { exits = append(exits, code) }, nil)
		crash("uncaughtException", errors.New("kaput"))
		crash("unhandledRejection", "plain reason")
		if !slices.Equal(exits, []int{1, 1}) {
			t.Fatalf("exit codes = %v, want [1 1]", exits)
		}
		data, err := os.ReadFile(domain.NewStateLayout(root).CrashLog)
		if err != nil {
			t.Fatal(err)
		}
		var lines []map[string]any
		for _, text := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
			var line map[string]any
			if err := json.Unmarshal([]byte(text), &line); err != nil {
				t.Fatal(err)
			}
			lines = append(lines, line)
		}
		if lines[0]["role"] != "worker" || lines[0]["event"] != "uncaughtException" ||
			lines[0]["error"] != "kaput" {
			t.Fatalf("the exception line = %v", lines[0])
		}
		if _, ok := lines[0]["stack"].(string); !ok {
			t.Fatalf("the exception line carries no stack: %v", lines[0])
		}
		if lines[1]["event"] != "unhandledRejection" || lines[1]["error"] != "plain reason" {
			t.Fatalf("the rejection line = %v", lines[1])
		}
	})
}

func TestRotatingLog(t *testing.T) {
	t.Parallel()
	t.Run("rotates to .1 past its limit and never throws, not even on a full disk", func(t *testing.T) {
		root := t.TempDir()
		path := filepath.Join(root, "router.log")
		log := RotatingLog(path, nil, 200)
		// A line with an astral pair and one with an invalid byte: the length the rotation counts is
		// the text's UTF-16 code units.
		log("\U0001F600 boots \xff")
		for i := 0; i < 10; i++ {
			log(fmt.Sprintf("request %d %s", i, strings.Repeat("x", 20)))
		}
		if _, err := os.Stat(path + ".1"); err != nil {
			t.Fatalf("the log did not rotate: %v", err)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Size() > 200 {
			t.Fatalf("the log grew to %d bytes, want at most 200", info.Size())
		}
		RotatingLog(path, failingLogFs{}, 10)("line")
	})

	t.Run("does not bring back a directory that was removed", func(t *testing.T) {
		root := t.TempDir()
		RotatingLog(filepath.Join(root, "gone", "router.log"), nil, 0)("line")
		if _, err := os.Stat(filepath.Join(root, "gone")); !os.IsNotExist(err) {
			t.Fatalf("logging brought the directory back: %v", err)
		}
	})
}
