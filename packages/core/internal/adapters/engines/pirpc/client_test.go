package pirpc

// The client tests: every one starts the fake pi from fakepi_test.go as a real child process and
// drives it over the real wire.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/shared"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// testSessionID is a readonly session the way the worker starts one.
const testSessionID = "00000000-0000-7000-8000-0000000000ff"

var rpcArgs = []string{
	"--mode", "rpc",
	"--model", "zai/glm-5.3",
	"--no-extensions", "--no-mcp", "--no-skills", "--no-context-files",
	"--tools", "read,grep,find,ls",
	"--session-id", testSessionID,
}

var handshakeSoon = HandshakeOptions{TimeoutMs: 30_000}

func selfExe(t *testing.T) string {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	return exe
}

// childEnv is the whole environment a child role needs: a bare PATH and HOME, the role, and the
// FAKE_PI knobs. GOCOVERDIR rides along under coverage so the re-executed child stays silent.
func childEnv(mode string, extra ...string) []string {
	env := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
		engineChildEnv + "=" + mode,
	}
	env = append(env, extra...)
	if dir := os.Getenv("GOCOVERDIR"); dir != "" {
		env = append(env, "GOCOVERDIR="+dir)
	}
	return env
}

// startFake starts the fake pi under the given FAKE_PI_* environment; it is killed when the test
// ends. A custom TimeoutMs or GraceMs rides along, everything else about the command is fixed.
func startFake(t *testing.T, fakeEnv []string, options PiRpcOptions) *PiRpcClient {
	t.Helper()
	options.PiCommand = PiCommand{
		Command:   selfExe(t),
		Args:      rpcArgs,
		Cwd:       t.TempDir(),
		Env:       childEnv("fake-pi", fakeEnv...),
		TimeoutMs: options.TimeoutMs,
		GraceMs:   options.GraceMs,
	}
	return startClient(t, options)
}

func startClient(t *testing.T, options PiRpcOptions) *PiRpcClient {
	t.Helper()
	client, err := StartPiRpc(context.Background(), options)
	if err != nil {
		t.Fatalf("startPiRpc: %s", err.Message)
	}
	t.Cleanup(func() {
		client.Kill(syscall.SIGKILL)
		client.Wait()
	})
	return client
}

// frameCollector collects every frame the client passes through, in order.
type frameCollector struct {
	mu     sync.Mutex
	frames []Frame
	done   chan struct{}
}

func collect(client *PiRpcClient) *frameCollector {
	c := &frameCollector{done: make(chan struct{})}
	go func() {
		defer close(c.done)
		for frame := range client.Frames {
			c.mu.Lock()
			c.frames = append(c.frames, frame)
			c.mu.Unlock()
		}
	}()
	return c
}

func (c *frameCollector) snapshot() []Frame {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Frame(nil), c.frames...)
}

// finish waits for the frames stream to end and returns everything that passed through.
func (c *frameCollector) finish(t *testing.T) []Frame {
	t.Helper()
	select {
	case <-c.done:
	case <-time.After(10 * time.Second):
		t.Fatal("the frames stream did not end")
	}
	return c.snapshot()
}

// waitFor resolves with the first frame matching predicate, failing the test after ms.
func (c *frameCollector) waitFor(t *testing.T, predicate func(Frame) bool, ms int64) Frame {
	t.Helper()
	deadline := time.Now().Add(time.Duration(ms) * time.Millisecond)
	for {
		for _, frame := range c.snapshot() {
			if predicate(frame) {
				return frame
			}
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("frame did not arrive within %d ms", ms)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func frameTypeIs(frame Frame, typ string) bool {
	return frameString(frame, "type") == typ
}

func isAbortResponse(frame Frame) bool {
	response, ok := IsResponse(frame)
	return ok && response.Command == "abort"
}

func frameTypes(frames []Frame) []string {
	types := make([]string, 0, len(frames))
	for _, frame := range frames {
		types = append(types, frameString(frame, "type"))
	}
	return types
}

// messageRoles is the role of every message_end frame, in order.
func messageRoles(frames []Frame) []string {
	var roles []string
	for _, frame := range frames {
		if frameTypeIs(frame, "message_end") {
			roles = append(roles, frameString(frameObject(frame, "message"), "role"))
		}
	}
	return roles
}

func readLines(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var lines []string
	for _, line := range strings.Split(string(data), "\n") {
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

// assertCleanExit is pi's own exit: code 0, no signal, nothing on stderr, unforced.
func assertCleanExit(t *testing.T, exit process.ProcessExit) {
	t.Helper()
	if exit.Code == nil || *exit.Code != 0 || exit.Signal != "" || exit.StderrTail != "" || exit.Forced != "" {
		t.Fatalf("exit = %+v, want code 0, no signal, empty tail, unforced", exit)
	}
}

// killedExitIs reports whether exit is a hard kill's exit: SIGKILL with no code.
func killedExitIs(exit process.ProcessExit) bool {
	return exit.Code == nil && exit.Signal == "SIGKILL"
}

type turnOutcome struct {
	turn TurnEnd
	err  *RpcError
}

type responseOutcome struct {
	response RpcResponse
	err      *RpcError
}

func TestHandshake(t *testing.T) {
	t.Run("sends get_state first and returns its data, with the whole exchange logged", func(t *testing.T) {
		dir := t.TempDir()
		log := &shared.RpcLogPaths{
			Stdout:    filepath.Join(dir, "a.jsonl"),
			Stdin:     filepath.Join(dir, "a.rpc-in.jsonl"),
			PromptRef: "ref",
		}
		client := startFake(t, nil, PiRpcOptions{Log: log})
		shake, err := client.Handshake(handshakeSoon)
		if err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		if got := frameString(shake.State, "sessionId"); got != testSessionID {
			t.Errorf("sessionId = %q, want %q", got, testSessionID)
		}
		if got := frameString(shake.State, "thinkingLevel"); got != "medium" {
			t.Errorf("thinkingLevel = %q, want medium", got)
		}
		if got := string(shake.State["messageCount"]); got != "0" {
			t.Errorf("messageCount = %s, want 0", got)
		}
		assertCleanExit(t, client.Close())
		if got := readLines(t, log.Stdin); !reflect.DeepEqual(got, []string{`{"id":"c1","type":"get_state"}`}) {
			t.Errorf("stdin log = %q, want the get_state command alone", got)
		}
		stdout := readLines(t, log.Stdout)
		if len(stdout) == 0 || !strings.Contains(stdout[0], `"command":"get_state"`) {
			t.Errorf("stdout log starts with %q, want the get_state response", firstLine(stdout))
		}
	})

	t.Run("marks pi's session-create warning benign and keeps it out of the exit's stderr tail", func(t *testing.T) {
		var mu sync.Mutex
		var seen []struct {
			line   string
			benign bool
		}
		client := startFake(t, nil, PiRpcOptions{OnStderr: func(line string, benign bool) {
			mu.Lock()
			seen = append(seen, struct {
				line   string
				benign bool
			}{line, benign})
			mu.Unlock()
		}})
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		if err := testkit.Until(t, func() bool {
			mu.Lock()
			defer mu.Unlock()
			return len(seen) == 1
		}, testkit.UntilOptions{Message: "the session warning did not arrive"}); err != nil {
			t.Fatal(err)
		}
		mu.Lock()
		defer mu.Unlock()
		want := "Warning: No project session found with id '" + testSessionID +
			"'; creating a new session with that id."
		if len(seen) != 1 || seen[0].line != want || !seen[0].benign {
			t.Fatalf("stderr = %+v, want only the benign session warning", seen)
		}
		if exit := client.Close(); exit.StderrTail != "" {
			t.Errorf("stderrTail = %q, want empty", exit.StderrTail)
		}
	})

	t.Run("still completes against a pi that answers get_state late", func(t *testing.T) {
		client := startFake(t, []string{"FAKE_PI_SLOW_STATE_MS=150"}, PiRpcOptions{})
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		assertCleanExit(t, client.Close())
	})

	t.Run("times out and kills pi when the answer never comes", func(t *testing.T) {
		client := startFake(t, []string{"FAKE_PI_SLOW_STATE_MS=5000"}, PiRpcOptions{})
		_, err := client.Handshake(HandshakeOptions{TimeoutMs: 200})
		if err == nil || err.Kind != RpcErrorTimeout ||
			err.Message != "pi did not complete the RPC handshake within 200 ms" {
			t.Fatalf("handshake error = %+v, want the 200 ms timeout", err)
		}
		exit := client.Wait()
		if !killedExitIs(exit) {
			t.Fatalf("exit = %+v, want the handshake's kill", exit)
		}
		if testkit.IsPidAlive(int(client.Pid)) {
			t.Error("pi is still alive after the handshake killed it")
		}
	})

	t.Run("refuses a get_state answer without a sessionId, as a protocol error, and kills pi", func(t *testing.T) {
		client := startFake(t, []string{"FAKE_PI_NO_SESSION_ID=1"}, PiRpcOptions{})
		_, err := client.Handshake(handshakeSoon)
		if err == nil || err.Kind != RpcErrorProtocol ||
			err.Message != "pi's get_state answer carries no sessionId" {
			t.Fatalf("handshake error = %+v, want the protocol refusal", err)
		}
		if exit := client.Wait(); !killedExitIs(exit) {
			t.Fatalf("exit = %+v, want the handshake's kill", exit)
		}
	})

	t.Run("reports a pi that dies before answering as an exit, with its stderr tail", func(t *testing.T) {
		client := startClient(t, PiRpcOptions{PiCommand: PiCommand{
			Command: selfExe(t),
			Env:     childEnv("early-death"),
			Cwd:     t.TempDir(),
		}})
		_, err := client.Handshake(handshakeSoon)
		if err == nil || err.Kind != RpcErrorExited || err.Message != "pi ended (exit code 3): early death" {
			t.Fatalf("handshake error = %+v, want the exit report", err)
		}
		exit := client.Wait()
		if exit.Code == nil || *exit.Code != 3 {
			t.Fatalf("exit = %+v, want code 3", exit)
		}
	})

	t.Run("tolerates a stray non-JSON line before the first command, logging it as sent", func(t *testing.T) {
		dir := t.TempDir()
		log := &shared.RpcLogPaths{
			Stdout:    filepath.Join(dir, "a.jsonl"),
			Stdin:     filepath.Join(dir, "a.rpc-in.jsonl"),
			PromptRef: "ref",
		}
		client := startFake(t, []string{"FAKE_PI_GARBAGE=1"}, PiRpcOptions{Log: log})
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		assertCleanExit(t, client.Close())
		stdout := readLines(t, log.Stdout)
		if len(stdout) == 0 || stdout[0] != "this is not json" {
			t.Errorf("stdout log starts with %q, want the stray line as sent", firstLine(stdout))
		}
	})

	t.Run("clears its timeout timer once the handshake answers", func(t *testing.T) {
		client := startFake(t, nil, PiRpcOptions{})
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		// Stop reports whether it disarmed an armed timer, so a timer the handshake failed to
		// clear fails the check.
		if client.handshakeTimer == nil {
			t.Fatal("the handshake left no timer to inspect")
		}
		if client.handshakeTimer.Stop() {
			t.Error("the handshake timer is still armed after the answer")
		}
		assertCleanExit(t, client.Close())
	})
}

func TestHandshakeTimeoutMs(t *testing.T) {
	t.Run("defaults to 15 seconds and honours PICC_HANDSHAKE_TIMEOUT_MS", func(t *testing.T) {
		if DefaultHandshakeTimeoutMs != 15_000 {
			t.Errorf("DEFAULT_HANDSHAKE_TIMEOUT_MS = %d, want 15000", DefaultHandshakeTimeoutMs)
		}
		cases := []struct {
			env  map[string]string
			want int64
		}{
			{map[string]string{}, 15_000},
			{map[string]string{"PICC_HANDSHAKE_TIMEOUT_MS": "60000"}, 60_000},
			{map[string]string{"PICC_HANDSHAKE_TIMEOUT_MS": "soon"}, 15_000},
			{map[string]string{"PICC_HANDSHAKE_TIMEOUT_MS": "0"}, 15_000},
		}
		for _, c := range cases {
			if got := HandshakeTimeoutMs(c.env); got != c.want {
				t.Errorf("handshakeTimeoutMs(%v) = %d, want %d", c.env, got, c.want)
			}
		}
	})
}

func TestCommands(t *testing.T) {
	t.Run("correlates answers by id", func(t *testing.T) {
		client := startFake(t, nil, PiRpcOptions{})
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		var wg sync.WaitGroup
		results := make([]responseOutcome, 2)
		wg.Add(2)
		go func() {
			defer wg.Done()
			results[0].response, results[0].err = client.Request(json.RawMessage(`{"type":"get_state"}`))
		}()
		go func() {
			defer wg.Done()
			results[1].response, results[1].err = client.Request(json.RawMessage(`{"type":"get_last_assistant_text"}`))
		}()
		wg.Wait()
		state, text := results[0], results[1]
		if state.err != nil || state.response.Command != "get_state" ||
			frameString(state.response.Data, "sessionId") != testSessionID {
			t.Errorf("get_state = %+v (err %+v), want its session data", state.response, state.err)
		}
		if text.err != nil || text.response.Command != "get_last_assistant_text" ||
			frameString(text.response.Data, "text") != "" {
			t.Errorf("get_last_assistant_text = %+v (err %+v), want the empty text", text.response, text.err)
		}
		assertCleanExit(t, client.Close())
	})

	t.Run("surfaces a command pi refuses", func(t *testing.T) {
		client := startFake(t, nil, PiRpcOptions{})
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		_, err := client.Request(json.RawMessage(`{"type":"frobnicate"}`))
		if err == nil || err.Kind != RpcErrorRejected || err.Command != "frobnicate" ||
			err.Message != "Unknown command: frobnicate" {
			t.Fatalf("error = %+v, want the frobnicate refusal", err)
		}
		assertCleanExit(t, client.Close())
	})

	t.Run("answers exited, not rejected, once pi is gone", func(t *testing.T) {
		client := startFake(t, nil, PiRpcOptions{})
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		assertCleanExit(t, client.Close())
		_, err := client.Request(json.RawMessage(`{"type":"get_state"}`))
		if err == nil || err.Kind != RpcErrorExited {
			t.Fatalf("error = %+v, want an exited failure", err)
		}
		if _, err := client.LastAssistantText(); err == nil || err.Kind != RpcErrorExited {
			t.Errorf("lastAssistantText after pi is gone = %+v, want the exit failure", err)
		}
	})

	t.Run("answers closed when stdin is already shut but pi lives on", func(t *testing.T) {
		client := startFake(t, []string{"FAKE_PI_SCENARIO=sleep"}, PiRpcOptions{})
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		seen := collect(client)
		promptDone := make(chan struct{})
		go func() {
			defer close(promptDone)
			_, _ = client.Prompt("sleep")
		}()
		// The prompt must be on the wire and admitted before stdin is shut.
		seen.waitFor(t, func(frame Frame) bool {
			response, ok := IsResponse(frame)
			return ok && response.Command == "prompt"
		}, 10_000)
		closing := make(chan process.ProcessExit, 1)
		go func() { closing <- client.Close() }()
		if err := testkit.Until(t, func() bool {
			client.mu.Lock()
			defer client.mu.Unlock()
			return client.inputClosed
		}, testkit.UntilOptions{Message: "stdin was not shut"}); err != nil {
			t.Fatal(err)
		}
		_, err := client.Request(json.RawMessage(`{"type":"get_state"}`))
		if err == nil || err.Kind != RpcErrorClosed ||
			err.Message != "pi's stdin is closed; no further commands can be sent" {
			t.Fatalf("error = %+v, want the closed failure", err)
		}
		if client.send(json.RawMessage(`{"type":"get_state"}`)) {
			t.Error("send after stdin was shut = true, want false")
		}
		client.Kill(syscall.SIGKILL)
		if exit := <-closing; !killedExitIs(exit) {
			t.Fatalf("exit = %+v, want the kill", exit)
		}
		<-promptDone
	})
}

func TestTurns(t *testing.T) {
	t.Run("resolves a prompt at agent_settled with its timings, and the transcript frames pass through in order", func(t *testing.T) {
		client := startFake(t, nil, PiRpcOptions{})
		seen := collect(client)
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		turn, err := client.Prompt("Do the thing.")
		if err != nil {
			t.Fatalf("prompt: %s", err.Message)
		}
		if turn.EndedAt < turn.PromptSentAt {
			t.Errorf("turn = %+v, endedAt not after promptSentAt", turn)
		}
		seen.waitFor(t, func(frame Frame) bool { return frameTypeIs(frame, "agent_settled") }, 10_000)
		frames := seen.snapshot()
		if got := messageRoles(frames); !reflect.DeepEqual(got, []string{"system", "user", "assistant"}) {
			t.Errorf("message roles = %v, want [system user assistant]", got)
		}
		found := false
		for _, typ := range frameTypes(frames) {
			if typ == "message_update" {
				found = true
			}
		}
		if !found {
			t.Error("no message_update frame passed through")
		}
		if last := frames[len(frames)-1]; len(last) != 1 || frameString(last, "type") != "agent_settled" {
			t.Errorf("last frame = %v, want a bare agent_settled", last)
		}
		text, err := client.LastAssistantText()
		if err != nil {
			t.Fatalf("lastAssistantText: %s", err.Message)
		}
		if text != "done" {
			t.Errorf("last assistant text = %q, want done", text)
		}
		assertCleanExit(t, client.Close())
	})

	t.Run("admits and settles a turn even when pi ends its assistant message in error", func(t *testing.T) {
		client := startFake(t, []string{"FAKE_PI_SCENARIO=error"}, PiRpcOptions{})
		seen := collect(client)
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		if _, err := client.Prompt("Summarize."); err != nil {
			t.Fatalf("prompt: %s", err.Message)
		}
		seen.waitFor(t, func(frame Frame) bool { return frameTypeIs(frame, "agent_settled") }, 10_000)
		if got := messageRoles(seen.snapshot()); !reflect.DeepEqual(got, []string{"system", "user", "assistant"}) {
			t.Errorf("message roles = %v, want [system user assistant]", got)
		}
		assertCleanExit(t, client.Close())
	})

	t.Run("settles with no assistant message at all when pi has nothing to say", func(t *testing.T) {
		client := startFake(t, []string{"FAKE_PI_NO_AGENT=1"}, PiRpcOptions{})
		seen := collect(client)
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		if _, err := client.Prompt("Just settle."); err != nil {
			t.Fatalf("prompt: %s", err.Message)
		}
		seen.waitFor(t, func(frame Frame) bool { return frameTypeIs(frame, "agent_settled") }, 10_000)
		frames := seen.snapshot()
		if got := messageRoles(frames); !reflect.DeepEqual(got, []string{"system", "user"}) {
			t.Errorf("message roles = %v, want [system user]", got)
		}
		if last := frames[len(frames)-1]; len(last) != 1 || frameString(last, "type") != "agent_settled" {
			t.Errorf("last frame = %v, want a bare agent_settled", last)
		}
		assertCleanExit(t, client.Close())
	})

	t.Run("rejects the prompt when pi will not take it", func(t *testing.T) {
		client := startFake(t, []string{"FAKE_PI_SCENARIO=no-such-scenario"}, PiRpcOptions{})
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		_, err := client.Prompt("Try anyway.")
		if err == nil || err.Kind != RpcErrorRejected || err.Command != "prompt" ||
			err.Message != "cannot prompt now" {
			t.Fatalf("error = %+v, want the prompt refusal", err)
		}
		assertCleanExit(t, client.Close())
	})

	t.Run("aborts a running tool: the turn settles before the abort response, in pi's order", func(t *testing.T) {
		client := startFake(t, []string{"FAKE_PI_SCENARIO=sleep"}, PiRpcOptions{})
		seen := collect(client)
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		turn := make(chan turnOutcome, 1)
		go func() {
			ended, err := client.Prompt("sleep")
			turn <- turnOutcome{ended, err}
		}()
		seen.waitFor(t, func(frame Frame) bool { return frameTypeIs(frame, "tool_execution_start") }, 10_000)
		response, err := client.Abort()
		if err != nil || response.Command != "abort" {
			t.Fatalf("abort = %+v (err %+v), want a successful abort answer", response, err)
		}
		if out := <-turn; out.err != nil {
			t.Fatalf("the aborted turn failed: %s", out.err.Message)
		}
		seen.waitFor(t, isAbortResponse, 10_000)
		frames := seen.snapshot()
		settledAt, abortReplyAt := -1, -1
		for i, frame := range frames {
			if frameTypeIs(frame, "agent_settled") && settledAt < 0 {
				settledAt = i
			}
			if isAbortResponse(frame) {
				abortReplyAt = i
			}
		}
		if settledAt < 0 || abortReplyAt <= settledAt {
			t.Fatalf("agent_settled at %d, abort reply at %d, want the settle first", settledAt, abortReplyAt)
		}
		var messages []Frame
		for _, frame := range frames {
			if frameTypeIs(frame, "message_end") {
				messages = append(messages, frame)
			}
		}
		last := frameObject(messages[len(messages)-1], "message")
		if frameString(last, "role") != "assistant" || frameString(last, "stopReason") != "error" ||
			frameString(last, "errorMessage") != "The operation was aborted." {
			t.Errorf("last message = %s, want the aborted assistant message", last)
		}
		assertCleanExit(t, client.Close())
	})

	t.Run("kills a pi that ignores the abort", func(t *testing.T) {
		graceMs := int64(300)
		client := startFake(t, []string{"FAKE_PI_SCENARIO=ignore-abort"}, PiRpcOptions{
			PiCommand: PiCommand{GraceMs: &graceMs},
		})
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		turn := make(chan turnOutcome, 1)
		go func() {
			ended, err := client.Prompt("sleep")
			turn <- turnOutcome{ended, err}
		}()
		collect(client).waitFor(t, func(frame Frame) bool {
			return frameTypeIs(frame, "tool_execution_start")
		}, 10_000)
		if _, err := client.Abort(); err != nil {
			t.Fatalf("abort: %s", err.Message)
		}
		// The ladder: an ignored SIGTERM, then the killing SIGKILL.
		client.Kill(syscall.SIGTERM)
		// Two waiters race the deadline: pi ignoring SIGTERM is still running 300 ms later.
		waiting := make(chan process.ProcessExit, 2)
		go func() { waiting <- client.Wait() }()
		go func() { waiting <- client.Wait() }()
		select {
		case exit := <-waiting:
			t.Fatalf("pi ended early: %+v", exit)
		case <-time.After(300 * time.Millisecond):
		}
		client.Kill(syscall.SIGKILL)
		<-waiting
		<-waiting
		out := <-turn
		if out.err == nil || out.err.Kind != RpcErrorExited || out.err.Exit == nil ||
			!killedExitIs(*out.err.Exit) {
			t.Fatalf("turn error = %+v, want the kill that ended the turn", out.err)
		}
	})

	t.Run("rejects the turn when pi dies mid-turn", func(t *testing.T) {
		client := startFake(t, []string{"FAKE_PI_SCENARIO=crash"}, PiRpcOptions{})
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		_, err := client.Prompt("crash")
		if err == nil || err.Kind != RpcErrorExited ||
			err.Message != "pi ended (exit code 1): fake pi: simulated crash" {
			t.Fatalf("error = %+v, want the crash report", err)
		}
		one := 1
		want := process.ProcessExit{Code: &one, StderrTail: "fake pi: simulated crash\n"}
		if err.Exit == nil || !reflect.DeepEqual(*err.Exit, want) {
			t.Fatalf("exit = %+v, want %+v", err.Exit, want)
		}
		client.Wait()
	})

	t.Run("refuses a second prompt while a turn is still open (pi is single-flight)", func(t *testing.T) {
		client := startFake(t, []string{"FAKE_PI_SCENARIO=sleep"}, PiRpcOptions{})
		seen := collect(client)
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		// The first turn's promise never settles once replaced; nothing may wait on it.
		go func() { _, _ = client.Prompt("first") }()
		seen.waitFor(t, func(frame Frame) bool {
			response, ok := IsResponse(frame)
			return ok && response.Command == "prompt"
		}, 10_000)
		_, err := client.Prompt("second")
		if err == nil || err.Kind != RpcErrorRejected || err.Command != "prompt" ||
			err.Message != "cannot prompt now" {
			t.Fatalf("error = %+v, want the single-flight refusal", err)
		}
		if _, err := client.Abort(); err != nil {
			t.Fatalf("abort: %s", err.Message)
		}
		assertCleanExit(t, client.Close())
	})
}

func TestLargeFrames(t *testing.T) {
	t.Run("carries a 2 MiB assistant message whole, without chunking", func(t *testing.T) {
		dir := t.TempDir()
		log := &shared.RpcLogPaths{
			Stdout:    filepath.Join(dir, "a.jsonl"),
			Stdin:     filepath.Join(dir, "a.rpc-in.jsonl"),
			PromptRef: "ref",
		}
		client := startFake(t, []string{"FAKE_PI_SCENARIO=big-frame"}, PiRpcOptions{Log: log})
		seen := collect(client)
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		if _, err := client.Prompt("read big.txt"); err != nil {
			t.Fatalf("prompt: %s", err.Message)
		}
		seen.waitFor(t, func(frame Frame) bool { return frameTypeIs(frame, "agent_settled") }, 10_000)
		var assistant Frame
		for _, frame := range seen.snapshot() {
			if frameTypeIs(frame, "message_end") &&
				frameString(frameObject(frame, "message"), "role") == "assistant" {
				assistant = frame
			}
		}
		if assistant == nil {
			t.Fatal("no assistant message_end frame passed through")
		}
		var parts []map[string]json.RawMessage
		content := frameObject(assistant, "message")["content"]
		if err := json.Unmarshal(content, &parts); err != nil {
			t.Fatalf("the assistant content is not a part list: %v", err)
		}
		if len(parts) == 0 {
			t.Fatal("the assistant message carries no content part")
		}
		text, hasText := frameStringOk(parts[0], "text")
		if !hasText || len(text) != 2*1024*1024 {
			t.Fatalf("first text part = %d bytes (present %v), want 2 MiB", len(text), hasText)
		}
		// The log is an append stream written behind the frames; close is what flushes it.
		assertCleanExit(t, client.Close())
		frames := seen.finish(t)
		logged := readLines(t, log.Stdout)
		if len(logged) != len(frames) {
			t.Fatalf("logged %d lines for %d frames", len(logged), len(frames))
		}
		longest := 0
		for _, line := range logged {
			if len(line) > longest {
				longest = len(line)
			}
			if strings.Contains(line, "rpc_chunk") {
				t.Fatal("a logged line carries an rpc_chunk")
			}
		}
		if longest <= 2*1024*1024 {
			t.Fatalf("longest logged line = %d, want over 2 MiB", longest)
		}
	})
}

func TestCloseAndExit(t *testing.T) {
	t.Run("close ends stdin, drains the remaining frames and reports pi's own exit", func(t *testing.T) {
		client := startFake(t, nil, PiRpcOptions{})
		seen := collect(client)
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		if _, err := client.Prompt("done"); err != nil {
			t.Fatalf("prompt: %s", err.Message)
		}
		assertCleanExit(t, client.Close())
		// The queue was closed at stdout end; nothing new can arrive after close.
		<-seen.done
		if _, open := <-client.Frames; open {
			t.Error("the frames stream is still open after close")
		}
		if len(seen.snapshot()) == 0 {
			t.Error("no frames passed through")
		}
		if testkit.IsPidAlive(int(client.Pid)) {
			t.Error("pi is still alive after its own exit")
		}
	})

	t.Run("fails with start when the binary is missing", func(t *testing.T) {
		_, err := StartPiRpc(context.Background(), PiRpcOptions{PiCommand: PiCommand{
			Command: "/nonexistent/pi",
			Cwd:     t.TempDir(),
			Env:     []string{},
		}})
		if err == nil || err.Kind != RpcErrorStart {
			t.Fatalf("error = %+v, want a start failure", err)
		}
		if !strings.Contains(err.Message, "ENOENT") {
			t.Errorf("error message = %q, want it to name ENOENT", err.Message)
		}
	})

	t.Run("fails with start when a log cannot be opened", func(t *testing.T) {
		dir := t.TempDir()
		// A file where a directory of logs should be makes both log paths unopenable.
		blocker := filepath.Join(dir, "blocked")
		if err := os.WriteFile(blocker, []byte("not a directory"), 0o644); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"stdout", "stdin"} {
			log := &shared.RpcLogPaths{
				Stdout:    filepath.Join(blocker, name+".jsonl"),
				Stdin:     filepath.Join(blocker, name+".rpc-in.jsonl"),
				PromptRef: "ref",
			}
			_, err := StartPiRpc(context.Background(), PiRpcOptions{
				PiCommand: PiCommand{Command: selfExe(t), Cwd: dir, Env: []string{}},
				Log:       log,
			})
			if err == nil || err.Kind != RpcErrorStart {
				t.Fatalf("error = %+v for %s, want a start failure", err, name)
			}
			if !strings.Contains(err.Message, "cannot open log") {
				t.Errorf("error message = %q, want it to say cannot open log", err.Message)
			}
		}
	})
}

// The worker tests cover these paths through the client; carried here as direct tests so the
// coverage stays whole.

func TestUnattendedReply(t *testing.T) {
	frameFrom := func(text string) Frame {
		var frame Frame
		if err := json.Unmarshal([]byte(text), &frame); err != nil {
			t.Fatalf("test frame does not parse: %v", err)
		}
		return frame
	}
	t.Run("approves a confirmation", func(t *testing.T) {
		frame := frameFrom(`{"type":"extension_ui_request","id":"ui-confirm","method":"confirm","title":"Test dialog"}`)
		want := `{"type":"extension_ui_response","id":"ui-confirm","confirmed":true}`
		if got := string(unattendedReply(frame)); got != want {
			t.Errorf("unattendedReply() = %s, want %s", got, want)
		}
	})
	for _, method := range []string{"select", "input", "editor"} {
		t.Run("cancels a "+method+" the user must answer", func(t *testing.T) {
			frame := frameFrom(fmt.Sprintf(`{"type":"extension_ui_request","id":"ui-%s","method":%q}`, method, method))
			want := fmt.Sprintf(`{"type":"extension_ui_response","id":"ui-%s","cancelled":true}`, method)
			if got := string(unattendedReply(frame)); got != want {
				t.Errorf("unattendedReply() = %s, want %s", got, want)
			}
		})
	}
	t.Run("ignores a request without an id", func(t *testing.T) {
		if got := unattendedReply(frameFrom(`{"type":"extension_ui_request","method":"confirm"}`)); got != nil {
			t.Errorf("unattendedReply() = %s, want none", got)
		}
	})
	t.Run("ignores a method it does not know", func(t *testing.T) {
		if got := unattendedReply(frameFrom(`{"type":"extension_ui_request","id":"ui-x","method":"other"}`)); got != nil {
			t.Errorf("unattendedReply() = %s, want none", got)
		}
	})
	t.Run("leaves a command that is not an object alone", func(t *testing.T) {
		if got := string(withID("c1", json.RawMessage(`42`))); got != "42" {
			t.Errorf("withID() = %s, want the command untouched", got)
		}
	})
	t.Run("escapes the id the way JSON.stringify does", func(t *testing.T) {
		frame := frameFrom(`{"type":"extension_ui_request","id":"x\u0001y\bz\fq\re\tf\"g\\h","method":"confirm"}`)
		want := `{"type":"extension_ui_response","id":"x\u0001y\bz\fq\re\tf\"g\\h","confirmed":true}`
		if got := string(unattendedReply(frame)); got != want {
			t.Errorf("unattendedReply() = %s, want %s", got, want)
		}
	})
}

func TestInterruptAndTextlessAnswers(t *testing.T) {
	t.Run("interrupt runs pi's own abort first, then ends the run", func(t *testing.T) {
		client := startFake(t, []string{"FAKE_PI_SCENARIO=sleep"}, PiRpcOptions{})
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		seen := collect(client)
		turn := make(chan turnOutcome, 1)
		go func() {
			ended, err := client.Prompt("sleep")
			turn <- turnOutcome{ended, err}
		}()
		seen.waitFor(t, func(frame Frame) bool { return frameTypeIs(frame, "tool_execution_start") }, 10_000)
		client.Interrupt(context.Background(), process.ForcedStopped, 2_000)
		// The exit is racy by design (the soft abort races the group kill), so only the forced
		// reason is asserted.
		<-turn
		exit := client.Wait()
		if exit.Forced != process.ForcedStopped {
			t.Fatalf("exit = %+v, want the forced stop", exit)
		}
		if testkit.IsPidAlive(int(client.Pid)) {
			t.Error("pi is still alive after the interrupt")
		}
	})

	t.Run("refuses a text-less get_last_assistant_text answer as a protocol error", func(t *testing.T) {
		client := startFake(t, []string{"FAKE_PI_LAST_TEXTLESS=1"}, PiRpcOptions{})
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		_, err := client.LastAssistantText()
		if err == nil || err.Kind != RpcErrorProtocol ||
			err.Message != "pi's get_last_assistant_text answer carries no text" {
			t.Fatalf("error = %+v, want the protocol refusal", err)
		}
		assertCleanExit(t, client.Close())
	})
}

func TestUnattendedDialogs(t *testing.T) {
	t.Run("answers extension confirmations and cancels text dialogs without waiting for a human", func(t *testing.T) {
		client := startFake(t, []string{"FAKE_PI_SCENARIO=ui"}, PiRpcOptions{})
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		// The fake exits 1 on any dialog answered the wrong way, so a clean turn is proof every
		// confirmation was approved and every text dialog cancelled.
		if _, err := client.Prompt("Open the dialog."); err != nil {
			t.Fatalf("prompt: %s", err.Message)
		}
		assertCleanExit(t, client.Close())
	})
}

func TestOnResponse(t *testing.T) {
	t.Run("answers a refusal without error text with pi refused the command", func(t *testing.T) {
		client := startFake(t, nil, PiRpcOptions{})
		if _, err := client.Handshake(handshakeSoon); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		answer := make(chan rpcAnswer, 1)
		client.mu.Lock()
		client.pending["c99"] = answer
		client.mu.Unlock()
		client.onResponse(RpcResponse{Id: "c99", Command: "frobnicate", Success: false})
		got := <-answer
		if got.err == nil || got.err.Kind != RpcErrorRejected || got.err.Command != "frobnicate" ||
			got.err.Message != "pi refused frobnicate" {
			t.Fatalf("the answer = %+v, want the refusal fallback", got.err)
		}
		assertCleanExit(t, client.Close())
	})
}

func TestRpcErrorMessage(t *testing.T) {
	// Error carries the failure through the error interface, where errors.As reads the
	// discriminant; the message stays the one the kinds built.
	failure := &RpcError{Kind: RpcErrorTimeout, Message: "pi did not answer"}
	if got := failure.Error(); got != "pi did not answer" {
		t.Errorf("Error() = %q, want the message", got)
	}
}

func firstLine(lines []string) string {
	if len(lines) == 0 {
		return ""
	}
	return lines[0]
}
