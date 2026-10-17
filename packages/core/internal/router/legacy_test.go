// The legacy-service retirement: commands are recorded, never run.
package router

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// legacyHome is a home directory with the named legacy service installed ("none" for a clean one).
func legacyHome(t *testing.T, kind string) string {
	t.Helper()
	dir := t.TempDir()
	switch kind {
	case "launchd":
		agents := filepath.Join(dir, "Library", "LaunchAgents")
		if err := os.MkdirAll(agents, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(agents, "test.acme-router.plist"), []byte("<plist/>"), 0o600); err != nil {
			t.Fatal(err)
		}
	case "systemd":
		user := filepath.Join(dir, ".config", "systemd", "user")
		if err := os.MkdirAll(user, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(user, "test.acme-router.service"), []byte("[Unit]"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// recordingRunner records every command as "bin arg arg" and reports success.
func recordingRunner(calls *[]string) CommandRunner {
	return func(bin string, args []string) bool {
		*calls = append(*calls, bin+" "+strings.Join(args, " "))
		return true
	}
}

func TestFindLegacyService(t *testing.T) {
	t.Parallel()
	t.Run("finds nothing where nothing was installed", func(t *testing.T) {
		if _, ok := FindLegacyService("test.acme-router", legacyHome(t, "none")); ok {
			t.Fatal("findLegacyService(clean home) found a service")
		}
	})
}

func TestMigrateLegacyService(t *testing.T) {
	t.Parallel()
	t.Run("stops the LaunchAgent, starts the new router, and only then removes the plist", func(t *testing.T) {
		dir := legacyHome(t, "launchd")
		service, ok := FindLegacyService("test.acme-router", dir)
		if !ok || service.Kind != LegacyLaunchd {
			t.Fatalf("findLegacyService = %+v (found %v), want a launchd service", service, ok)
		}
		var calls []string
		result := MigrateLegacyService(
			context.Background(),
			service,
			recordingRunner(&calls),
			func(context.Context) bool {
				calls = append(calls, "start new")
				if _, err := os.Stat(service.Definition); err != nil {
					t.Errorf("the new router started after the plist had been removed: %v", err)
				}
				return true
			},
			501,
		)
		want := []string{"launchctl bootout gui/501/test.acme-router", "start new"}
		if !slices.Equal(calls, want) {
			t.Fatalf("commands = %q, want %q", calls, want)
		}
		if !result.Migrated {
			t.Fatalf("migrated = false, line %q", result.Line)
		}
		if !strings.Contains(result.Line, "replaced the old launchd service") {
			t.Fatalf("line = %q, want it to say the service was replaced", result.Line)
		}
		if _, err := os.Stat(service.Definition); !os.IsNotExist(err) {
			t.Fatalf("the plist survived the migration: %v", err)
		}
	})

	t.Run("leaves the old systemd unit running when the new router does not come up", func(t *testing.T) {
		dir := legacyHome(t, "systemd")
		service, ok := FindLegacyService("test.acme-router", dir)
		if !ok {
			t.Fatal("findLegacyService(systemd home) found nothing")
		}
		var calls []string
		run := recordingRunner(&calls)
		kept := MigrateLegacyService(context.Background(), service, run, func(context.Context) bool { return false }, 1000)
		if kept.Migrated {
			t.Fatalf("migrated = true, line %q", kept.Line)
		}
		wantKept := []string{
			"systemctl --user stop test.acme-router.service",
			"systemctl --user start test.acme-router.service",
		}
		if !slices.Equal(calls, wantKept) {
			t.Fatalf("commands = %q, want %q", calls, wantKept)
		}
		if _, err := os.Stat(service.Definition); err != nil {
			t.Fatalf("the unit file was removed though the new router did not come up: %v", err)
		}

		calls = nil
		replaced := MigrateLegacyService(context.Background(), service, run, func(context.Context) bool { return true }, 1000)
		if !replaced.Migrated {
			t.Fatalf("migrated = false, line %q", replaced.Line)
		}
		wantReplaced := []string{
			"systemctl --user stop test.acme-router.service",
			"systemctl --user disable --now test.acme-router.service",
			"systemctl --user daemon-reload",
		}
		if !slices.Equal(calls, wantReplaced) {
			t.Fatalf("commands = %q, want %q", calls, wantReplaced)
		}
		if _, err := os.Stat(service.Definition); !os.IsNotExist(err) {
			t.Fatalf("the unit file survived the migration: %v", err)
		}
	})

	t.Run("restarts a LaunchAgent the new router could not replace", func(t *testing.T) {
		service, ok := FindLegacyService("test.acme-router", legacyHome(t, "launchd"))
		if !ok {
			t.Fatal("findLegacyService(launchd home) found nothing")
		}
		var calls []string
		MigrateLegacyService(
			context.Background(),
			service,
			recordingRunner(&calls),
			func(context.Context) bool { return false },
			7,
		)
		want := []string{
			"launchctl bootout gui/7/test.acme-router",
			"launchctl bootstrap gui/7 " + service.Definition,
		}
		if !slices.Equal(calls, want) {
			t.Fatalf("commands = %q, want %q", calls, want)
		}
	})
}
