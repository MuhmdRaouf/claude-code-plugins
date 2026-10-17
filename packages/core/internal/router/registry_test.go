// The peer registry's cases. The parseEntry and health-check arms get direct cases here.
package router

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// registryEntry builds kimi's announcement, overridden field by field.
func registryEntry(over func(*RegisteredRouter)) RegisteredRouter {
	t := RegisteredRouter{
		Name:          "kimi",
		Port:          18788,
		ModelPrefixes: []string{"kimi-"},
		CatalogIds:    []string{"kimi-k3", "kimi-k2.6"},
		UpdatedAt:     "2026-10-07T00:00:00.000Z",
	}
	if over != nil {
		over(&t)
	}
	return t
}

// registryHome is a registry home under a temp root, as every test env pins with
// PROVIDER_ROUTERS_HOME.
func registryHome(t *testing.T) (root string, env domain.EnvLookup) {
	t.Helper()
	root = t.TempDir()
	return root, domain.EnvLookup{
		"HOME":                  filepath.Join(root, "home"),
		"PROVIDER_ROUTERS_HOME": filepath.Join(root, "routers"),
	}
}

func mustSaveEntry(t *testing.T, env domain.EnvLookup, entry RegisteredRouter) {
	t.Helper()
	if err := SaveRegistryEntry(t.Context(), env, entry); err != nil {
		t.Fatalf("saveRegistryEntry(%s): %v", entry.Name, err)
	}
}

func TestRoutersHome(t *testing.T) {
	t.Parallel()
	t.Run("takes PROVIDER_ROUTERS_HOME over ~/.agents", func(t *testing.T) {
		if got := RoutersHome(domain.EnvLookup{"PROVIDER_ROUTERS_HOME": "/pin", "HOME": "/home"}, nil); got != "/pin" {
			t.Fatalf("routersHome(pin) = %q, want /pin", got)
		}
		if got := RoutersHome(domain.EnvLookup{"HOME": "/home"}, nil); got != filepath.Join("/home", ".agents", "provider-routers") {
			t.Fatalf("routersHome(home) = %q, want %s", got, filepath.Join("/home", ".agents", "provider-routers"))
		}
	})
}

func TestRegistryFiles(t *testing.T) {
	t.Parallel()
	t.Run("writes one file per plugin and reads them back sorted by name", func(t *testing.T) {
		_, env := registryHome(t)

		mustSaveEntry(t, env, registryEntry(func(e *RegisteredRouter) {
			e.Name = "zai"
			e.Port = 18787
			e.CatalogIds = []string{"glm-5.3"}
		}))
		mustSaveEntry(t, env, registryEntry(nil))

		entries := ReadRegistry(env)
		var names []string
		for _, entry := range entries {
			names = append(names, entry.Name)
		}
		if strings.Join(names, ",") != "kimi,zai" {
			t.Fatalf("registry names = %v, want [kimi zai]", names)
		}
		var kimi *RegisteredRouter
		for i, entry := range entries {
			if entry.Name == "kimi" {
				kimi = &entries[i]
			}
		}
		if kimi == nil {
			t.Fatal("no kimi entry")
		}
		if kimi.Port != 18788 || strings.Join(kimi.ModelPrefixes, ",") != "kimi-" ||
			strings.Join(kimi.CatalogIds, ",") != "kimi-k3,kimi-k2.6" {
			t.Fatalf("kimi entry = %+v", *kimi)
		}
		if kimi.Pid != nil {
			t.Fatalf("kimi entry carries pid %d, want none", *kimi.Pid)
		}
	})

	t.Run("keeps the recorded pid when a new entry carries none (setup writes without one)", func(t *testing.T) {
		_, env := registryHome(t)
		pid := int64(4242)
		mustSaveEntry(t, env, registryEntry(func(e *RegisteredRouter) { e.Pid = &pid }))

		mustSaveEntry(t, env, registryEntry(nil))
		if entry, ok := findEntry(ReadRegistry(env), "kimi"); !ok || entry.Pid == nil || *entry.Pid != 4242 {
			t.Fatalf("kimi pid after a pid-less save = %v, want the recorded 4242", entry.Pid)
		}
		replacement := int64(99)
		mustSaveEntry(t, env, registryEntry(func(e *RegisteredRouter) { e.Pid = &replacement }))
		if entry, ok := findEntry(ReadRegistry(env), "kimi"); !ok || entry.Pid == nil || *entry.Pid != 99 {
			t.Fatalf("kimi pid after a carrying save = %v, want 99", entry.Pid)
		}
	})

	t.Run("skips unreadable or malformed files, and an absent dir reads as empty", func(t *testing.T) {
		root, env := registryHome(t)
		if entries := ReadRegistry(env); len(entries) != 0 {
			t.Fatalf("an absent dir read as %v, want empty", entries)
		}

		dir := RoutersHome(env, nil)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "garbage.json"), []byte("{ not json"), 0o600); err != nil {
			t.Fatal(err)
		}
		half := `{"name":"half","port":"nope"}`
		if err := os.WriteFile(filepath.Join(dir, "half.json"), []byte(half), 0o600); err != nil {
			t.Fatal(err)
		}
		// A directory ending in .json: unreadable, skipped too.
		if err := os.MkdirAll(filepath.Join(dir, "nested.json"), 0o700); err != nil {
			t.Fatal(err)
		}

		if entries := ReadRegistry(env); len(entries) != 0 {
			t.Fatalf("a dir of junk read as %v, want empty", entries)
		}
		if _, err := os.Stat(filepath.Join(root, "routers", "half.json")); err != nil {
			t.Fatalf("half.json did not survive: %v", err)
		}
	})

	t.Run("removes one plugin's entry; a missing entry is fine", func(t *testing.T) {
		_, env := registryHome(t)
		mustSaveEntry(t, env, registryEntry(nil))

		RemoveRegistryEntry(env, "kimi")
		RemoveRegistryEntry(env, "kimi")

		if entries := ReadRegistry(env); len(entries) != 0 {
			t.Fatalf("the registry still holds %v", entries)
		}
	})
}

func TestEntryClaim(t *testing.T) {
	t.Parallel()
	t.Run("claims catalog ids and prefixed ids, never another plugin's", func(t *testing.T) {
		kimi := registryEntry(nil)
		claim := EntryClaim(kimi)
		for _, model := range []string{"kimi-k3", "kimi-future-9"} {
			if !domain.Claims(claim, model) {
				t.Fatalf("claims(%q) = false, want true", model)
			}
		}
		for _, model := range []string{"glm-5.3", "claude-sonnet-5-5"} {
			if domain.Claims(claim, model) {
				t.Fatalf("claims(%q) = true, want false", model)
			}
		}
	})
}

func TestCreatePeerLookup(t *testing.T) {
	t.Parallel()
	t.Run("finds the peer that serves a model, never itself", func(t *testing.T) {
		_, env := registryHome(t)
		mustSaveEntry(t, env, registryEntry(nil))

		lookup := CreatePeerLookup(env, "zai", nil)
		if peer, ok := lookup("kimi-k3"); !ok || peer != (PeerTarget{Name: "kimi", Port: 18788}) {
			t.Fatalf("lookup(kimi-k3) = %+v (%v), want kimi on 18788", peer, ok)
		}
		for _, model := range []string{"glm-5.3", "claude-sonnet-5-5"} {
			if _, ok := lookup(model); ok {
				t.Fatalf("lookup(%q) found a peer, want none", model)
			}
		}

		selfLookup := CreatePeerLookup(env, "kimi", nil)
		if _, ok := selfLookup("kimi-k3"); ok {
			t.Fatal("the lookup answered with the plugin's own router")
		}
	})

	t.Run("re-reads the registry at most every 5 s", func(t *testing.T) {
		_, env := registryHome(t)
		mustSaveEntry(t, env, registryEntry(nil))
		now := int64(1_000_000)
		lookup := CreatePeerLookup(env, "zai", func() int64 { return now })
		if peer, ok := lookup("kimi-k3"); !ok || peer.Name != "kimi" {
			t.Fatalf("lookup(kimi-k3) = %+v (%v), want kimi", peer, ok)
		}

		mustSaveEntry(t, env, registryEntry(func(e *RegisteredRouter) {
			e.Name = "deepseek"
			e.Port = 18789
			e.ModelPrefixes = []string{"deepseek-"}
		}))
		if _, ok := lookup("deepseek-v4-pro"); ok {
			t.Fatal("the lookup re-read the registry before 5 s passed")
		}

		now += 5000
		if peer, ok := lookup("deepseek-v4-pro"); !ok || peer != (PeerTarget{Name: "deepseek", Port: 18789}) {
			t.Fatalf("lookup(deepseek-v4-pro) = %+v (%v), want deepseek on 18789", peer, ok)
		}
	})
}

func TestLiveRouters(t *testing.T) {
	t.Parallel()
	t.Run("keeps only the entries whose router answers, minus this plugin's own", func(t *testing.T) {
		_, env := registryHome(t)
		mustSaveEntry(t, env, registryEntry(func(e *RegisteredRouter) { e.Port = 18788 }))
		mustSaveEntry(t, env, registryEntry(func(e *RegisteredRouter) {
			e.Name = "deepseek"
			e.Port = 18789
		}))
		mustSaveEntry(t, env, registryEntry(func(e *RegisteredRouter) {
			e.Name = "zai"
			e.Port = 18787
		}))

		living := LiveRouters(t.Context(), env, "zai", func(_ context.Context, candidate RegisteredRouter) bool {
			return candidate.Port == 18789
		})

		var names []string
		for _, entry := range living {
			names = append(names, entry.Name)
		}
		if strings.Join(names, ",") != "deepseek" {
			t.Fatalf("live routers = %v, want [deepseek]", names)
		}
	})

	t.Run("health-checks the entries itself: a router that is down is not live", func(t *testing.T) {
		_, env := registryHome(t)
		mustSaveEntry(t, env, registryEntry(func(e *RegisteredRouter) { e.Port = 1 })) // nothing answers on loopback port 1

		if living := LiveRouters(t.Context(), env, "zai", nil); len(living) != 0 {
			t.Fatalf("a router that is down counted as live: %v", living)
		}
	})

	t.Run("a peer that answers its health with its own name is live", func(t *testing.T) {
		// The uninstall flow covers this arm too; here it gets its own case.
		var asked []string
		peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			asked = append(asked, r.URL.Path)
			fmt.Fprintf(w, `{"ok":true,"name":"kimi"}`)
		}))
		defer peer.Close()
		_, env := registryHome(t)
		mustSaveEntry(t, env, registryEntry(func(e *RegisteredRouter) {
			e.Port = portOfURL(t, peer.URL)
		}))

		living := LiveRouters(t.Context(), env, "zai", nil)

		if len(living) != 1 || living[0].Name != "kimi" {
			t.Fatalf("live routers = %v, want [kimi]", living)
		}
		if len(asked) != 1 || asked[0] != "/kimi-router/health" {
			t.Fatalf("health paths asked = %v, want the peer's own health path once", asked)
		}
	})

	t.Run("a peer whose health names another plugin is not live", func(t *testing.T) {
		peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			fmt.Fprint(w, `{"ok":true,"name":"deepseek"}`)
		}))
		defer peer.Close()
		_, env := registryHome(t)
		mustSaveEntry(t, env, registryEntry(func(e *RegisteredRouter) {
			e.Port = portOfURL(t, peer.URL)
		}))

		if living := LiveRouters(t.Context(), env, "zai", nil); len(living) != 0 {
			t.Fatalf("a health answer naming another plugin counted as live: %v", living)
		}
	})

	t.Run("a peer that answers anything but a 2xx or JSON is not live", func(t *testing.T) {
		for name, answer := range map[string]struct {
			status int
			body   string
		}{
			"a 404":        {404, `{"ok":true,"name":"kimi"}`},
			"not JSON":     {200, `ok`},
			"ok a string":  {200, `{"ok":"yes","name":"kimi"}`},
			"ok not named": {200, `{"ok":true}`},
		} {
			peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(answer.status)
				fmt.Fprint(w, answer.body)
			}))
			_, env := registryHome(t)
			mustSaveEntry(t, env, registryEntry(func(e *RegisteredRouter) { e.Port = portOfURL(t, peer.URL) }))
			if living := LiveRouters(t.Context(), env, "zai", nil); len(living) != 0 {
				peer.Close()
				t.Fatalf("%s counted as live: %v", name, living)
			}
			peer.Close()
		}
	})
}

// stderrLog is the default log RoutersHome falls back to; it writes the line to stderr, the way
// console.error does.
// TestStderrLog stays serial: it swaps the process-wide os.Stderr for a pipe.
func TestStderrLog(t *testing.T) {
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	saved := os.Stderr
	os.Stderr = writer
	stderrLog("state migrate: a line")
	os.Stderr = saved
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	text, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if string(text) != "state migrate: a line\n" {
		t.Fatalf("stderrLog wrote %q", text)
	}
}

func TestThePortMap(t *testing.T) {
	t.Parallel()
	t.Run("knows every plugin's router port, and reads ports out of URLs", func(t *testing.T) {
		if got := domain.PluginRouters[18787]; got != "zai" {
			t.Fatalf("PLUGIN_ROUTERS.get(18787) = %q, want zai", got)
		}
		if got := domain.PluginRouters[18791]; got != "qwen" {
			t.Fatalf("PLUGIN_ROUTERS.get(18791) = %q, want qwen", got)
		}
		if len(domain.PluginRouters) != 5 {
			t.Fatalf("PLUGIN_ROUTERS holds %d plugins, want 5", len(domain.PluginRouters))
		}
		if got := domain.PortOf("http://127.0.0.1:18788/health"); got != 18788 {
			t.Fatalf("portOf(health URL) = %d, want 18788", got)
		}
		if got := domain.PortOf("http://localhost/x"); got != -1 {
			t.Fatalf("portOf(no port) = %d, want -1", got)
		}
		if got := domain.PortOf("not a url"); got != -1 {
			t.Fatalf("portOf(junk) = %d, want -1", got)
		}
	})
}

// The entry parse, direct (readRegistry's skip case drives it too).
func TestParseEntry(t *testing.T) {
	t.Parallel()
	kept := func(pid string) string {
		return `{"name":"kimi","port":18788,"modelPrefixes":["kimi-"],"catalogIds":["kimi-k3"],"updatedAt":"t"` + pid + "}"
	}
	t.Run("keeps a valid entry and drops extra keys", func(t *testing.T) {
		entry, ok := parseEntry(kept(`,"extra":"dropped","pid":4242`))
		if !ok {
			t.Fatal("a valid entry was discarded")
		}
		if entry.Name != "kimi" || entry.Port != 18788 || entry.Pid == nil || *entry.Pid != 4242 {
			t.Fatalf("entry = %+v", entry)
		}
	})
	t.Run("a missing or mistyped field discards the entry", func(t *testing.T) {
		for name, text := range map[string]string{
			"no name":         `{"port":1,"modelPrefixes":[],"catalogIds":[],"updatedAt":"t"}`,
			"port a string":   `{"name":"k","port":"1","modelPrefixes":[],"catalogIds":[],"updatedAt":"t"}`,
			"no updatedAt":    `{"name":"k","port":1,"modelPrefixes":[],"catalogIds":[]}`,
			"prefix a string": `{"name":"k","port":1,"modelPrefixes":"kimi-","catalogIds":[],"updatedAt":"t"}`,
			"ids not array":   `{"name":"k","port":1,"modelPrefixes":[],"catalogIds":"kimi","updatedAt":"t"}`,
			"pid a string":    kept(`,"pid":"12"`),
			"pid null":        kept(`,"pid":null`),
			"pid a bool":      kept(`,"pid":true`),
			"not an object":   `["kimi"]`,
			"trailing junk":   kept("") + " {}",
		} {
			if entry, ok := parseEntry(text); ok {
				t.Fatalf("%s: parseEntry kept %+v", name, entry)
			}
		}
	})
	t.Run("an entry without a pid reads back with none", func(t *testing.T) {
		if entry, ok := parseEntry(kept("")); !ok || entry.Pid != nil {
			t.Fatalf("parseEntry(no pid) = %+v (%v)", entry, ok)
		}
	})
}

// The written entry: the file's own bytes, the ones every router build writes.
func TestSaveRegistryEntryFile(t *testing.T) {
	t.Parallel()
	t.Run("writes the entry, an inherited pid last", func(t *testing.T) {
		root, env := registryHome(t)
		pid := int64(4242)
		mustSaveEntry(t, env, registryEntry(func(e *RegisteredRouter) { e.Pid = &pid }))
		own := filepath.Join(root, "routers", "kimi.json")
		assertFileText(t, own, `{
  "name": "kimi",
  "port": 18788,
  "modelPrefixes": [
    "kimi-"
  ],
  "catalogIds": [
    "kimi-k3",
    "kimi-k2.6"
  ],
  "pid": 4242,
  "updatedAt": "2026-10-07T00:00:00.000Z"
}
`)

		mustSaveEntry(t, env, registryEntry(nil))
		assertFileText(t, own, `{
  "name": "kimi",
  "port": 18788,
  "modelPrefixes": [
    "kimi-"
  ],
  "catalogIds": [
    "kimi-k3",
    "kimi-k2.6"
  ],
  "updatedAt": "2026-10-07T00:00:00.000Z",
  "pid": 4242
}
`)
		info, err := os.Stat(own)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("entry mode = %o, want 600", info.Mode().Perm())
		}
	})

	t.Run("writes empty model lists as empty arrays, never null", func(t *testing.T) {
		root, env := registryHome(t)
		mustSaveEntry(t, env, registryEntry(func(e *RegisteredRouter) {
			e.ModelPrefixes = nil
			e.CatalogIds = nil
		}))
		text, err := os.ReadFile(filepath.Join(root, "routers", "kimi.json"))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(text), "null") {
			t.Fatalf("entry wrote a null list: %s", text)
		}
	})
}

func findEntry(entries []RegisteredRouter, name string) (RegisteredRouter, bool) {
	for _, entry := range entries {
		if entry.Name == name {
			return entry, true
		}
	}
	return RegisteredRouter{}, false
}

func portOfURL(t *testing.T, raw string) int64 {
	t.Helper()
	port := domain.PortOf(raw)
	if port < 0 {
		t.Fatalf("portOf(%q) = %d", raw, port)
	}
	return port
}

func assertFileText(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != want {
		t.Fatalf("%s =\n%s; want\n%s", path, got, want)
	}
}

// The 5 s re-read boundary itself, at its edges.
func TestCreatePeerLookupRereadBoundary(t *testing.T) {
	t.Parallel()
	_, env := registryHome(t)
	now := int64(500)
	lookup := CreatePeerLookup(env, "zai", func() int64 { return now })
	if _, ok := lookup("kimi-k3"); ok {
		t.Fatal("an empty registry answered")
	}
	mustSaveEntry(t, env, registryEntry(nil))
	now += 4999
	if _, ok := lookup("kimi-k3"); ok {
		t.Fatal("the registry was re-read a millisecond early")
	}
	now++
	if _, ok := lookup("kimi-k3"); !ok {
		t.Fatal("the registry was not re-read after 5 s")
	}
}

// The health check's own timeout: a peer that never answers is not live either. The server below
// accepts the connection and stalls, so the 500 ms budget is the only way this test passes.
func TestLiveRoutersHealthTimeout(t *testing.T) {
	t.Parallel()
	if testing.Short() {
		t.Skip("waits out the health check's 500 ms budget")
	}
	stalled := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(2 * time.Second)
		fmt.Fprint(w, `{"ok":true,"name":"kimi"}`)
	}))
	defer stalled.Close()
	_, env := registryHome(t)
	mustSaveEntry(t, env, registryEntry(func(e *RegisteredRouter) {
		e.Port = portOfURL(t, stalled.URL)
	}))

	before := time.Now()
	living := LiveRouters(t.Context(), env, "zai", nil)
	if len(living) != 0 {
		t.Fatalf("a stalling router counted as live: %v", living)
	}
	if elapsed := time.Since(before); elapsed > 1500*time.Millisecond {
		t.Fatalf("the health check waited %v, want the 500 ms budget", elapsed)
	}
}
