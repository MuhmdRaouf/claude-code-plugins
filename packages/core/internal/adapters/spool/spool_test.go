package spool

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// The spool's scenarios: the paths, the writer's appends and retries, and the reader's
// skipping. The direct tests of the unexported marshalling and logging follow state-migrate and
// worker-events: the layers above cover them only indirectly.

// testEnv is a fresh home and Radar home under a temp dir: the real ~/.agents is never touched.
func testEnv(t *testing.T) domain.EnvLookup {
	t.Helper()
	root := t.TempDir()
	return domain.EnvLookup{
		"HOME":       filepath.Join(root, "home"),
		"RADAR_HOME": filepath.Join(root, "radar"),
	}
}

// pinnedNoon is the clock the writer is pinned to: 2026-10-07 12:00 local, so no case depends
// on today's date.
func pinnedNoon() int64 {
	return time.Date(2026, time.October, 7, 12, 0, 0, 0, time.Local).UnixMilli()
}

func routerStart(ts string) domain.RouterEvent {
	return domain.RouterEvent{
		Ts: ts, Event: domain.EventRouter, Plugin: "zai",
		Port: 18787, State: domain.RouterStateStart, Version: 1,
	}
}

// route is the reference route event, every field set.
func route(ts, plugin string) domain.RouteEvent {
	return domain.RouteEvent{
		Ts: ts, Event: domain.EventRoute, Plugin: plugin,
		Model: "glm-5.3", Upstream: "api.z.ai", Route: "provider", Status: 200, LatencyMs: 5,
	}
}

func statMode(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return info.Mode().Perm()
}

func fileLines(t *testing.T, path string) []string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return strings.Split(strings.TrimRight(string(data), "\n"), "\n")
}

func decode(t *testing.T, line string, into any) {
	t.Helper()
	if err := json.Unmarshal([]byte(line), into); err != nil {
		t.Fatalf("decode %q: %v", line, err)
	}
}

// spoolWith seeds one file per name with a good route line, a malformed one and an empty one.
func spoolWith(t *testing.T, names ...string) domain.EnvLookup {
	t.Helper()
	e := testEnv(t)
	line, err := json.Marshal(route("2026-10-07T10:00:00.000Z", "zai"))
	if err != nil {
		t.Fatalf("marshal the seed line: %v", err)
	}
	for _, name := range names {
		file := filepath.Join(RadarHome(e), "spool", name)
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", filepath.Dir(file), err)
		}
		if err := os.WriteFile(file, append(line, "\nnot json\n\n"...), 0o600); err != nil {
			t.Fatalf("seed %s: %v", file, err)
		}
	}
	return e
}

func TestTheSpoolsPaths(t *testing.T) {
	t.Run("takes RADAR_HOME over ~/.agents", func(t *testing.T) {
		if got := RadarHome(domain.EnvLookup{"RADAR_HOME": "/pin", "HOME": "/home"}); got != "/pin" {
			t.Fatalf("RadarHome with RADAR_HOME set = %q, want /pin", got)
		}
		if got := RadarHome(domain.EnvLookup{"HOME": "/home"}); got != filepath.Join("/home", ".agents", "radar") {
			t.Fatalf("RadarHome without RADAR_HOME = %q, want %q", got, filepath.Join("/home", ".agents", "radar"))
		}
	})

	t.Run("names the file for the local date, not UTC's", func(t *testing.T) {
		// Late on the 7th in UTC+3 is still the 7th locally; in UTC-10 it is already the 8th here.
		late := time.Date(2026, time.October, 7, 23, 30, 0, 0, time.Local).UnixMilli()
		if got := SpoolFile(domain.EnvLookup{"RADAR_HOME": "/o"}, late); got != filepath.Join("/o", "spool", "2026-10-07.jsonl") {
			t.Fatalf("SpoolFile late on the 7th = %q, want %q", got, filepath.Join("/o", "spool", "2026-10-07.jsonl"))
		}
		early := time.Date(2026, time.November, 1, 0, 5, 0, 0, time.Local).UnixMilli()
		if got := SpoolFile(domain.EnvLookup{"RADAR_HOME": "/o"}, early); got != filepath.Join("/o", "spool", "2026-11-01.jsonl") {
			t.Fatalf("SpoolFile early on the 1st = %q, want %q", got, filepath.Join("/o", "spool", "2026-11-01.jsonl"))
		}
	})
}

func TestCreateSpoolWriter(t *testing.T) {
	t.Run("appends one JSON line per event to a 0600 file in a 0700 dir", func(t *testing.T) {
		e := testEnv(t)
		// The day's file is named for the writer's clock, pinned here so the test does not depend on today's date.
		noon := pinnedNoon()
		write := CreateSpoolWriter(e, nil, func() int64 { return noon })

		write(routerStart("2026-10-07T10:00:00.000Z"))
		write(domain.RouteEvent{
			Ts: "2026-10-07T10:00:01.000Z", Event: domain.EventRoute, Plugin: "zai",
			Model: "glm-5.3", Upstream: "api.z.ai", Route: "provider", Status: 200, LatencyMs: 42,
		})

		file := SpoolFile(e, noon)
		if mode := statMode(t, filepath.Join(RadarHome(e), "spool")); mode != 0o700 {
			t.Fatalf("spool dir mode = %o, want 700", mode)
		}
		if mode := statMode(t, file); mode != 0o600 {
			t.Fatalf("spool file mode = %o, want 600", mode)
		}
		lines := fileLines(t, file)
		if len(lines) != 2 {
			t.Fatalf("wrote %d lines, want 2: %q", len(lines), lines)
		}
		var first domain.RouterEvent
		decode(t, lines[0], &first)
		if first.Event != domain.EventRouter || first.State != domain.RouterStateStart {
			t.Fatalf("first line = %+v, want a router start", first)
		}
		var second domain.RouteEvent
		decode(t, lines[1], &second)
		if second.Event != domain.EventRoute || second.Model != "glm-5.3" {
			t.Fatalf("second line = %+v, want a glm-5.3 route", second)
		}
	})

	t.Run("makes the spool directory again when Radar removed it under a running router", func(t *testing.T) {
		e := testEnv(t)
		var warnings []string
		write := CreateSpoolWriter(e, func(line string) { warnings = append(warnings, line) }, nil)
		event := domain.RouterEvent{
			Ts: "t", Event: domain.EventRouter, Plugin: "zai",
			Port: 1, State: domain.RouterStateStart, Version: 1,
		}
		write(event)
		if err := os.RemoveAll(filepath.Join(RadarHome(e), "spool")); err != nil {
			t.Fatalf("remove the spool dir: %v", err)
		}
		write(event)
		if len(warnings) != 0 {
			t.Fatalf("warnings = %q, want none", warnings)
		}
		entries, err := os.ReadDir(filepath.Join(RadarHome(e), "spool"))
		if err != nil {
			t.Fatalf("read the spool dir: %v", err)
		}
		if len(entries) != 1 {
			t.Fatalf("spool holds %d entries, want 1", len(entries))
		}
	})

	t.Run("swallows a failing write into one warning line", func(t *testing.T) {
		root := t.TempDir()
		blocked := filepath.Join(root, "radar")
		if err := os.WriteFile(blocked, []byte("in the way"), 0o600); err != nil {
			t.Fatalf("block the radar home: %v", err)
		}
		var warnings []string
		write := CreateSpoolWriter(
			domain.EnvLookup{"HOME": filepath.Join(root, "home"), "RADAR_HOME": blocked},
			func(line string) { warnings = append(warnings, line) },
			nil,
		)

		write(routerStart("2026-10-07T10:00:00.000Z"))

		if len(warnings) != 1 || !strings.Contains(warnings[0], "route spool:") {
			t.Fatalf("warnings = %q, want one \"route spool:\" line", warnings)
		}
	})
}

func TestReadingTheSpoolBack(t *testing.T) {
	noon := pinnedNoon()

	t.Run("lists the last days' files, today included, oldest first, and nothing when there is no spool yet", func(t *testing.T) {
		e := spoolWith(t, "2026-10-07.jsonl", "2026-10-06.jsonl", "2026-10-05.jsonl", "notes.txt")
		spoolDir := filepath.Join(RadarHome(e), "spool")

		if got := ListSpoolFiles(e, noon, 2); !slices.Equal(got, []string{
			filepath.Join(spoolDir, "2026-10-06.jsonl"),
			filepath.Join(spoolDir, "2026-10-07.jsonl"),
		}) {
			t.Fatalf("two days = %q, want the 6th then the 7th", got)
		}
		if got := ListSpoolFiles(e, noon, 1); !slices.Equal(got, []string{
			filepath.Join(spoolDir, "2026-10-07.jsonl"),
		}) {
			t.Fatalf("one day = %q, want only the 7th", got)
		}
		gone := domain.EnvLookup{"HOME": filepath.Join(t.TempDir(), "gone")}
		if got := ListSpoolFiles(gone, noon, 30); len(got) != 0 {
			t.Fatalf("no spool yet = %q, want nothing", got)
		}
	})

	t.Run("reads every parseable event and skips malformed lines and unreadable files", func(t *testing.T) {
		e := spoolWith(t, "2026-10-07.jsonl")
		events := ReadSpoolEvents(ListSpoolFiles(e, noon, 1))
		want := []domain.SpoolEvent{route("2026-10-07T10:00:00.000Z", "zai")}
		if !reflect.DeepEqual(events, want) {
			t.Fatalf("events = %+v, want %+v", events, want)
		}
		if got := ReadSpoolEvents([]string{filepath.Join(RadarHome(e), "spool", "nope.jsonl")}); len(got) != 0 {
			t.Fatalf("an unreadable file yielded %d events, want none", len(got))
		}
	})

	t.Run("reads through the RouteSpool port the board and usage use", func(t *testing.T) {
		e := spoolWith(t, "2026-10-07.jsonl")
		events := CreateSpoolReader(e).Events(noon, 1)
		want := []domain.SpoolEvent{route("2026-10-07T10:00:00.000Z", "zai")}
		if !reflect.DeepEqual(events, want) {
			t.Fatalf("events = %+v, want %+v", events, want)
		}
	})

	t.Run("leaves a file whose date is not a real calendar date out", func(t *testing.T) {
		e := spoolWith(t, "2026-10-07.jsonl", "2026-13-45.jsonl", "2026-02-30.jsonl")
		spoolDir := filepath.Join(RadarHome(e), "spool")
		if got := ListSpoolFiles(e, noon, 30); !slices.Equal(got, []string{
			filepath.Join(spoolDir, "2026-10-07.jsonl"),
		}) {
			t.Fatalf("thirty days = %q, want only the real date's file", got)
		}
	})

	t.Run("reads router health lines beside route events, and skips a health line that is not one", func(t *testing.T) {
		e := testEnv(t)
		write := CreateSpoolWriter(e, nil, func() int64 { return noon })
		health := domain.HealthEvent("zai", domain.HealthRateLimited, "HTTP 429", "glm-5.3", 1_791_000_000_000)
		write(health)
		write(domain.HealthEvent("zai", domain.HealthFallback, "no worker was ready", "", 1_791_000_000_001))
		file := SpoolFile(e, noon)

		broken := []string{
			healthLine(t, health, func(object map[string]any) { object["event"] = "exploded" }),
			healthLine(t, health, func(object map[string]any) { object["ts"] = "yesterday" }),
			healthLine(t, health, func(object map[string]any) { object["reason"] = 7; object["model"] = 8 }),
		}
		rewritten := strings.Join(append(fileLines(t, file), broken...), "\n")
		if err := os.WriteFile(file, []byte(rewritten), 0o600); err != nil {
			t.Fatalf("rewrite %s: %v", file, err)
		}

		model := "glm-5.3"
		want := []domain.SpoolEvent{
			domain.RouterHealthEvent{
				Kind: domain.HealthEventKind, Plugin: "zai", Event: domain.HealthRateLimited,
				Reason: "HTTP 429", Model: &model, Ts: 1_791_000_000_000,
			},
			domain.RouterHealthEvent{
				Kind: domain.HealthEventKind, Plugin: "zai", Event: domain.HealthFallback,
				Reason: "no worker was ready", Ts: 1_791_000_000_001,
			},
			// A string ts with no event name is neither shape; a wrong reason or model type reads as none.
			domain.RouterHealthEvent{
				Kind: domain.HealthEventKind, Plugin: "zai", Event: domain.HealthRateLimited,
				Reason: "", Ts: 1_791_000_000_000,
			},
		}
		if got := ReadSpoolEvents([]string{file}); !reflect.DeepEqual(got, want) {
			t.Fatalf("events =\n%+v\nwant\n%+v", got, want)
		}
	})
}

// parseEvent's classification, exercised directly: every arm here is a line a router could find
// beside the route and health lines.
func TestParseEvent(t *testing.T) {
	cases := []struct {
		name string
		line string
		want domain.SpoolEvent
	}{
		{
			name: "a router line",
			line: `{"ts":"t","event":"router","plugin":"zai","port":1,"state":"start","version":1}`,
			want: domain.RouterEvent{
				Ts: "t", Event: domain.EventRouter, Plugin: "zai",
				Port: 1, State: domain.RouterStateStart, Version: 1,
			},
		},
		{
			name: "a capture line",
			line: `{"ts":"t","event":"capture","plugin":"zai","prompt_hash":"h","gz":"Zw=="}`,
			want: domain.CaptureEvent{
				Ts: "t", Event: domain.EventCapture, Plugin: "zai", PromptHash: "h", Gz: "Zw==",
			},
		},
		{name: "an event name no event of ours carries", line: `{"ts":"t","event":"bogus"}`},
		{name: "null is not an object", line: `null`},
		{name: "a bare number is not an object", line: `5`},
		{name: "a timestamp that is not a string", line: `{"ts":5,"event":"route"}`},
		{name: "no event name", line: `{"ts":"t"}`},
		{name: "a health line without a plugin", line: `{"kind":"router.event","event":"fallback","ts":1}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := parseEvent(c.line)
			if c.want == nil {
				if ok {
					t.Fatalf("parseEvent(%q) = %+v, want no event", c.line, got)
				}
				return
			}
			if !ok || !reflect.DeepEqual(got, c.want) {
				t.Fatalf("parseEvent(%q) = %+v (%v), want %+v", c.line, got, ok, c.want)
			}
		})
	}
}

// healthLine re-encodes a health event with fields swapped; key order does not matter to the
// reader.
func healthLine(t *testing.T, base domain.RouterHealthEvent, tweak func(object map[string]any)) string {
	t.Helper()
	encoded, err := json.Marshal(base)
	if err != nil {
		t.Fatalf("marshal the health event: %v", err)
	}
	var object map[string]any
	if err := json.Unmarshal(encoded, &object); err != nil {
		t.Fatalf("decode the health event: %v", err)
	}
	tweak(object)
	line, err := json.Marshal(object)
	if err != nil {
		t.Fatalf("marshal the broken line: %v", err)
	}
	return string(line)
}

// The direct tests of the writer's line marshalling: the field order and the raw characters are
// the spool's byte-exactness contract.
func TestMarshalSpoolLine(t *testing.T) {
	t.Run("encodes a route event in the wire field order", func(t *testing.T) {
		line, err := marshalSpoolLine(route("2026-10-07T10:00:00.000Z", "zai"))
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		want := `{"ts":"2026-10-07T10:00:00.000Z","event":"route","plugin":"zai","model":"glm-5.3",` +
			`"upstream":"api.z.ai","route":"provider","status":200,"latency_ms":5}`
		if string(line) != want {
			t.Fatalf("line =\n%s\nwant\n%s", line, want)
		}
	})

	t.Run("leaves angle brackets, the ampersand and the line separators raw", func(t *testing.T) {
		line, err := marshalSpoolLine(
			domain.HealthEvent("zai", domain.HealthRefusal, "<a> & b c d", "", 1_791_000_000_002),
		)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		want := `{"kind":"router.event","plugin":"zai","event":"refusal","reason":"<a> & b` +
			" c d" + `","model":null,"ts":1791000000002}`
		if string(line) != want {
			t.Fatalf("line =\n%s\nwant\n%s", line, want)
		}
	})

	t.Run("reports a value JSON cannot encode", func(t *testing.T) {
		if _, err := marshalSpoolLine(make(chan int)); err == nil {
			t.Fatal("marshalSpoolLine of a channel = no error, want one")
		}
	})
}

// stderrLog's twin in adapters is covered the same way.
func TestStderrLog(t *testing.T) {
	t.Run("writes the line to stderr", func(t *testing.T) {
		reader, writer, err := os.Pipe()
		if err != nil {
			t.Fatalf("pipe: %v", err)
		}
		oldStderr := os.Stderr
		os.Stderr = writer
		stderrLog("route spool: a line")
		os.Stderr = oldStderr
		if err := writer.Close(); err != nil {
			t.Fatalf("close the pipe's writer: %v", err)
		}
		text, err := io.ReadAll(reader)
		if err != nil {
			t.Fatalf("read the pipe: %v", err)
		}
		if string(text) != "route spool: a line\n" {
			t.Fatalf("stderrLog wrote %q, want %q", text, "route spool: a line\n")
		}
	})
}
