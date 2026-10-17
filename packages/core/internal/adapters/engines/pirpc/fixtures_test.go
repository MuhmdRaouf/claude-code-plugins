package pirpc

// The fixture tests: every recorded pi run replays through the fake pi, and the wire traffic must
// round-trip — the frames the client saw are exactly the frames the recording saw, in order, and
// each run ends as recorded.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/shared"
)

// fixturesRoot is testdata/engines/pi: the recorded runs, byte for byte.
var fixturesRoot = filepath.Join("..", "..", "..", "..", "testdata", "engines", "pi")

func fixturePath(t *testing.T, elems ...string) string {
	t.Helper()
	absolute, err := filepath.Abs(filepath.Join(append([]string{fixturesRoot}, elems...)...))
	if err != nil {
		t.Fatalf("resolve %v: %v", elems, err)
	}
	return absolute
}

func jsonLines(t *testing.T, path string) []string {
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

// fixtureNames is every recorded run, the fixture directories themselves.
func fixtureNames(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(fixturesRoot)
	if err != nil {
		t.Fatalf("read %s: %v", fixturesRoot, err)
	}
	var names []string
	for _, entry := range entries {
		if entry.Name() != "README.md" {
			names = append(names, entry.Name())
		}
	}
	return names
}

// recordedCommand is one command the recording sent, as the client must send it again.
type recordedCommand struct {
	Type    string
	Message string
	Raw     json.RawMessage
}

func recordedCommands(t *testing.T, name string) []recordedCommand {
	t.Helper()
	var commands []recordedCommand
	for _, line := range jsonLines(t, fixturePath(t, name, "stdin.jsonl")) {
		var frame Frame
		if err := json.Unmarshal([]byte(line), &frame); err != nil {
			t.Fatalf("%s: the recorded command %q does not parse: %v", name, line, err)
		}
		message := frameString(frame, "message")
		commands = append(commands, recordedCommand{Type: frameString(frame, "type"), Message: message, Raw: json.RawMessage(line)})
	}
	return commands
}

// recordedFrames is what the recording saw on stdout, in order.
func recordedFrames(t *testing.T, name string) []Frame {
	t.Helper()
	var frames []Frame
	for _, line := range jsonLines(t, fixturePath(t, name, "interleaved.jsonl")) {
		var entry struct {
			Dir   string          `json:"dir"`
			Frame json.RawMessage `json:"frame"`
		}
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatalf("%s: the interleaved entry %q does not parse: %v", name, line, err)
		}
		if entry.Dir != "out" || len(entry.Frame) == 0 {
			continue
		}
		var frame Frame
		if err := json.Unmarshal(entry.Frame, &frame); err != nil {
			t.Fatalf("%s: the recorded frame %s does not parse: %v", name, entry.Frame, err)
		}
		frames = append(frames, frame)
	}
	return frames
}

// commandWithoutID is the recorded command with the id dropped: the client assigns its own.
func commandWithoutID(t *testing.T, raw json.RawMessage) json.RawMessage {
	t.Helper()
	var frame Frame
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatalf("the recorded command %s does not parse: %v", raw, err)
	}
	delete(frame, "id")
	remarshalled, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("rebuild %s: %v", raw, err)
	}
	return remarshalled
}

// replayedRun is one fixture driven through the client.
type replayedRun struct {
	turn      chan turnOutcome
	responses []responseOutcome
	frames    *frameCollector
	client    *PiRpcClient
}

// driveFixture speaks the recorded commands to the replaying fake, in the recorded order: the
// client's handshake get_state stands in for the recorded one.
func driveFixture(t *testing.T, name string, options PiRpcOptions) *replayedRun {
	t.Helper()
	var rest []recordedCommand
	for _, command := range recordedCommands(t, name) {
		if command.Type != "get_state" {
			rest = append(rest, command)
		}
	}
	client := startFake(t, []string{"FAKE_PI_FIXTURE=" + fixturePath(t, name)}, options)
	frames := collect(client)
	if _, err := client.Handshake(HandshakeOptions{TimeoutMs: 30_000}); err != nil {
		t.Fatalf("handshake against %s: %s", name, err.Message)
	}
	run := &replayedRun{frames: frames, client: client}
	var turn chan turnOutcome
	for _, command := range rest {
		switch command.Type {
		case "prompt":
			turn = make(chan turnOutcome, 1)
			message := command.Message
			go func() {
				ended, err := client.Prompt(message)
				turn <- turnOutcome{ended, err}
			}()
		case "abort":
			frames.waitFor(t, func(frame Frame) bool {
				return frameTypeIs(frame, "tool_execution_start")
			}, 10_000)
			response, err := client.Abort()
			run.responses = append(run.responses, responseOutcome{response, err})
		default:
			response, err := client.Request(commandWithoutID(t, command.Raw))
			run.responses = append(run.responses, responseOutcome{response, err})
		}
	}
	if turn == nil {
		t.Fatalf("fixture %s recorded no prompt", name)
	}
	// An abort fixture's turn cannot settle until the abort arrives; the recording proves the
	// timing instead.
	run.turn = turn
	return run
}

// The fixture directories that run to completion without an abort.
var completedFixtures = []string{"success-readonly", "error-after-success", "resume-turn2", "malformed-line"}

// The fixture directories whose recording includes an abort mid-tool.
var abortedFixtures = []string{"abort-mid-run", "hang-mid-tool"}

func TestRecordedPiRuns(t *testing.T) {
	for _, name := range completedFixtures {
		t.Run(name+" replays to the same frames and settles as recorded", func(t *testing.T) {
			run := driveFixture(t, name, PiRpcOptions{})
			if out := <-run.turn; out.err != nil {
				t.Fatalf("the recorded turn failed: %s", out.err.Message)
			}
			assertCleanExit(t, run.client.Close())
			want := frameTypes(recordedFrames(t, name))
			if got := frameTypes(run.frames.finish(t)); !reflect.DeepEqual(got, want) {
				t.Fatalf("frame types = %v, want %v", got, want)
			}
		})
	}

	for _, name := range abortedFixtures {
		t.Run(name+" settles before the abort response, in pi's own order", func(t *testing.T) {
			run := driveFixture(t, name, PiRpcOptions{})
			if out := <-run.turn; out.err != nil {
				t.Fatalf("the recorded turn failed: %s", out.err.Message)
			}
			if len(run.responses) != 1 || run.responses[0].err != nil ||
				run.responses[0].response.Command != "abort" {
				t.Fatalf("responses = %+v, want one successful abort answer", run.responses)
			}
			assertCleanExit(t, run.client.Close())
			frames := run.frames.finish(t)
			want := frameTypes(recordedFrames(t, name))
			if got := frameTypes(frames); !reflect.DeepEqual(got, want) {
				t.Fatalf("frame types = %v, want %v", got, want)
			}
			// pi answers abort only once the agent has settled; the replay must keep that order.
			settledAt, abortReplyAt := -1, -1
			for i, frame := range frames {
				if frameTypeIs(frame, "agent_settled") && settledAt < 0 {
					settledAt = i
				}
				if isAbortResponse(frame) {
					abortReplyAt = i
				}
			}
			if settledAt < 0 {
				t.Fatal("no agent_settled frame")
			}
			if abortReplyAt <= settledAt {
				t.Fatalf("the abort reply at %d did not follow the settle at %d", abortReplyAt, settledAt)
			}
		})
	}

	t.Run("a stray non-JSON line rides the wire, lands in the stdout log verbatim, and the turn still settles", func(t *testing.T) {
		dir := t.TempDir()
		log := &shared.RpcLogPaths{
			Stdout:    filepath.Join(dir, "a.jsonl"),
			Stdin:     filepath.Join(dir, "a.rpc-in.jsonl"),
			PromptRef: "ref",
		}
		run := driveFixture(t, "malformed-line", PiRpcOptions{Log: log})
		if out := <-run.turn; out.err != nil {
			t.Fatalf("the recorded turn failed: %s", out.err.Message)
		}
		if exit := run.client.Close(); exit.Code == nil || *exit.Code != 0 {
			t.Fatalf("exit = %+v, want pi's own exit 0", exit)
		}
		found := false
		for _, line := range readLines(t, log.Stdout) {
			if line == "this is not json" {
				found = true
			}
		}
		if !found {
			t.Error("the stray line is not in the stdout log verbatim")
		}
	})

	t.Run("every recorded stdout line decodes as an RPC frame, except the deliberate stray", func(t *testing.T) {
		for _, name := range fixtureNames(t) {
			decoder := CreateFrameDecoder()
			for _, line := range jsonLines(t, fixturePath(t, name, "stdout.jsonl")) {
				decoded := decoder.Push(line)
				if name == "malformed-line" && line == "this is not json" {
					if decoded.Kind != DecodedMalformed {
						t.Errorf("%s: %q decoded as %q, want malformed", name, line, decoded.Kind)
					}
				} else if decoded.Kind != DecodedFrame {
					t.Errorf("%s: %q decoded as %q, want a frame", name, line, decoded.Kind)
				}
			}
		}
	})
}

func TestFixtureHygiene(t *testing.T) {
	t.Run("carries no secrets, tokens or home paths", func(t *testing.T) {
		secret := regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{16,}|ZAI_API_KEY=|probe-invalid-key|credentialId|responseId`)
		token := regexp.MustCompile(`[A-Za-z0-9+_=-]{32,}`)
		hasDigit := regexp.MustCompile(`\d`)
		hasLetter := regexp.MustCompile(`[A-Za-z]`)
		home := regexp.MustCompile(`/(Users|home)/[a-z]`)
		// Shapes the recordings legitimately carry: tool call ids, session ids, file stamps.
		allowed := []*regexp.Regexp{
			regexp.MustCompile(`^call_[0-9a-f]{24}$`),
			regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`),
			regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z_[0-9a-f-]+$`),
		}

		problemsIn := func(where, text string) []string {
			var problems []string
			if secret.MatchString(text) {
				problems = append(problems, where+": secret-looking text")
			}
			if home.MatchString(text) {
				problems = append(problems, where+": absolute home path")
			}
			for _, match := range token.FindAllString(text, -1) {
				known := false
				for _, pattern := range allowed {
					if pattern.MatchString(match) {
						known = true
					}
				}
				if hasDigit.MatchString(match) && hasLetter.MatchString(match) && !known {
					problems = append(problems, where+": long token "+match[:8]+"…")
				}
			}
			return problems
		}

		var problems []string
		for _, name := range fixtureNames(t) {
			files, err := os.ReadDir(fixturePath(t, name))
			if err != nil {
				t.Fatalf("read %s: %v", name, err)
			}
			for _, file := range files {
				text, err := os.ReadFile(fixturePath(t, name, file.Name()))
				if err != nil {
					t.Fatalf("read %s/%s: %v", name, file.Name(), err)
				}
				problems = append(problems, problemsIn(name+"/"+file.Name(), string(text))...)
			}
		}
		if len(problems) != 0 {
			t.Errorf("fixture problems:\n%s", strings.Join(problems, "\n"))
		}
	})
}
