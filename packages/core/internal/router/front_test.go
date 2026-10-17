// The front cases that need the process layer: a real router process the starter spawned (this
// binary re-executed in its front mode, forking real workers), the pid records it writes, and the
// key check across the process boundary. Every other front case is front_focus_test.go's, against
// an in-process fake worker with the same assertions.
package router

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// runProcessChildFront is a real front process: this binary re-executed by the starter, forking
// its workers as real router children. It exits when its work is done (the production Done).
func runProcessChildFront() {
	fail := func(line string) {
		fmt.Fprintln(os.Stderr, line)
		os.Exit(3)
	}
	name := os.Getenv("PROCESS_CHILD_NAME")
	display := os.Getenv("PROCESS_CHILD_DISPLAY")
	anthropicRaw := os.Getenv("PROCESS_CHILD_ANTHROPIC")
	token := os.Getenv("PROCESS_CHILD_TOKEN")
	version := os.Getenv("PROCESS_CHILD_VERSION")
	execPath := os.Getenv("PROCESS_CHILD_EXEC")
	anthropic, err := url.Parse(anthropicRaw)
	if err != nil {
		fail("bad anthropic url: " + err.Error())
	}
	port := 0
	if raw := os.Getenv("ACME_ROUTER_PORT"); raw != "" {
		port, err = strconv.Atoi(raw)
		if err != nil {
			fail("bad ACME_ROUTER_PORT: " + err.Error())
		}
	}
	// The fork target: the exec the front was given (a missing one, in the tests that prove the
	// key check's failure), else this binary re-executed as the focus worker child.
	forkTarget := execPath
	if forkTarget == "" {
		if self, selfErr := os.Executable(); selfErr == nil {
			forkTarget = self
		}
	}
	fork := func(string, string) (WorkerHandle, error) {
		command := exec.Command(forkTarget, name, "router", "worker")
		command.Env = []string{
			focusChildEnv + "=worker",
			"FRONT_FOCUS_CHILD_NAME=" + name,
			"FRONT_FOCUS_CHILD_ANTHROPIC=" + anthropicRaw,
			"FRONT_FOCUS_CHILD_TOKEN=" + token,
			WorkerTokenEnv + "=" + token,
			"FRONT_FOCUS_CHILD_HB=20",
		}
		command.Stderr = os.Stderr
		stdin, stdinErr := command.StdinPipe()
		stdoutPipe, stdoutErr := command.StdoutPipe()
		if err := errors.Join(stdinErr, stdoutErr, command.Start()); err != nil {
			return nil, err
		}
		handle := newExecHandle(command.Process, stdin)
		go handle.readMessages(stdoutPipe)
		go handle.awaitExit(command)
		return handle, nil
	}
	front := CreateFront(FrontOptions{
		Name:       name,
		Display:    display,
		HealthPath: "/" + name + "-router/health",
		Claim:      domain.ModelClaim{Prefixes: []string{"big-"}},
		Port:       port,
		Anthropic:  anthropic,
		Env:        ProxyEnv{},
		Version:    version,
		Token:      token,
		Exec:       execPath,
		Fork:       fork,
		Note:       func(line string) { fmt.Fprintln(os.Stderr, line) },
		Done:       func() { os.Exit(0) },
	})
	if _, err := front.Start(); err != nil {
		fail("front start: " + err.Error())
	}
	select {}
}

// frontProcessSetup is a start whose spawn runs real front children of this binary.
type frontProcessSetup struct {
	t         *testing.T
	root      string
	dist      string
	state     string
	port      int
	env       domain.EnvLookup
	anthropic *url.URL
	exec      string
	logFile   string

	mu      sync.Mutex
	spawned []DetachedChild
}

func newFrontProcessSetup(t *testing.T, execPath string) *frontProcessSetup {
	t.Helper()
	anthropic, _ := focusAnthropic(t)
	root := t.TempDir()
	dist := filepath.Join(root, "dist")
	if err := os.MkdirAll(dist, 0o755); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dist, routerBinaryName), data, 0o755); err != nil {
		t.Fatal(err)
	}
	port, err := FreePort()
	if err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(root, "state")
	s := &frontProcessSetup{
		t:         t,
		root:      root,
		dist:      dist,
		state:     state,
		port:      port,
		env:       domain.EnvLookup{"HOME": filepath.Join(root, "home"), "ACME_ROUTER_PORT": strconv.Itoa(port)},
		anthropic: anthropic,
		exec:      execPath,
		logFile:   domain.NewStateLayout(state).RouterLog,
	}
	t.Cleanup(s.stopChildren)
	return s
}

func (s *frontProcessSetup) options() StartOptions {
	return StartOptions{
		Provider:     processAcme,
		Env:          s.env,
		StateRoot:    s.state,
		Source:       filepath.Join(s.dist, routerBinaryName),
		BudgetMs:     8000,
		HealthWaitMs: 5000,
		Answers:      func(context.Context, int) bool { return false },
		Spawn:        s.spawn,
	}
}

// spawn is the production spawn with the child's test configuration added to its environment.
func (s *frontProcessSetup) spawn(binary string, args []string, env map[string]string, logFile string) DetachedChild {
	merged := make(map[string]string, len(env)+6)
	for name, value := range env {
		merged[name] = value
	}
	merged[focusChildEnv] = "front"
	merged["PROCESS_CHILD_NAME"] = "acme"
	merged["PROCESS_CHILD_DISPLAY"] = "Acme Models"
	merged["PROCESS_CHILD_ANTHROPIC"] = s.anthropic.String()
	merged["PROCESS_CHILD_TOKEN"] = env["ACME_ROUTER_TOKEN"]
	merged["PROCESS_CHILD_VERSION"] = "v1"
	if s.exec != "" {
		merged["PROCESS_CHILD_EXEC"] = s.exec
	}
	child := spawnRouterDetached(binary, args, merged, logFile)
	if child.Pid() != 0 {
		s.mu.Lock()
		s.spawned = append(s.spawned, child)
		s.mu.Unlock()
	}
	return child
}

// stopChildren ends every front child the setup started; a worker dies with its front (its stdin
// ends) or its own drain limit.
func (s *frontProcessSetup) stopChildren() {
	s.mu.Lock()
	children := append([]DetachedChild(nil), s.spawned...)
	s.mu.Unlock()
	for _, child := range children {
		child.Kill()
	}
}

func (s *frontProcessSetup) spawnedCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.spawned)
}

func (s *frontProcessSetup) firstPid() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.spawned) == 0 {
		return 0
	}
	return s.spawned[0].Pid()
}

// lastPid is the newest front child the setup started.
func (s *frontProcessSetup) lastPid() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.spawned) == 0 {
		return 0
	}
	return s.spawned[len(s.spawned)-1].Pid()
}

func TestFrontProcess(t *testing.T) {
	t.Parallel()
	t.Run("hands requests to its worker and reports itself in health", func(t *testing.T) {
		s := newFrontProcessSetup(t, "")
		line, err := StartRouter(context.Background(), s.options())
		if err != nil {
			t.Fatal(err)
		}
		pid := s.firstPid()
		if want := fmt.Sprintf("running on http://127.0.0.1:%d (pid %d)", s.port, pid); line != want {
			t.Fatalf("line = %q, want %q", line, want)
		}
		record, ok := ReadPidFile(context.Background(), s.state)
		if !ok || record.Pid != pid || record.Port != int64(s.port) || record.Mode != PidModeRouter {
			t.Fatalf("record = %+v, want the real front (pid %d)", record, pid)
		}
		waitUntil(t, 8*time.Second, func() bool { return frontProcessHealth(t, s.port).Worker == "up" })
		status, body, err := frontProcessPost(t, s.port, "claude-x")
		if err != nil || status != 200 || body != "from anthropic" {
			t.Fatalf("post = %d %q %v, want 200 from anthropic", status, body, err)
		}
		health := frontProcessHealth(t, s.port)
		if !health.OK || health.Name != "acme" || health.Provider != "Acme Models" || health.Mode != "router" ||
			health.Version != "v1" || health.FrontVersion != FrontVersion || health.Pid != int(pid) || health.WorkerPid == nil {
			t.Fatalf("health = %+v", health)
		}
		if probe := ProbeRouter(context.Background(), s.port, processAcme, 0); probe.State != ProbeOurs {
			t.Fatalf("the port probes as %s", probe.State)
		}
	})

	t.Run("hands over: stops accepting so a new front can bind, finishes open connections, then is done", func(t *testing.T) {
		s := newFrontProcessSetup(t, "")
		if _, err := StartRouter(context.Background(), s.options()); err != nil {
			t.Fatal(err)
		}
		record, ok := ReadPidFile(context.Background(), s.state)
		if !ok {
			t.Fatal("no pid record")
		}
		status, body, err := frontProcessControl(t, s.port, "handover", record.Token)
		if err != nil || status != 200 || body != `{"ok":true}` {
			t.Fatalf("handover = %d %q %v", status, body, err)
		}
		waitUntil(t, 8*time.Second, func() bool {
			listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", s.port))
			if err != nil {
				return false
			}
			_ = listener.Close()
			return true
		})
		// The old front is done: its process ends, and the starter brings a new one up on the port.
		line, err := StartRouter(context.Background(), s.options())
		if err != nil {
			t.Fatal(err)
		}
		if want := fmt.Sprintf("running on http://127.0.0.1:%d (pid %d)", s.port, s.lastPid()); line != want {
			t.Fatalf("line = %q, want %q", line, want)
		}
		if got := s.spawnedCount(); got != 2 {
			t.Fatalf("%d fronts were started, want 2", got)
		}
		if probe := ProbeRouter(context.Background(), s.port, processAcme, 0); probe.State != ProbeOurs {
			t.Fatalf("the port probes as %s", probe.State)
		}
	})

	t.Run("answers the key check through the worker, and says when it cannot", func(t *testing.T) {
		s := newFrontProcessSetup(t, "")
		if _, err := StartRouter(context.Background(), s.options()); err != nil {
			t.Fatal(err)
		}
		source, err := RouterKeyCheck(context.Background(), processAcme, s.env, s.state, 0)
		if err != nil || source != "CHILD_KEY" {
			t.Fatalf("key check = %q %v, want CHILD_KEY", source, err)
		}

		// A front whose worker cannot be forked has no key to read: the check says so.
		broken := newFrontProcessSetup(t, filepath.Join(t.TempDir(), "missing", routerBinaryName))
		if _, err := StartRouter(context.Background(), broken.options()); err != nil {
			t.Fatal(err)
		}
		if _, err := RouterKeyCheck(context.Background(), processAcme, broken.env, broken.state, 300); err == nil || err.Error() != NoWorker {
			t.Fatalf("err = %v, want %q", err, NoWorker)
		}
	})
}

// frontProcessHealth reads the real front's health answer.
func frontProcessHealth(t *testing.T, port int) healthBody {
	t.Helper()
	answer, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d%s", port, processHealthPath))
	if err != nil {
		t.Fatal(err)
	}
	defer answer.Body.Close()
	text, _ := io.ReadAll(answer.Body)
	var health healthBody
	if err := json.Unmarshal(text, &health); err != nil {
		t.Fatalf("health %q: %v", text, err)
	}
	return health
}

// frontProcessPost posts one message request to the front.
func frontProcessPost(t *testing.T, port int, model string) (int, string, error) {
	t.Helper()
	return frontProcessDo(t, http.MethodPost, port, "/v1/messages", fmt.Sprintf(`{"model":%q}`, model), "")
}

// frontProcessControl makes one control call with the token.
func frontProcessControl(t *testing.T, port int, action, token string) (int, string, error) {
	t.Helper()
	return frontProcessDo(t, http.MethodPost, port, processHealthPath+"/"+action, "{}", token)
}

func frontProcessDo(t *testing.T, method string, port int, path, body, token string) (int, string, error) {
	t.Helper()
	request, err := http.NewRequest(method, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), strings.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	request.Host = fmt.Sprintf("127.0.0.1:%d", port)
	if token != "" {
		request.Header.Set(TokenHeader, token)
	}
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	answer, err := client.Do(request)
	if err != nil {
		return 0, "", err
	}
	defer answer.Body.Close()
	text, _ := io.ReadAll(answer.Body)
	return answer.StatusCode, string(text), nil
}
