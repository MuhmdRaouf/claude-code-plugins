// The one-time migration off the OS services an earlier release installed (a LaunchAgent on macOS,
// a systemd --user unit on Linux). This is the only file that names those tools. Order is
// everything: the old service is stopped, the new plugin-started router is started on the same port
// in the same call, and only once the new one answers health is the old definition removed. If the
// new router does not come up, the old service is started again and left alone, and the line says
// so. Every command goes through an injected runner; tests never run one.
package router

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// CommandRunner runs one command; true on exit 0.
type CommandRunner func(bin string, args []string) bool

// LegacyKind is which OS service an earlier release installed: a LaunchAgent or a systemd --user
// unit.
type LegacyKind string

const (
	LegacyLaunchd LegacyKind = "launchd"
	LegacySystemd LegacyKind = "systemd"
)

// LegacyService is the legacy service definition that is still on disk.
type LegacyService struct {
	Kind LegacyKind
	// Definition is the plist or unit file.
	Definition string
	Label      string
}

// FindLegacyService is the legacy service definition for this label under the home directory, if
// one is still on disk.
func FindLegacyService(label, home string) (LegacyService, bool) {
	plist := filepath.Join(home, "Library", "LaunchAgents", label+".plist")
	if _, err := os.Stat(plist); err == nil {
		return LegacyService{Kind: LegacyLaunchd, Definition: plist, Label: label}, true
	}
	unit := filepath.Join(home, ".config", "systemd", "user", label+".service")
	if _, err := os.Stat(unit); err == nil {
		return LegacyService{Kind: LegacySystemd, Definition: unit, Label: label}, true
	}
	return LegacyService{}, false
}

// MigrationResult is what one migration attempt ended with.
type MigrationResult struct {
	// Migrated is true once the old service is gone and the new router holds the port.
	Migrated bool
	Line     string
}

// MigrateLegacyService replaces the legacy service with the plugin-started router, never leaving
// the port without one for longer than the start takes. startNew starts the new router and reports
// true once it answers health.
func MigrateLegacyService(
	ctx context.Context,
	service LegacyService,
	run CommandRunner,
	startNew func(context.Context) bool,
	uid int64,
) MigrationResult {
	domain := fmt.Sprintf("gui/%d", uid)
	unit := service.Label + ".service"
	if service.Kind == LegacyLaunchd {
		run("launchctl", []string{"bootout", domain + "/" + service.Label})
	} else {
		run("systemctl", []string{"--user", "stop", unit})
	}
	if !startNew(ctx) {
		if service.Kind == LegacyLaunchd {
			run("launchctl", []string{"bootstrap", domain, service.Definition})
		} else {
			run("systemctl", []string{"--user", "start", unit})
		}
		return MigrationResult{
			Migrated: false,
			Line:     fmt.Sprintf("kept the old %s service %s: the new router did not come up", service.Kind, service.Label),
		}
	}
	if service.Kind == LegacySystemd {
		run("systemctl", []string{"--user", "disable", "--now", unit})
	}
	_ = os.Remove(service.Definition)
	if service.Kind == LegacySystemd {
		run("systemctl", []string{"--user", "daemon-reload"})
	}
	return MigrationResult{
		Migrated: true,
		Line:     fmt.Sprintf("replaced the old %s service %s with the plugin's router", service.Kind, service.Label),
	}
}
