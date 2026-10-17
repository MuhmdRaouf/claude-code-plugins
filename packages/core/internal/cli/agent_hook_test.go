package cli_test

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakedeps"
)

const glmRunJSONL = `{"type":"user","message":{"content":"do it"}}
{"type":"assistant","message":{"id":"m1","model":"glm-5.3","usage":{"input_tokens":1000,"output_tokens":100,"cache_read_input_tokens":9000},"content":[]}}
{"type":"assistant","message":{"id":"m1","model":"glm-5.3","usage":{"input_tokens":1000,"output_tokens":100,"cache_read_input_tokens":9000},"content":[]}}
{"type":"assistant","message":{"id":"m2","model":"glm-5.3","usage":{"input_tokens":500,"output_tokens":50,"cache_creation_input_tokens":2000},"content":[]}}
not json`

const sonnetRunJSONL = `{"type":"assistant","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":10},"content":[]}}`

// assistantLine builds one transcript line in the shape Claude Code writes:
// {type:"assistant", message:{id, model, usage, content: []}}.
func assistantLine(id, model string, usage string) string {
	if id == "" {
		return `{"type":"assistant","message":{"model":"` + model + `","usage":` + usage + `,"content":[]}}`
	}
	return `{"type":"assistant","message":{"id":"` + id + `","model":"` + model + `","usage":` + usage + `,"content":[]}}`
}

func TestModelAgentOf(t *testing.T) {
	t.Run("knows only this plugin's model agents, with or without the plugin prefix", func(t *testing.T) {
		cases := []struct {
			agentType any
			want      string
			ok        bool
		}{
			{"zai:glm-5.3", "glm-5.3", true},
			{"glm-5.3-flash", "glm-5.3-flash", true},
			{"zai:omp", "", false},
			{"Explore", "", false},
			{nil, "", false},
		}
		for _, tc := range cases {
			got, ok := cli.ModelAgentOf(testkit.ReferenceProvider, cli.AgentStopInput{AgentType: tc.agentType})
			if ok != tc.ok || got != tc.want {
				t.Fatalf("modelAgentOf(%v) = (%q, %v), want (%q, %v)", tc.agentType, got, ok, tc.want, tc.ok)
			}
		}
	})
}

func TestTranscriptPathOf(t *testing.T) {
	t.Run("finds the agent's transcript: the given path, else beside the session's", func(t *testing.T) {
		got, ok := cli.TranscriptPathOf(cli.AgentStopInput{AgentTranscriptPath: "/t/agent.jsonl"})
		if !ok || got != "/t/agent.jsonl" {
			t.Fatalf("given path = (%q, %v)", got, ok)
		}
		got, ok = cli.TranscriptPathOf(cli.AgentStopInput{
			TranscriptPath: "/p/s1.jsonl",
			SessionID:      "s1",
			AgentID:        "a1",
		})
		if want := filepath.Join("/p", "s1", "subagents", "agent-a1.jsonl"); !ok || got != want {
			t.Fatalf("beside the session = (%q, %v)", got, ok)
		}
		if _, ok = cli.TranscriptPathOf(cli.AgentStopInput{TranscriptPath: "/p/s1.jsonl"}); ok {
			t.Fatal("a main transcript without the ids is no agent transcript")
		}
		if _, ok = cli.TranscriptPathOf(cli.AgentStopInput{AgentTranscriptPath: ""}); ok {
			t.Fatal("an empty given path is no transcript")
		}
	})
}

func TestAgentRunFolding(t *testing.T) {
	t.Run("folds the transcript: models, one request per message id, the tokens", func(t *testing.T) {
		run := cli.AgentRunOf(glmRunJSONL)
		if !reflect.DeepEqual(run.Models, []string{"glm-5.3"}) {
			t.Fatalf("models = %q", run.Models)
		}
		if run.Requests != 2 {
			t.Fatalf("requests = %d, want 2", run.Requests)
		}
		if run.InputTokens != 1500 || run.OutputTokens != 150 || run.CacheReadTokens != 9000 || run.CacheWriteTokens != 2000 {
			t.Fatalf("tokens = %+v", run.TokenCounts)
		}
		if models := cli.AgentRunOf("").Models; len(models) != 0 {
			t.Fatalf("models of an empty transcript = %q", models)
		}
	})

	t.Run("skips what is not an assistant message naming a model", func(t *testing.T) {
		jsonl := strings.Join([]string{
			assistantLine("m1", "<synthetic>", `{"input_tokens":10}`),
			`{"type":"assistant","message":{"model":42}}`,
			`{"type":"assistant","message":null}`,
			`{"type":"assistant","message":{"id":"m1","model":"glm-5.3","usage":"not a map"}}`,
			`{"type":"user","note":"mentions \"assistant\" but is not one"}`,
			`"assistant"`,
		}, "\n")
		run := cli.AgentRunOf(jsonl)
		if !reflect.DeepEqual(run.Models, []string{"glm-5.3"}) {
			t.Fatalf("models = %q", run.Models)
		}
		if run.Requests != 1 {
			t.Fatalf("requests = %d, want 1", run.Requests)
		}
		if run.InputTokens != 0 {
			t.Fatalf("input tokens = %v, want 0", run.InputTokens)
		}
	})

	t.Run("messages without an id count one request each, and bad token values count nothing", func(t *testing.T) {
		jsonl := strings.Join([]string{
			assistantLine("", "glm-5.3", `{"input_tokens":100}`),
			assistantLine("", "glm-5.3", `{"input_tokens":-5,"output_tokens":0}`),
			assistantLine("", "glm-5.3", `{"input_tokens":"100","cache_read_input_tokens":10}`),
		}, "\n")
		run := cli.AgentRunOf(jsonl)
		if run.Requests != 3 {
			t.Fatalf("requests = %d, want 3", run.Requests)
		}
		if run.InputTokens != 100 || run.OutputTokens != 0 || run.CacheReadTokens != 10 {
			t.Fatalf("tokens = %+v", run.TokenCounts)
		}
	})
}

func TestAgentStopMessage(t *testing.T) {
	t.Run("on the provider's model: what it ran on, its tokens and the estimated cost", func(t *testing.T) {
		got, ok := cli.AgentStopMessage(testkit.ReferenceProvider, "glm-5.3", cli.AgentRunOf(glmRunJSONL), true)
		want := "zai:glm-5.3 ran on glm-5.3 via the zai router: 2 requests, 12.5k in / 150 out, est. $0.0051."
		if !ok || got != want {
			t.Fatalf("got (%q, %v), want %q", got, ok, want)
		}
	})

	t.Run("on Sonnet: why, and the slash command that fixes it", func(t *testing.T) {
		run := cli.AgentRunOf(sonnetRunJSONL)
		got, ok := cli.AgentStopMessage(testkit.ReferenceProvider, "glm-5.3", run, true)
		if !ok || got != "zai:glm-5.3 ran on Sonnet: the zai router was down; run /zai:setup." {
			t.Fatalf("setup done = (%q, %v)", got, ok)
		}
		got, ok = cli.AgentStopMessage(testkit.ReferenceProvider, "glm-5.3", run, false)
		if !ok || got != "zai:glm-5.3 ran on Sonnet: zai is not set up yet; run /zai:setup." {
			t.Fatalf("not set up = (%q, %v)", got, ok)
		}
		if _, ok = cli.AgentStopMessage(testkit.ReferenceProvider, "glm-5.3", cli.AgentRunOf(""), true); ok {
			t.Fatal("a run with no models says nothing")
		}
	})

	t.Run("several provider models name them all and price none", func(t *testing.T) {
		jsonl := strings.Join([]string{
			assistantLine("m1", "glm-5.3", `{"input_tokens":1000,"output_tokens":100,"cache_read_input_tokens":9000}`),
			assistantLine("m2", "glm-5.3-flash", `{"input_tokens":500,"output_tokens":50,"cache_creation_input_tokens":2000}`),
		}, "\n")
		got, ok := cli.AgentStopMessage(testkit.ReferenceProvider, "glm-5.3", cli.AgentRunOf(jsonl), true)
		want := "zai:glm-5.3 ran on glm-5.3, glm-5.3-flash via the zai router: 2 requests, 12.5k in / 150 out."
		if !ok || got != want {
			t.Fatalf("got (%q, %v), want %q", got, ok, want)
		}
	})

	t.Run("a run partly on Sonnet says so", func(t *testing.T) {
		jsonl := strings.Join([]string{
			assistantLine("m1", "glm-5.3", `{"input_tokens":1000,"output_tokens":100,"cache_read_input_tokens":9000}`),
			assistantLine("m2", "claude-sonnet-4-6", `{"input_tokens":10,"output_tokens":10}`),
		}, "\n")
		got, ok := cli.AgentStopMessage(testkit.ReferenceProvider, "glm-5.3", cli.AgentRunOf(jsonl), true)
		want := "zai:glm-5.3 ran on glm-5.3 via the zai router: 2 requests, 10.0k in / 110 out, est. $0.0042 (part of it on Sonnet: the router dropped out)."
		if !ok || got != want {
			t.Fatalf("got (%q, %v), want %q", got, ok, want)
		}
	})

	t.Run("an unpriced provider model shows no estimate", func(t *testing.T) {
		jsonl := assistantLine("m1", "glm-x", `{"input_tokens":1000,"output_tokens":100}`)
		got, ok := cli.AgentStopMessage(testkit.ReferenceProvider, "glm-5.3", cli.AgentRunOf(jsonl), true)
		want := "zai:glm-5.3 ran on glm-x via the zai router: 1 request, 1.0k in / 100 out."
		if !ok || got != want {
			t.Fatalf("got (%q, %v), want %q", got, ok, want)
		}
	})
}

func TestReadTail(t *testing.T) {
	t.Run("reads only the transcript's tail, from a whole line", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "agent.jsonl")
		content := strings.Repeat("x", 100) + "\n" + sonnetRunJSONL + "\n"
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}

		from := len(sonnetRunJSONL) + 5
		got, ok := cli.ReadTail(path, int64(from))
		if !ok || got != sonnetRunJSONL+"\n" {
			t.Fatalf("tail of %d bytes = (%q, %v)", from, got, ok)
		}
		got, ok = cli.ReadTail(path, int64(len(content)+16))
		if !ok || got != content {
			t.Fatalf("whole file = (%q, %v)", got, ok)
		}
		if _, ok = cli.ReadTail(filepath.Join(dir, "missing"), 4096); ok {
			t.Fatal("a missing file has no tail")
		}
	})

	t.Run("a tail cut mid-character still starts at a whole line", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "cut.jsonl")
		if err := os.WriteFile(path, []byte("\xf0\x9f\x98\x80\nline2\n"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		got, ok := cli.ReadTail(path, 9)
		if !ok || got != "line2\n" {
			t.Fatalf("cut tail = (%q, %v)", got, ok)
		}
	})

	t.Run("a tail without a newline is the whole tail", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "nonl.txt")
		if err := os.WriteFile(path, []byte("abcdef"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		got, ok := cli.ReadTail(path, 4)
		if !ok || got != "cdef" {
			t.Fatalf("newline-less tail = (%q, %v)", got, ok)
		}
	})

	t.Run("a directory has no tail to read", func(t *testing.T) {
		// Reading a directory fails EISDIR.
		if _, ok := cli.ReadTail(t.TempDir(), 4096); ok {
			t.Fatal("a directory reads as no transcript")
		}
	})
}

func TestReadStdinWithin(t *testing.T) {
	t.Run("never waits on stdin longer than its budget", func(t *testing.T) {
		// An io.Pipe write returns only once a reader took it, so the chunk lands from a
		// goroutine: the pipe stays open until the budget ends, as a hook's stdin can.
		reader, writer := io.Pipe()
		written := make(chan error, 1)
		go func() {
			_, err := writer.Write([]byte("{"))
			written <- err
		}()
		defer func() {
			if err := <-written; err != nil {
				t.Errorf("write: %v", err)
			}
			writer.Close()
		}()

		started := time.Now()
		got := cli.ReadStdinWithin(50, reader)
		if got != "{" {
			t.Fatalf("got = %q, want %q", got, "{")
		}
		if elapsed := time.Since(started); elapsed >= time.Second {
			t.Fatalf("waited %v, want under 1s", elapsed)
		}
	})

	t.Run("a closed stdin comes back whole, however long the budget", func(t *testing.T) {
		got := cli.ReadStdinWithin(5000, strings.NewReader(`{"a":1}`))
		if got != `{"a":1}` {
			t.Fatalf("got = %q", got)
		}
		if got := cli.ReadStdinWithin(5000, strings.NewReader("")); got != "" {
			t.Fatalf("empty stdin = %q", got)
		}
	})
}

// hookStdin replaces the process stdin for one `usage --hook` run, the way the hooks file feeds
// it.
func hookStdin(t *testing.T, text string) {
	t.Helper()
	pipeReader, pipeWriter, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pipeWriter.WriteString(text); err != nil {
		t.Fatal(err)
	}
	pipeWriter.Close()
	previous := os.Stdin
	os.Stdin = pipeReader
	t.Cleanup(func() {
		os.Stdin = previous
		pipeReader.Close()
	})
}

// hookSystemMessages runs `usage --hook` with the input on stdin and collects the systemMessages
// it speaks.
func hookSystemMessages(t *testing.T, world fakedeps.Fakes, stdin string) []string {
	t.Helper()
	world.Out.Lines = nil
	hookStdin(t, stdin)
	if code := cli.RunCli(context.Background(), []string{"usage", "--hook"}, world.Deps, "/repo"); code != cli.ExitOK {
		t.Fatalf("exit = %d, want 0", code)
	}
	messages := []string{}
	for _, line := range world.Out.Lines {
		var parsed struct {
			SystemMessage string `json:"systemMessage"`
		}
		if json.Unmarshal([]byte(line), &parsed) == nil && parsed.SystemMessage != "" {
			messages = append(messages, parsed.SystemMessage)
		}
	}
	return messages
}

func TestAgentStopHookThroughCli(t *testing.T) {
	t.Run("speaks to the user only (a systemMessage), and stays silent on anything it cannot read", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		cli.RecordSetupDone(world.Root)
		path := filepath.Join(world.Root, "agent.jsonl")
		if err := os.WriteFile(path, []byte(hookSonnetRun()), 0o644); err != nil {
			t.Fatal(err)
		}

		if got := hookSystemMessages(t, world,
			`{"agent_type":"zai:glm-5.3","agent_transcript_path":`+strconv.Quote(path)+`}`); !equalStrings(got, []string{
			"zai:glm-5.3 ran on Sonnet: the zai router was down; run /zai:setup.",
		}) {
			t.Fatalf("messages = %q", got)
		}
		if got := hookSystemMessages(t, world,
			`{"agent_type":"Explore","agent_transcript_path":`+strconv.Quote(path)+`}`); len(got) != 0 {
			t.Fatalf("messages = %q", got)
		}
		if got := hookSystemMessages(t, world,
			`{"agent_type":"zai:glm-5.3","agent_transcript_path":"/nope.jsonl"}`); len(got) != 0 {
			t.Fatalf("messages = %q", got)
		}
		world.Out.Lines = nil
		hookStdin(t, "not json")
		if code := cli.RunCli(context.Background(), []string{"usage", "--hook"}, world.Deps, "/repo"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if len(world.Out.Lines) != 0 {
			t.Fatalf("lines = %q", world.Out.Lines)
		}
	})

	t.Run("`usage --hook` is the command the hooks file runs; it skips the workspace cleanup", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)

		hookStdin(t, "")
		if code := cli.RunCli(context.Background(), []string{"usage", "--hook"}, world.Deps, "/repo"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
	})
}

// hookSonnetRun is one assistant answer Claude Sonnet gave.
func hookSonnetRun() string {
	return `{"type":"assistant","message":{"id":"m1","model":"claude-sonnet-4-6","usage":{"input_tokens":10,"output_tokens":10},"content":[]}}`
}
