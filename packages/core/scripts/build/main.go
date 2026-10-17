// build cross-compiles the release binary (plugin-core) for the four release
// targets and writes the SHA256SUMS file and the release manifest:
//
//	go run ./scripts/build [-bin plugin-core] [-out dir] [-manifest] [-check] [-target os/arch]
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// binary is one release binary: the command package built into it, the VERSION
// file its version comes from and the release directory its manifest goes into,
// both relative to the module root.
type binary struct {
	name        string
	pkg         string
	versionFile string
	releaseDir  string
	tagPrefix   string
	// extraStamp is a second package variable the version is stamped into,
	// besides main.version: plugin-core's adapters version (setup's runtime
	// line). Empty for the binaries that print only their own version.
	extraStamp string
}

// binaries lists every release binary, keyed by the -bin flag value.
var binaries = []binary{
	{
		name:        "plugin-core",
		pkg:         "./cmd/plugin-core",
		versionFile: "VERSION",
		releaseDir:  "release",
		tagPrefix:   "core-v",
		extraStamp:  "github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters.version",
	},
}

// binaryByName looks a binary up by its -bin flag value.
func binaryByName(name string) (binary, bool) {
	for _, b := range binaries {
		if b.name == name {
			return b, true
		}
	}
	return binary{}, false
}

// versionPath is the VERSION file's path under the module root.
func (b binary) versionPath(root string) string {
	return filepath.Join(root, b.versionFile)
}

// manifestPath is the release manifest's path under the module root.
func (b binary) manifestPath(root, version string) string {
	return filepath.Join(root, b.releaseDir, "v"+version+".json")
}

// target is one release cross-build target.
type target struct {
	OS   string
	Arch string
}

// key is the target's manifest key, as in "-target linux/amd64".
func (t target) key() string {
	return t.OS + "-" + t.Arch
}

// asset is the built file's name.
func (t target) asset(name string) string {
	return name + "-" + t.OS + "-" + t.Arch
}

// targets is the release matrix, in manifest key order.
var targets = []target{
	{OS: "darwin", Arch: "amd64"},
	{OS: "darwin", Arch: "arm64"},
	{OS: "linux", Arch: "amd64"},
	{OS: "linux", Arch: "arm64"},
}

// builtAsset is one built binary with its digest.
type builtAsset struct {
	Target target
	Name   string
	SHA256 string
	Size   int64
}

// manifestAsset is one entry of release/v<VERSION>.json.
type manifestAsset struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// assetEntry is one key/value pair of the manifest's assets object.
type assetEntry struct {
	Key   string
	Value manifestAsset
}

// assetEntries marshals as a JSON object that keeps its key order; encoding/json
// would sort a map's keys.
type assetEntries []assetEntry

// MarshalJSON writes the entries as a JSON object in slice order.
func (e assetEntries) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, entry := range e {
		if i > 0 {
			b.WriteByte(',')
		}
		key, err := json.Marshal(entry.Key)
		if err != nil {
			return nil, err
		}
		value, err := json.Marshal(entry.Value)
		if err != nil {
			return nil, err
		}
		b.Write(key)
		b.WriteByte(':')
		b.Write(value)
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

// manifest is the release manifest written by -manifest.
type manifest struct {
	Version string       `json:"version"`
	Tag     string       `json:"tag"`
	Assets  assetEntries `json:"assets"`
}

// manifestFile is the reading shape of a release manifest.
type manifestFile struct {
	Version string                   `json:"version"`
	Tag     string                   `json:"tag"`
	Assets  map[string]manifestAsset `json:"assets"`
}

var versionRe = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

// parseVersion trims surrounding whitespace and requires the x.y.z shape the
// release tag core-v<VERSION> is built from.
func parseVersion(content string) (string, error) {
	version := strings.TrimSpace(content)
	if !versionRe.MatchString(version) {
		return "", fmt.Errorf("version %q must match ^\\d+\\.\\d+\\.\\d+$", version)
	}
	return version, nil
}

// readVersionFile reads and validates the module's VERSION file.
func readVersionFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return parseVersion(string(data))
}

// targetByKey looks a target up by its "os/arch" flag value.
func targetByKey(key string) (target, bool) {
	for _, t := range targets {
		if t.OS+"/"+t.Arch == key {
			return t, true
		}
	}
	return target{}, false
}

// allTargetKeys lists every target key, in release order, for error messages.
func allTargetKeys() string {
	keys := make([]string, 0, len(targets))
	for _, t := range targets {
		keys = append(keys, t.OS+"/"+t.Arch)
	}
	return strings.Join(keys, ", ")
}

// selectTargets keeps the release order of the targets named in keys; every
// target when keys is empty.
func selectTargets(keys []string) []target {
	if len(keys) == 0 {
		return targets
	}
	named := make(map[string]bool, len(keys))
	for _, key := range keys {
		named[key] = true
	}
	selected := make([]target, 0, len(keys))
	for _, t := range targets {
		if named[t.OS+"/"+t.Arch] {
			selected = append(selected, t)
		}
	}
	return selected
}

// targetList collects the repeatable -target flag.
type targetList struct {
	keys []string
}

func (l *targetList) String() string {
	return strings.Join(l.keys, ",")
}

func (l *targetList) Set(value string) error {
	if _, ok := targetByKey(value); !ok {
		return fmt.Errorf("unknown target %q, want <os>/<arch> one of %s", value, allTargetKeys())
	}
	l.keys = append(l.keys, value)
	return nil
}

// ldflags is the exact -ldflags value of every build: stripped, no build id,
// with the version stamped into main.version (the --version answer) and the
// binary's extra stamp, when it has one (plugin-core's adapters.version,
// setup's runtime line).
func ldflags(b binary, version string) string {
	flags := "-s -w -buildid= -X main.version=" + version
	if b.extraStamp != "" {
		flags += " -X " + b.extraStamp + "=" + version
	}
	return flags
}

// goBuildArgs is the exact argument vector of one asset's build; the bytes of
// the binary must depend on nothing but the source, the version and the target.
func goBuildArgs(b binary, outPath, version string) []string {
	return []string{
		"build",
		"-trimpath",
		"-buildvcs=false",
		"-ldflags", ldflags(b, version),
		"-o", outPath,
		b.pkg,
	}
}

// buildEnv returns environ with CGO_ENABLED, GOOS, GOARCH and GOFLAGS pinned
// for t, so a user's flags never change the built bytes.
func buildEnv(environ []string, t target) []string {
	pinned := []string{"CGO_ENABLED=0", "GOOS=" + t.OS, "GOARCH=" + t.Arch, "GOFLAGS="}
	env := make([]string, 0, len(environ)+len(pinned))
	for _, entry := range environ {
		name, _, _ := strings.Cut(entry, "=")
		switch name {
		case "CGO_ENABLED", "GOOS", "GOARCH", "GOFLAGS":
		default:
			env = append(env, entry)
		}
	}
	return append(env, pinned...)
}

// sha256File returns the file's sha256 as lowercase hex and its size.
func sha256File(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	digest := sha256.New()
	size, err := io.Copy(digest, file)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(digest.Sum(nil)), size, nil
}

// builder cross-compiles assets for one version of the module.
type builder struct {
	GoTool  string
	Root    string
	Bin     binary
	Version string
	Stderr  io.Writer
}

// build runs the one fixed cross-build command for t into outDir and digests
// the result.
func (b builder) build(ctx context.Context, t target, outDir string) (builtAsset, error) {
	out := filepath.Join(outDir, t.asset(b.Bin.name))
	cmd := exec.CommandContext(ctx, b.GoTool, goBuildArgs(b.Bin, out, b.Version)...)
	cmd.Dir = b.Root
	cmd.Env = buildEnv(os.Environ(), t)
	cmd.Stdout = b.Stderr
	cmd.Stderr = b.Stderr
	if err := cmd.Run(); err != nil {
		return builtAsset{}, err
	}
	sum, size, err := sha256File(out)
	if err != nil {
		return builtAsset{}, err
	}
	return builtAsset{Target: t, Name: t.asset(b.Bin.name), SHA256: sum, Size: size}, nil
}

// buildAll builds every target into outDir at once (each link is single-threaded, so the targets overlap) and
// answers them in release order; the first failure in that order is the error.
func (b builder) buildAll(ctx context.Context, outDir string, selected []target) ([]builtAsset, error) {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return nil, err
	}
	assets := make([]builtAsset, len(selected))
	errs := make([]error, len(selected))
	var wg sync.WaitGroup
	for i, t := range selected {
		wg.Add(1)
		go func() {
			defer wg.Done()
			assets[i], errs[i] = b.build(ctx, t, outDir)
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			return nil, fmt.Errorf("%s: %w", selected[i].key(), err)
		}
	}
	return assets, nil
}

// sha256sums renders the checksum file in the sha256sum format — "<hex>  <asset>"
// per line — sorted by asset name.
func sha256sums(assets []builtAsset) []byte {
	sorted := make([]builtAsset, len(assets))
	copy(sorted, assets)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Name < sorted[j].Name })
	var b strings.Builder
	for _, asset := range sorted {
		fmt.Fprintf(&b, "%s  %s\n", asset.SHA256, asset.Name)
	}
	return []byte(b.String())
}

// buildManifest assembles the release manifest for one build.
func buildManifest(b binary, version string, assets []builtAsset) manifest {
	m := manifest{Version: version, Tag: b.tagPrefix + version}
	for _, asset := range assets {
		m.Assets = append(m.Assets, assetEntry{
			Key:   asset.Target.key(),
			Value: manifestAsset{Name: asset.Name, SHA256: asset.SHA256, Size: asset.Size},
		})
	}
	return m
}

// manifestBytes renders m as JSON with 2-space indent and a trailing newline.
func manifestBytes(m manifest) ([]byte, error) {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
}

// loadManifestAssets reads a release manifest's assets keyed by target.
func loadManifestAssets(path string) (map[string]manifestAsset, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var file manifestFile
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return file.Assets, nil
}

// compareLines renders one line per built asset — "ok <asset>" when its digest
// matches the manifest, "MISMATCH <asset> want <a> got <b>" when it does not —
// and reports whether every asset matched. A target the manifest does not list
// counts as a mismatch with want "missing".
func compareLines(assets []builtAsset, want map[string]manifestAsset) ([]string, bool) {
	lines := make([]string, 0, len(assets))
	ok := true
	for _, asset := range assets {
		expected, found := want[asset.Target.key()]
		if found && expected.SHA256 == asset.SHA256 {
			lines = append(lines, "ok "+asset.Name)
			continue
		}
		ok = false
		wantHex := "missing"
		if found {
			wantHex = expected.SHA256
		}
		lines = append(lines, fmt.Sprintf("MISMATCH %s want %s got %s", asset.Name, wantHex, asset.SHA256))
	}
	return lines, ok
}

// runCheck rebuilds into a throwaway directory and compares every digest with
// the manifest; the manifest is read first so a missing one fails before any
// build work happens.
func runCheck(ctx context.Context, root string, bin binary, version string, selected []target, stdout, stderr io.Writer) int {
	want, err := loadManifestAssets(bin.manifestPath(root, version))
	if errors.Is(err, fs.ErrNotExist) {
		fmt.Fprintf(stderr, "no manifest for %s\n", version)
		return 4
	}
	if err != nil {
		fmt.Fprintln(stderr, "build:", err)
		return 1
	}
	tmp, err := os.MkdirTemp("", bin.name+"-check-")
	if err != nil {
		fmt.Fprintln(stderr, "build:", err)
		return 1
	}
	defer os.RemoveAll(tmp)
	b := builder{GoTool: "go", Root: root, Bin: bin, Version: version, Stderr: stderr}
	assets, err := b.buildAll(ctx, tmp, selected)
	if err != nil {
		fmt.Fprintln(stderr, "build:", err)
		return 1
	}
	lines, ok := compareLines(assets, want)
	for _, line := range lines {
		fmt.Fprintln(stdout, line)
	}
	if !ok {
		return 1
	}
	return 0
}

// run parses the flags, reads the binary's VERSION file and drives the
// requested mode; root is the module root holding go.mod, the cmd/ packages
// and plugin-core's VERSION file.
func run(args []string, root string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("build", flag.ContinueOnError)
	fs.SetOutput(stderr)
	binName := fs.String("bin", "plugin-core", "binary to build: plugin-core")
	out := fs.String("out", "dist", "directory for the assets and SHA256SUMS")
	wantManifest := fs.Bool("manifest", false, "also write the binary's release manifest")
	check := fs.Bool("check", false, "rebuild into a temporary directory and compare with the manifest")
	list := &targetList{}
	fs.Var(list, "target", "os/arch to build, repeatable")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "build: unexpected argument %q\n", fs.Arg(0))
		return 2
	}
	if *wantManifest && *check {
		fmt.Fprintln(stderr, "build: -manifest and -check are separate modes")
		return 2
	}
	if *wantManifest && len(list.keys) > 0 {
		fmt.Fprintln(stderr, "build: -target cannot be combined with -manifest")
		return 2
	}

	bin, ok := binaryByName(*binName)
	if !ok {
		fmt.Fprintf(stderr, "build: unknown binary %q, want plugin-core\n", *binName)
		return 2
	}

	version, err := readVersionFile(bin.versionPath(root))
	if err != nil {
		fmt.Fprintln(stderr, "build:", err)
		return 2
	}

	if *check {
		return runCheck(context.Background(), root, bin, version, selectTargets(list.keys), stdout, stderr)
	}

	b := builder{GoTool: "go", Root: root, Bin: bin, Version: version, Stderr: stderr}
	assets, err := b.buildAll(context.Background(), *out, selectTargets(list.keys))
	if err != nil {
		fmt.Fprintln(stderr, "build:", err)
		return 1
	}
	if err := os.WriteFile(filepath.Join(*out, "SHA256SUMS"), sha256sums(assets), 0o644); err != nil {
		fmt.Fprintln(stderr, "build:", err)
		return 1
	}
	if !*wantManifest {
		return 0
	}
	data, err := manifestBytes(buildManifest(bin, version, assets))
	if err != nil {
		fmt.Fprintln(stderr, "build:", err)
		return 1
	}
	path := bin.manifestPath(root, version)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		fmt.Fprintln(stderr, "build:", err)
		return 1
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		fmt.Fprintln(stderr, "build:", err)
		return 1
	}
	return 0
}

func main() {
	os.Exit(run(os.Args[1:], ".", os.Stdout, os.Stderr))
}
