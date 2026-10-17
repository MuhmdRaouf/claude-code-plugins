package main

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestParseVersion(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    string
		wantErr bool
	}{
		{"valid", "0.1.0", "0.1.0", false},
		{"trailing newline", "0.2.1\n", "0.2.1", false},
		{"surrounding whitespace", "  1.2.3\t\n", "1.2.3", false},
		{"two components", "0.1", "", true},
		{"four components", "0.1.0.0", "", true},
		{"prerelease suffix", "0.1.0-rc1", "", true},
		{"leading v", "v0.1.0", "", true},
		{"non numeric patch", "0.1.x", "", true},
		{"empty", "", "", true},
		{"whitespace only", " \n", "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseVersion(tt.content)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("parseVersion(%q) = %q, want an error", tt.content, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseVersion(%q) failed: %v", tt.content, err)
			}
			if got != tt.want {
				t.Errorf("parseVersion(%q) = %q, want %q", tt.content, got, tt.want)
			}
		})
	}
}

// goldenAssets is a fixed fake build result: every target, one digest per
// target in release order, so a wrong order shows up in the goldens.
func goldenAssets() []builtAsset {
	return []builtAsset{
		{Target: target{OS: "darwin", Arch: "amd64"}, Name: "plugin-core-darwin-amd64", SHA256: "aa", Size: 1024},
		{Target: target{OS: "darwin", Arch: "arm64"}, Name: "plugin-core-darwin-arm64", SHA256: "bb", Size: 2048},
		{Target: target{OS: "linux", Arch: "amd64"}, Name: "plugin-core-linux-amd64", SHA256: "cc", Size: 3072},
		{Target: target{OS: "linux", Arch: "arm64"}, Name: "plugin-core-linux-arm64", SHA256: "dd", Size: 4096},
	}
}

func TestTargets(t *testing.T) {
	want := []struct {
		key   string
		asset string
	}{
		{"darwin-amd64", "plugin-core-darwin-amd64"},
		{"darwin-arm64", "plugin-core-darwin-arm64"},
		{"linux-amd64", "plugin-core-linux-amd64"},
		{"linux-arm64", "plugin-core-linux-arm64"},
	}
	if len(targets) != len(want) {
		t.Fatalf("targets has %d entries, want %d", len(targets), len(want))
	}
	for i, tt := range want {
		if got := targets[i].key(); got != tt.key {
			t.Errorf("targets[%d].key() = %q, want %q", i, got, tt.key)
		}
		if got := targets[i].asset("plugin-core"); got != tt.asset {
			t.Errorf("targets[%d].asset() = %q, want %q", i, got, tt.asset)
		}
	}
}

func TestBinaryByName(t *testing.T) {
	for _, name := range []string{"plugin-core"} {
		bin, ok := binaryByName(name)
		if !ok {
			t.Errorf("binaryByName(%q) not found", name)
			continue
		}
		if bin.name != name {
			t.Errorf("binaryByName(%q).name = %q", name, bin.name)
		}
	}
	if _, ok := binaryByName("zai"); ok {
		t.Error("binaryByName(\"zai\") found, want only plugin-core")
	}
}

func TestBinaryPaths(t *testing.T) {
	root := filepath.Join(t.TempDir(), "repo", "packages", "core")
	tests := []struct {
		bin          string
		versionFile  string
		manifestPath string
	}{
		{"plugin-core", "VERSION", filepath.Join("release", "v0.0.1.json")},
	}
	for _, tt := range tests {
		t.Run(tt.bin, func(t *testing.T) {
			bin, ok := binaryByName(tt.bin)
			if !ok {
				t.Fatalf("binaryByName(%q) not found", tt.bin)
			}
			if got, want := bin.versionFile, tt.versionFile; got != want {
				t.Errorf("versionFile = %q, want %q", got, want)
			}
			if got, want := bin.manifestPath(root, "0.0.1"), filepath.Join(root, tt.manifestPath); got != want {
				t.Errorf("manifestPath() = %q, want %q", got, want)
			}
		})
	}
}

func TestSelectTargets(t *testing.T) {
	if got := selectTargets(nil); !reflect.DeepEqual(got, targets) {
		t.Errorf("selectTargets(nil) = %v, want every target", got)
	}
	got := selectTargets([]string{"linux/arm64", "linux/amd64", "linux/arm64"})
	want := []target{{OS: "linux", Arch: "amd64"}, {OS: "linux", Arch: "arm64"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("selectTargets() = %v, want %v (release order, deduplicated)", got, want)
	}
}

func TestSHA256SUMS(t *testing.T) {
	want := "aa  plugin-core-darwin-amd64\n" +
		"bb  plugin-core-darwin-arm64\n" +
		"cc  plugin-core-linux-amd64\n" +
		"dd  plugin-core-linux-arm64\n"
	assets := goldenAssets()
	reversed := make([]builtAsset, 0, len(assets))
	for i := len(assets) - 1; i >= 0; i-- {
		reversed = append(reversed, assets[i])
	}
	for _, list := range [][]builtAsset{assets, reversed} {
		if got := string(sha256sums(list)); got != want {
			t.Errorf("sha256sums() = %q, want %q", got, want)
		}
	}
}

func TestManifestJSON(t *testing.T) {
	want := `{
  "version": "0.1.0",
  "tag": "v0.1.0",
  "assets": {
    "darwin-amd64": {
      "name": "plugin-core-darwin-amd64",
      "sha256": "aa",
      "size": 1024
    },
    "darwin-arm64": {
      "name": "plugin-core-darwin-arm64",
      "sha256": "bb",
      "size": 2048
    },
    "linux-amd64": {
      "name": "plugin-core-linux-amd64",
      "sha256": "cc",
      "size": 3072
    },
    "linux-arm64": {
      "name": "plugin-core-linux-arm64",
      "sha256": "dd",
      "size": 4096
    }
  }
}
`
	data, err := manifestBytes(buildManifest(pluginCore(t), "0.1.0", goldenAssets()))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != want {
		t.Errorf("manifest bytes =\n%s\nwant\n%s", data, want)
	}
}

func TestPartialTargetManifestJSON(t *testing.T) {
	want := `{
  "version": "0.0.1",
  "tag": "v0.0.1",
  "assets": {
    "darwin-amd64": {
      "name": "plugin-core-darwin-amd64",
      "sha256": "aa",
      "size": 1024
    },
    "linux-arm64": {
      "name": "plugin-core-linux-arm64",
      "sha256": "ff",
      "size": 6144
    }
  }
}
`
	assets := []builtAsset{
		{Target: target{OS: "darwin", Arch: "amd64"}, Name: "plugin-core-darwin-amd64", SHA256: "aa", Size: 1024},
		{Target: target{OS: "linux", Arch: "arm64"}, Name: "plugin-core-linux-arm64", SHA256: "ff", Size: 6144},
	}
	data, err := manifestBytes(buildManifest(pluginCore(t), "0.0.1", assets))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != want {
		t.Errorf("manifest bytes =\n%s\nwant\n%s", data, want)
	}
}

// pluginCore is the plugin-core binary spec, the -bin default.
func pluginCore(t *testing.T) binary {
	t.Helper()
	bin, ok := binaryByName("plugin-core")
	if !ok {
		t.Fatal("plugin-core binary not found")
	}
	return bin
}

func TestCompareLines(t *testing.T) {
	linux := builtAsset{Target: target{OS: "linux", Arch: "amd64"}, Name: "plugin-core-linux-amd64", SHA256: "zz", Size: 1}
	darwin := builtAsset{Target: target{OS: "darwin", Arch: "arm64"}, Name: "plugin-core-darwin-arm64", SHA256: "ee", Size: 2}
	assets := []builtAsset{linux, darwin}

	t.Run("match", func(t *testing.T) {
		want := map[string]manifestAsset{
			"linux-amd64":  {Name: "plugin-core-linux-amd64", SHA256: "zz", Size: 1},
			"darwin-arm64": {Name: "plugin-core-darwin-arm64", SHA256: "ee", Size: 2},
		}
		lines, ok := compareLines(assets, want)
		if !ok {
			t.Error("compareLines reported a mismatch for matching digests")
		}
		wantLines := []string{"ok plugin-core-linux-amd64", "ok plugin-core-darwin-arm64"}
		if !reflect.DeepEqual(lines, wantLines) {
			t.Errorf("lines = %q, want %q", lines, wantLines)
		}
	})

	t.Run("mismatch", func(t *testing.T) {
		want := map[string]manifestAsset{
			"linux-amd64":  {Name: "plugin-core-linux-amd64", SHA256: "aa", Size: 1},
			"darwin-arm64": {Name: "plugin-core-darwin-arm64", SHA256: "ee", Size: 2},
		}
		lines, ok := compareLines(assets, want)
		if ok {
			t.Error("compareLines reported ok for a differing digest")
		}
		wantLines := []string{
			"MISMATCH plugin-core-linux-amd64 want aa got zz",
			"ok plugin-core-darwin-arm64",
		}
		if !reflect.DeepEqual(lines, wantLines) {
			t.Errorf("lines = %q, want %q", lines, wantLines)
		}
	})

	t.Run("missing manifest entry", func(t *testing.T) {
		want := map[string]manifestAsset{
			"darwin-arm64": {Name: "plugin-core-darwin-arm64", SHA256: "ee", Size: 2},
		}
		lines, ok := compareLines(assets, want)
		if ok {
			t.Error("compareLines reported ok for a target the manifest does not list")
		}
		wantLines := []string{
			"MISMATCH plugin-core-linux-amd64 want missing got zz",
			"ok plugin-core-darwin-arm64",
		}
		if !reflect.DeepEqual(lines, wantLines) {
			t.Errorf("lines = %q, want %q", lines, wantLines)
		}
	})
}

func TestLoadManifestAssets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "v0.1.0.json")
	data, err := manifestBytes(buildManifest(pluginCore(t), "0.1.0", goldenAssets()))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := loadManifestAssets(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(targets) {
		t.Fatalf("loaded %d assets, want %d", len(got), len(targets))
	}
	darwin := got["darwin-amd64"]
	if darwin.Name != "plugin-core-darwin-amd64" || darwin.SHA256 != "aa" || darwin.Size != 1024 {
		t.Errorf("darwin-amd64 = %+v, want {plugin-core-darwin-amd64 aa 1024}", darwin)
	}
}

func TestLoadManifestAssetsMissing(t *testing.T) {
	_, err := loadManifestAssets(filepath.Join(t.TempDir(), "v9.9.9.json"))
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("error = %v, want fs.ErrNotExist", err)
	}
}

func TestGoBuildArgs(t *testing.T) {
	core := pluginCore(t)
	out := filepath.Join("dist", "plugin-core-linux-amd64")
	want := []string{
		"build",
		"-trimpath",
		"-buildvcs=false",
		"-ldflags", ldflags(core, "0.1.0"),
		"-o", out,
		"./cmd/plugin-core",
	}
	if got := goBuildArgs(core, out, "0.1.0"); !reflect.DeepEqual(got, want) {
		t.Errorf("goBuildArgs() = %q, want %q", got, want)
	}
	const oneTwoThree = "-s -w -buildid= -X main.version=1.2.3" +
		" -X github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters.version=1.2.3"
	if got := ldflags(core, "1.2.3"); got != oneTwoThree {
		t.Errorf("ldflags(1.2.3) = %q, want %q", got, oneTwoThree)
	}
}

func TestBuildEnv(t *testing.T) {
	environ := []string{
		"GOFLAGS=-tags=debug",
		"CGO_ENABLED=1",
		"GOOS=darwin",
		"GOARCH=arm64",
		"PATH=/usr/bin:/bin",
		"HOME=/users/raouf",
	}
	want := []string{
		"PATH=/usr/bin:/bin",
		"HOME=/users/raouf",
		"CGO_ENABLED=0",
		"GOOS=linux",
		"GOARCH=amd64",
		"GOFLAGS=",
	}
	got := buildEnv(environ, target{OS: "linux", Arch: "amd64"})
	if !reflect.DeepEqual(got, want) {
		t.Errorf("buildEnv() = %q, want %q", got, want)
	}
}

func versionRoot(t *testing.T, content string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "VERSION"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestRunUsageErrors(t *testing.T) {
	root := versionRoot(t, "0.1.0\n")
	tests := []struct {
		name string
		args []string
	}{
		{"unknown flag", []string{"-fresh"}},
		{"stray argument", []string{"extra"}},
		{"unknown binary", []string{"-bin", "zai"}},
		{"empty binary", []string{"-bin", ""}},
		{"target with manifest", []string{"-target", "linux/amd64", "-manifest"}},
		{"manifest with check", []string{"-manifest", "-check"}},
		{"unknown target", []string{"-target", "plan9/amd64"}},
		{"target without arch", []string{"-target", "linux"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			if code := run(tt.args, root, &stdout, &stderr); code != 2 {
				t.Fatalf("exit = %d, want 2", code)
			}
			if stdout.Len() != 0 {
				t.Errorf("stdout = %q, want empty", stdout.String())
			}
			if stderr.Len() == 0 {
				t.Error("stderr is empty, want a usage message")
			}
		})
	}
}

func TestRunRejectsBadVersion(t *testing.T) {
	root := versionRoot(t, "0.1.0-dev")
	var stdout, stderr bytes.Buffer
	if code := run([]string{"-target", "linux/amd64"}, root, &stdout, &stderr); code != 2 {
		t.Fatalf("exit = %d, want 2", code)
	}
	if stdout.Len() != 0 {
		t.Errorf("stdout = %q, want empty", stdout.String())
	}
	if stderr.Len() == 0 {
		t.Error("stderr is empty, want a version error")
	}
}

func TestRunCheckWithoutManifest(t *testing.T) {
	root := versionRoot(t, "0.1.0\n")
	var stdout, stderr bytes.Buffer
	code := run([]string{"-check"}, root, &stdout, &stderr)
	if code != 4 {
		t.Fatalf("exit = %d, want 4", code)
	}
	if got, want := stderr.String(), "no manifest for 0.1.0\n"; got != want {
		t.Errorf("stderr = %q, want %q", got, want)
	}
	if stdout.Len() != 0 {
		t.Errorf("stdout = %q, want empty", stdout.String())
	}
}

// TestReproducibleLinuxAmd64Build builds the same target twice from scratch
// and requires identical digests: the whole point of the pinned flags.
func TestReproducibleLinuxAmd64Build(t *testing.T) {
	if testing.Short() {
		t.Skip("real cross-build skipped in -short")
	}
	b := builder{GoTool: "go", Root: "../..", Bin: pluginCore(t), Version: "0.0.0-test", Stderr: os.Stderr}
	linuxAmd64 := target{OS: "linux", Arch: "amd64"}
	first, err := b.build(context.Background(), linuxAmd64, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	second, err := b.build(context.Background(), linuxAmd64, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if first.SHA256 == "" || first.SHA256 != second.SHA256 {
		t.Errorf("two linux/amd64 builds differ: %q vs %q", first.SHA256, second.SHA256)
	}
	if first.Size == 0 || first.Size != second.Size {
		t.Errorf("sizes differ: %d vs %d", first.Size, second.Size)
	}
}
