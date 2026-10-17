// The uninstall suite: the plugin's presence as Claude Code's own bookkeeping tells it, the watch
// that undoes setup once the plugin is gone, the settings undo it drives, and the worker and
// service entries this card adds (the worker run in process, and the whole service — starter,
// front, forked worker — as real children of this binary).
package router

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

const undoRouterURL = "http://127.0.0.1:18787"
const undoKimiURL = "http://127.0.0.1:18788"

// presenceConfig is a Claude Code config dir with a plugins dir, as the presence tests shape it.
func presenceConfig(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "plugins"), 0o755); err != nil {
		t.Fatal(err)
	}
	return dir
}

// installPlugins writes installed_plugins.json.
func installPlugins(t *testing.T, dir string, plugins string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "plugins", "installed_plugins.json"), []byte(plugins), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestPluginPresence(t *testing.T) {
	t.Parallel()
	t.Run("is unknown while installed_plugins.json is missing or half-written, absent once the plugin is gone", func(t *testing.T) {
		dir := presenceConfig(t)
		if got := PluginPresence("zai", dir, nil, nil); got != PresenceUnknown {
			t.Fatalf("no file: %s, want unknown", got)
		}
		installPlugins(t, dir, `{"version": 2, "plug`)
		if got := PluginPresence("zai", dir, nil, nil); got != PresenceUnknown {
			t.Fatalf("half-written: %s, want unknown", got)
		}
		installPlugins(t, dir, `{"version":2,"plugins":{"kimi-plugin-cc@m":[{"scope":"user"}]}}`)
		if got := PluginPresence("zai", dir, nil, nil); got != PresenceAbsent {
			t.Fatalf("plugin gone: %s, want absent", got)
		}
	})

	t.Run("is present when installed and not turned off, in the v2 and the flat shape", func(t *testing.T) {
		dir := presenceConfig(t)
		installPlugins(t, dir, `{"version":2,"plugins":{"zai-plugin-cc@muhmdraouf":[{"scope":"user"}]}}`)
		if got := PluginPresence("zai", dir, nil, nil); got != PresencePresent {
			t.Fatalf("v2 shape: %s, want present", got)
		}
		installPlugins(t, dir, `{"zai-plugin-cc@muhmdraouf":"not a list"}`)
		if got := PluginPresence("zai", dir, nil, nil); got != PresencePresent {
			t.Fatalf("flat shape: %s, want present", got)
		}
	})

	t.Run("is absent when the data dir's marker is gone (uninstall deletes it)", func(t *testing.T) {
		dir := presenceConfig(t)
		installPlugins(t, dir, `{"version":2,"plugins":{"zai-plugin-cc@m":[{"scope":"user"}]}}`)
		marker := filepath.Join(dir, "installed")
		if got := PluginPresence("zai", dir, &marker, nil); got != PresenceAbsent {
			t.Fatalf("marker gone: %s, want absent", got)
		}
		if err := os.WriteFile(marker, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := PluginPresence("zai", dir, &marker, nil); got != PresencePresent {
			t.Fatalf("marker back: %s, want present", got)
		}
	})

	t.Run("is disabled only when every scope it is installed in says false", func(t *testing.T) {
		dir := presenceConfig(t)
		project := t.TempDir()
		if err := os.MkdirAll(filepath.Join(project, ".claude"), 0o755); err != nil {
			t.Fatal(err)
		}
		installPlugins(t, dir, fmt.Sprintf(
			`{"version":2,"plugins":{"zai-plugin-cc@m":[{"scope":"user"},{"scope":"project","projectPath":%q},{"scope":"local","projectPath":%q},null]}}`,
			project, project))
		off := `{"enabledPlugins":{"zai-plugin-cc@m":false}}`
		for _, path := range []string{
			filepath.Join(dir, "settings.json"),
			filepath.Join(project, ".claude", "settings.json"),
			filepath.Join(project, ".claude", "settings.local.json"),
		} {
			if err := os.WriteFile(path, []byte(off), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		// The null entry counts as a user install, whose settings say false.
		if got := PluginPresence("zai", dir, nil, nil); got != PresenceDisabled {
			t.Fatalf("every scope off: %s, want disabled", got)
		}
		if err := os.WriteFile(filepath.Join(project, ".claude", "settings.local.json"),
			[]byte(`{"enabledPlugins":{}}`), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := PluginPresence("zai", dir, nil, nil); got != PresencePresent {
			t.Fatalf("one scope back on: %s, want present", got)
		}
	})
}

// watchLedger is the ledger the watch tests undo.
func watchLedger(root string) Ledger {
	return Ledger{
		Version:      1,
		Plugin:       "zai",
		RouterURL:    undoRouterURL,
		SettingsPath: filepath.Join(root, "settings.json"),
		Settings:     MergeSettingsUndo(nil, nil),
		Keystore:     LedgerKeystore{Created: false},
		RouterFiles:  []string{},
		StateRoot:    root,
	}
}

// uninstallHarness is the suite's harness: a watch over scripted presence answers that records
// its actions.
type uninstallHarness struct {
	root  string
	calls []string
	watch *FrontWatch
}

func newUninstallHarness(t *testing.T, answers []Presence) *uninstallHarness {
	t.Helper()
	h := &uninstallHarness{root: t.TempDir()}
	remaining := append([]Presence(nil), answers...)
	h.watch = CreateUninstallWatch(UninstallWatchOptions{
		StateRoot: h.root,
		Actions: UninstallActions{
			Presence: func(Ledger) Presence {
				if len(remaining) == 0 {
					return PresencePresent
				}
				next := remaining[0]
				remaining = remaining[1:]
				return next
			},
			Undo: func(Ledger) error {
				h.calls = append(h.calls, "undo")
				return nil
			},
			Remove: func(_ Ledger, disabled bool) error {
				if disabled {
					h.calls = append(h.calls, "remove disabled")
				} else {
					h.calls = append(h.calls, "remove")
				}
				return nil
			},
		},
	})
	return h
}

func (h *uninstallHarness) tick(t *testing.T) string {
	t.Helper()
	say, err := h.watch.Tick()
	if err != nil {
		t.Fatal(err)
	}
	return say
}

func TestUninstallWatch(t *testing.T) {
	t.Parallel()
	t.Run("does nothing without a ledger", func(t *testing.T) {
		h := newUninstallHarness(t, []Presence{PresenceAbsent, PresenceAbsent})
		if h.watch.EveryMs != 10_000 {
			t.Fatalf("everyMs = %d, want 10000", h.watch.EveryMs)
		}
		if got := h.tick(t); got != "stay" {
			t.Fatalf("tick = %q, want stay", got)
		}
		if got := h.tick(t); got != "stay" {
			t.Fatalf("tick = %q, want stay", got)
		}
		if err := h.watch.Cleanup(); err != nil {
			t.Fatal(err)
		}
		if len(h.calls) != 0 {
			t.Fatalf("calls = %q, want none", h.calls)
		}
	})

	t.Run("needs two consecutive gone answers: an update window (unknown, then present) cleans nothing", func(t *testing.T) {
		h := newUninstallHarness(t, []Presence{PresenceAbsent, PresenceUnknown, PresenceAbsent, PresencePresent, PresenceAbsent})
		layout := domain.NewStateLayout(h.root)
		if err := WriteLedger(context.Background(), layout.Ledger, watchLedger(h.root)); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 5; i++ {
			if got := h.tick(t); got != "stay" {
				t.Fatalf("tick %d = %q, want stay", i, got)
			}
		}
		if err := h.watch.Cleanup(); err != nil {
			t.Fatal(err)
		}
		if len(h.calls) != 0 {
			t.Fatalf("calls = %q, want none", h.calls)
		}
	})

	t.Run("undoes after two gone answers and says retire; the cleanup removes the rest when the front exits", func(t *testing.T) {
		h := newUninstallHarness(t, []Presence{PresenceAbsent, PresenceAbsent})
		layout := domain.NewStateLayout(h.root)
		if err := WriteLedger(context.Background(), layout.Ledger, watchLedger(h.root)); err != nil {
			t.Fatal(err)
		}
		if got := h.tick(t); got != "stay" {
			t.Fatalf("first tick = %q, want stay", got)
		}
		if got := h.tick(t); got != "retire" {
			t.Fatalf("second tick = %q, want retire", got)
		}
		if !reflect.DeepEqual(h.calls, []string{"undo"}) {
			t.Fatalf("calls = %q, want [undo]", h.calls)
		}
		if _, err := os.Stat(layout.Ledger); !os.IsNotExist(err) {
			t.Fatalf("the ledger is still on disk (%v)", err)
		}
		// The ledger lives on in memory: the plugin's data dir may be gone already.
		if got := h.tick(t); got != "retire" {
			t.Fatalf("tick after undo = %q, want retire", got)
		}
		if err := h.watch.Cleanup(); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(h.calls, []string{"undo", "remove"}) {
			t.Fatalf("calls = %q, want [undo remove]", h.calls)
		}
	})

	t.Run("disable keeps the ledger as ledger.disabled.json; setting up again before the exit cancels the cleanup", func(t *testing.T) {
		h := newUninstallHarness(t, []Presence{PresenceDisabled, PresenceDisabled})
		layout := domain.NewStateLayout(h.root)
		ledger := watchLedger(h.root)
		if err := WriteLedger(context.Background(), layout.Ledger, ledger); err != nil {
			t.Fatal(err)
		}
		h.tick(t)
		if got := h.tick(t); got != "retire" {
			t.Fatalf("second tick = %q, want retire", got)
		}
		kept, ok := ReadLedger(context.Background(), layout.DisabledLedger)
		// The read copy also carries the file's key order, which no ledger built in memory has.
		kept.fileOrder = nil
		if !ok || !reflect.DeepEqual(kept, ledger) {
			t.Fatalf("the disabled ledger = %+v, want %+v", kept, ledger)
		}
		// Re-enabled: the hook re-applied setup, which wrote a new ledger.
		if err := WriteLedger(context.Background(), layout.Ledger, ledger); err != nil {
			t.Fatal(err)
		}
		if err := h.watch.Cleanup(); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(h.calls, []string{"undo"}) {
			t.Fatalf("calls = %q, want [undo]", h.calls)
		}
	})

	t.Run("tells a disabled cleanup from an uninstall", func(t *testing.T) {
		h := newUninstallHarness(t, []Presence{PresenceDisabled, PresenceDisabled})
		layout := domain.NewStateLayout(h.root)
		if err := WriteLedger(context.Background(), layout.Ledger, watchLedger(h.root)); err != nil {
			t.Fatal(err)
		}
		h.tick(t)
		h.tick(t)
		if err := h.watch.Cleanup(); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(h.calls, []string{"undo", "remove disabled"}) {
			t.Fatalf("calls = %q, want [undo remove disabled]", h.calls)
		}
	})

	t.Run("leaves a note for undecided jobs, and removes the router's own files", func(t *testing.T) {
		root := t.TempDir()
		WriteLeftBehind(root, "zai", nil)
		if _, err := os.Stat(filepath.Join(root, "LEFT-BEHIND.md")); !os.IsNotExist(err) {
			t.Fatalf("a note was written for no jobs (%v)", err)
		}
		worktree := "/w/j1"
		WriteLeftBehind(root, "zai", []LeftBehind{{ID: "j1", Worktree: &worktree}, {ID: "j2"}})
		note, err := os.ReadFile(filepath.Join(root, "LEFT-BEHIND.md"))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(note), "- j1: /w/j1\n- j2\n") {
			t.Fatalf("the note = %q", note)
		}
		if err := os.MkdirAll(filepath.Join(root, "router"), 0o755); err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"router.pid", "router.retired"} {
			if err := os.WriteFile(filepath.Join(root, name), []byte("{}"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		RemoveRouterFiles(root)
		for _, path := range []string{
			filepath.Join(root, "router"), filepath.Join(root, "router.pid"), filepath.Join(root, "router.retired"),
		} {
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Fatalf("%s survived the cleanup (%v)", path, err)
			}
		}
	})
}

// undoSettings writes a settings file the undo tests shape, and returns its path.
func undoSettings(t *testing.T, text string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".claude"), 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, ".claude", "settings.json")
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// undoSetUp runs setup on the settings file and returns what it recorded.
func undoSetUp(t *testing.T, path string, live []string) adapters.SettingsDelta {
	t.Helper()
	var delta adapters.SettingsDelta
	_, err := adapters.ApplyProviderSettings(context.Background(), path, routerProvider, undoRouterURL,
		adapters.ApplyProviderOptions{
			LivePluginURLs: live,
			Record:         func(recorded adapters.SettingsDelta) { delta = recorded },
		})
	if err != nil {
		t.Fatal(err)
	}
	return delta
}

func TestUninstallSettingsUndo(t *testing.T) {
	t.Parallel()
	t.Run("setup then uninstall leaves settings.json byte-identical, even in the user's own formatting", func(t *testing.T) {
		original := "{\n    \"theme\": \"dark\",\n    \"permissions\": { \"allow\": [] }\n}\n"
		path := undoSettings(t, original)
		delta := undoSetUp(t, path, nil)
		backup, err := os.ReadFile(adapters.SettingsBackupPath(path, "zai"))
		if err != nil || string(backup) != original {
			t.Fatalf("the backup = %q %v, want the original", backup, err)
		}
		if _, err := adapters.UndoProviderSettings(context.Background(), path, "zai",
			MergeSettingsUndo(nil, &delta), undoRouterURL, nil); err != nil {
			t.Fatal(err)
		}
		after, err := os.ReadFile(path)
		if err != nil || string(after) != original {
			t.Fatalf("settings after = %q %v, want the original bytes", after, err)
		}
	})

	t.Run("reverts only this plugin's keys when the user edited another key in between", func(t *testing.T) {
		path := undoSettings(t, "{\n  \"theme\": \"dark\",\n  \"availableModels\": [\n    \"sonnet\"\n  ]\n}\n")
		delta := undoSetUp(t, path, nil)
		edited := map[string]any{}
		if err := json.Unmarshal(mustRead(t, path), &edited); err != nil {
			t.Fatal(err)
		}
		edited["theme"] = "light"
		if err := os.WriteFile(path, mustMarshal(t, edited), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := adapters.UndoProviderSettings(context.Background(), path, "zai",
			MergeSettingsUndo(nil, &delta), undoRouterURL, nil); err != nil {
			t.Fatal(err)
		}
		var after map[string]any
		if err := json.Unmarshal(mustRead(t, path), &after); err != nil {
			t.Fatal(err)
		}
		want := map[string]any{"theme": "light", "availableModels": []any{"sonnet"}}
		if !reflect.DeepEqual(after, want) {
			t.Fatalf("settings after = %+v, want %+v", after, want)
		}
	})

	t.Run("leaves a base URL the user changed meanwhile alone", func(t *testing.T) {
		path := undoSettings(t, "{}\n")
		delta := undoSetUp(t, path, nil)
		edited := map[string]any{}
		if err := json.Unmarshal(mustRead(t, path), &edited); err != nil {
			t.Fatal(err)
		}
		env := map[string]any{"ANTHROPIC_BASE_URL": "https://my-proxy.example"}
		edited["env"] = env
		if err := os.WriteFile(path, mustMarshal(t, edited), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := adapters.UndoProviderSettings(context.Background(), path, "zai",
			MergeSettingsUndo(nil, &delta), undoRouterURL, nil); err != nil {
			t.Fatal(err)
		}
		var after map[string]any
		if err := json.Unmarshal(mustRead(t, path), &after); err != nil {
			t.Fatal(err)
		}
		want := map[string]any{"env": map[string]any{"ANTHROPIC_BASE_URL": "https://my-proxy.example"}}
		if !reflect.DeepEqual(after, want) {
			t.Fatalf("settings after = %+v, want %+v", after, want)
		}
	})

	t.Run("repoints at the surviving plugin's router when two were set up and one is removed", func(t *testing.T) {
		path := undoSettings(t, "{}\n")
		delta := undoSetUp(t, path, nil)
		if _, err := adapters.UndoProviderSettings(context.Background(), path, "zai",
			MergeSettingsUndo(nil, &delta), undoRouterURL, []string{undoKimiURL}); err != nil {
			t.Fatal(err)
		}
		var after map[string]any
		if err := json.Unmarshal(mustRead(t, path), &after); err != nil {
			t.Fatal(err)
		}
		want := map[string]any{"env": map[string]any{"ANTHROPIC_BASE_URL": undoKimiURL}}
		if !reflect.DeepEqual(after, want) {
			t.Fatalf("settings after = %+v, want %+v", after, want)
		}
	})

	t.Run("puts a previous base URL back unless it is a plugin router that is not running", func(t *testing.T) {
		proxy := undoSettings(t, string(mustMarshal(t, map[string]any{"env": map[string]any{"ANTHROPIC_BASE_URL": undoKimiURL}}))+"\n")
		delta := undoSetUp(t, proxy, nil)
		if delta.BaseURLBefore == nil || *delta.BaseURLBefore != undoKimiURL {
			t.Fatalf("baseUrlBefore = %+v, want "+undoKimiURL, delta.BaseURLBefore)
		}
		if _, err := adapters.UndoProviderSettings(context.Background(), proxy, "zai",
			MergeSettingsUndo(nil, &delta), undoRouterURL, nil); err != nil {
			t.Fatal(err)
		}
		var after map[string]any
		if err := json.Unmarshal(mustRead(t, proxy), &after); err != nil {
			t.Fatal(err)
		}
		// The kimi router it replaced is not running: nothing to point at.
		if want := map[string]any{"env": map[string]any{}}; !reflect.DeepEqual(after, want) {
			t.Fatalf("settings after = %+v, want %+v", after, want)
		}

		live := undoSettings(t, string(mustMarshal(t, map[string]any{"env": map[string]any{"ANTHROPIC_BASE_URL": undoKimiURL}}))+"\n")
		again := undoSetUp(t, live, nil)
		if _, err := adapters.UndoProviderSettings(context.Background(), live, "zai",
			MergeSettingsUndo(nil, &again), undoRouterURL, []string{undoKimiURL}); err != nil {
			t.Fatal(err)
		}
		var afterLive map[string]any
		if err := json.Unmarshal(mustRead(t, live), &afterLive); err != nil {
			t.Fatal(err)
		}
		if want := map[string]any{"env": map[string]any{"ANTHROPIC_BASE_URL": undoKimiURL}}; !reflect.DeepEqual(afterLive, want) {
			t.Fatalf("settings after = %+v, want %+v", afterLive, want)
		}
	})

	t.Run("keeps a live plugin router's base URL at setup instead of moving it", func(t *testing.T) {
		path := undoSettings(t, string(mustMarshal(t, map[string]any{"env": map[string]any{"ANTHROPIC_BASE_URL": undoKimiURL}}))+"\n")
		delta := undoSetUp(t, path, []string{undoKimiURL})
		if delta.BaseURLBefore != nil {
			t.Fatalf("baseUrlBefore = %q, want none", *delta.BaseURLBefore)
		}
		var after map[string]any
		if err := json.Unmarshal(mustRead(t, path), &after); err != nil {
			t.Fatal(err)
		}
		if want := map[string]any{"ANTHROPIC_BASE_URL": undoKimiURL}; !reflect.DeepEqual(after["env"], want) {
			t.Fatalf("env after = %+v, want %+v", after["env"], want)
		}
	})
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func mustMarshal(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// ── the worker entry ────────────────────────────────────────────────────────────────────────────────────────────────

// workerMessages collects the IPC lines the worker sends, and waits for one to arrive.
type workerMessages struct {
	mu    sync.Mutex
	lines []string
	wake  chan struct{}
}

func newWorkerMessages() *workerMessages {
	return &workerMessages{wake: make(chan struct{}, 1)}
}

func (m *workerMessages) send(line string) {
	m.mu.Lock()
	m.lines = append(m.lines, line)
	m.mu.Unlock()
	select {
	case m.wake <- struct{}{}:
	default:
	}
}

func (m *workerMessages) snapshot() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.lines...)
}

func (m *workerMessages) wait(t *testing.T, want string) {
	t.Helper()
	m.waitContaining(t, want)
}

// waitContaining waits for a line that contains want (heartbeats carry a live number).
func (m *workerMessages) waitContaining(t *testing.T, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		for _, line := range m.snapshot() {
			if strings.Contains(line, want) {
				return
			}
		}
		select {
		case <-m.wake:
		case <-time.After(10 * time.Millisecond):
		}
		if time.Now().After(deadline) {
			t.Fatalf("the worker never sent %q; got %q", want, m.snapshot())
		}
	}
}

// workerListeningPort reads the port out of the worker's listening message.
func workerListeningPort(t *testing.T, m *workerMessages) int {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		for _, line := range m.snapshot() {
			var message struct {
				T    string `json:"t"`
				Port int    `json:"port"`
			}
			if json.Unmarshal([]byte(line), &message) == nil && message.T == "listening" && message.Port != 0 {
				return message.Port
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("the worker never listened; got %q", m.snapshot())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// runTestWorker starts the worker in process and returns how to talk to it: the pipe it reads
// messages from, its messages, its exits, and when it returned.
func runTestWorker(t *testing.T, env domain.EnvLookup) (*workerRig, func()) {
	t.Helper()
	anthropic := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		_, _ = w.Write([]byte("worker anthropic"))
	}))
	t.Cleanup(anthropic.Close)
	root := t.TempDir()
	full := domain.EnvLookup{"HOME": root}
	for name, value := range env {
		full[name] = value
	}
	if _, given := full["ZAI_ROUTER_ANTHROPIC_URL"]; !given {
		full["ZAI_ROUTER_ANTHROPIC_URL"] = anthropic.URL
	}
	if _, given := full["ZAI_ROUTER_URL"]; !given {
		full["ZAI_ROUTER_URL"] = closedUpstream
	}
	// A real pipe (kernel-buffered), so a line written to a worker that already left never blocks
	// the test.
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reader.Close() })
	messages := newWorkerMessages()
	rig := &workerRig{writer: writer, messages: messages}
	rig.exits = make(chan int, 4)
	returned := make(chan struct{})
	go func() {
		RunWorker(WorkerOptions{
			Provider:    routerProvider,
			Env:         full,
			StateRoot:   root,
			Version:     "v1",
			LogFile:     domain.NewStateLayout(root).RouterLog,
			Token:       "worker-token",
			HeartbeatMs: 20,
		}, reader, messages.send, func(code int) { rig.exits <- code })
		close(returned)
	}()
	return rig, func() {
		_ = writer.Close()
		waitUntil(t, 5*time.Second, func() bool {
			select {
			case <-returned:
				return true
			default:
				return false
			}
		})
	}
}

// workerRig is one in-process worker's handles.
type workerRig struct {
	writer   *os.File
	messages *workerMessages
	exits    chan int
}

func (r *workerRig) say(t *testing.T, line string) {
	t.Helper()
	if _, err := fmt.Fprintln(r.writer, line); err != nil {
		t.Fatal(err)
	}
}

func (r *workerRig) waitExit(t *testing.T) int {
	t.Helper()
	select {
	case code := <-r.exits:
		return code
	case <-time.After(5 * time.Second):
		t.Fatal("the worker never exited")
		return -1
	}
}

func TestRunWorker(t *testing.T) {
	t.Parallel()
	t.Run("reports its port, heartbeats, serves requests and answers the key check", func(t *testing.T) {
		rig, waitReturned := runTestWorker(t, domain.EnvLookup{"ZAI_API_KEY": "test-key"})
		port := workerListeningPort(t, rig.messages)
		rig.messages.waitContaining(t, `{"t":"hb","rss":`)

		request, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/v1/messages", port),
			strings.NewReader(`{"model":"claude-x"}`))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set(TokenHeader, "worker-token")
		answer, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(answer.Body)
		answer.Body.Close()
		if answer.StatusCode != 200 || string(body) != "worker anthropic" {
			t.Fatalf("post = %d %q, want 200 worker anthropic", answer.StatusCode, body)
		}

		rig.say(t, `{"t":"key","id":"k1"}`)
		rig.messages.wait(t, `{"t":"key","id":"k1","ok":true,"source":"ZAI_API_KEY"}`)

		rig.say(t, `{"t":"drain","ms":100}`)
		if code := rig.waitExit(t); code != 0 {
			t.Fatalf("drain exit = %d, want 0", code)
		}
		waitReturned()
	})

	t.Run("a drain waits out the request in flight and answers it whole", func(t *testing.T) {
		// The hot update's recycle: a request is already upstream (the front has its ack) when the
		// old worker is told to drain, and the upstream is slow. The answer must still arrive whole
		// before the worker exits.
		arrived := make(chan struct{}, 1)
		release := make(chan struct{})
		held := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			arrived <- struct{}{}
			<-release
			_, _ = w.Write([]byte("held answer"))
		}))
		t.Cleanup(held.Close)
		rig, waitReturned := runTestWorker(t, domain.EnvLookup{
			"ZAI_API_KEY":              "test-key",
			"ZAI_ROUTER_ANTHROPIC_URL": held.URL,
		})
		port := workerListeningPort(t, rig.messages)
		// The front's shape: a fresh connection per request, so the answer rides one socket.
		client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: 10 * time.Second}
		type answer struct {
			status int
			body   string
			err    error
		}
		replied := make(chan answer, 1)
		go func() {
			request, err := http.NewRequest(http.MethodPost,
				fmt.Sprintf("http://127.0.0.1:%d/v1/messages", port), strings.NewReader(`{"model":"claude-x"}`))
			if err != nil {
				replied <- answer{err: err}
				return
			}
			request.Header.Set(TokenHeader, "worker-token")
			response, err := client.Do(request)
			if err != nil {
				replied <- answer{err: err}
				return
			}
			body, _ := io.ReadAll(response.Body)
			response.Body.Close()
			replied <- answer{status: response.StatusCode, body: string(body)}
		}()
		<-arrived
		rig.say(t, `{"t":"drain","ms":5000}`)
		close(release)
		if got := <-replied; got.err != nil || got.status != 200 || got.body != "held answer" {
			t.Fatalf("the drained request = %d %q %v, want 200 held answer", got.status, got.body, got.err)
		}
		if code := rig.waitExit(t); code != 0 {
			t.Fatalf("drain exit = %d, want 0", code)
		}
		waitReturned()
	})

	t.Run("says why the key check failed, and ends when the front goes away", func(t *testing.T) {
		rig, waitReturned := runTestWorker(t, domain.EnvLookup{})
		rig.say(t, `{"t":"key","id":"k9"}`)
		rig.messages.wait(t, `{"t":"key","id":"k9","ok":false,"error":"no_key"}`)

		if err := rig.writer.Close(); err != nil {
			t.Fatal(err)
		}
		if code := rig.waitExit(t); code != 0 {
			t.Fatalf("disconnect exit = %d, want 0", code)
		}
		waitReturned()
	})
}

// ── the service command ─────────────────────────────────────────────────────────────────────────────────────────────

// serviceEnv is the environment the service tests run with: a temp home, a free port, and the
// state dirs under a temp root, so nothing real is ever touched.
// closedUpstream is a loopback address nothing listens on: an upstream pointed here fails
// locally instead of ever leaving the machine.
const closedUpstream = "http://127.0.0.1:1"

// serviceEnv is the environment the service tests run with, built as one explicit map so nothing
// from the developer's shell leaks into a spawned child: a temp home, temp state dirs, a free
// port, and both upstreams on loopback (tests that need a working fake replace them).
func serviceEnv(t *testing.T, root string, port int) domain.EnvLookup {
	t.Helper()
	return domain.EnvLookup{
		"HOME":                     filepath.Join(root, "home"),
		"CLAUDE_CONFIG_DIR":        filepath.Join(root, "claude"),
		"RADAR_HOME":               filepath.Join(root, "radar"),
		"PROVIDER_ROUTERS_HOME":    filepath.Join(root, "routers"),
		"PATH":                     os.Getenv("PATH"),
		"ZAI_ROUTER_PORT":          strconv.Itoa(port),
		"ZAI_ROUTER_TUNING":        `{"heartbeatMs":20,"hangMs":2000,"startMs":8000,"waitWorkerMs":5000}`,
		"ZAI_ROUTER_ANTHROPIC_URL": closedUpstream,
		"ZAI_ROUTER_URL":           closedUpstream,
	}
}

func TestRouterServiceCommands(t *testing.T) {
	t.Parallel()
	t.Run("prints usage and exits 2 for an unknown command", func(t *testing.T) {
		root := t.TempDir()
		var out, errOut bytes.Buffer
		code := RouterService(RouterServiceOptions{
			Provider: routerProvider, StateRoot: filepath.Join(root, "state"), Script: "plugin-core",
			Env: serviceEnv(t, root, freeRouterPort(t)), Argv: []string{"explode"}, Out: &out, Err: &errOut,
		})
		if code != 2 {
			t.Fatalf("exit = %d, want 2", code)
		}
		if out.Len() != 0 {
			t.Fatalf("stdout = %q, want empty", out.String())
		}
		if want := "usage: zai-router run | start | stop | status\n"; errOut.String() != want {
			t.Fatalf("stderr = %q, want %q", errOut.String(), want)
		}
	})

	t.Run("status reports a router that is not running", func(t *testing.T) {
		root := t.TempDir()
		port := freeRouterPort(t)
		var out, errOut bytes.Buffer
		code := RouterService(RouterServiceOptions{
			Provider: routerProvider, StateRoot: filepath.Join(root, "state"), Script: "plugin-core",
			Env: serviceEnv(t, root, port), Argv: []string{"status"}, Out: &out, Err: &errOut,
		})
		if code != 1 {
			t.Fatalf("exit = %d, want 1", code)
		}
		want := fmt.Sprintf("zai-router not running on http://127.0.0.1:%d; this session does not use it\n", port)
		if out.String() != want {
			t.Fatalf("stdout = %q, want %q", out.String(), want)
		}
	})

	t.Run("stop without a router says so and exits 0", func(t *testing.T) {
		root := t.TempDir()
		var out, errOut bytes.Buffer
		code := RouterService(RouterServiceOptions{
			Provider: routerProvider, StateRoot: filepath.Join(root, "state"), Script: "plugin-core",
			Env: serviceEnv(t, root, freeRouterPort(t)), Argv: []string{"stop"}, Out: &out, Err: &errOut,
		})
		if code != 0 {
			t.Fatalf("exit = %d, want 0", code)
		}
		if want := "zai-router stopped (was not running)\n"; out.String() != want {
			t.Fatalf("stdout = %q, want %q", out.String(), want)
		}
	})

	t.Run("run reports a port it cannot listen on", func(t *testing.T) {
		root := t.TempDir()
		taker, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", freeRouterPort(t)))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = taker.Close() })
		taken := taker.Addr().(*net.TCPAddr).Port
		var out, errOut bytes.Buffer
		self, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		code := RouterService(RouterServiceOptions{
			Provider: routerProvider, StateRoot: filepath.Join(root, "state"), Script: self,
			Env: serviceEnv(t, root, taken), Argv: []string{"run"}, Out: &out, Err: &errOut,
		})
		if code != 1 {
			t.Fatalf("exit = %d, want 1", code)
		}
	})
}

// ── the service as real child processes ─────────────────────────────────────────────────────────────────────────────

// serviceFrontHealth reads the real front's health (the zai reference provider's path, not the
// process rig's acme one).
func serviceFrontHealth(t *testing.T, port int) healthBody {
	t.Helper()
	health, err := tryServiceFrontHealth(port)
	if err != nil {
		t.Fatalf("health: %v", err)
	}
	return health
}

// tryServiceFrontHealth is the front's health, or the error of asking (a waiter polls through the
// refusals while the front comes up).
func tryServiceFrontHealth(port int) (healthBody, error) {
	_, body, err := frontProcessDoQuiet(port, routerProvider.Router.HealthPath)
	if err != nil {
		return healthBody{}, err
	}
	var parsed healthBody
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		return healthBody{}, err
	}
	return parsed, nil
}

// frontProcessDoQuiet makes one request without the test's own fatals.
func frontProcessDoQuiet(port int, path string) (int, string, error) {
	request, err := http.NewRequest(http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d%s", port, path), nil)
	if err != nil {
		return 0, "", err
	}
	request.Host = fmt.Sprintf("127.0.0.1:%d", port)
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}, Timeout: 2 * time.Second}
	answer, err := client.Do(request)
	if err != nil {
		return 0, "", err
	}
	defer answer.Body.Close()
	text, err := io.ReadAll(answer.Body)
	return answer.StatusCode, string(text), err
}

// runServiceChild is the service child: this binary re-executed by the starter (`<name> router
// run`) or the front (`<name> router worker`), running the real service entry.
func runServiceChild() {
	fail := func(line string) {
		fmt.Fprintln(os.Stderr, line)
		os.Exit(3)
	}
	name := os.Getenv("SERVICE_CHILD_NAME")
	if len(os.Args) != 4 || os.Args[1] != name || os.Args[2] != "router" {
		fail(fmt.Sprintf("service child argv = %v", os.Args))
	}
	stateRoot := os.Getenv("SERVICE_CHILD_STATE")
	env := domain.EnvLookup{}
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		env[name] = value
	}
	self, err := os.Executable()
	if err != nil {
		fail("no executable: " + err.Error())
	}
	os.Exit(RouterService(RouterServiceOptions{
		Provider:  routerProvider,
		StateRoot: stateRoot,
		Script:    self,
		Env:       env,
		Argv:      os.Args[3:],
		// The child's own starts (an ensure-spawned start) spawn through the mode-aware spawn,
		// so the grandchildren re-enter this mode too.
		Spawn: serviceSpawn(stateRoot),
	}))
}

// serviceSpawn is the production spawn with the child's test mode added to its environment.
func serviceSpawn(state string) func(string, []string, map[string]string, string) DetachedChild {
	return func(binary string, args []string, env map[string]string, logFile string) DetachedChild {
		merged := make(map[string]string, len(env)+3)
		for name, value := range env {
			merged[name] = value
		}
		merged[focusChildEnv] = "service"
		merged["SERVICE_CHILD_NAME"] = "zai"
		merged["SERVICE_CHILD_STATE"] = state
		return spawnRouterDetached(binary, args, merged, logFile)
	}
}

// localOnlyUpstream is the one upstream a real-child test may talk to: a local fake that records
// every request it is handed, so the test can prove nothing left the machine.
type localOnlyUpstream struct {
	server *httptest.Server
	mu     sync.Mutex
	seen   []string // each request's remote address
}

func newLocalOnlyUpstream(t *testing.T) *localOnlyUpstream {
	t.Helper()
	upstream := &localOnlyUpstream{}
	upstream.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		upstream.mu.Lock()
		upstream.seen = append(upstream.seen, r.RemoteAddr)
		upstream.mu.Unlock()
		_, _ = w.Write([]byte("from anthropic"))
	}))
	t.Cleanup(upstream.server.Close)
	return upstream
}

func (u *localOnlyUpstream) requests() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.seen...)
}

// assertAllLocal fails the test when any recorded request arrived from off the machine, and proves
// the fake was the upstream the chain talked to.
func (u *localOnlyUpstream) assertAllLocal(t *testing.T, atLeast int) {
	t.Helper()
	seen := u.requests()
	if len(seen) < atLeast {
		t.Fatalf("the fake upstream saw %d requests, want at least %d", len(seen), atLeast)
	}
	for _, remote := range seen {
		host, _, err := net.SplitHostPort(remote)
		if err != nil {
			host = remote
		}
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			t.Fatalf("the fake upstream was reached from %s, a non-local address", remote)
		}
	}
}

// waitForLocalRouteLine waits until the temp radar spool holds a route line that names a local
// upstream: the line lands when the request ends, which a caller about to end the router (a
// handover, a stop) must wait for or the write can be cut by the exit.
func waitForLocalRouteLine(t *testing.T, radarHome string) {
	t.Helper()
	routeLine := func(line string) bool {
		return strings.Contains(line, `"event":"route"`) && strings.Contains(line, `"upstream":"127.0.0.1:`)
	}
	waitUntil(t, 5*time.Second, func() bool {
		files, err := os.ReadDir(filepath.Join(radarHome, "spool"))
		if err != nil {
			return false
		}
		for _, file := range files {
			for _, line := range strings.Split(string(mustRead(t, filepath.Join(radarHome, "spool", file.Name()))), "\n") {
				if routeLine(line) {
					return true
				}
			}
		}
		return false
	})
}

// assertSpoolStayedLocal reads the temp radar spool the chain wrote and fails when a line names a
// real upstream: a request that reached one would be recorded here with its host. The route line
// lands when the request ends, so it is waited for before the scan.
func assertSpoolStayedLocal(t *testing.T, radarHome string) {
	t.Helper()
	waitForLocalRouteLine(t, radarHome)
	files, err := os.ReadDir(filepath.Join(radarHome, "spool"))
	if err != nil {
		t.Fatalf("the chain wrote no spool lines under %s (%v)", radarHome, err)
	}
	for _, file := range files {
		for _, line := range strings.Split(string(mustRead(t, filepath.Join(radarHome, "spool", file.Name()))), "\n") {
			for _, real := range []string{"api.anthropic.com", "api.z.ai"} {
				if strings.Contains(line, real) {
					t.Fatalf("a spool line names the real upstream %s: %s", real, line)
				}
			}
		}
	}
}

func TestRouterServiceChild(t *testing.T) {
	t.Parallel()
	t.Run("start brings the real front up, which forks the real worker; Claude traffic flows", func(t *testing.T) {
		anthropic := newLocalOnlyUpstream(t)
		root := t.TempDir()
		dist := filepath.Join(root, "dist")
		if err := os.MkdirAll(dist, 0o755); err != nil {
			t.Fatal(err)
		}
		self, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dist, routerBinaryName), mustRead(t, self), 0o755); err != nil {
			t.Fatal(err)
		}
		state := filepath.Join(root, "state")
		port := freeRouterPort(t)
		env := serviceEnv(t, root, port)
		// Both upstreams point at the one local fake: whatever the chain forwards stays on this
		// machine, and the fake records it.
		env["ZAI_ROUTER_ANTHROPIC_URL"] = anthropic.server.URL
		env["ZAI_ROUTER_URL"] = anthropic.server.URL
		env["ZAI_API_KEY"] = "test-key"

		var out bytes.Buffer
		code := RouterService(RouterServiceOptions{
			Provider: routerProvider, StateRoot: state, Script: filepath.Join(dist, routerBinaryName),
			Env: env, Argv: []string{"start"}, Out: &out, Spawn: serviceSpawn(state),
		})
		if code != 0 {
			t.Fatalf("start exit = %d, out = %q", code, out.String())
		}
		pid := int64(0)
		if _, err := fmt.Sscanf(out.String(), "zai-router running on http://127.0.0.1:"+strconv.Itoa(port)+" (pid %d)", &pid); err != nil {
			t.Fatalf("start line = %q", out.String())
		}
		if pid <= 1 {
			t.Fatalf("start pid = %d", pid)
		}
		worker := int(0)
		t.Cleanup(func() { stopServicePid(t, pid, port, worker) })

		waitUntil(t, 15*time.Second, func() bool {
			health, err := tryServiceFrontHealth(port)
			if err == nil && health.Worker == "up" {
				if health.WorkerPid != nil {
					worker = *health.WorkerPid
				}
				return true
			}
			return false
		})
		status, body, err := frontProcessPost(t, port, "claude-x")
		if err != nil || status != 200 || body != "from anthropic" {
			t.Fatalf("post through the real service = %d %q %v", status, body, err)
		}
		source, err := RouterKeyCheck(context.Background(), routerProvider, env, state, 8000)
		if err != nil || source != "ZAI_API_KEY" {
			t.Fatalf("the key check through the service = %q %v, want ZAI_API_KEY", source, err)
		}
		waitUntil(t, 5*time.Second, func() bool {
			entries := ReadRegistry(env)
			return len(entries) == 1 && entries[0].Name == "zai" && entries[0].Port == int64(port) &&
				entries[0].Pid != nil && *entries[0].Pid == pid
		})
		// The guard: everything the chain forwarded was seen by the local fake from a local
		// address, and the spool it wrote names no real upstream.
		anthropic.assertAllLocal(t, 1)
		assertSpoolStayedLocal(t, env["RADAR_HOME"])
	})
}

// stopServicePid ends a front child the test started and waits for its port to go, then for the
// worker it had forked. The pid came from the start line, so PidMatches guards the signal: a
// recycled pid is never signalled. The signal goes through the router's own signalPid, the stop
// the production code makes too. The worker is waited for because it runs the copied bundle.
func stopServicePid(t *testing.T, pid int64, port int, worker int) {
	t.Helper()
	if testkit.PidMatches(pid, "router run", 0) {
		signalPid(pid, "SIGTERM")
	}
	waitUntil(t, 10*time.Second, func() bool {
		listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			return false
		}
		_ = listener.Close()
		return true
	})
	if worker != 0 {
		waitUntil(t, 10*time.Second, func() bool { return !testkit.IsPidAlive(worker) })
	}
}

// ── the service's uninstall actions, directly ──────────────────────────────────────────────────────────────────────

// serviceActionWorld is one state root with its environment, as the uninstall actions see it.
func serviceActionWorld(t *testing.T) (RouterServiceOptions, *focusNotes) {
	t.Helper()
	root := t.TempDir()
	state := filepath.Join(root, "state")
	notes := &focusNotes{}
	options := RouterServiceOptions{
		Provider:  routerProvider,
		StateRoot: state,
		Script:    "plugin-core",
		Env:       serviceEnv(t, root, freeRouterPort(t)),
	}
	_ = notes
	return options, notes
}

func TestServiceUninstallActions(t *testing.T) {
	t.Parallel()
	t.Run("presence follows Claude Code's bookkeeping", func(t *testing.T) {
		options, _ := serviceActionWorld(t)
		actions := serviceUninstallActions(context.Background(), options, func(string) {}, nil)
		if got := actions.Presence(Ledger{}); got != PresenceUnknown {
			t.Fatalf("presence without installed_plugins.json = %s, want unknown", got)
		}
	})

	t.Run("undo restores the settings and the agents, and drops the setup marker", func(t *testing.T) {
		options, notes := serviceActionWorld(t)
		env := options.Env
		config := env["CLAUDE_CONFIG_DIR"]
		if err := os.MkdirAll(config, 0o755); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(config, "settings.json")
		if err := os.WriteFile(path, []byte("{}\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		var delta adapters.SettingsDelta
		if _, err := adapters.ApplyProviderSettings(context.Background(), path, routerProvider, undoRouterURL,
			adapters.ApplyProviderOptions{Record: func(recorded adapters.SettingsDelta) { delta = recorded }}); err != nil {
			t.Fatal(err)
		}
		agentsDir := filepath.Join(options.StateRoot, "agents")
		if err := os.MkdirAll(agentsDir, 0o755); err != nil {
			t.Fatal(err)
		}
		changed := "glm-5.3"
		if err := os.WriteFile(filepath.Join(agentsDir, "code.md"), []byte("---\nmodel: other\n---\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		// A nil model removes the line; the file has to be there for it.
		if err := os.WriteFile(filepath.Join(agentsDir, "scout.md"), []byte("---\nmodel: other\n---\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		layout := domain.NewStateLayout(options.StateRoot)
		if err := os.WriteFile(layout.SetupDone, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		agents := NewLedgerAgents()
		agents.Set("code", &changed)
		agents.Set("scout", nil)
		ledger := watchLedger(options.StateRoot)
		ledger.SettingsPath = path
		ledger.Settings = MergeSettingsUndo(nil, &delta)
		ledger.Agents = agents
		ledger.AgentsDir = &agentsDir

		actions := serviceUninstallActions(context.Background(), options, notes.add, nil)
		if err := actions.Undo(ledger); err != nil {
			t.Fatal(err)
		}
		if got := mustRead(t, path); string(got) != "{}\n" {
			t.Fatalf("settings after undo = %q, want the original", got)
		}
		if model, found, _ := adapters.ReadModelLine(filepath.Join(agentsDir, "code.md")); !found || model != "glm-5.3" {
			t.Fatalf("the agent's model = %q %v, want glm-5.3", model, found)
		}
		if _, err := os.Stat(layout.SetupDone); !os.IsNotExist(err) {
			t.Fatalf("setup-done survived the undo (%v)", err)
		}
		joined := notes.joined()
		if !strings.Contains(joined, "plugin removed: ") {
			t.Fatalf("notes = %q, want the settings undo line", joined)
		}
		if !strings.Contains(joined, "plugin removed: agents restored (code: glm-5.3, scout: (none))") {
			t.Fatalf("notes = %q, want the agents line", joined)
		}
	})

	t.Run("remove takes the registry entry, the router files and the decided jobs", func(t *testing.T) {
		options, _ := serviceActionWorld(t)
		layout := domain.NewStateLayout(options.StateRoot)
		if err := os.MkdirAll(layout.RouterDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(layout.RouterPid, []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := SaveRegistryEntry(context.Background(), options.Env, RegisteredRouter{Name: "zai", Port: 1,
			ModelPrefixes: []string{}, CatalogIds: []string{}, UpdatedAt: isoNow()}); err != nil {
			t.Fatal(err)
		}
		worktree := filepath.Join(options.StateRoot, "wt-j2")
		undecided := testkit.AJob(func(job *domain.Job) {
			job.ID = "j2"
			job.State = domain.JobStateAwaitingReview
			job.Workspace = domain.Workspace{RepoRoot: t.TempDir(), Worktree: &worktree, ArtifactsDir: "artifacts"}
		})
		store := adapters.CreateFsStore(options.StateRoot, func(int64) bool { return false })
		if _, err := store.Create(context.Background(), undecided); err != nil {
			t.Fatal(err)
		}

		actions := serviceUninstallActions(context.Background(), options, func(string) {}, nil)
		if err := actions.Remove(watchLedger(options.StateRoot), false); err != nil {
			t.Fatal(err)
		}
		if entries := ReadRegistry(options.Env); len(entries) != 0 {
			t.Fatalf("the registry still holds %+v", entries)
		}
		if _, err := os.Stat(layout.RouterDir); !os.IsNotExist(err) {
			t.Fatalf("the router dir survived (%v)", err)
		}
		if _, err := os.Stat(layout.RouterPid); !os.IsNotExist(err) {
			t.Fatalf("the pid file survived (%v)", err)
		}
		note, err := os.ReadFile(layout.LeftBehind)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(note), "- j2: "+worktree) {
			t.Fatalf("LEFT-BEHIND.md = %q", note)
		}
	})

	t.Run("remove closes the front's log before the router files go", func(t *testing.T) {
		options, _ := serviceActionWorld(t)
		layout := domain.NewStateLayout(options.StateRoot)
		if err := os.MkdirAll(layout.RouterDir, 0o755); err != nil {
			t.Fatal(err)
		}
		// The front's log writer the way serviceRun builds it (closableLog): no line the front
		// logs past the cleanup may open a new router.log behind the removal.
		var lines []string
		write, off := closableLog(func(line string) { lines = append(lines, line) })
		write("listening")
		actions := serviceUninstallActions(context.Background(), options, func(string) {}, off)
		if err := actions.Remove(watchLedger(options.StateRoot), false); err != nil {
			t.Fatal(err)
		}
		write("a line past the cleanup")
		if got := strings.Join(lines, "\n"); got != "listening" {
			t.Fatalf("the log saw %q, want only the line from before the cleanup", got)
		}
		if _, err := os.Stat(layout.RouterLog); !os.IsNotExist(err) {
			t.Fatalf("router.log came back after the removal (%v)", err)
		}
	})
}

// TestClosableLog is the front's log off switch on its own: every line lands until the close, none
// after it, and the close is idempotent.
func TestClosableLog(t *testing.T) {
	t.Parallel()
	t.Run("keeps every line until the close, then drops them all", func(t *testing.T) {
		var lines []string
		write, off := closableLog(func(line string) { lines = append(lines, line) })
		write("first")
		off()
		off()
		write("past the close")
		if got := strings.Join(lines, "\n"); got != "first" {
			t.Fatalf("lines = %q, want only what came before the close", got)
		}
	})
}

// TestReleaseSpawnedLog is the front freeing its own hold on the router log: the starter spawns the
// router with stdout and stderr appending to that file, and the handles live until the process
// ends — the retiring front closes them before the removal. The streams here stand in for the
// process's own; the null device takes their place.
// TestReleaseSpawnedLog stays serial: it swaps the process-wide os.Stdout and os.Stderr.
func TestReleaseSpawnedLog(t *testing.T) {
	t.Run("closes both spawned streams and points the process at the null device", func(t *testing.T) {
		dir := t.TempDir()
		spawned := make([]*os.File, 2)
		for index, name := range []string{"router.log", "start.log"} {
			file, err := os.OpenFile(filepath.Join(dir, name), os.O_WRONLY|os.O_CREATE, 0o600)
			if err != nil {
				t.Fatal(err)
			}
			spawned[index] = file
		}
		oldOut, oldErr := os.Stdout, os.Stderr
		t.Cleanup(func() { os.Stdout, os.Stderr = oldOut, oldErr })
		if !releaseSpawnedLog(spawned[0], spawned[1]) {
			t.Fatal("releaseSpawnedLog did not close both streams")
		}
		if os.Stdout == oldOut || os.Stderr == oldErr {
			t.Fatal("the process streams were not pointed at the null device")
		}
		for index, stream := range spawned {
			if _, err := stream.WriteString("past the close"); err == nil {
				t.Fatalf("stream %d is still open", index)
			}
		}
		if _, err := io.WriteString(os.Stdout, ""); err != nil {
			t.Fatalf("the null device: %v", err)
		}
	})

	t.Run("a null device that cannot be opened closes nothing", func(t *testing.T) {
		dir := t.TempDir()
		file, err := os.OpenFile(filepath.Join(dir, "router.log"), os.O_WRONLY|os.O_CREATE, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = file.Close() })
		oldOut, oldErr := os.Stdout, os.Stderr
		t.Cleanup(func() { os.Stdout, os.Stderr = oldOut, oldErr })
		if releaseSpawnedLogWith(func() (*os.File, error) { return nil, syscall.EPERM }, file, file) {
			t.Fatal("releaseSpawnedLog claimed both streams were closed")
		}
		if os.Stdout != oldOut || os.Stderr != oldErr {
			t.Fatal("the process streams were changed anyway")
		}
		if _, err := file.WriteString("still open"); err != nil {
			t.Fatalf("the stream was closed anyway: %v", err)
		}
	})
}

// TestRemoveHeldLog is the router log's delete under a busy answer: the router processes are
// spawned with their stdio on this very file, so a process still ending can hold the delete back,
// and the removal retries past it. The injected violations stand in for the collision; the real
// file goes on the first attempt.
func TestRemoveHeldLog(t *testing.T) {
	t.Parallel()
	t.Run("retries a sharing violation past the holder's exit", func(t *testing.T) {
		calls := 0
		removeHeldLogWith(func(string) error {
			calls++
			if calls <= 2 {
				return fmt.Errorf("delete: %w", syscall.EBUSY)
			}
			return nil
		}, filepath.Join(t.TempDir(), "router.log"))
		if calls != 3 {
			t.Fatalf("calls = %d, want 3", calls)
		}
	})

	t.Run("gives up after the bound while the holder stays", func(t *testing.T) {
		calls := 0
		removeHeldLogWith(func(string) error {
			calls++
			return syscall.EBUSY
		}, filepath.Join(t.TempDir(), "router.log"))
		if calls != heldLogAttempts+1 {
			t.Fatalf("calls = %d, want %d", calls, heldLogAttempts+1)
		}
	})

	t.Run("does not retry another error", func(t *testing.T) {
		calls := 0
		removeHeldLogWith(func(string) error {
			calls++
			return syscall.EPERM
		}, filepath.Join(t.TempDir(), "router.log"))
		if calls != 1 {
			t.Fatalf("calls = %d, want 1", calls)
		}
	})

	t.Run("a log nobody holds goes on the first attempt, and a missing log is fine", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "router.log")
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		removeHeldLog(path)
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("the log survived (%v)", err)
		}
		removeHeldLog(filepath.Join(t.TempDir(), "gone"))
	})
}

// TestServiceCleanupJobs stays serial: IsolateGitConfig sets the process's own environment.
func TestServiceCleanupJobs(t *testing.T) {
	testkit.IsolateGitConfig(t)
	repo := testkit.MakeRepo(t)
	root := t.TempDir()
	state := filepath.Join(root, "state")
	options := RouterServiceOptions{Provider: routerProvider, StateRoot: state, Env: serviceEnv(t, root, freeRouterPort(t))}
	store := adapters.CreateFsStore(state, func(int64) bool { return false })

	worktree := filepath.Join(state, "wt-j1")
	repo.Git("worktree", "add", "-q", "-b", "zai/j1", "--", worktree, repo.Head())
	branch := "zai/j1"
	if _, err := store.Create(context.Background(), testkit.AJob(func(job *domain.Job) {
		job.ID = "j1"
		job.State = domain.JobStateAccepted
		job.Workspace = domain.Workspace{RepoRoot: repo.Dir, BaseSha: repo.Head(), Worktree: &worktree, Branch: &branch}
	})); err != nil {
		t.Fatal(err)
	}

	serviceCleanupJobs(context.Background(), options)
	if _, err := os.Stat(worktree); !os.IsNotExist(err) {
		t.Fatalf("the decided job's worktree survived (%v)", err)
	}
	if _, err := os.Stat(domain.NewStateLayout(state).LeftBehind); !os.IsNotExist(err) {
		t.Fatal("a note was written for a job that needed none")
	}
}

// ── the run and worker entries in process ───────────────────────────────────────────────────────────────────────────

// TestRouterServiceRunEntry stays serial: it sets the process's own environment for the service entry.
func TestRouterServiceRunEntry(t *testing.T) {
	t.Run("run serves until a handover drains it, and the exit is clean", func(t *testing.T) {
		root := t.TempDir()
		port := freeRouterPort(t)
		env := serviceEnv(t, root, port)
		anthropic := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			_, _ = w.Write([]byte("from anthropic"))
		}))
		t.Cleanup(anthropic.Close)
		env["ZAI_ROUTER_ANTHROPIC_URL"] = anthropic.URL
		env["ZAI_ROUTER_TOKEN"] = "run-token"
		// The front forks this binary as its worker through the production fork, which passes the
		// process's own environment: every var the worker needs is exported for the child too, and
		// a developer shell's proxies are emptied so no upstream call can leave through them.
		for name, value := range env {
			t.Setenv(name, value)
		}
		for _, proxy := range []string{"http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"} {
			t.Setenv(proxy, "")
		}
		// The child mode runs the real worker entry.
		state := filepath.Join(root, "state")
		t.Setenv(focusChildEnv, "service")
		t.Setenv("SERVICE_CHILD_NAME", "zai")
		t.Setenv("SERVICE_CHILD_STATE", state)
		self, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		exits := make(chan int, 4)
		go func() {
			exits <- RouterService(RouterServiceOptions{
				Provider: routerProvider, StateRoot: state, Script: self, Env: env,
				Argv: []string{"run"}, Exit: func(code int) { exits <- code },
			})
		}()
		waitUntil(t, 15*time.Second, func() bool {
			health, err := tryServiceFrontHealth(port)
			return err == nil && health.Worker == "up"
		})
		health := serviceFrontHealth(t, port)
		workerPid := health.WorkerPid
		status, body, err := frontProcessPost(t, port, "claude-x")
		if err != nil || status != 200 || body != "from anthropic" {
			t.Fatalf("post through the running service = %d %q %v", status, body, err)
		}
		// The route line must be on disk before the handover: the drain that follows ends the
		// worker, and with it any spool write still in flight.
		waitForLocalRouteLine(t, env["RADAR_HOME"])
		controlStatus, _, err := frontProcessDo(t, http.MethodPost, port, routerProvider.Router.HealthPath+"/handover", "{}", "run-token")
		if err != nil || controlStatus != 200 {
			t.Fatalf("handover = %d %v", controlStatus, err)
		}
		select {
		case code := <-exits:
			if code != 0 {
				t.Fatalf("the service exited %d, want 0", code)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("the service never exited after the handover")
		}
		if workerPid != nil {
			waitUntil(t, 10*time.Second, func() bool { return !testkit.IsPidAlive(*workerPid) })
		}
		// The in-process run wrote its own temp spool; no line may name a real upstream.
		assertSpoolStayedLocal(t, env["RADAR_HOME"])
	})
}

// TestRouterServiceWorkerEntry stays serial: it swaps the process-wide os.Stdin and os.Stdout.
func TestRouterServiceWorkerEntry(t *testing.T) {
	t.Run("worker speaks the fork's IPC on stdio", func(t *testing.T) {
		root := t.TempDir()
		env := serviceEnv(t, root, freeRouterPort(t))
		env["ZAI_ROUTER_TUNING"] = `{"heartbeatMs":20}`
		env["ZAI_API_KEY"] = "test-key"
		env["ZAI_ROUTER_WORKER_TOKEN"] = "fork-token"
		inReader, inWriter, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		outReader, outWriter, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		oldIn, oldOut := os.Stdin, os.Stdout
		os.Stdin, os.Stdout = inReader, outWriter
		t.Cleanup(func() { os.Stdin, os.Stdout = oldIn, oldOut })
		self, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		// The front is gone from the start (an already-closed stdin): the worker still reports
		// its port, then ends itself the way a forked worker must.
		if err := inWriter.Close(); err != nil {
			t.Fatal(err)
		}
		code := RouterService(RouterServiceOptions{
			Provider: routerProvider, StateRoot: filepath.Join(root, "state"), Script: self, Env: env,
			Argv: []string{"worker"}, Exit: func(int) {},
		})
		if code != 0 {
			t.Fatalf("worker entry exit = %d, want 0", code)
		}
		os.Stdout = oldOut
		_ = outWriter.Close()
		spoken, err := io.ReadAll(outReader)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(spoken), `{"t":"listening","port":`) {
			t.Fatalf("the worker's stdout = %q, want a listening line", spoken)
		}
	})
}

func TestEnsureEntry(t *testing.T) {
	t.Parallel()
	t.Run("costs nothing when the router answers, and skips an uninstalled plugin", func(t *testing.T) {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = listener.Close() })
		root := t.TempDir()
		up := serviceEnv(t, root, listener.Addr().(*net.TCPAddr).Port)
		EnsureEntry(routerProvider, up) // no panic, no spawn, no output

		skipped := serviceEnv(t, filepath.Join(root, "elsewhere"), freeRouterPort(t))
		EnsureEntry(routerProvider, skipped)
	})
}

// TestServiceEntryBranches covers the entry paths the happy-path tests never take: the failures
// that exit 1, the state root resolved from the environment, and a status that finds the router
// up.
func TestServiceEntryBranches(t *testing.T) {
	t.Parallel()
	t.Run("start says why when the port is held by another program", func(t *testing.T) {
		root := t.TempDir()
		taker, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", freeRouterPort(t)))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = taker.Close() })
		var out bytes.Buffer
		code := RouterService(RouterServiceOptions{
			Provider: routerProvider, StateRoot: filepath.Join(root, "state"), Script: "plugin-core",
			Env: serviceEnv(t, root, taker.Addr().(*net.TCPAddr).Port), Argv: []string{"start"}, Out: &out,
		})
		if code != 1 {
			t.Fatalf("start exit = %d, want 1", code)
		}
		if !strings.Contains(out.String(), "zai-router start failed: port ") {
			t.Fatalf("start line = %q", out.String())
		}
	})

	t.Run("run and worker exit 1 when this binary cannot be read", func(t *testing.T) {
		root := t.TempDir()
		env := serviceEnv(t, root, freeRouterPort(t))
		for _, command := range []string{"run", "worker"} {
			code := RouterService(RouterServiceOptions{
				Provider: routerProvider, StateRoot: filepath.Join(root, "state"),
				Script: filepath.Join(root, "gone"), Env: env, Argv: []string{command},
			})
			if code != 1 {
				t.Fatalf("%s exit = %d, want 1", command, code)
			}
		}
	})

	t.Run("run exits 1 on an anthropic URL that does not parse", func(t *testing.T) {
		root := t.TempDir()
		self, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		env := serviceEnv(t, root, freeRouterPort(t))
		env["ZAI_ROUTER_ANTHROPIC_URL"] = "http://[::1]:bad"
		code := RouterService(RouterServiceOptions{
			Provider: routerProvider, StateRoot: filepath.Join(root, "state"),
			Script: self, Env: env, Argv: []string{"run"},
		})
		if code != 1 {
			t.Fatalf("run exit = %d, want 1", code)
		}
	})

	t.Run("resolves the state root from the environment when none is given", func(t *testing.T) {
		root := t.TempDir()
		state := filepath.Join(root, "resolved")
		env := serviceEnv(t, root, freeRouterPort(t))
		env["ZAI_STATE_DIR"] = state
		var out bytes.Buffer
		code := RouterService(RouterServiceOptions{
			Provider: routerProvider, Script: "plugin-core", Env: env,
			Argv: []string{"stop"}, Out: &out,
		})
		if code != 0 {
			t.Fatalf("stop exit = %d, want 0", code)
		}
		if _, err := os.Stat(domain.NewStateLayout(state).RouterLock); err == nil {
			t.Fatal("the resolved state root was not used")
		}
		if entries := ReadRegistry(env); len(entries) != 0 {
			t.Fatalf("the resolved root's registry = %+v", entries)
		}
	})

	t.Run("status exits 0 when our router answers", func(t *testing.T) {
		root := t.TempDir()
		port := freeRouterPort(t)
		env := serviceEnv(t, root, port)
		listener, err := StartEmergency(context.Background(), EmergencyOptions{
			Name: routerProvider.Name, Display: routerProvider.Display,
			HealthPath: routerProvider.Router.HealthPath,
			Claim:      routerProvider.ModelClaim(), Port: port,
			Anthropic: mustURL(t, "http://127.0.0.1:1"), Env: ProxyEnv{},
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = listener.Close() })
		var out bytes.Buffer
		code := RouterService(RouterServiceOptions{
			Provider: routerProvider, StateRoot: filepath.Join(root, "state"), Script: "plugin-core",
			Env: env, Argv: []string{"status"}, Out: &out,
		})
		if code != 0 {
			t.Fatalf("status exit = %d, want 0 (out = %q)", code, out.String())
		}
		if !strings.Contains(out.String(), "zai-router running (emergency)") {
			t.Fatalf("status line = %q", out.String())
		}
	})

	t.Run("undo notes a settings file it cannot touch, and remove skips a keystore it never made", func(t *testing.T) {
		root := t.TempDir()
		config := filepath.Join(root, "claude")
		if err := os.MkdirAll(config, 0o755); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(config, "settings.json")
		if err := os.WriteFile(path, []byte("not json"), 0o644); err != nil {
			t.Fatal(err)
		}
		options, notes := serviceActionWorld(t)
		options.Env["CLAUDE_CONFIG_DIR"] = config
		ledger := watchLedger(options.StateRoot)
		ledger.SettingsPath = path
		actions := serviceUninstallActions(context.Background(), options, notes.add, nil)
		if err := actions.Undo(ledger); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(notes.joined(), "plugin removed: ") {
			t.Fatalf("notes = %q", notes.joined())
		}
		made := LedgerKeystore{Created: true}
		ledger.Keystore = made
		if err := actions.Remove(ledger, true); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("the agent restore walks the ledger's own order, not the map's", func(t *testing.T) {
		root := t.TempDir()
		agentsDir := filepath.Join(root, "agents")
		if err := os.MkdirAll(agentsDir, 0o755); err != nil {
			t.Fatal(err)
		}
		for _, agent := range []string{"zealot", "alpha", "mid"} {
			if err := os.WriteFile(filepath.Join(agentsDir, agent+".md"), []byte("---\nmodel: other\n---\n"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		// The ledger file writes its agents in an order that is not alphabetical; the file
		// keeps that order, so the restore must walk it. The paths go in JSON-quoted, so a
		// platform's own backslashes stay valid escapes in the literal.
		jsonQuoted := func(text string) string {
			quoted, err := json.Marshal(text)
			if err != nil {
				t.Fatal(err)
			}
			return string(quoted)
		}
		ledgerJSON := `{
  "version": 1,
  "plugin": "zai",
  "routerUrl": "http://127.0.0.1:18787",
  "settingsPath": ` + jsonQuoted(filepath.Join(root, "settings.json")) + `,
  "settings": {},
  "keystore": {"created": false},
  "routerFiles": [],
  "agents": {"zealot": "glm-5.3", "alpha": null, "mid": "glm-5.3-flash"},
  "agentsDir": ` + jsonQuoted(agentsDir) + `,
  "stateRoot": ` + jsonQuoted(root) + `
}
`
		if err := os.WriteFile(domain.NewStateLayout(root).Ledger, []byte(ledgerJSON), 0o600); err != nil {
			t.Fatal(err)
		}
		ledger, ok := ReadLedger(context.Background(), domain.NewStateLayout(root).Ledger)
		if !ok {
			t.Fatal("the hand-written ledger did not read back")
		}
		restored := restoreLedgerAgents(context.Background(), ledger)
		want := []string{"zealot: glm-5.3", "alpha: (none)", "mid: glm-5.3-flash"}
		if !reflect.DeepEqual(restored, want) {
			t.Fatalf("restored = %q, want %q (the ledger's own order)", restored, want)
		}
	})

	t.Run("the agent restore skips a file it cannot write", func(t *testing.T) {
		agentsDir := t.TempDir()
		// A directory where the agent's file would be: the write cannot happen.
		if err := os.MkdirAll(filepath.Join(agentsDir, "code.md"), 0o755); err != nil {
			t.Fatal(err)
		}
		model := "glm-5.3"
		agents := NewLedgerAgents()
		agents.Set("code", &model)
		if restored := restoreLedgerAgents(context.Background(), Ledger{Agents: agents, AgentsDir: &agentsDir}); len(restored) != 0 {
			t.Fatalf("restored = %q, want none", restored)
		}
	})
}

// TestServiceEntryDefaults covers the entries' default output (the process's own stdout) and the
// undo's live-router hunt.
func TestServiceEntryDefaults(t *testing.T) {
	t.Parallel()
	t.Run("stop and status write to the process stdout when given no writer", func(t *testing.T) {
		root := t.TempDir()
		env := serviceEnv(t, root, freeRouterPort(t))
		if code := RouterService(RouterServiceOptions{Provider: routerProvider,
			StateRoot: filepath.Join(root, "state"), Script: "plugin-core", Env: env, Argv: []string{"stop"}}); code != 0 {
			t.Fatalf("stop exit = %d", code)
		}
		if code := RouterService(RouterServiceOptions{Provider: routerProvider,
			StateRoot: filepath.Join(root, "state"), Script: "plugin-core", Env: env, Argv: []string{"status"}}); code != 1 {
			t.Fatalf("status exit = %d", code)
		}
	})

	t.Run("undo points the base URL at a live surviving router", func(t *testing.T) {
		port := freeRouterPort(t)
		peer, err := StartEmergency(context.Background(), EmergencyOptions{
			Name: "kimi", Display: "Kimi", HealthPath: "/kimi-router/health",
			Claim: domain.ModelClaim{}, Port: port,
			Anthropic: mustURL(t, "http://127.0.0.1:1"), Env: ProxyEnv{},
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = peer.Close() })
		options, _ := serviceActionWorld(t)
		if err := SaveRegistryEntry(context.Background(), options.Env, RegisteredRouter{
			Name: "kimi", Port: int64(port), ModelPrefixes: []string{}, CatalogIds: []string{}, UpdatedAt: isoNow(),
		}); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(options.Env["CLAUDE_CONFIG_DIR"], "settings.json")
		if err := os.MkdirAll(options.Env["CLAUDE_CONFIG_DIR"], 0o755); err != nil {
			t.Fatal(err)
		}
		var delta adapters.SettingsDelta
		if _, err := adapters.ApplyProviderSettings(context.Background(), path, routerProvider, undoRouterURL,
			adapters.ApplyProviderOptions{Record: func(recorded adapters.SettingsDelta) { delta = recorded }}); err != nil {
			t.Fatal(err)
		}
		ledger := watchLedger(options.StateRoot)
		ledger.SettingsPath = path
		ledger.Settings = MergeSettingsUndo(nil, &delta)
		actions := serviceUninstallActions(context.Background(), options, func(string) {}, nil)
		if err := actions.Undo(ledger); err != nil {
			t.Fatal(err)
		}
		var after map[string]any
		if err := json.Unmarshal(mustRead(t, path), &after); err != nil {
			t.Fatal(err)
		}
		if want := map[string]any{"ANTHROPIC_BASE_URL": fmt.Sprintf("http://127.0.0.1:%d", port)}; !reflect.DeepEqual(after["env"], want) {
			t.Fatalf("env after = %+v, want %+v", after["env"], want)
		}
	})
}

// TestServiceRemainingBranches lifts the last branches: the base URL guard's say, the worker's
// refusals, and the watch's failing undo.
func TestServiceRemainingBranches(t *testing.T) {
	t.Parallel()
	t.Run("start says what the base URL guard did when the router cannot come up", func(t *testing.T) {
		root := t.TempDir()
		taker, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", freeRouterPort(t)))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = taker.Close() })
		port := taker.Addr().(*net.TCPAddr).Port
		env := serviceEnv(t, root, port)
		config := env["CLAUDE_CONFIG_DIR"]
		if err := os.MkdirAll(config, 0o755); err != nil {
			t.Fatal(err)
		}
		settings := filepath.Join(config, "settings.json")
		if err := os.WriteFile(settings, mustMarshal(t, map[string]any{
			"env": map[string]any{"ANTHROPIC_BASE_URL": fmt.Sprintf("http://127.0.0.1:%d", port)},
		}), 0o644); err != nil {
			t.Fatal(err)
		}
		var out bytes.Buffer
		code := RouterService(RouterServiceOptions{
			Provider: routerProvider, StateRoot: filepath.Join(root, "state"), Script: "plugin-core",
			Env: env, Argv: []string{"start"}, Out: &out,
		})
		if code != 1 {
			t.Fatalf("start exit = %d, want 1 (out = %q)", code, out.String())
		}
		if !strings.Contains(out.String(), "Restart Claude Code sessions") {
			t.Fatalf("the guard never said anything: %q", out.String())
		}
	})

	t.Run("the worker refuses URLs it cannot parse", func(t *testing.T) {
		for name, value := range map[string]string{
			"ZAI_ROUTER_ANTHROPIC_URL": "http://[::1]:bad",
			"ZAI_ROUTER_URL":           "http://[::1]:bad",
		} {
			env := domain.EnvLookup{name: value}
			rig, waitReturned := runTestWorker(t, env)
			if code := rig.waitExit(t); code != 1 {
				t.Fatalf("%s exit = %d, want 1", name, code)
			}
			waitReturned()
		}
	})

	t.Run("the worker ignores messages that are not its protocol", func(t *testing.T) {
		rig, waitReturned := runTestWorker(t, domain.EnvLookup{"ZAI_API_KEY": "test-key"})
		workerListeningPort(t, rig.messages)
		rig.say(t, `null`)
		rig.say(t, `{"t":"key"}`)
		rig.say(t, `{"t":"unknown"}`)
		rig.say(t, `{"t":"drain"}`)
		if code := rig.waitExit(t); code != 0 {
			t.Fatalf("drain exit = %d, want 0", code)
		}
		waitReturned()
	})

	t.Run("the watch carries an undo error and a ledger it cannot set aside", func(t *testing.T) {
		root := t.TempDir()
		undoFails := CreateUninstallWatch(UninstallWatchOptions{
			StateRoot: root,
			Actions: UninstallActions{
				Presence: func(Ledger) Presence { return PresenceAbsent },
				Undo:     func(Ledger) error { return errors.New("undo boom") },
				Remove:   func(Ledger, bool) error { return nil },
			},
		})
		if err := WriteLedger(context.Background(), domain.NewStateLayout(root).Ledger, watchLedger(root)); err != nil {
			t.Fatal(err)
		}
		if say, err := undoFails.Tick(); err != nil || say != "stay" {
			t.Fatalf("first tick = %q %v, want stay", say, err)
		}
		if _, err := undoFails.Tick(); err == nil || err.Error() != "undo boom" {
			t.Fatalf("second tick error = %v, want undo boom", err)
		}
		if err := undoFails.Cleanup(); err != nil {
			t.Fatal(err)
		}

		// A directory where ledger.disabled.json would go: the disabled ledger cannot be written.
		blocked := t.TempDir()
		if err := os.MkdirAll(filepath.Join(blocked, "ledger.disabled.json"), 0o755); err != nil {
			t.Fatal(err)
		}
		blockedWatch := CreateUninstallWatch(UninstallWatchOptions{
			StateRoot: blocked,
			Actions: UninstallActions{
				Presence: func(Ledger) Presence { return PresenceDisabled },
				Undo:     func(Ledger) error { return nil },
				Remove:   func(Ledger, bool) error { return nil },
			},
		})
		if err := WriteLedger(context.Background(), domain.NewStateLayout(blocked).Ledger, watchLedger(blocked)); err != nil {
			t.Fatal(err)
		}
		if _, err := blockedWatch.Tick(); err != nil {
			t.Fatal(err)
		}
		if _, err := blockedWatch.Tick(); err == nil {
			t.Fatal("the second tick hid the unwritable disabled ledger")
		}
	})
}
