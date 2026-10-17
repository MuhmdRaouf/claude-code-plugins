// The ensure hook's check: its cases and inputs, with the chaos suite exercising the same check
// end to end.
package router

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

func TestEnsureRouter(t *testing.T) {
	t.Parallel()
	t.Run("does nothing for a plugin never set up, nothing when the router answers health, and starts it when refused", func(t *testing.T) {
		root := t.TempDir()
		port := freeRouterPort(t)
		var started [][]string
		options := EnsureOptions{
			Name:         "acme",
			EnvPrefix:    "ACME",
			Display:      processAcme.Display,
			HealthPath:   processAcme.Router.HealthPath,
			DefaultPort:  1,
			Env:          domain.EnvLookup{"ACME_STATE_DIR": root, "ACME_ROUTER_PORT": strconv.Itoa(port)},
			RouterScript: "/dist/acme-router.js",
			Node:         "/node",
			Start: func(node string, args []string, _ domain.EnvLookup) {
				started = append(started, append([]string{node}, args...))
			},
		}
		if got := EnsureRouter(t.Context(), options); got != EnsureSkipped {
			t.Fatalf("ensureRouter(never set up) = %q, want skipped", got)
		}
		if err := os.WriteFile(filepath.Join(root, "setup-done"), []byte("true\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if got := EnsureRouter(t.Context(), options); got != EnsureStarted {
			t.Fatalf("ensureRouter(setup done, port refused) = %q, want started", got)
		}
		if strings.Join(flatten(started), " ") != "/node /dist/acme-router.js start" {
			t.Fatalf("started = %v, want /node /dist/acme-router.js start", started)
		}
		// "Answering" is our health, not a bare connect: the body must name this plugin's router.
		held := processHold(t, port, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"ok":true,"name":"acme","provider":"Acme Models","mode":"router"}`))
		})
		t.Cleanup(held.close)
		if got := EnsureRouter(t.Context(), options); got != EnsureUp {
			t.Fatalf("ensureRouter(router answering health) = %q, want up", got)
		}
	})

	t.Run("counts a pid record as setup too, and the env port over the default", func(t *testing.T) {
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, "router.pid"), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		var started [][]string
		port := freeRouterPort(t)
		got := EnsureRouter(t.Context(), EnsureOptions{
			Name:         "acme",
			EnvPrefix:    "ACME",
			DefaultPort:  1,
			Env:          domain.EnvLookup{"ACME_STATE_DIR": root, "ACME_ROUTER_PORT": strconv.Itoa(port)},
			RouterScript: "router.js",
			Start: func(node string, args []string, env domain.EnvLookup) {
				started = append(started, append([]string{node}, args...))
			},
		})
		if got != EnsureStarted {
			t.Fatalf("ensureRouter(pid record only) = %q, want started", got)
		}
		// The start carries the caller's whole environment: the router needs whatever Claude
		// Code runs under.
		if len(started) != 1 {
			t.Fatalf("started = %v", started)
		}
	})

	t.Run("starts a real detached process by default, and returns at once", func(t *testing.T) {
		root := t.TempDir()
		if err := os.WriteFile(filepath.Join(root, "router.pid"), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		marker := filepath.Join(root, "ran")
		script := filepath.Join(root, "router.js")
		if err := os.WriteFile(script, []byte("#!/bin/sh\n[ \"$1\" = start ] && printf start > "+marker+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		started := time.Now()
		got := EnsureRouter(t.Context(), EnsureOptions{
			Name:         "acme",
			EnvPrefix:    "ACME",
			DefaultPort:  freeRouterPort(t),
			Env:          domain.EnvLookup{"ACME_STATE_DIR": root, "PATH": os.Getenv("PATH")},
			RouterScript: script,
			Node:         "/bin/sh",
		})
		if got != EnsureStarted {
			t.Fatalf("ensureRouter(real start) = %q, want started", got)
		}
		if elapsed := time.Since(started); elapsed >= time.Second {
			t.Fatalf("ensureRouter waited %v, want it to return at once", elapsed)
		}
		deadline := time.Now().Add(3 * time.Second)
		for {
			if text, err := os.ReadFile(marker); err == nil && string(text) == "start" {
				return
			}
			if time.Now().After(deadline) {
				t.Fatal("the detached router never ran")
			}
			time.Sleep(20 * time.Millisecond)
		}
	})

	t.Run("a hook's world: CLAUDE_PLUGIN_DATA set, state under ~/.agents, and the router comes back for real", func(t *testing.T) {
		root := t.TempDir()
		home := filepath.Join(root, "home")
		state := filepath.Join(home, ".agents", "zai")
		if err := os.MkdirAll(state, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(state, "setup-done"), []byte("true\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		data := filepath.Join(root, "claude", "plugins", "data", "zai-plugin-cc-muhmdraouf")
		if err := os.MkdirAll(data, 0o700); err != nil {
			t.Fatal(err)
		}
		port := freeRouterPort(t)
		env := serviceEnv(t, root, port)
		env["CLAUDE_PLUGIN_DATA"] = data
		// The env key spares the chain the OS keystore: the worker's check reads it first.
		env["ZAI_API_KEY"] = "test-key"
		// The start-child resolves the state root from this environment itself, the way the
		// spawned `router start` does; nothing pins the root for it.
		childEnv := domain.EnvLookup{}
		for name, value := range env {
			childEnv[name] = value
		}
		childEnv[focusChildEnv] = "service"
		childEnv["SERVICE_CHILD_NAME"] = "zai"
		self, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		got := EnsureRouter(t.Context(), EnsureOptions{
			Name:         "zai",
			EnvPrefix:    "ZAI",
			DefaultPort:  port,
			Env:          env,
			RouterScript: "zai-router.js",
			Node:         self,
			Start: func(node string, _ []string, _ domain.EnvLookup) {
				// EnsureEntry's spawn: this binary in its router start mode.
				_ = process.StartDetached(node, []string{"zai", "router", "start"},
					process.DetachedOptions{Env: environOf(childEnv)})
			},
		})
		if got != EnsureStarted {
			t.Fatalf("ensureRouter(a hook's world) = %q, want started", got)
		}
		worker := 0
		t.Cleanup(func() { stopSpawnedService(t, state, port, worker) })
		waitUntil(t, 3*time.Second, func() bool {
			health, err := tryServiceFrontHealth(port)
			return err == nil && health.OK && health.Mode == "router"
		})
		waitUntil(t, 10*time.Second, func() bool {
			health, err := tryServiceFrontHealth(port)
			if err == nil && health.Worker == "up" {
				if health.WorkerPid != nil {
					worker = *health.WorkerPid
				}
				return true
			}
			return false
		})
		waitUntil(t, 5*time.Second, func() bool {
			_, err := os.Stat(filepath.Join(state, "router.pid"))
			return err == nil
		})
		if _, err := os.Stat(filepath.Join(data, "router.pid")); !os.IsNotExist(err) {
			t.Fatalf("the router's pid file landed in the data dir (stat err %v)", err)
		}
	})
}

// stopSpawnedService ends a router the ensure hook's real start left behind: the pid record is
// waited for (the start writes it after the health check), signalled only when its pid is still
// the process the record names — router front or emergency passthrough — and the port and the
// forked worker are waited for within the same bound. Best effort: a chain that never wrote a
// record is left to its own exits.
func stopSpawnedService(t *testing.T, stateRoot string, port, worker int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	var record PidRecord
	for time.Now().Before(deadline) {
		if found, ok := ReadPidFile(context.Background(), stateRoot); ok {
			record = found
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	needle := "router run"
	if record.Mode == PidModeEmergency {
		needle = "passthrough"
	}
	if record.Pid != 0 && testkit.PidMatches(record.Pid, needle, 0) {
		signalPid(record.Pid, "SIGTERM")
	}
	for time.Now().Before(deadline) {
		listener, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err == nil {
			_ = listener.Close()
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if worker != 0 {
		for time.Now().Before(deadline.Add(5*time.Second)) && testkit.IsPidAlive(worker) {
			time.Sleep(50 * time.Millisecond)
		}
	}
}

func flatten(started [][]string) []string {
	var out []string
	for _, call := range started {
		out = append(out, call...)
	}
	return out
}
