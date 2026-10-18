package omprpc

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/shared"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// parsedLine reads a log line as a JSON object.
func parsedLine(t *testing.T, line string) map[string]any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(line), &value); err != nil {
		t.Fatalf("log line is not JSON: %v\n%s", err, line)
	}
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("log line is not an object: %s", line)
	}
	return object
}

// assertExitExact checks the whole ProcessExit, field for field.
func assertExitExact(t *testing.T, exit process.ProcessExit, code int) {
	t.Helper()
	if exit.Code == nil || *exit.Code != code {
		t.Errorf("exit code = %v, want %d", exit.Code, code)
	}
	if exit.Signal != "" || exit.StderrTail != "" || exit.Forced != "" {
		t.Errorf("exit = signal %q, tail %q, forced %q; want a plain exit %d", exit.Signal, exit.StderrTail, exit.Forced, code)
	}
}

// killedExitIs reports whether exit is a hard kill's exit: SIGKILL with no code.
func killedExitIs(exit process.ProcessExit) bool {
	return exit.Code == nil && exit.Signal == "SIGKILL"
}

// frameTypes is the collector's frame types, in order.
func frameTypes(seen *frameLog) []string {
	var types []string
	for _, frame := range seen.snapshot() {
		types = append(types, rawString(frame["type"]))
	}
	return types
}

func frameIsType(frameType string) func(Frame) bool {
	return func(frame Frame) bool { return rawString(frame["type"]) == frameType }
}

// responseTo matches the ack of a command.
func responseTo(command string) func(Frame) bool {
	return func(frame Frame) bool {
		return rawString(frame["type"]) == "response" && rawString(frame["command"]) == command
	}
}

// messageEndRoles reads every message_end frame's message.role, in order.
func messageEndRoles(seen *frameLog) []string {
	var roles []string
	for _, frame := range seen.snapshot() {
		if rawString(frame["type"]) != "message_end" {
			continue
		}
		var message map[string]json.RawMessage
		if json.Unmarshal(frame["message"], &message) == nil {
			roles = append(roles, rawString(message["role"]))
		}
	}
	return roles
}

func TestHandshake(t *testing.T) {
	t.Run("negotiates v2, mounts the host tools, sets the filter and returns get_state", func(t *testing.T) {
		dir := t.TempDir()
		log := &shared.RpcLogPaths{
			Stdout:    filepath.Join(dir, "a.jsonl"),
			Stdin:     filepath.Join(dir, "a.rpc-in.jsonl"),
			PromptRef: "ref",
		}
		client := startFake(t, nil, fakeOptions{Log: log})
		options := handshakeOptions()
		options.ExpectTools = []string{"read", "grep", "glob", "submit_report"}
		shake, err := client.Handshake(context.Background(), options)
		if err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		if !reflect.DeepEqual(shake.Ready.SupportedProtocolVersions, []float64{1, 2}) {
			t.Errorf("ready versions = %v, want [1 2]", shake.Ready.SupportedProtocolVersions)
		}
		model, _ := shake.State["model"].(map[string]any)
		if model["id"] != "glm-5.3" {
			t.Errorf("state.model.id = %v, want glm-5.3", model["id"])
		}
		assertExitExact(t, client.Close(), 0)

		var sent []map[string]any
		for _, line := range lines(t, log.Stdin) {
			sent = append(sent, parsedLine(t, line))
		}
		var types []string
		for _, command := range sent {
			types = append(types, command["type"].(string))
		}
		if !reflect.DeepEqual(types, []string{"negotiate_protocol", "set_host_tools", "set_event_filter", "get_state"}) {
			t.Errorf("sent command types = %v", types)
		}
		if !reflect.DeepEqual(sent[0], map[string]any{"id": "c1", "type": "negotiate_protocol", "protocolVersion": float64(2)}) {
			t.Errorf("negotiate_protocol = %v", sent[0])
		}
		tools, _ := sent[1]["tools"].([]any)
		first, _ := tools[0].(map[string]any)
		if first["name"] != "submit_report" || first["loadMode"] != "essential" {
			t.Errorf("tools[0] = %v, want submit_report mounted essential", first)
		}
		filter, _ := sent[2]["events"].([]any)
		hasUpdates := false
		for _, event := range filter {
			if event == "message_update" {
				hasUpdates = true
			}
		}
		if !hasUpdates || sent[2]["messageUpdates"] != "delta" {
			t.Errorf("set_event_filter = %v, want message_update events and delta updates", sent[2])
		}
	})

	t.Run("tolerates tools beyond the expected set", func(t *testing.T) {
		client := startFake(t, nil, fakeOptions{})
		options := handshakeOptions()
		options.ExpectTools = []string{"read", "grep", "glob"}
		if _, err := client.Handshake(context.Background(), options); err != nil {
			t.Errorf("handshake error = %v, want the mounted submit_report tolerated", err)
		}
	})

	t.Run("fails when dumpTools lacks an expected tool", func(t *testing.T) {
		client := startFake(t, nil, fakeOptions{})
		options := handshakeOptions()
		options.ExpectTools = []string{"read", "grep", "glob", "plan"}
		_, err := client.Handshake(context.Background(), options)
		if err == nil || err.Kind != RpcErrorProtocol || !strings.Contains(err.Message, "plan") {
			t.Errorf("handshake error = %v, want a protocol error naming plan", err)
		}
	})

	t.Run("waits for a slow ready, and reports omp's 'Still starting' stderr as benign", func(t *testing.T) {
		var mu sync.Mutex
		var stderr []struct {
			line   string
			benign bool
		}
		client := startFake(t, map[string]string{"FAKE_OMP_READY_DELAY_MS": "1500"}, fakeOptions{
			OnStderr: func(line string, benign bool) {
				mu.Lock()
				stderr = append(stderr, struct {
					line   string
					benign bool
				}{line, benign})
				mu.Unlock()
			},
		})
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		mu.Lock()
		defer mu.Unlock()
		want := "Still starting after 10s — phase: discoverCustomToolPaths"
		if len(stderr) != 1 || stderr[0].line != want || !stderr[0].benign {
			t.Errorf("stderr = %+v, want one benign %q", stderr, want)
		}
		if exit := client.Close(); exit.StderrTail != "" {
			t.Errorf("stderrTail = %q, want empty", exit.StderrTail)
		}
	})

	t.Run("times out when ready does not come in time, then kills the omp nobody drives anymore", func(t *testing.T) {
		client := startFake(t, map[string]string{"FAKE_OMP_READY_DELAY_MS": "5000"}, fakeOptions{})
		options := handshakeOptions()
		options.TimeoutMs = 200
		_, err := client.Handshake(context.Background(), options)
		if err == nil || err.Kind != RpcErrorTimeout ||
			err.Message != "omp did not complete the RPC handshake within 200 ms" {
			t.Fatalf("handshake error = %v, want the 200 ms timeout", err)
		}
		exit := client.Exit()
		if !killedExitIs(exit) {
			t.Errorf("exit = %v (signal %q), want the handshake's kill", exit.Code, exit.Signal)
		}
	})

	t.Run("refuses an omp without protocol 2, then kills it", func(t *testing.T) {
		client := startFake(t, map[string]string{"FAKE_OMP_PROTOCOLS": "1"}, fakeOptions{})
		_, err := client.Handshake(context.Background(), handshakeOptions())
		if err == nil || err.Kind != RpcErrorProtocol ||
			err.Message != "omp offers RPC protocol 1; 2 is required" {
			t.Fatalf("handshake error = %v, want the protocol refusal", err)
		}
		exit := client.Exit()
		if !killedExitIs(exit) {
			t.Errorf("exit = %v (signal %q), want the handshake's kill", exit.Code, exit.Signal)
		}
	})

	t.Run("reports an omp that exits before ready, with its stderr (recorded: --resume <unknown id>)", func(t *testing.T) {
		client := startFixture(t, "resume-unknown-id", fakeOptions{})
		_, err := client.Handshake(context.Background(), handshakeOptions())
		if err == nil || err.Kind != RpcErrorExited || err.Exit == nil || err.Exit.Code == nil || *err.Exit.Code != 1 {
			t.Fatalf("handshake error = %+v, want an exited error with code 1", err)
		}
		if !strings.Contains(err.Message, "not found") {
			t.Errorf("message = %q, want the stderr tail with 'not found'", err.Message)
		}
	})

	t.Run("tolerates a line that is not a frame, and logs it", func(t *testing.T) {
		dir := t.TempDir()
		log := &shared.RpcLogPaths{
			Stdout:    filepath.Join(dir, "a.jsonl"),
			Stdin:     filepath.Join(dir, "b.jsonl"),
			PromptRef: "ref",
		}
		client := startFake(t, map[string]string{"FAKE_OMP_GARBAGE": "1"}, fakeOptions{Log: log})
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		assertExitExact(t, client.Close(), 0)
		if got := lines(t, log.Stdout)[0]; got != "this is not json" {
			t.Errorf("first logged line = %q, want the stray output", got)
		}
	})

	t.Run("reads the timeout from OMPCC_HANDSHAKE_TIMEOUT_MS, defaulting to 45 s", func(t *testing.T) {
		if DefaultHandshakeTimeoutMs < 30_000 {
			t.Errorf("default = %d, want at least 30000", DefaultHandshakeTimeoutMs)
		}
		if got := HandshakeTimeoutMs(map[string]string{"OMPCC_HANDSHAKE_TIMEOUT_MS": "60000"}); got != 60_000 {
			t.Errorf("env timeout = %d, want 60000", got)
		}
		for _, value := range []string{"", "0", "-5", "1.5", "soon"} {
			env := map[string]string{"OMPCC_HANDSHAKE_TIMEOUT_MS": value}
			if got := HandshakeTimeoutMs(env); got != DefaultHandshakeTimeoutMs {
				t.Errorf("timeout for %q = %d, want the default %d", value, got, DefaultHandshakeTimeoutMs)
			}
		}
		if got := HandshakeTimeoutMs(nil); got != DefaultHandshakeTimeoutMs {
			t.Errorf("timeout without the variable = %d, want the default", got)
		}
	})

	t.Run("leaves no handshake timeout timer behind once the handshake answers", func(t *testing.T) {
		client := startFake(t, nil, fakeOptions{})
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		// The Go timer is stopped the moment the handshake answers (time.Timer.Stop); the pipe-drop
		// fallback after exit then runs on its own real timer, which this close waits out.
		assertExitExact(t, client.Close(), 0)
	})
}

func TestCommands(t *testing.T) {
	t.Run("correlates concurrent responses by id", func(t *testing.T) {
		client := startFake(t, nil, fakeOptions{})
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		stateCh := make(chan RpcResponse, 1)
		statsCh := make(chan RpcResponse, 1)
		go func() {
			response, _ := client.Request(RpcCommand(`{"type":"get_state"}`))
			stateCh <- response
		}()
		go func() {
			response, _ := client.Request(RpcCommand(`{"type":"get_session_stats"}`))
			statsCh <- response
		}()
		state := <-stateCh
		stats := <-statsCh
		if state.Command != "get_state" {
			t.Errorf("first response command = %q, want get_state", state.Command)
		}
		var stateData map[string]any
		if err := json.Unmarshal(state.Data, &stateData); err != nil {
			t.Fatalf("get_state data: %v", err)
		}
		if _, ok := stateData["dumpTools"].([]any); !ok {
			t.Errorf("get_state data.dumpTools = %v, want an array", stateData["dumpTools"])
		}
		var statsData map[string]any
		if err := json.Unmarshal(stats.Data, &statsData); err != nil {
			t.Fatalf("get_session_stats data: %v", err)
		}
		if statsData["assistantMessages"] != float64(0) {
			t.Errorf("assistantMessages = %v, want 0", statsData["assistantMessages"])
		}
	})

	t.Run("returns omp's refusal", func(t *testing.T) {
		client := startFake(t, nil, fakeOptions{})
		response, err := client.Request(RpcCommand(`{"type":"frobnicate"}`))
		if err == nil || err.Kind != RpcErrorRejected || err.Command != "frobnicate" ||
			err.Message != "Unknown command: frobnicate" {
			t.Fatalf("request = (%v, %v), want the refusal", response, err)
		}
	})

	t.Run("refuses to send after close", func(t *testing.T) {
		client := startFake(t, nil, fakeOptions{})
		client.Close()
		if _, err := client.Request(RpcCommand(`{"type":"get_state"}`)); err == nil || err.Kind != RpcErrorExited {
			t.Errorf("request after close = %v, want an exited error", err)
		}
	})

	t.Run("fails a request whose process has its stdin closed but is still running", func(t *testing.T) {
		client := startFake(t, map[string]string{"FAKE_OMP_SCENARIO": "sleep"}, fakeOptions{})
		seen := collect(client)
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		go func() { _, _ = client.Prompt("sleep") }()
		seen.waitForFrame(t, 10_000, frameIsType("tool_execution_start"))
		closing := make(chan process.ProcessExit, 1)
		go func() { closing <- client.Close() }()
		// The close races the request, so the first refusal is polled for and must be the
		// closed one.
		deadline := time.Now().Add(10 * time.Second)
		var err *RpcError
		for {
			_, err = client.Request(RpcCommand(`{"type":"get_state"}`))
			if err != nil {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("requests kept succeeding after the close")
			}
			time.Sleep(5 * time.Millisecond)
		}
		if err.Kind != RpcErrorClosed ||
			err.Message != "omp's stdin is closed; no further commands can be sent" {
			t.Fatalf("request = %v, want the closed error", err)
		}
		client.Kill(syscall.SIGKILL)
		<-closing
	})

	t.Run("interrupt runs the soft stop, then the group's termination", func(t *testing.T) {
		client := startFake(t, map[string]string{"FAKE_OMP_SCENARIO": "sleep"}, fakeOptions{})
		seen := collect(client)
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		turn := make(chan struct {
			end TurnEnd
			err *RpcError
		}, 1)
		go func() {
			end, err := client.Prompt("sleep")
			turn <- struct {
				end TurnEnd
				err *RpcError
			}{end, err}
		}()
		seen.waitForFrame(t, 10_000, frameIsType("tool_execution_start"))
		client.Interrupt(process.ForcedTimeout)
		result := <-turn
		if result.err != nil || result.end.Result.Status != "aborted" {
			t.Errorf("turn = (%v, %v), want the aborted turn", result.end.Result, result.err)
		}
		exit := client.Exit()
		if exit.Forced != process.ForcedTimeout {
			t.Errorf("forced = %q, want timeout", exit.Forced)
		}
	})
}

func TestTurns(t *testing.T) {
	t.Run("runs a turn: host tool before tool start, report accepted, prompt_result completed and settled", func(t *testing.T) {
		var calls []HostToolCall
		var mu sync.Mutex
		client := startFake(t, map[string]string{"FAKE_OMP_REPORT": `{"status":"done","summary":"ok"}`}, fakeOptions{
			OnHostToolCall: func(call HostToolCall, _ <-chan struct{}) (*HostToolReply, error) {
				mu.Lock()
				calls = append(calls, call)
				mu.Unlock()
				return &HostToolReply{Text: "Report received."}, nil
			},
		})
		seen := collect(client)
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		end, err := client.Prompt("Do the thing.")
		if err != nil {
			t.Fatalf("prompt: %s", err.Message)
		}
		if end.Result.Status != "completed" || !end.Result.AgentInvoked || !end.Result.SessionSettled {
			t.Errorf("result = %+v, want completed, agent invoked, settled", end.Result)
		}
		seen.waitForFrame(t, 10_000, frameIsType("session_settled"))
		mu.Lock()
		defer mu.Unlock()
		if len(calls) != 1 || calls[0].ToolName != "submit_report" {
			t.Fatalf("calls = %+v, want one submit_report", calls)
		}
		var arguments map[string]any
		if err := json.Unmarshal(calls[0].Arguments, &arguments); err != nil ||
			arguments["status"] != "done" || arguments["summary"] != "ok" {
			t.Errorf("arguments = %v, want the done report", arguments)
		}
		types := frameTypes(seen)
		hostAt, toolAt, updates := -1, -1, 0
		for i, frameType := range types {
			switch frameType {
			case "host_tool_call":
				if hostAt == -1 {
					hostAt = i
				}
			case "tool_execution_start":
				if toolAt == -1 {
					toolAt = i
				}
			case "message_update":
				updates++
			}
		}
		if hostAt == -1 || toolAt == -1 || hostAt >= toolAt {
			t.Errorf("host_tool_call at %d, tool_execution_start at %d; the call must come first\nframes: %v",
				hostAt, toolAt, types)
		}
		if updates == 0 {
			t.Error("no message_update frame arrived")
		}
		if roles := messageEndRoles(seen); !reflect.DeepEqual(roles, []string{"user", "assistant", "toolResult", "assistant"}) {
			t.Errorf("message_end roles = %v", roles)
		}
	})

	t.Run("passes the host's rejections back until it accepts", func(t *testing.T) {
		var calls int
		var mu sync.Mutex
		client := startFake(t, nil, fakeOptions{
			OnHostToolCall: func(_ HostToolCall, _ <-chan struct{}) (*HostToolReply, error) {
				mu.Lock()
				defer mu.Unlock()
				calls++
				if calls < 3 {
					return &HostToolReply{Text: "files.0.path: expected string", IsError: true}, nil
				}
				return &HostToolReply{Text: "Report received."}, nil
			},
		})
		seen := collect(client)
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		end, err := client.Prompt("go")
		if err != nil || end.Result.Status != "completed" {
			t.Fatalf("prompt = (%+v, %v), want a completed turn", end.Result, err)
		}
		seen.waitForFrame(t, 10_000, frameIsType("session_settled"))
		mu.Lock()
		if calls != 3 {
			t.Errorf("calls = %d, want 3", calls)
		}
		mu.Unlock()
		var errors []bool
		var first string
		for _, frame := range seen.snapshot() {
			if rawString(frame["type"]) == "tool_execution_end" {
				errors = append(errors, rawBool(frame["isError"]))
				if first == "" {
					first = string(frame["result"])
				}
			}
		}
		if !reflect.DeepEqual(errors, []bool{true, true, false}) {
			t.Errorf("isError flags = %v, want [true true false]", errors)
		}
		if !strings.Contains(first, "files.0.path: expected string") {
			t.Errorf("first tool result = %s, want the rejection text", first)
		}
	})

	t.Run("replies isError for a handler that throws", func(t *testing.T) {
		client := startFake(t, nil, fakeOptions{
			OnHostToolCall: func(_ HostToolCall, _ <-chan struct{}) (*HostToolReply, error) {
				return nil, fmt.Errorf("validator crashed")
			},
		})
		seen := collect(client)
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		if _, err := client.Prompt("go"); err != nil {
			t.Fatalf("prompt: %s", err.Message)
		}
		seen.waitForFrame(t, 10_000, frameIsType("session_settled"))
		end := firstToolExecutionEnd(t, seen)
		isError, content := toolEndResult(t, end)
		if !isError || content != "validator crashed" {
			t.Errorf("tool end = (%v, %q), want the crash text", isError, content)
		}
	})

	t.Run("replies isError for no handler", func(t *testing.T) {
		client := startFake(t, nil, fakeOptions{})
		seen := collect(client)
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		if _, err := client.Prompt("go"); err != nil {
			t.Fatalf("prompt: %s", err.Message)
		}
		seen.waitForFrame(t, 10_000, frameIsType("session_settled"))
		end := firstToolExecutionEnd(t, seen)
		isError, content := toolEndResult(t, end)
		if !isError || content != "No host tool named submit_report." {
			t.Errorf("tool end = (%v, %q), want the missing-tool text", isError, content)
		}
	})

	t.Run("replies isError when the handler returns something that is not a reply", func(t *testing.T) {
		client := startFake(t, nil, fakeOptions{
			OnHostToolCall: func(_ HostToolCall, _ <-chan struct{}) (*HostToolReply, error) {
				return nil, nil
			},
		})
		seen := collect(client)
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		end, err := client.Prompt("go")
		if err != nil || end.Result.Status != "completed" {
			t.Fatalf("prompt = (%+v, %v), want a completed turn", end.Result, err)
		}
		seen.waitForFrame(t, 10_000, frameIsType("session_settled"))
		var errors []bool
		var first string
		for _, frame := range seen.snapshot() {
			if rawString(frame["type"]) == "tool_execution_end" {
				errors = append(errors, rawBool(frame["isError"]))
				if first == "" {
					first = string(frame["result"])
				}
			}
		}
		if !reflect.DeepEqual(errors, []bool{true, true, true}) {
			t.Errorf("isError flags = %v, want three errors", errors)
		}
		if !strings.Contains(first, "did not return a reply") {
			t.Errorf("first tool result = %s, want the no-reply text", first)
		}
	})

	t.Run("waits for session_settled when prompt_result says the session is not settled", func(t *testing.T) {
		client := startFake(t, map[string]string{"FAKE_OMP_LATE_SETTLE": "1"}, fakeOptions{
			OnHostToolCall: func(_ HostToolCall, _ <-chan struct{}) (*HostToolReply, error) {
				return &HostToolReply{Text: "Report received."}, nil
			},
		})
		seen := collect(client)
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		end, err := client.Prompt("go")
		if err != nil {
			t.Fatalf("prompt: %s", err.Message)
		}
		if end.Result.SessionSettled {
			t.Error("prompt_result said the session was settled")
		}
		seen.waitForFrame(t, 10_000, frameIsType("session_settled"))
		types := frameTypes(seen)
		at := -1
		for i, frameType := range types {
			if frameType == "prompt_result" {
				at = i
			}
		}
		if at == -1 || !reflect.DeepEqual(types[at+1:], []string{"session_settled"}) {
			t.Errorf("frames after prompt_result = %v, want only session_settled", types[at+1:])
		}
		if end.EndedAtMs-end.PromptSentAtMs < 100 {
			t.Errorf("turn lasted %d ms, want at least the 100 ms settle delay", end.EndedAtMs-end.PromptSentAtMs)
		}
	})

	t.Run("settles a turn whose prompt ran no agent, without waiting for session_settled", func(t *testing.T) {
		client := startFake(t, map[string]string{"FAKE_OMP_NO_AGENT": "1"}, fakeOptions{})
		seen := collect(client)
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		end, err := client.Prompt("go")
		if err != nil || end.Result.Status != "completed" || end.Result.AgentInvoked || end.Result.SessionSettled {
			t.Fatalf("prompt = (%+v, %v), want a completed no-agent turn", end.Result, err)
		}
		assertExitExact(t, client.Close(), 0)
		<-seen.done
		for _, frameType := range frameTypes(seen) {
			if frameType == "session_settled" {
				t.Error("a session_settled frame arrived for a no-agent turn")
			}
		}
	})

	t.Run("aborts a running tool: the turn ends aborted", func(t *testing.T) {
		client := startFake(t, map[string]string{"FAKE_OMP_SCENARIO": "sleep"}, fakeOptions{})
		seen := collect(client)
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		turn := make(chan struct {
			end TurnEnd
			err *RpcError
		}, 1)
		go func() {
			end, err := client.Prompt("sleep")
			turn <- struct {
				end TurnEnd
				err *RpcError
			}{end, err}
		}()
		seen.waitForFrame(t, 10_000, frameIsType("tool_execution_start"))
		response, err := client.Abort()
		if err != nil || response.Command != "abort" {
			t.Fatalf("abort = (%v, %v), want the ack", response, err)
		}
		result := <-turn
		if result.err != nil || result.end.Result.Status != "aborted" {
			t.Fatalf("turn = (%+v, %v), want the aborted turn", result.end.Result, result.err)
		}
		seen.waitForFrame(t, 10_000, frameIsType("session_settled"))
		// The last message_end is the aborted assistant message.
		var last map[string]json.RawMessage
		for _, frame := range seen.snapshot() {
			if rawString(frame["type"]) == "message_end" {
				var message map[string]json.RawMessage
				if json.Unmarshal(frame["message"], &message) == nil {
					last = message
				}
			}
		}
		if rawString(last["role"]) != "assistant" || rawString(last["stopReason"]) != "aborted" {
			t.Errorf("last message = %v, want the aborted assistant message", last)
		}
	})

	t.Run("aborts the host-tool handler on host_tool_cancel and sends no result", func(t *testing.T) {
		dir := t.TempDir()
		log := &shared.RpcLogPaths{
			Stdout:    filepath.Join(dir, "a.jsonl"),
			Stdin:     filepath.Join(dir, "b.jsonl"),
			PromptRef: "ref",
		}
		cancelled := make(chan struct{})
		client := startFake(t, nil, fakeOptions{
			Log: log,
			OnHostToolCall: func(_ HostToolCall, signal <-chan struct{}) (*HostToolReply, error) {
				<-signal
				close(cancelled)
				return &HostToolReply{Text: "too late"}, nil
			},
		})
		seen := collect(client)
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		turn := make(chan struct {
			end TurnEnd
			err *RpcError
		}, 1)
		go func() {
			end, err := client.Prompt("go")
			turn <- struct {
				end TurnEnd
				err *RpcError
			}{end, err}
		}()
		seen.waitForFrame(t, 10_000, frameIsType("host_tool_call"))
		if _, err := client.Abort(); err != nil {
			t.Fatalf("abort: %s", err.Message)
		}
		result := <-turn
		if result.err != nil || result.end.Result.Status != "aborted" {
			t.Fatalf("turn = (%+v, %v), want the aborted turn", result.end.Result, result.err)
		}
		select {
		case <-cancelled:
		case <-time.After(10 * time.Second):
			t.Fatal("the handler was never cancelled")
		}
		assertExitExact(t, client.Close(), 0)
		<-seen.done
		var sawCancel bool
		for _, frameType := range frameTypes(seen) {
			if frameType == "host_tool_cancel" {
				sawCancel = true
			}
		}
		if !sawCancel {
			t.Error("no host_tool_cancel frame arrived")
		}
		for _, line := range lines(t, log.Stdin) {
			if strings.Contains(line, `"host_tool_result"`) {
				t.Errorf("a host_tool_result was sent after the cancel: %s", line)
			}
		}
	})

	t.Run("an omp that ignores abort leaves the turn open until it is killed", func(t *testing.T) {
		client := startFake(t, map[string]string{"FAKE_OMP_SCENARIO": "ignore-abort"}, fakeOptions{})
		seen := collect(client)
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		turn := make(chan struct {
			end TurnEnd
			err *RpcError
		}, 1)
		go func() {
			end, err := client.Prompt("sleep")
			turn <- struct {
				end TurnEnd
				err *RpcError
			}{end, err}
		}()
		seen.waitForFrame(t, 10_000, frameIsType("tool_execution_start"))
		if _, err := client.Abort(); err != nil {
			t.Fatalf("abort: %s", err.Message)
		}
		// The two-step ladder: an ignored SIGTERM, then the killing SIGKILL.
		client.Kill(syscall.SIGTERM)
		select {
		case <-turn:
			t.Fatal("the turn ended although omp ignored both abort and SIGTERM")
		case <-time.After(300 * time.Millisecond):
		}
		client.Kill(syscall.SIGKILL)
		result := <-turn
		if result.err == nil || result.err.Kind != RpcErrorExited || result.err.Exit == nil ||
			!killedExitIs(*result.err.Exit) {
			t.Fatalf("turn error = %+v, want the kill that ended the turn", result.err)
		}
	})

	t.Run("abort reaches a bash child in its own process group", func(t *testing.T) {
		pidFile := filepath.Join(t.TempDir(), "child.pid")
		client := startFake(t, map[string]string{
			"FAKE_OMP_SCENARIO":      "bash-child",
			"FAKE_OMP_CHILD_PIDFILE": pidFile,
		}, fakeOptions{})
		seen := collect(client)
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		turn := make(chan struct {
			end TurnEnd
			err *RpcError
		}, 1)
		go func() {
			end, err := client.Prompt("run it")
			turn <- struct {
				end TurnEnd
				err *RpcError
			}{end, err}
		}()
		seen.waitForFrame(t, 10_000, frameIsType("tool_execution_start"))
		data, err := os.ReadFile(pidFile)
		if err != nil {
			t.Fatalf("read the pid file: %v", err)
		}
		child, err := strconv.Atoi(strings.TrimSpace(string(data)))
		if err != nil {
			t.Fatalf("pid file holds %q", data)
		}
		if !process.IsAlive(int64(child)) {
			t.Fatal("the bash child was dead before the abort")
		}
		if _, err := client.Abort(); err != nil {
			t.Fatalf("abort: %s", err.Message)
		}
		result := <-turn
		if result.err != nil || result.end.Result.Status != "aborted" {
			t.Fatalf("turn = (%+v, %v), want the aborted turn", result.end.Result, result.err)
		}
		deadline := time.Now().Add(10 * time.Second)
		for process.IsAlive(int64(child)) && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if process.IsAlive(int64(child)) {
			t.Error("the bash child survived the abort")
		}
	})

	t.Run("a crash mid-turn fails the turn with the exit and the stderr tail", func(t *testing.T) {
		client := startFake(t, map[string]string{"FAKE_OMP_SCENARIO": "crash"}, fakeOptions{})
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		_, err := client.Prompt("go")
		if err == nil || err.Kind != RpcErrorExited ||
			err.Message != "omp ended (exit code 1): fake omp: simulated crash" {
			t.Fatalf("prompt error = %v, want the crash report", err)
		}
		want := process.ProcessExit{
			Code:       ptr(1),
			StderrTail: "fake omp: simulated crash\n",
		}
		if err.Exit == nil || !reflect.DeepEqual(*err.Exit, want) {
			t.Errorf("exit = %+v, want %+v", err.Exit, want)
		}
	})

	t.Run("returns omp's refusal of a prompt", func(t *testing.T) {
		client := startFake(t, map[string]string{"FAKE_OMP_SCENARIO": "sleep"}, fakeOptions{})
		seen := collect(client)
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		go func() { _, _ = client.Prompt("first") }()
		seen.waitForFrame(t, 10_000, frameIsType("tool_execution_start"))
		_, err := client.Prompt("second")
		if err == nil || err.Kind != RpcErrorRejected || err.Command != "prompt" {
			t.Fatalf("second prompt = %v, want omp's refusal of it", err)
		}
	})
}

func TestLargeFrames(t *testing.T) {
	t.Run("reassembles v2 rpc_chunk frames and logs tool details cut to head and tail", func(t *testing.T) {
		dir := t.TempDir()
		log := &shared.RpcLogPaths{
			Stdout:    filepath.Join(dir, "a.jsonl"),
			Stdin:     filepath.Join(dir, "b.jsonl"),
			PromptRef: "job.json#attempts[0].prompt",
		}
		client := startFake(t, map[string]string{
			"FAKE_OMP_SCENARIO": "big-frame",
			"FAKE_OMP_WIRE_LOG": filepath.Join(dir, "wire.jsonl"),
		}, fakeOptions{
			Log: log,
			OnHostToolCall: func(_ HostToolCall, _ <-chan struct{}) (*HostToolReply, error) {
				return &HostToolReply{Text: "Report received."}, nil
			},
		})
		seen := collect(client)
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		end, err := client.Prompt("read big.txt")
		if err != nil || end.Result.Status != "completed" {
			t.Fatalf("prompt = (%+v, %v), want a completed turn", end.Result, err)
		}
		assertExitExact(t, client.Close(), 0)
		<-seen.done

		var toolEnd Frame
		for _, frame := range seen.snapshot() {
			if rawString(frame["type"]) == "tool_execution_end" {
				toolEnd = frame
				break
			}
		}
		if toolEnd == nil {
			t.Fatal("no tool_execution_end frame arrived")
		}
		var result struct {
			Details struct {
				DisplayContent struct {
					Text string `json:"text"`
				} `json:"displayContent"`
			} `json:"details"`
		}
		if err := json.Unmarshal(toolEnd["result"], &result); err != nil {
			t.Fatalf("tool result: %v", err)
		}
		if len(result.Details.DisplayContent.Text) != 3*1024*1024 {
			t.Errorf("display text = %d chars, want 3 MiB", len(result.Details.DisplayContent.Text))
		}

		logged := lines(t, log.Stdout)
		if len(logged) != len(seen.snapshot()) {
			t.Errorf("logged %d lines for %d frames", len(logged), len(seen.snapshot()))
		}
		longest := 0
		for _, line := range logged {
			if len(line) > longest {
				longest = len(line)
			}
			if strings.Contains(line, `"type":"rpc_chunk"`) {
				t.Errorf("a logged line carries a raw chunk: %.80s", line)
			}
		}
		if longest >= 40*1024+3*shared.LogKeep {
			t.Errorf("longest logged line = %d, want under 40 KiB plus three keeps", longest)
		}

		// The wire itself carried the two big frames as rpc_chunk runs; only the client reassembled them.
		chunkIDs := map[string]bool{}
		for _, line := range lines(t, filepath.Join(dir, "wire.jsonl")) {
			frame := parsedLine(t, line)
			if frame["type"] != "rpc_chunk" {
				if frame["type"] == "tool_execution_end" && frame["toolName"] == "read" {
					t.Error("the read's tool_execution_end travelled as one frame")
				}
				continue
			}
			chunkIDs[frame["chunkId"].(string)] = true
			if byteLength, _ := frame["byteLength"].(float64); byteLength <= 1024*1024 {
				t.Errorf("chunk byteLength = %v, want over 1 MiB", frame["byteLength"])
			}
		}
		if len(chunkIDs) != 2 {
			t.Errorf("chunk ids = %v, want the two chunked frames", chunkIDs)
		}

		var loggedEnd string
		for _, line := range logged {
			if strings.HasPrefix(line, `{"type":"tool_execution_end"`) {
				loggedEnd = line
				break
			}
		}
		if loggedEnd == "" {
			t.Fatal("no tool_execution_end line in the inbound log")
		}
		loggedFrame := parsedLine(t, loggedEnd)
		loggedResult, _ := loggedFrame["result"].(map[string]any)
		details, _ := loggedResult["details"].(map[string]any)
		truncated, ok := details["$truncated"].(float64)
		if !ok || len(details) != 3 {
			t.Fatalf("logged details = %v, want exactly $truncated, head and tail", details)
		}
		if _, hasHead := details["head"]; !hasHead {
			t.Error("logged details carry no head")
		}
		if _, hasTail := details["tail"]; !hasTail {
			t.Error("logged details carry no tail")
		}
		var rawResult struct {
			Details json.RawMessage `json:"details"`
		}
		if err := json.Unmarshal(toolEnd["result"], &rawResult); err != nil {
			t.Fatal(err)
		}
		if int(truncated) != len(rawResult.Details) {
			t.Errorf("$truncated = %v, want %d (the details' own JSON length)", truncated, len(rawResult.Details))
		}

		promptRef := regexp.MustCompile(`"message":\{"\$ref":"job\.json#attempts\[0\]\.prompt"\}`)
		var promptLine string
		for _, line := range lines(t, log.Stdin) {
			if strings.Contains(line, `"prompt"`) {
				promptLine = line
				break
			}
		}
		if promptLine == "" || !promptRef.MatchString(promptLine) {
			t.Errorf("logged prompt = %q, want the message replaced by its ref", promptLine)
		}
	})
}

func TestCloseAndExit(t *testing.T) {
	t.Run("close keeps draining stdout, so a frame sent after close still arrives", func(t *testing.T) {
		// No host tools: a turn omp can finish without us, since close() has already closed our side.
		client := startFake(t, map[string]string{"FAKE_OMP_LATE_SETTLE": "1"}, fakeOptions{})
		seen := collect(client)
		options := handshakeOptions()
		options.HostTools = nil
		if _, err := client.Handshake(context.Background(), options); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		turn := make(chan struct {
			end TurnEnd
			err *RpcError
		}, 1)
		go func() {
			end, err := client.Prompt("go")
			turn <- struct {
				end TurnEnd
				err *RpcError
			}{end, err}
		}()
		// The close must wait for the prompt's ack to know it is on the wire.
		seen.waitForFrame(t, 10_000, responseTo("prompt"))
		closing := make(chan process.ProcessExit, 1)
		go func() { closing <- client.Close() }()
		seen.waitForFrame(t, 10_000, frameIsType("session_settled"))
		result := <-turn
		if result.err != nil || result.end.Result.SessionSettled {
			t.Fatalf("turn = (%+v, %v), want an unsettled prompt_result", result.end.Result, result.err)
		}
		assertExitExact(t, <-closing, 0)
		<-seen.done
		types := frameTypes(seen)
		if len(types) == 0 || types[len(types)-1] != "session_settled" {
			t.Errorf("the frames ended with %v, want session_settled last and nothing after it", types)
		}
	})

	t.Run("drops the pipes shortly after exit when a grandchild holds stdout", func(t *testing.T) {
		pidFile := filepath.Join(t.TempDir(), "pids")
		client := startFake(t, map[string]string{"FAKE_OMP_PIDFILE": pidFile}, fakeOptions{})
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		data, err := os.ReadFile(pidFile)
		if err != nil {
			t.Fatalf("read the pid file: %v", err)
		}
		parts := strings.Fields(string(data))
		if len(parts) != 2 {
			t.Fatalf("pid file holds %q", data)
		}
		grandchild, err := strconv.Atoi(parts[1])
		if err != nil {
			t.Fatalf("pid file holds %q", data)
		}
		started := time.Now()
		exit := client.Close()
		if exit.Code == nil || *exit.Code != 0 {
			t.Fatalf("exit = %+v, want code 0", exit)
		}
		if elapsed := time.Since(started); elapsed >= 5*time.Second {
			t.Errorf("close took %v, want the pipes dropped shortly after exit", elapsed)
		}
		if !process.IsAlive(int64(grandchild)) {
			t.Error("the grandchild died with omp")
		}
		// omp is gone, so the client's own signal is a no-op; the group still holds the grandchild.
		// The grandchild this test put in that group is the group's proof of ownership: while it
		// sits there the group id cannot have been handed to another process, and without it the
		// leader's pid could be anyone's by now.
		if testkit.PidInGroup(int64(grandchild), client.Pid) {
			if !process.SignalGroup(client.Pid, syscall.SIGKILL) {
				t.Fatal("could not signal omp's group to kill the grandchild")
			}
		}
		deadline := time.Now().Add(10 * time.Second)
		for process.IsAlive(int64(grandchild)) && time.Now().Before(deadline) {
			time.Sleep(20 * time.Millisecond)
		}
		if process.IsAlive(int64(grandchild)) {
			t.Error("the grandchild survived the group kill")
		}
	})

	t.Run("reports a missing binary as a start error", func(t *testing.T) {
		started, err := StartOmpRpc(context.Background(), OmpRpcOptions{
			Command: "/nonexistent/omp",
			Cwd:     t.TempDir(),
			Env:     []string{},
		})
		if started != nil || err == nil || err.Kind != RpcErrorStart || !strings.Contains(err.Message, "ENOENT") {
			t.Fatalf("start = (%v, %v), want a start error naming ENOENT", started, err)
		}
	})

	t.Run("reports a log it cannot open as a start error", func(t *testing.T) {
		dir := t.TempDir()
		file := filepath.Join(dir, "file")
		if err := os.WriteFile(file, []byte(""), 0o600); err != nil {
			t.Fatal(err)
		}
		exe, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		for _, paths := range []*shared.RpcLogPaths{
			{Stdout: filepath.Join(file, "a.jsonl"), Stdin: filepath.Join(dir, "b.jsonl"), PromptRef: "r"},
			{Stdout: filepath.Join(dir, "a.jsonl"), Stdin: filepath.Join(file, "b.jsonl"), PromptRef: "r"},
		} {
			started, err := StartOmpRpc(context.Background(), OmpRpcOptions{
				Command: exe,
				Args:    readonlyArgs,
				Cwd:     dir,
				Env:     []string{childModeEnv + "=omp"},
				Log:     paths,
			})
			if started != nil || err == nil || err.Kind != RpcErrorStart ||
				!strings.Contains(err.Message, "cannot open log") {
				t.Fatalf("start = (%v, %v), want a start error naming the log", started, err)
			}
		}
	})
}

// firstToolExecutionEnd is the first tool_execution_end frame the client passed through.
func firstToolExecutionEnd(t *testing.T, seen *frameLog) Frame {
	t.Helper()
	for _, frame := range seen.snapshot() {
		if rawString(frame["type"]) == "tool_execution_end" {
			return frame
		}
	}
	t.Fatal("no tool_execution_end frame arrived")
	return nil
}

// toolEndResult reads a tool_execution_end frame's isError flag and first text of its result.
func toolEndResult(t *testing.T, frame Frame) (bool, string) {
	t.Helper()
	var result struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(frame["result"], &result); err != nil {
		t.Fatalf("tool result: %v", err)
	}
	text := ""
	if len(result.Content) > 0 {
		text = result.Content[0].Text
	}
	return rawBool(frame["isError"]), text
}

// TestMessageGuards carries the message-decoder coverage: no handshake timer outlives the
// handshake (Stop is structural), and every malformed frame is refused by its own guard.
func TestMessageGuards(t *testing.T) {
	frame := func(text string) Frame {
		var parsed Frame
		if err := json.Unmarshal([]byte(text), &parsed); err != nil {
			t.Fatalf("test frame %s: %v", text, err)
		}
		return parsed
	}

	t.Run("a ready frame needs its versions and protocol number", func(t *testing.T) {
		good := frame(`{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1024}`)
		ready, ok := IsReady(good)
		if !ok || ready.ProtocolVersion != 1 || !reflect.DeepEqual(ready.SupportedProtocolVersions, []float64{1, 2}) {
			t.Fatalf("IsReady = (%+v, %v)", ready, ok)
		}
		if ready.MaxFrameBytes == nil || *ready.MaxFrameBytes != 1024 {
			t.Errorf("maxFrameBytes = %v, want 1024", ready.MaxFrameBytes)
		}
		for _, bad := range []string{
			`{"type":"ready","supportedProtocolVersions":[1,2]}`,
			`{"type":"ready","protocolVersion":1}`,
			`{"type":"ready","protocolVersion":"1","supportedProtocolVersions":[1,2]}`,
			`{"type":"ready","protocolVersion":1,"supportedProtocolVersions":["1","2"]}`,
			`{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,null]}`,
			`{"type":"session_settled"}`,
		} {
			if _, ok := IsReady(frame(bad)); ok {
				t.Errorf("IsReady(%s) = ok", bad)
			}
		}
	})

	t.Run("a response needs its command and success", func(t *testing.T) {
		response, ok := IsResponse(frame(`{"id":"c1","type":"response","command":"get_state","success":true,"data":{"x":1}}`))
		if !ok || response.Command != "get_state" || !response.Success ||
			response.ID == nil || *response.ID != "c1" || string(response.Data) != `{"x":1}` {
			t.Fatalf("IsResponse = %+v, %v", response, ok)
		}
		refused, ok := IsResponse(frame(`{"type":"response","command":"prompt","success":false,"error":"no"}`))
		if !ok || refused.Error == nil || *refused.Error != "no" || refused.ID != nil {
			t.Fatalf("IsResponse = %+v, %v", refused, ok)
		}
		for _, bad := range []string{
			`{"type":"response","command":"get_state"}`,
			`{"type":"response","success":true}`,
			`{"type":"response","command":"get_state","success":"true"}`,
			`{"type":"prompt"}`,
		} {
			if _, ok := IsResponse(frame(bad)); ok {
				t.Errorf("IsResponse(%s) = ok", bad)
			}
		}
	})

	t.Run("a prompt_result needs its four members", func(t *testing.T) {
		result, ok := IsPromptResult(frame(`{"type":"prompt_result","id":"c5","agentInvoked":true,"status":"completed","sessionSettled":true,"error":{"message":"boom","provider":"zai","model":"glm-5.3","httpStatus":401,"retryable":false}}`))
		if !ok || result.ID != "c5" || !result.AgentInvoked || result.Status != "completed" || !result.SessionSettled {
			t.Fatalf("IsPromptResult = %+v, %v", result, ok)
		}
		if result.Error == nil || result.Error.Message != "boom" || result.Error.Provider == nil ||
			*result.Error.Provider != "zai" || result.Error.HTTPStatus == nil || *result.Error.HTTPStatus != 401 ||
			result.Error.Retryable == nil || *result.Error.Retryable {
			t.Errorf("error = %+v, want the whole recorded error", result.Error)
		}
		if none, ok := IsPromptResult(frame(`{"type":"prompt_result","id":"c5","agentInvoked":true,"status":"completed","sessionSettled":true,"error":null}`)); !ok || none.Error != nil {
			t.Errorf("a null error = (%+v, %v), want no error", none, ok)
		}
		for _, bad := range []string{
			`{"type":"prompt_result","agentInvoked":true,"status":"completed","sessionSettled":true}`,
			`{"type":"prompt_result","id":"c5","status":"completed","sessionSettled":true}`,
			`{"type":"prompt_result","id":"c5","agentInvoked":true,"status":"finished","sessionSettled":true}`,
		} {
			if _, ok := IsPromptResult(frame(bad)); ok {
				t.Errorf("IsPromptResult(%s) = ok", bad)
			}
		}
	})

	t.Run("a host_tool_call needs its strings and an object of arguments", func(t *testing.T) {
		call, ok := IsHostToolCall(frame(`{"type":"host_tool_call","id":"h1","toolCallId":"t1","toolName":"submit_report","arguments":{"status":"done"}}`))
		if !ok || call.ID != "h1" || call.ToolCallID != "t1" || call.ToolName != "submit_report" ||
			string(call.Arguments) != `{"status":"done"}` {
			t.Fatalf("IsHostToolCall = %+v, %v", call, ok)
		}
		for _, bad := range []string{
			`{"type":"host_tool_call","toolCallId":"t1","toolName":"submit_report","arguments":{}}`,
			`{"type":"host_tool_call","id":"h1","toolCallId":"t1","toolName":"submit_report","arguments":[]}`,
			`{"type":"host_tool_call","id":"h1","toolCallId":"t1","toolName":"submit_report"}`,
		} {
			if _, ok := IsHostToolCall(frame(bad)); ok {
				t.Errorf("IsHostToolCall(%s) = ok", bad)
			}
		}
	})

	t.Run("a host_tool_cancel needs its ids", func(t *testing.T) {
		target, ok := IsHostToolCancel(frame(`{"type":"host_tool_cancel","id":"h2","targetId":"h1"}`))
		if !ok || target != "h1" {
			t.Fatalf("IsHostToolCancel = (%q, %v)", target, ok)
		}
		if _, ok := IsHostToolCancel(frame(`{"type":"host_tool_cancel","id":"h2"}`)); ok {
			t.Error("IsHostToolCancel without a target = ok")
		}
	})
}

func TestRpcErrorAndEncodeFallbacks(t *testing.T) {
	t.Run("an RpcError reads as its message", func(t *testing.T) {
		err := &RpcError{Kind: RpcErrorRejected, Command: "frobnicate", Message: "Unknown command: frobnicate"}
		if err.Error() != "Unknown command: frobnicate" {
			t.Errorf("Error() = %q", err.Error())
		}
	})

	t.Run("a value that cannot marshal falls back to an empty object", func(t *testing.T) {
		if got := string(mustJSON(make(chan int))); got != "{}" {
			t.Errorf("mustJSON() = %s, want {}", got)
		}
	})
}

func TestUnmatchedFramesAndRawMembers(t *testing.T) {
	t.Run("a prompt_result for a turn nobody asked about is dropped", func(t *testing.T) {
		client := startFake(t, nil, fakeOptions{})
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		client.onPromptResult(PromptResult{ID: "unknown", AgentInvoked: true, Status: "completed"})
		client.mu.Lock()
		turns := len(client.turns)
		client.mu.Unlock()
		if turns != 0 {
			t.Errorf("turns = %d, want none", turns)
		}
		assertExitExact(t, client.Close(), 0)
	})

	t.Run("a response without an id answers nobody", func(t *testing.T) {
		client := startFake(t, nil, fakeOptions{})
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		client.onResponse(RpcResponse{Command: "get_state", Success: true})
		assertExitExact(t, client.Close(), 0)
	})

	t.Run("send refuses once the client is closed", func(t *testing.T) {
		client := startFake(t, nil, fakeOptions{})
		if _, err := client.Handshake(context.Background(), handshakeOptions()); err != nil {
			t.Fatalf("handshake: %s", err.Message)
		}
		assertExitExact(t, client.Close(), 0)
		if client.send(mustJSON(typeOnlyCommand{Type: "get_state"})) {
			t.Error("send after close wrote the command")
		}
	})

	t.Run("raw members that are broken JSON read as no number", func(t *testing.T) {
		frame := Frame{"index": json.RawMessage("{broken"), "byteLength": json.RawMessage("")}
		if _, ok := memberCount(frame, "index"); ok {
			t.Error("memberCount(broken JSON) = ok")
		}
		if _, ok := memberCount(frame, "byteLength"); ok {
			t.Error("memberCount(empty) = ok")
		}
		if _, ok := rawNumberValue(json.RawMessage("")); ok {
			t.Error("rawNumberValue(empty) = ok")
		}
		if _, ok := rawNumberValue(json.RawMessage("{broken")); ok {
			t.Error("rawNumberValue(broken JSON) = ok")
		}
	})
}
