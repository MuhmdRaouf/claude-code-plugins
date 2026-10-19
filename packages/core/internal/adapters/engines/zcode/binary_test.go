package zcode

// The desktop-app mapping: zcode on PATH can be a symlink to the GUI executable, whose CLI is the
// bundle's script, and an app-bundled run needs the bundle's built-in provider config named. Every
// bundle here is a fake in a temp directory; nothing on this machine is resolved or started.

import (
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// appBundle builds a desktop app bundle in a temp directory — the GUI executable (a real file, so
// symlinks to it resolve inside the bundle), the CLI script and the built-in provider config — and
// returns the three paths.
func appBundle(t *testing.T) (script, exe, config string) {
	t.Helper()
	root := testkit.TempDir(t, "zcode-bundle-")
	contents := filepath.Join(root, "ZCode.app", "Contents")
	script = filepath.Join(contents, "Resources", "glm", "zcode.cjs")
	exe = filepath.Join(contents, "MacOS", "ZCode")
	config = filepath.Join(contents, "Resources", "config", "provider", "zcode-builtin.json")
	for _, file := range []string{script, config} {
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("// the bundled CLI\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(exe), 0o755); err != nil {
		t.Fatal(err)
	}
	// A real file, executable like the app's Electron binary; the tests that start it overwrite
	// this placeholder with the test binary.
	if err := os.WriteFile(exe, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return script, exe, config
}

// copyTestBinary makes path a real copy of this test binary — a symlink would resolve past the
// bundle layout the mapping looks for.
func copyTestBinary(t *testing.T, path string) {
	t.Helper()
	source, err := os.Open(fakeZcodeBin)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	target, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(target, source); err != nil {
		t.Fatal(err)
	}
	if err := target.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestMapsTheGUIExecutableToTheBundlesCLIScript(t *testing.T) {
	script, exe, _ := appBundle(t)
	if got := CLIScriptFor(exe); got != script {
		t.Fatalf("CLIScriptFor(exe) = %s, want %s", got, script)
	}
	// The zcode on PATH is a symlink to the GUI executable (a Nix install is): the mapping
	// resolves the link and answers the bundle's script.
	binDir := testkit.TempDir(t, "zcode-guipath-")
	link := filepath.Join(binDir, "zcode")
	if err := os.Symlink(exe, link); err != nil {
		t.Fatal(err)
	}
	if got := CLIScriptFor(link); got != script {
		t.Fatalf("CLIScriptFor(symlink) = %s, want %s", got, script)
	}
	// Anything else runs as itself: a bundled script, a link to one, a missing binary.
	if got := CLIScriptFor(script); got != "" {
		t.Fatalf("CLIScriptFor(script) = %s, want none", got)
	}
	other := filepath.Join(binDir, "other.cjs")
	if err := os.WriteFile(other, []byte("// not the bundle\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	otherLink := filepath.Join(binDir, "linked.cjs")
	if err := os.Symlink(other, otherLink); err != nil {
		t.Fatal(err)
	}
	if got := CLIScriptFor(otherLink); got != "" {
		t.Fatalf("CLIScriptFor(other link) = %s, want none", got)
	}
	if got := CLIScriptFor(filepath.Join(binDir, "missing")); got != "" {
		t.Fatalf("CLIScriptFor(missing) = %s, want none", got)
	}
	// A GUI executable with no script beside it has no CLI to map to.
	if err := os.Remove(script); err != nil {
		t.Fatal(err)
	}
	if got := CLIScriptFor(exe); got != "" {
		t.Fatalf("CLIScriptFor(exe without script) = %s, want none", got)
	}
}

func TestNamesTheBundlesBuiltinProviderConfig(t *testing.T) {
	script, exe, config := appBundle(t)
	if got := BuiltinProviderConfig(script); got != config {
		t.Fatalf("BuiltinProviderConfig(script) = %s, want %s", got, config)
	}
	// No config in the bundle: nothing to name.
	if err := os.Remove(config); err != nil {
		t.Fatal(err)
	}
	if got := BuiltinProviderConfig(script); got != "" {
		t.Fatalf("BuiltinProviderConfig(script without config) = %s, want none", got)
	}
	// A script outside an app bundle has no bundle to take a config from, and the GUI executable
	// is not a script.
	plain := filepath.Join(testkit.TempDir(t, "zcode-plain-"), "zcode.cjs")
	if err := os.WriteFile(plain, []byte("// not bundled\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := BuiltinProviderConfig(plain); got != "" {
		t.Fatalf("BuiltinProviderConfig(plain script) = %s, want none", got)
	}
	if got := BuiltinProviderConfig(exe); got != "" {
		t.Fatalf("BuiltinProviderConfig(exe) = %s, want none", got)
	}
}
