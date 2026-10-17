package fakeclaude

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// The golden contract lives in testdata/fakeclaude: a fixed scenario table with the recorded
// stdout, stderr, exit codes, dump files and edited files. These tests replay every scenario
// against the fake and must not drift from it.

const goldenDir = "../../../testdata/fakeclaude"

// goldenScenario is one recorded scenario of the manifest.
type goldenScenario struct {
	Name              string            `json:"name"`
	Argv              []string          `json:"argv"`
	Env               map[string]string `json:"env"`
	Stdin             string            `json:"stdin"`
	Files             map[string]string `json:"files"`
	Exit              *int              `json:"exit"`
	Stderr            string            `json:"stderr"`
	StderrNonPortable bool              `json:"stderrNonPortable"`
	Killed            bool              `json:"killed"`
	Dumps             map[string]string `json:"dumps"`
	Edits             map[string]string `json:"edits"`
}

func loadGoldens(t *testing.T) []goldenScenario {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(goldenDir, "manifest.json"))
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	var scenarios []goldenScenario
	if err := json.Unmarshal(data, &scenarios); err != nil {
		t.Fatalf("parse manifest: %v", err)
	}
	if len(scenarios) == 0 {
		t.Fatal("manifest has no scenarios")
	}
	return scenarios
}

func goldenByName(t *testing.T, name string) goldenScenario {
	t.Helper()
	for _, s := range loadGoldens(t) {
		if s.Name == name {
			return s
		}
	}
	t.Fatalf("no golden scenario named %q", name)
	return goldenScenario{}
}

func goldenStdout(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(goldenDir, name+".stdout"))
	if err != nil {
		t.Fatalf("read golden stdout: %v", err)
	}
	return string(data)
}

// realTempDir is t.TempDir with symlinks resolved: the fake reports process.cwd(), which the
// kernel returns resolved, so the golden normalisation must replace the resolved path. It
// returns the directory to run in plus the one spelling of it the output carries.
func realTempDir(t *testing.T) (string, []string) {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("resolve temp dir: %v", err)
	}
	return dir, []string{dir}
}

// normalizeCwd replaces the temp directory with <CWD> in captured output. The fake reports its
// cwd inside JSON, where a backslash is escaped, so the escaped spelling is replaced first — the
// plain one never matches inside it — for every spelling realTempDir returns.
func normalizeCwd(out string, spellings ...string) string {
	for _, dir := range spellings {
		out = strings.ReplaceAll(out, strings.ReplaceAll(dir, `\`, `\\`), "<CWD>")
	}
	for _, dir := range spellings {
		out = strings.ReplaceAll(out, dir, "<CWD>")
	}
	return out
}

func envSlice(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(env))
	for _, key := range keys {
		out = append(out, key+"="+env[key])
	}
	return out
}

func writeGoldenFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for path, content := range files {
		full := filepath.Join(dir, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", full, err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", full, err)
		}
	}
}

// snapshotFiles lists every file under dir the scenario did not start with.
func snapshotFiles(t *testing.T, dir string, initial map[string]string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if _, ok := initial[rel]; ok {
			return nil
		}
		content, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		out[rel] = string(content)
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}
	return out
}

func sameMaps(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for key, val := range a {
		if b[key] != val {
			return false
		}
	}
	return true
}

// syncBuffer collects a command's output while it runs (the sleep scenario polls it for the
// first line before the command exits).
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// runKilled starts cmd, asserts it emits a first line and then keeps running through the grace
// period, and kills it: the sleep scenario never exits on its own.
func runKilled(t *testing.T, cmd *exec.Cmd, out *syncBuffer, grace time.Duration) {
	t.Helper()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	deadline := time.Now().Add(2 * time.Second)
	for !strings.Contains(out.String(), "\n") {
		select {
		case err := <-done:
			t.Fatalf("the fake exited with %v before emitting its first line", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("the fake emitted no first line within 2s")
		}
		time.Sleep(5 * time.Millisecond)
	}
	select {
	case err := <-done:
		t.Fatalf("the fake exited with %v while it should still be running", err)
	case <-time.After(grace):
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatalf("kill: %v", err)
	}
	<-done
}

func TestBuildCompilesOncePerTestBinary(t *testing.T) {
	first, second := Build(t), Build(t)
	if first != second {
		t.Errorf("Build returned %q then %q: the binary must compile once per test binary", first, second)
	}
	info, err := os.Stat(first)
	if err != nil {
		t.Fatalf("stat %s: %v", first, err)
	}
	if info.IsDir() {
		t.Errorf("%s is a directory", first)
	}
}

// compile fails with the module root missing before it runs the toolchain.
func TestCompileFailsOutsideTheModule(t *testing.T) {
	t.Chdir(t.TempDir()) // no go.mod above the temp dir
	if _, err := compile("./nowhere"); err == nil {
		t.Error("compile succeeded outside the module")
	}
}

// compile fails with the toolchain's own error when the package does not exist.
func TestCompileReportsAMissingPackage(t *testing.T) {
	_, err := compile("./internal/testkit/cmd/does-not-exist")
	if err == nil {
		t.Fatal("compile succeeded for a missing package")
	}
	if !strings.Contains(err.Error(), "go build ./internal/testkit/cmd/does-not-exist") {
		t.Errorf("error = %v, want it to name the package", err)
	}
}

// Build fails the test that asked for a broken build (checked in a subprocess: the failure is a
// testing.TB.Fatal, which cannot be expected in-process).
func TestBuildFatalsWhenThePackageCannotBuild(t *testing.T) {
	if os.Getenv("FAKE_CLAUDE_TEST_BREAK_BUILD") == "1" {
		buildPackage = "./internal/testkit/cmd/does-not-exist"
		Build(t) // must Fatal before returning
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run", "^TestBuildFatalsWhenThePackageCannotBuild$")
	cmd.Env = append(os.Environ(), "FAKE_CLAUDE_TEST_BREAK_BUILD=1")
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("the subprocess passed although the build must fail: %s", out)
	}
	if !strings.Contains(string(out), "build the fake claude binary") {
		t.Errorf("subprocess output does not name the failure: %s", out)
	}
}

// TestScenariosMatchTheGoldens replays every golden scenario against the compiled fake and
// compares stdout (byte for byte), stderr, exit code, dump files and edited files with the
// recorded golden.
func TestScenariosMatchTheGoldens(t *testing.T) {
	bin := Build(t)
	for _, s := range loadGoldens(t) {
		t.Run(s.Name, func(t *testing.T) {
			dir, spellings := realTempDir(t)
			writeGoldenFiles(t, dir, s.Files)
			cmd := exec.Command(bin, s.Argv...)
			cmd.Dir = dir
			cmd.Env = envSlice(s.Env)
			cmd.Stdin = strings.NewReader(s.Stdin)
			var stdout, stderr syncBuffer
			cmd.Stdout = &stdout
			cmd.Stderr = &stderr

			if s.Killed {
				runKilled(t, cmd, &stdout, 300*time.Millisecond)
			} else {
				var gotExit int
				if err := cmd.Run(); err != nil {
					var exitErr *exec.ExitError
					if !errors.As(err, &exitErr) {
						t.Fatal(err)
					}
					gotExit = exitErr.ExitCode()
				}
				if s.Exit == nil {
					t.Fatalf("golden scenario %q records no exit code", s.Name)
				}
				if gotExit != *s.Exit {
					t.Errorf("exit = %d, want %d (stderr %q)", gotExit, *s.Exit, stderr.String())
				}
			}

			if got, want := normalizeCwd(stdout.String(), spellings...), goldenStdout(t, s.Name); got != want {
				t.Errorf("stdout mismatch\n got: %q\nwant: %q", got, want)
			}
			if !s.StderrNonPortable && stderr.String() != s.Stderr {
				t.Errorf("stderr = %q, want %q", stderr.String(), s.Stderr)
			}
			if got, want := readDumps(t, dir, s), s.Dumps; !sameMaps(normalizeDumps(got), want) {
				t.Errorf("dump files = %v, want %v", got, want)
			}
			gotFiles := snapshotFiles(t, dir, s.Files)
			delete(gotFiles, filepath.ToSlash(s.Env["FAKE_CLAUDE_DUMP"]))
			if want := s.Edits; !sameMaps(gotFiles, want) {
				t.Errorf("files after the run = %v, want %v", gotFiles, want)
			}
		})
	}
}

func readDumps(t *testing.T, dir string, s goldenScenario) map[string]string {
	t.Helper()
	name, ok := s.Env["FAKE_CLAUDE_DUMP"]
	if !ok {
		return map[string]string{}
	}
	content, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(name)))
	if err != nil {
		t.Fatalf("read dump %s: %v", name, err)
	}
	return map[string]string{name: string(content)}
}

// normalizeDumps reads the dumps back the way the golden reports them.
func normalizeDumps(dumps map[string]string) map[string]string {
	return dumps
}

// The --version branch prints the version line and exits before reading stdin, so an open stdin
// pipe must not hang it.
func TestVersionExitsWithoutReadingStdin(t *testing.T) {
	bin := Build(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, "--version")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	var out syncBuffer
	cmd.Stdout = &out
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer stdin.Close() // never closed before the command must exit
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	if out.String() != "2.1.289 (Claude Code, fake)\n" {
		t.Errorf("stdout = %q", out.String())
	}
}

// FAKE_CLAUDE_PIDFILE starts a grandchild in the same process group that holds stdout open and
// outlives the parent: "<own pid> <grandchild pid>" (no trailing newline) once it runs, the
// parent exits normally, and stdout only drains after the grandchild dies.
func TestPidfileGrandchildHoldsStdout(t *testing.T) {
	bin := Build(t)
	scenario := goldenByName(t, "ok")
	dir, spellings := realTempDir(t)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(bin, scenario.Argv...)
	cmd.Dir = dir
	cmd.Env = append(envSlice(scenario.Env), "FAKE_CLAUDE_PIDFILE=pid.txt")
	cmd.Stdin = strings.NewReader(scenario.Stdin)
	// a raw *os.File, so cmd.Wait returns at the parent's exit instead of waiting for the copy
	cmd.Stdout = writer
	cmd.Stderr = writer
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	writer.Close()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		testkit.StopProcessesUnder(filepath.Dir(bin))
	})
	if err := cmd.Wait(); err != nil {
		t.Fatalf("the parent must exit on its own: %v", err)
	}

	record, err := os.ReadFile(filepath.Join(dir, "pid.txt"))
	if err != nil {
		t.Fatalf("read pidfile: %v", err)
	}
	if fields := strings.Fields(string(record)); len(fields) != 2 {
		t.Fatalf("pidfile = %q, want \"<pid> <grandchild pid>\"", record)
	} else if fields[0] != strconv.Itoa(cmd.Process.Pid) {
		t.Errorf("pidfile = %q, want the parent's pid %d", record, cmd.Process.Pid)
	}
	grandchildPid, err := strconv.Atoi(strings.Fields(string(record))[1])
	if err != nil {
		t.Fatalf("pidfile = %q: %v", record, err)
	}
	if grandchildPid == cmd.Process.Pid {
		t.Errorf("pidfile = %q: the grandchild pid equals the parent's", record)
	}

	drained := make(chan string, 1)
	go func() {
		data, _ := io.ReadAll(reader)
		drained <- string(data)
	}()
	select {
	case data := <-drained:
		t.Fatalf("stdout closed with %q while the grandchild should hold it open", data)
	case <-time.After(300 * time.Millisecond):
	}
	grandchild, err := os.FindProcess(grandchildPid)
	if err != nil {
		t.Fatalf("find grandchild %d: %v", grandchildPid, err)
	}
	if err := grandchild.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("grandchild %d is not alive: %v", grandchildPid, err)
	}
	// The pid came from the fake's pidfile: kill it only while it still runs the re-executed fake
	// binary (its one grandchild argument names it), so a pid the kernel has handed to another
	// process is never signalled — and the pipe it held open has drained on its own by then.
	if testkit.PidMatches(int64(grandchildPid), bin+" --fake-grandchild", 0) {
		if err := grandchild.Kill(); err != nil {
			t.Fatalf("kill grandchild %d: %v", grandchildPid, err)
		}
	}
	var got string
	select {
	case got = <-drained:
	case <-time.After(5 * time.Second):
		t.Fatal("stdout did not drain after the grandchild was killed")
	}
	if normalized := normalizeCwd(got, spellings...); normalized != goldenStdout(t, "ok") {
		t.Errorf("stdout = %q, want the ok golden", normalized)
	}
}
