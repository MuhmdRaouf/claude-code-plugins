package omprpc

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

// jsonObjects reads a jsonl file as objects, in order.
func jsonObjects(t *testing.T, path string) []map[string]json.RawMessage {
	t.Helper()
	var out []map[string]json.RawMessage
	for _, line := range lines(t, path) {
		var value map[string]json.RawMessage
		if err := json.Unmarshal([]byte(line), &value); err != nil {
			t.Fatalf("%s holds a line that is not an object (%.80s): %v", path, line, err)
		}
		out = append(out, value)
	}
	return out
}

// recordedReplies gives the fixture's recorded host-tool replies back, in order.
func recordedReplies(t *testing.T, commands []map[string]json.RawMessage) HostToolHandler {
	t.Helper()
	var replies []map[string]json.RawMessage
	for _, command := range commands {
		if rawString(command["type"]) == "host_tool_result" {
			replies = append(replies, command)
		}
	}
	next := 0
	return func(HostToolCall, <-chan struct{}) (*HostToolReply, error) {
		if next >= len(replies) {
			t.Fatal("the fixture asked for a host-tool reply beyond those recorded")
		}
		reply := replies[next]
		next++
		var body struct {
			Result struct {
				Content []struct {
					Text string `json:"text"`
				} `json:"content"`
			} `json:"result"`
			IsError bool `json:"isError"`
		}
		if err := json.Unmarshal(reply["result"], &body); err != nil {
			t.Fatalf("recorded reply: %v", err)
		}
		text := ""
		if len(body.Result.Content) > 0 {
			text = body.Result.Content[0].Text
		}
		return &HostToolReply{Text: text, IsError: rawBool(reply["isError"])}, nil
	}
}

type replayedResponse struct {
	response RpcResponse
	err      *RpcError
}

type replayedTurn struct {
	end TurnEnd
	err *RpcError
}

type replayed struct {
	turn      *replayedTurn
	responses []replayedResponse
	frames    *frameLog
	client    *OmpRpcClient
}

// drive sends the fixture's recorded commands again through the client.
func drive(t *testing.T, name string) replayed {
	t.Helper()
	fixture := filepath.Join(fixturesDir(), name)
	commands := jsonObjects(t, filepath.Join(fixture, "stdin.jsonl"))
	client := startFixture(t, name, fakeOptions{OnHostToolCall: recordedReplies(t, commands)})
	frames := collect(client)

	options := handshakeOptions()
	options.HostTools = nil
	for _, command := range commands {
		if rawString(command["type"]) == "set_host_tools" {
			var tools []HostToolSpec
			if err := json.Unmarshal(command["tools"], &tools); err != nil {
				t.Fatalf("recorded host tools: %v", err)
			}
			options.HostTools = tools
			break
		}
	}
	if _, err := client.Handshake(context.Background(), options); err != nil {
		t.Fatalf("handshake: %s", err.Message)
	}

	var rest []map[string]json.RawMessage
	for _, command := range commands[4:] {
		if rawString(command["type"]) != "host_tool_result" {
			rest = append(rest, command)
		}
	}
	hasAbort := false
	for _, command := range rest {
		if rawString(command["type"]) == "abort" {
			hasAbort = true
		}
	}

	var turn chan replayedTurn
	var out replayed
	for _, command := range rest {
		switch rawString(command["type"]) {
		case "prompt":
			prompt := command
			turn = make(chan replayedTurn, 1)
			go func() {
				end, err := client.Prompt(rawString(prompt["message"]))
				turn <- replayedTurn{end, err}
			}()
			if !hasAbort {
				result := <-turn
				out.turn = &result
			}
		case "abort":
			frames.waitForFrame(t, 10_000, frameIsType("tool_execution_start"))
			response, err := client.Abort()
			out.responses = append(out.responses, replayedResponse{response, err})
		default:
			response, err := client.Request(RpcCommand(withoutID(mustObject(t, command))))
			out.responses = append(out.responses, replayedResponse{response, err})
		}
	}
	if turn != nil && out.turn == nil {
		result := <-turn
		out.turn = &result
	}
	out.frames = frames
	out.client = client
	return out
}

// mustObject re-encodes a parsed command as raw JSON.
func mustObject(t *testing.T, command map[string]json.RawMessage) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(command)
	if err != nil {
		t.Fatalf("re-encode a recorded command: %v", err)
	}
	return encoded
}

// recordedFrameTypes is the fixture's outbound frame types, in order.
func recordedFrameTypes(t *testing.T, name string) []string {
	t.Helper()
	var types []string
	for _, entry := range jsonObjects(t, filepath.Join(fixturesDir(), name, "interleaved.jsonl")) {
		if rawString(entry["dir"]) == "out" {
			var frame map[string]json.RawMessage
			if err := json.Unmarshal(entry["frame"], &frame); err != nil {
				t.Fatalf("%s: a recorded frame does not parse: %v", name, err)
			}
			types = append(types, rawString(frame["type"]))
		}
	}
	return types
}

var completedFixtures = []string{
	"success-edit",
	"success-edit-glm",
	"success-readonly",
	"report-invalid-retry",
	"report-host-reject-retry",
	"readonly-write-attempt",
	"resume-turn1",
	"resume-open-session",
	"text-delta",
	"max-time-expiry",
	"big-frame",
	"rpc-chunk",
	"rate-limited-429.synthetic",
}

func TestRecordedOmpSessions(t *testing.T) {
	for _, name := range completedFixtures {
		t.Run(name+": the turn completes and every recorded frame comes through in order", func(t *testing.T) {
			run := drive(t, name)
			if run.turn == nil || run.turn.err != nil ||
				run.turn.end.Result.Status != "completed" || !run.turn.end.Result.AgentInvoked {
				t.Fatalf("turn = (%+v, %v), want a completed agent turn", run.turn, run.turn)
			}
			for _, response := range run.responses {
				if response.err != nil {
					t.Errorf("a recorded command failed: %s (%s)", response.err.Message, response.err.Kind)
				}
			}
			if exit := run.client.Close(); exit.Code == nil || *exit.Code != 0 {
				t.Errorf("exit = %+v, want code 0", exit)
			}
			<-run.frames.done
			got := frameTypes(run.frames)
			want := recordedFrameTypes(t, name)
			if len(got) != len(want) {
				t.Fatalf("%d frames arrived, want the %d recorded", len(got), len(want))
			}
			for i := range got {
				if got[i] != want[i] {
					t.Errorf("frame %d is a %s, want a %s", i, got[i], want[i])
				}
			}
		})
	}

	t.Run("not-authenticated: prompt_result error with agentInvoked false, no session_settled to wait for", func(t *testing.T) {
		run := drive(t, "not-authenticated")
		if run.turn == nil || run.turn.err != nil || run.turn.end.Result.Status != "error" ||
			run.turn.end.Result.AgentInvoked || run.turn.end.Result.Error == nil {
			t.Fatalf("turn = (%+v, %v), want the recorded error turn", run.turn, run.turn)
		}
		if message := run.turn.end.Result.Error.Message; !strings.HasPrefix(message, "No API key found for zai") {
			t.Errorf("error message = %q, want the no-API-key text", message)
		}
		for _, frameType := range frameTypes(run.frames) {
			if frameType == "session_settled" {
				t.Error("a session_settled frame arrived for an unauthenticated turn")
			}
		}
	})

	t.Run("provider-error-401: prompt_result error carries the HTTP status", func(t *testing.T) {
		run := drive(t, "provider-error-401")
		if run.turn == nil || run.turn.err != nil || run.turn.end.Result.Error == nil {
			t.Fatalf("turn = (%+v, %v), want the recorded error turn", run.turn, run.turn)
		}
		recorded := run.turn.end.Result.Error
		if recorded.HTTPStatus == nil || *recorded.HTTPStatus != 401 {
			t.Errorf("httpStatus = %v, want 401", recorded.HTTPStatus)
		}
		if recorded.Retryable == nil || *recorded.Retryable {
			t.Errorf("retryable = %v, want false", recorded.Retryable)
		}
	})

	t.Run("abort-mid-tool: abort ends the turn aborted, then omp is killed (exit 143)", func(t *testing.T) {
		run := drive(t, "abort-mid-tool")
		if run.turn == nil || run.turn.err != nil || run.turn.end.Result.Status != "aborted" ||
			!run.turn.end.Result.SessionSettled {
			t.Fatalf("turn = (%+v, %v), want the aborted settled turn", run.turn, run.turn)
		}
		if len(run.responses) < 2 || run.responses[1].err != nil || run.responses[1].response.Command != "abort" {
			t.Fatalf("responses = %+v, want the abort ack second", run.responses)
		}
		exit := run.client.Exit()
		if exit.Code == nil || *exit.Code != 143 {
			t.Errorf("exit = %+v, want code 143", exit)
		}
	})

	t.Run("sigterm-mid-tool: the process dies mid-turn with no further frames; the turn fails", func(t *testing.T) {
		run := drive(t, "sigterm-mid-tool")
		if run.turn == nil || run.turn.err == nil || run.turn.err.Kind != RpcErrorExited ||
			run.turn.err.Exit == nil || run.turn.err.Exit.Code == nil || *run.turn.err.Exit.Code != 143 {
			t.Fatalf("turn error = %+v, want an exit-143 failure", run.turn)
		}
	})

	t.Run("resume-missing: open_session answers resumed: false", func(t *testing.T) {
		run := drive(t, "resume-missing")
		assertOpenSession(t, run, false)
	})

	t.Run("resume-open-session: open_session answers resumed: true", func(t *testing.T) {
		run := drive(t, "resume-open-session")
		assertOpenSession(t, run, true)
	})

	t.Run("resume-flag: the handshake's get_state carries the resumed session", func(t *testing.T) {
		run := drive(t, "resume-flag")
		if exit := run.client.Close(); exit.Code == nil || *exit.Code != 0 {
			t.Errorf("exit = %+v, want code 0", exit)
		}
	})

	t.Run("every recorded stdout line decodes (rpc-chunk's trimmed chunk data aside)", func(t *testing.T) {
		fixtures := fixtureDirs(t)
		for _, name := range fixtures {
			decoder := CreateFrameDecoder()
			for _, line := range lines(t, filepath.Join(fixturesDir(), name, "stdout.jsonl")) {
				if strings.HasPrefix(line, `{"type":"rpc_chunk"`) {
					continue
				}
				if decoded := decoder.Push(line); decoded.Kind != DecodedFrame {
					t.Errorf("%s: %.80s decodes as %s (%s)", name, line, decoded.Kind, decoded.Reason)
				}
			}
		}
	})

	t.Run("the trimmed rpc-chunk fixture keeps real chunk metadata: 256 KiB slices, no id", func(t *testing.T) {
		var chunks []map[string]any
		var data []string
		for _, line := range lines(t, filepath.Join(fixturesDir(), "rpc-chunk", "stdout.jsonl")) {
			frame := parsedLine(t, line)
			if frame["type"] != "rpc_chunk" {
				continue
			}
			if _, ok := frame["byteLength"].(float64); !ok {
				t.Errorf("chunk byteLength = %v, want a number", frame["byteLength"])
			}
			if text, ok := frame["data"].(string); ok {
				data = append(data, text)
			}
			delete(frame, "data")
			delete(frame, "byteLength")
			chunks = append(chunks, frame)
		}
		if len(chunks) != 2 {
			t.Fatalf("chunks = %d, want the recorded first and last", len(chunks))
		}
		first := map[string]any{"type": "rpc_chunk", "chunkId": "rpc-1", "index": float64(0), "count": float64(5)}
		last := map[string]any{"type": "rpc_chunk", "chunkId": "rpc-1", "index": float64(4), "count": float64(5)}
		for i, want := range []map[string]any{first, last} {
			if !reflect.DeepEqual(chunks[i], want) {
				t.Errorf("chunk %d = %v, want %v", i, chunks[i], want)
			}
		}
		if len(data) != 2 || data[0] != "<349528 base64 chars>" {
			t.Errorf("chunk data = %q, want the recorded placeholder", data)
		}
	})
}

func assertOpenSession(t *testing.T, run replayed, resumed bool) {
	t.Helper()
	if len(run.responses) == 0 || run.responses[0].err != nil ||
		run.responses[0].response.Command != "open_session" {
		t.Fatalf("responses = %+v, want open_session first", run.responses)
	}
	var data struct {
		Resumed bool `json:"resumed"`
	}
	if err := json.Unmarshal(run.responses[0].response.Data, &data); err != nil {
		t.Fatalf("open_session data: %v", err)
	}
	if data.Resumed != resumed {
		t.Errorf("resumed = %v, want %v", data.Resumed, resumed)
	}
}

func fixtureDirs(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(fixturesDir())
	if err != nil {
		t.Fatalf("read the fixtures: %v", err)
	}
	var dirs []string
	for _, entry := range entries {
		if entry.IsDir() {
			dirs = append(dirs, entry.Name())
		}
	}
	return dirs
}

func TestBrokenChunkSequence(t *testing.T) {
	t.Run("fails pending requests with a protocol error", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "broken")
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		chunk := object(
			fStr("type", "rpc_chunk"),
			fStr("chunkId", "rpc-1"),
			fInt("index", 1),
			fInt("count", 5),
			fInt("byteLength", 1_200_000),
			fStr("data", "QUFB"),
		)
		entries := []string{
			string(object(fStr("dir", "out"), fRaw("frame", object(
				fStr("type", "ready"), fInt("protocolVersion", 1),
				fRaw("supportedProtocolVersions", array(float64(1), float64(2))))))),
			string(object(fStr("dir", "in"), fRaw("frame", object(
				fStr("id", "neg"), fStr("type", "negotiate_protocol"))))),
			string(object(fStr("dir", "out"), fRaw("frame", chunk))),
		}
		if err := os.WriteFile(filepath.Join(dir, "interleaved.jsonl"), []byte(strings.Join(entries, "\n")), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte(`{"exit":0}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "stderr.txt"), []byte(""), 0o600); err != nil {
			t.Fatal(err)
		}
		client := startFake(t, map[string]string{"FAKE_OMP_FIXTURE": dir}, fakeOptions{})
		_, err := client.Handshake(context.Background(), handshakeOptions())
		if err == nil || err.Kind != RpcErrorProtocol ||
			err.Message != "omp RPC stream: rpc chunk sequence must start at index 0" {
			t.Fatalf("handshake error = %v, want the chunk-sequence protocol error", err)
		}
		if _, err := client.Request(RpcCommand(`{"type":"get_state"}`)); err == nil || err.Kind != RpcErrorProtocol {
			t.Errorf("request = %v, want the protocol error", err)
		}
	})
}

func TestFixtureHygiene(t *testing.T) {
	secret := regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{16,}|ZAI_API_KEY=|probe-invalid-key|credentialId|responseId`)
	token := regexp.MustCompile(`[A-Za-z0-9+_=-]{32,}`)
	allowed := []*regexp.Regexp{
		regexp.MustCompile(`^call_[0-9a-f]{24}$`),
		regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`),
		regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_[0-9a-f-]+$`),
	}
	homePath := regexp.MustCompile(`/(Users|home)/[a-z]`)
	hasDigit := regexp.MustCompile(`\d`)
	hasLetter := regexp.MustCompile(`[A-Za-z]`)

	problemsIn := func(where, text string) []string {
		var problems []string
		if secret.MatchString(text) {
			problems = append(problems, where+": secret-like text")
		}
		if homePath.MatchString(text) {
			problems = append(problems, where+": absolute home path")
		}
		for _, match := range token.FindAllString(text, -1) {
			if hasDigit.MatchString(match) && hasLetter.MatchString(match) {
				allowedMatch := false
				for _, pattern := range allowed {
					if pattern.MatchString(match) {
						allowedMatch = true
						break
					}
				}
				if !allowedMatch {
					problems = append(problems, fmt.Sprintf("%s: %s", where, match[:min(40, len(match))]))
				}
			}
		}
		return problems
	}

	t.Run("no fixture holds a key, an absolute home path or an unexplained token", func(t *testing.T) {
		var problems []string
		for _, name := range fixtureDirs(t) {
			files, err := os.ReadDir(filepath.Join(fixturesDir(), name))
			if err != nil {
				t.Fatalf("read %s: %v", name, err)
			}
			for _, file := range files {
				data, err := os.ReadFile(filepath.Join(fixturesDir(), name, file.Name()))
				if err != nil {
					t.Fatalf("read %s/%s: %v", name, file.Name(), err)
				}
				problems = append(problems, problemsIn(name+"/"+file.Name(), string(data))...)
			}
		}
		if len(problems) != 0 {
			t.Errorf("fixture problems:\n%s", strings.Join(problems, "\n"))
		}
	})
}
