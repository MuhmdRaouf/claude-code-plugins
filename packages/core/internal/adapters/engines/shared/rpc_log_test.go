package shared

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// The omp and pi client tests cover the rpc-log helpers through their own shapes; these direct
// tests cover the helpers themselves, against real files in a temp directory.

func mustFrame(t *testing.T, text string) map[string]json.RawMessage {
	t.Helper()
	var frame map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text), &frame); err != nil {
		t.Fatalf("test frame does not parse: %v", err)
	}
	return frame
}

func TestLogText(t *testing.T) {
	t.Run("passes a frame that is not a tool result through unchanged", func(t *testing.T) {
		text := `{"type":"assistant_update","delta":"hi"}`
		if got := LogText(mustFrame(t, text), text); got != text {
			t.Errorf("LogText() = %q, want the text itself", got)
		}
	})
	t.Run("passes a tool result whose fields fit through unchanged", func(t *testing.T) {
		text := `{"type":"tool_execution_end","result":{"details":"small"}}`
		if got := LogText(mustFrame(t, text), text); got != text {
			t.Errorf("LogText() = %q, want the text itself", got)
		}
	})
	t.Run("passes a tool_execution_end without an object result through unchanged", func(t *testing.T) {
		for _, text := range []string{
			`{"type":"tool_execution_end","result":"done"}`,
			`{"type":"tool_execution_end","result":null}`,
			`{"type":"tool_execution_end"}`,
		} {
			if got := LogText(mustFrame(t, text), text); got != text {
				t.Errorf("LogText() = %q, want the text itself", got)
			}
		}
	})
	t.Run("passes a message_end that is not a tool result through unchanged", func(t *testing.T) {
		for _, text := range []string{
			`{"type":"message_end","message":{"role":"assistant","content":[]}}`,
			`{"type":"message_end","message":{"role":"toolResult","content":"small"}}`,
			`{"type":"message_end","message":"text"}`,
			`{"type":"message_end"}`,
		} {
			if got := LogText(mustFrame(t, text), text); got != text {
				t.Errorf("LogText(%s) = %q, want the text itself", text, got)
			}
		}
	})
	t.Run("cuts an oversized tool_execution_end result details", func(t *testing.T) {
		details := strings.Repeat("a", LogFieldLimit+8)
		text := `{"type":"tool_execution_end","seq":7,"result":{"ok":true,"details":"` + details + `"}}`
		kept := LogKeep - 1
		want := `{"type":"tool_execution_end","seq":7,"result":{"ok":true,"details":` +
			`{"$truncated":` + itoa(len(details)+2) +
			`,"head":"` + jsonQuote + strings.Repeat("a", kept) +
			`","tail":"` + strings.Repeat("a", kept) + jsonQuote + `"}}}`

		if got := LogText(mustFrame(t, text), text); got != want {
			t.Errorf("LogText() cuts wrong\n got: %.120s\nwant: %.120s", got, want)
		}
	})
	t.Run("walks a cut to UTF-8 boundaries so no character is halved", func(t *testing.T) {
		details := strings.Repeat("é", 40000)
		text := `{"type":"tool_execution_end","result":{"details":"` + details + `"}}`
		// The value's JSON is a quote, 80000 bytes of two-byte characters and a quote; both cuts
		// land inside a character and give up its lead byte.
		kept := strings.Repeat("é", (LogKeep-1)/2)
		want := `{"type":"tool_execution_end","result":{"details":` +
			`{"$truncated":80002,"head":"` + jsonQuote + kept +
			`","tail":"` + kept + jsonQuote + `"}}}`

		if got := LogText(mustFrame(t, text), text); got != want {
			t.Errorf("LogText() cuts wrong\n got: %.120s\nwant: %.120s", got, want)
		}
	})
	t.Run("cuts both oversized fields of a toolResult message_end", func(t *testing.T) {
		big := strings.Repeat("b", LogFieldLimit+2)
		text := `{"type":"message_end","message":{"role":"toolResult","content":"` + big +
			`","details":{"text":"` + big + `","ok":false}}}`
		kept := LogKeep - 1
		content := `{"$truncated":` + itoa(len(big)+2) + `,"head":"` + jsonQuote + strings.Repeat("b", kept) +
			`","tail":"` + strings.Repeat("b", kept) + jsonQuote + `"}`
		object := `{"text":"` + big + `","ok":false}`
		// The head and the tail are slices of the object's JSON, embedded as text: their own
		// quotes arrive escaped.
		details := `{"$truncated":` + itoa(len(object)) +
			`,"head":"` + `{\"text\":\"` + strings.Repeat("b", LogKeep-9) +
			`","tail":"` + strings.Repeat("b", LogKeep-13) + `\",\"ok\":false}` + `"}`
		want := `{"type":"message_end","message":{"role":"toolResult","content":` + content +
			`,"details":` + details + `}}`

		if got := LogText(mustFrame(t, text), text); got != want {
			t.Errorf("LogText() cuts wrong\n got: %.120s\nwant: %.120s", got, want)
		}
	})
	t.Run("compacts the members it rewrites", func(t *testing.T) {
		details := strings.Repeat("a", LogFieldLimit+4)
		text := `{"type": "tool_execution_end", "result": {"details": "` + details + `", "ok": true }}`
		kept := LogKeep - 1
		want := `{"type":"tool_execution_end","result":{"details":` +
			`{"$truncated":` + itoa(len(details)+2) +
			`,"head":"` + jsonQuote + strings.Repeat("a", kept) +
			`","tail":"` + strings.Repeat("a", kept) + jsonQuote + `"},"ok":true}}`

		if got := LogText(mustFrame(t, text), text); got != want {
			t.Errorf("LogText() cuts wrong\n got: %.120s\nwant: %.120s", got, want)
		}
	})
}

// jsonQuote is a double quote inside a JSON string literal, what a cut slice of a string value's
// JSON starts or ends with.
const jsonQuote = `\"`

func TestOutboundLogText(t *testing.T) {
	t.Run("replaces a prompt's message with its ref", func(t *testing.T) {
		command := `{"type":"prompt","id":"c1","message":"do the thing"}`
		want := `{"type":"prompt","id":"c1","message":{"$ref":"job.json#attempts[0].prompt"}}`
		if got := OutboundLogText(json.RawMessage(command), "job.json#attempts[0].prompt"); got != want {
			t.Errorf("OutboundLogText() = %q, want %q", got, want)
		}
	})
	t.Run("appends the ref when the prompt carries no message", func(t *testing.T) {
		command := `{"type":"prompt","id":"c1"}`
		want := `{"type":"prompt","id":"c1","message":{"$ref":"ref"}}`
		if got := OutboundLogText(json.RawMessage(command), "ref"); got != want {
			t.Errorf("OutboundLogText() = %q, want %q", got, want)
		}
	})
	t.Run("logs any other command as sent, compacted", func(t *testing.T) {
		command := `{"type": "session_new", "cwd": "/tmp"}`
		want := `{"type":"session_new","cwd":"/tmp"}`
		if got := OutboundLogText(json.RawMessage(command), "ref"); got != want {
			t.Errorf("OutboundLogText() = %q, want %q", got, want)
		}
	})
	t.Run("keeps a non-prompt command's message", func(t *testing.T) {
		command := `{"type":"host_tool_result","message":"kept"}`
		if got := OutboundLogText(json.RawMessage(command), "ref"); got != command {
			t.Errorf("OutboundLogText() = %q, want %q", got, command)
		}
	})
	t.Run("logs a command without a string type as sent", func(t *testing.T) {
		for _, command := range []string{`{"id":"c1"}`, `{"type":1}`, `{broken`} {
			if got := OutboundLogText(json.RawMessage(command), "ref"); got != command {
				t.Errorf("OutboundLogText(%s) = %q, want the command itself", command, got)
			}
		}
	})
}

func TestOpenRpcLogs(t *testing.T) {
	ctx := context.Background()

	t.Run("without paths nothing is logged", func(t *testing.T) {
		logs, err := OpenRpcLogs(ctx, nil)
		if err != nil {
			t.Fatalf("OpenRpcLogs(nil) failed: %v", err)
		}
		logs.Inbound("line")
		logs.Outbound(json.RawMessage(`{"type":"prompt"}`))
		if _, failed := logs.Failure(); failed {
			t.Error("Failure() reported a failure with no logs open")
		}
		if err := logs.Close(ctx); err != nil {
			t.Errorf("Close() = %v, want nil", err)
		}
	})

	t.Run("opens both logs for appending, private, and keeps the prompt ref out", func(t *testing.T) {
		dir := t.TempDir()
		paths := &RpcLogPaths{
			Stdout:    filepath.Join(dir, "attempts", "attempt-1.jsonl"),
			Stdin:     filepath.Join(dir, "attempts", "attempt-1.rpc-in.jsonl"),
			PromptRef: "job.json#attempts[0].prompt",
		}

		logs, err := OpenRpcLogs(ctx, paths)
		if err != nil {
			t.Fatalf("OpenRpcLogs() failed: %v", err)
		}
		logs.Inbound(`{"type":"ready"}`)
		logs.Outbound(json.RawMessage(`{"type":"prompt","message":"secret prompt"}`))
		if _, failed := logs.Failure(); failed {
			t.Fatal("Failure() reported a failure on a healthy log")
		}
		if err := logs.Close(ctx); err != nil {
			t.Fatalf("Close() = %v, want nil", err)
		}

		wantOut := "{\"type\":\"ready\"}\n"
		wantIn := "{\"type\":\"prompt\",\"message\":{\"$ref\":\"job.json#attempts[0].prompt\"}}\n"
		assertFile(t, paths.Stdout, wantOut, "inbound")
		assertFile(t, paths.Stdin, wantIn, "outbound")

		// The second session appends to the same attempt files.
		again, err := OpenRpcLogs(ctx, paths)
		if err != nil {
			t.Fatalf("OpenRpcLogs() again failed: %v", err)
		}
		again.Inbound(`{"type":"message_end"}`)
		if err := again.Close(ctx); err != nil {
			t.Fatalf("Close() = %v, want nil", err)
		}
		assertFile(t, paths.Stdout, wantOut+"{\"type\":\"message_end\"}\n", "inbound, second open")
	})

	t.Run("a path it cannot open fails with the path in the error", func(t *testing.T) {
		dir := t.TempDir()
		blocked := filepath.Join(dir, "busy")
		if err := os.WriteFile(blocked, []byte("a file"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := OpenRpcLogs(ctx, &RpcLogPaths{Stdout: filepath.Join(blocked, "a.jsonl"), Stdin: filepath.Join(dir, "b.jsonl")}); err == nil {
			t.Error("OpenRpcLogs() with an unopenable stdout succeeded")
		}
		// A directory in the log's place: the directory opens no append stream.
		adir := filepath.Join(dir, "adir")
		if err := os.MkdirAll(adir, 0o700); err != nil {
			t.Fatal(err)
		}
		logs, err := OpenRpcLogs(ctx, &RpcLogPaths{
			Stdout: filepath.Join(dir, "c.jsonl"),
			Stdin:  adir,
		})
		if err == nil {
			logs.Close(ctx)
			t.Fatal("OpenRpcLogs() with an unopenable stdin succeeded")
		}
		if !strings.Contains(err.Error(), "cannot open log "+adir) {
			t.Errorf("error names the wrong path: %v", err)
		}
		assertFile(t, filepath.Join(dir, "c.jsonl"), "", "inbound left behind")
	})
}

func TestCreateRpcLogs(t *testing.T) {
	ctx := context.Background()

	t.Run("takes inbound and outbound writers from two goroutines at once", func(t *testing.T) {
		// An engine client logs inbound frames from its reader goroutine and outbound commands
		// from whichever caller sends them. The two files are distinct, so what they share is the
		// failure bookkeeping: one writer whose writes fail records while the other reads, which
		// is why the frames file here is closed before both writers start.
		dir := t.TempDir()
		frames, commands := openAppend(t, filepath.Join(dir, "a.jsonl")), openAppend(t, filepath.Join(dir, "b.jsonl"))
		logs := CreateRpcLogs(frames, commands, "ref")
		if err := frames.Close(); err != nil {
			t.Fatal(err)
		}
		const writes = 200
		var group sync.WaitGroup
		group.Add(2)
		go func() {
			defer group.Done()
			for i := 0; i < writes; i++ {
				logs.Inbound(`{"type":"message_end"}`)
			}
		}()
		go func() {
			defer group.Done()
			for i := 0; i < writes; i++ {
				logs.Outbound(json.RawMessage(`{"id":"c1","type":"get_state"}`))
			}
		}()
		group.Wait()
		failure, failed := logs.Failure()
		if !failed || !strings.Contains(failure, "closed") {
			t.Fatalf("Failure() = (%q, %v), want the failed inbound writes", failure, failed)
		}
		if err := logs.Close(ctx); err != nil {
			t.Errorf("Close() = %v, want nil", err)
		}
		// The healthy stream keeps whatever fit before the failure stopped it: whole lines, and
		// never more than were written.
		written := readAllLines(t, filepath.Join(dir, "b.jsonl"))
		if len(written) > writes {
			t.Fatalf("the commands log holds %d lines, want at most %d", len(written), writes)
		}
		for _, line := range written {
			if line != `{"id":"c1","type":"get_state"}` {
				t.Fatalf("a torn line in the commands log: %q", line)
			}
		}
	})

	t.Run("a second Close is a no-op, not a failure of its own", func(t *testing.T) {
		dir := t.TempDir()
		frames, commands := openAppend(t, filepath.Join(dir, "a.jsonl")), openAppend(t, filepath.Join(dir, "b.jsonl"))
		logs := CreateRpcLogs(frames, commands, "ref")
		if err := logs.Close(ctx); err != nil {
			t.Fatalf("Close() = %v, want nil", err)
		}
		if err := logs.Close(ctx); err != nil {
			t.Errorf("second Close() = %v, want nil", err)
		}
		if failure, failed := logs.Failure(); failed {
			t.Errorf("Failure() = %q after two closes, want none", failure)
		}
	})

	t.Run("stops writing after the first failure", func(t *testing.T) {
		dir := t.TempDir()
		frames, commands := openAppend(t, filepath.Join(dir, "a.jsonl")), openAppend(t, filepath.Join(dir, "b.jsonl"))
		logs := CreateRpcLogs(frames, commands, "ref")

		if err := frames.Close(); err != nil {
			t.Fatal(err)
		}
		logs.Inbound(`{"type":"ready"}`)
		failure, failed := logs.Failure()
		if !failed {
			t.Fatal("Failure() reported nothing after a failed write")
		}
		if !strings.Contains(failure, "closed") {
			t.Errorf("Failure() = %q, want the write error", failure)
		}
		// The failure stops the outbound log too.
		logs.Outbound(json.RawMessage(`{"type":"prompt","message":"x"}`))
		if err := logs.Close(ctx); err != nil {
			t.Errorf("Close() = %v, want nil", err)
		}
		assertFile(t, filepath.Join(dir, "b.jsonl"), "", "outbound after the failure")
	})
}

// The raw-JSON helpers rpc_log.go is built on, in document order.

func TestWalkObject(t *testing.T) {
	t.Run("visits members in written order and can stop early", func(t *testing.T) {
		var names []string
		ok := walkObject(json.RawMessage(`{"b":1,"a":{"x":[1,2]},"c":"s"}`), func(key string, value json.RawMessage) bool {
			names = append(names, key+":"+string(value))
			return key != "a"
		})
		if !ok {
			t.Error("walkObject() = false for an object")
		}
		want := []string{`b:1`, `a:{"x":[1,2]}`}
		if strings.Join(names, "|") != strings.Join(want, "|") {
			t.Errorf("walkObject() visited %v, want %v", names, want)
		}
	})
	t.Run("accepts an empty object", func(t *testing.T) {
		if !walkObject(json.RawMessage(`{}`), func(string, json.RawMessage) bool { return true }) {
			t.Error("walkObject({}) = false")
		}
	})
	for _, raw := range []string{`null`, `[1,2]`, `"s"`, `1`, ``, `{broken`, `{"a"`} {
		if walkObject(json.RawMessage(raw), func(string, json.RawMessage) bool { return true }) {
			t.Errorf("walkObject(%s) = true, want false", raw)
		}
	}
}

func TestUnquoteString(t *testing.T) {
	if got, ok := unquoteString(json.RawMessage(`"a\"b"`)); !ok || got != `a"b` {
		t.Errorf(`unquoteString("a\"b") = (%q, %v)`, got, ok)
	}
	for _, raw := range []string{`1`, `null`, `true`, `{}`, `not json`} {
		if _, ok := unquoteString(json.RawMessage(raw)); ok {
			t.Errorf("unquoteString(%s) = ok, want false", raw)
		}
	}
}

func TestJSONStringLiteral(t *testing.T) {
	cases := []struct{ text, want string }{
		{text: "plain", want: `"plain"`},
		{text: `a"b`, want: `"a\"b"`},
		{text: `a\b`, want: `"a\\b"`},
		{text: "a\nb", want: `"a\nb"`},
		{text: "a\tb", want: `"a\tb"`},
		{text: "a\bb", want: `"a\bb"`},
		{text: "a\fb", want: `"a\fb"`},
		{text: "a\rb", want: `"a\rb"`},
		{text: "a\x01b", want: `"a\u0001b"`},
		{text: "a<b>&", want: `"a<b>&"`},
		{text: "a\u2028b", want: "\"a\u2028b\""},
	}
	for _, c := range cases {
		var out bytes.Buffer
		jsonStringLiteral(&out, c.text)
		if out.String() != c.want {
			t.Errorf("jsonStringLiteral(%q) = %s, want %s", c.text, out.String(), c.want)
		}
	}
}

func TestCutValue(t *testing.T) {
	t.Run("keeps a value that fits", func(t *testing.T) {
		if _, cut := cutValue(json.RawMessage(`{"a":"b"}`)); cut {
			t.Error("cutValue() cut a small value")
		}
	})
	t.Run("rejects broken JSON", func(t *testing.T) {
		if _, cut := cutValue(json.RawMessage(`{broken`)); cut {
			t.Error("cutValue() cut broken JSON")
		}
	})
	t.Run("counts the compacted JSON, not the raw spacing", func(t *testing.T) {
		spaced := "{ \"a\" : \"" + strings.Repeat("x", LogFieldLimit) + "\" }"
		compactLen := len(`{"a":"` + strings.Repeat("x", LogFieldLimit) + `"}`)
		truncated, cut := cutValue(json.RawMessage(spaced))
		if !cut {
			t.Fatal("cutValue() did not cut an oversized value")
		}
		var decoded struct {
			Truncated int    `json:"$truncated"`
			Head      string `json:"head"`
			Tail      string `json:"tail"`
		}
		if err := json.Unmarshal(truncated, &decoded); err != nil {
			t.Fatalf("the truncated field is not JSON: %v", err)
		}
		if decoded.Truncated != compactLen {
			t.Errorf("$truncated = %d, want %d", decoded.Truncated, compactLen)
		}
	})
}

func TestMemberValue(t *testing.T) {
	if got, ok := memberValue(json.RawMessage(`{"b":1,"a":2}`), "a"); !ok || string(got) != "2" {
		t.Errorf("memberValue(a) = (%s, %v)", got, ok)
	}
	if _, ok := memberValue(json.RawMessage(`{"b":1}`), "a"); ok {
		t.Error("memberValue(missing) = ok")
	}
	if _, ok := memberValue(json.RawMessage(`[1]`), "a"); ok {
		t.Error("memberValue(not an object) = ok")
	}
}

func itoa(n int) string {
	return strconv.Itoa(n)
}

// openAppend opens path for appending the way the rpc logs themselves are opened.
func openAppend(t *testing.T, path string) *os.File {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	t.Cleanup(func() { file.Close() })
	return file
}

// assertFile reads path and compares it byte for byte.
func assertFile(t *testing.T, path, want, what string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if string(data) != want {
		t.Errorf("%s log = %q, want %q", what, data, want)
	}
	if info, err := os.Stat(path); err == nil && info.Mode().Perm() != 0o600 {
		t.Errorf("%s log has mode %v, want 0600", what, info.Mode().Perm())
	}
}

// readAllLines is path's lines, empty ones dropped.
func readAllLines(t *testing.T, path string) []string {
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
