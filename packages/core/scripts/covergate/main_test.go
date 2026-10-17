package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const mp = "github.com/MuhmdRaouf/claude-code-plugins/packages/core"

const sampleProfile = "mode: atomic\n" +
	mp + "/internal/domain/brief/brief.go:10.20,12.3 2 1\n" +
	mp + "/internal/domain/brief/brief.go:15.20,17.3 3 0\n" +
	mp + "/internal/domain/job/job.go:1.1,2.2 4 1\n" +
	mp + "/internal/adapters/fsfiles/fsfiles.go:5.10,6.20 4 1\n" +
	mp + "/internal/testkit/tk.go:1.1,2.2 5 0\n" +
	mp + "/cmd/plugin-core/main.go:1.1,2.2 5 1\n" +
	mp + "/scripts/covergate/main.go:1.1,2.2 5 0\n"

func sampleCoverage(t *testing.T) map[string]coverage {
	t.Helper()
	blocks, err := parseProfile(strings.NewReader(sampleProfile))
	if err != nil {
		t.Fatal(err)
	}
	return aggregate(blocks)
}

func TestParseProfile(t *testing.T) {
	blocks, err := parseProfile(strings.NewReader(sampleProfile))
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 7 {
		t.Fatalf("parsed %d blocks, want 7", len(blocks))
	}
	first := blocks[0]
	if first.File != mp+"/internal/domain/brief/brief.go" || first.Statements != 2 || first.Count != 1 {
		t.Errorf("first block = %+v, want {%s 2 1}", first, mp+"/internal/domain/brief/brief.go")
	}
	uncovered := blocks[1]
	if uncovered.File != mp+"/internal/domain/brief/brief.go" || uncovered.Statements != 3 || uncovered.Count != 0 {
		t.Errorf("second block = %+v, want {%s 3 0}", uncovered, mp+"/internal/domain/brief/brief.go")
	}
}

func TestParseProfileRejectsBadInput(t *testing.T) {
	tests := []struct {
		name    string
		profile string
	}{
		{"missing mode header", mp + "/internal/app/app.go:1.1,2.2 1 1\n"},
		{"wrong mode header", "mode: set"},
		{"truncated line", "mode: atomic\n" + mp + "/internal/app/app.go:1.1,2.2 1\n"},
		{"non-numeric statements", "mode: atomic\n" + mp + "/internal/app/app.go:1.1,2.2 x 1\n"},
		{"non-numeric count", "mode: atomic\n" + mp + "/internal/app/app.go:1.1,2.2 1 y\n"},
		{"no position", "mode: atomic\n" + mp + "/internal/app/app.go 1 1\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := parseProfile(strings.NewReader(tt.profile)); err == nil {
				t.Fatal("parseProfile succeeded, want an error")
			}
		})
	}
}

func TestParseProfileSkipsBlankLines(t *testing.T) {
	profile := "mode: atomic\n\n" + mp + "/internal/app/app.go:1.1,2.2 1 1\n\n"
	blocks, err := parseProfile(strings.NewReader(profile))
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 {
		t.Fatalf("parsed %d blocks, want 1", len(blocks))
	}
}

func TestAggregate(t *testing.T) {
	cov := sampleCoverage(t)
	want := map[string]coverage{
		mp + "/internal/domain/brief":     {Statements: 5, Covered: 2},
		mp + "/internal/domain/job":       {Statements: 4, Covered: 4},
		mp + "/internal/adapters/fsfiles": {Statements: 4, Covered: 4},
		mp + "/internal/testkit":          {Statements: 5, Covered: 0},
		mp + "/cmd/plugin-core":           {Statements: 5, Covered: 5},
		mp + "/scripts/covergate":         {Statements: 5, Covered: 0},
	}
	if len(cov) != len(want) {
		t.Fatalf("aggregated %d packages, want %d", len(cov), len(want))
	}
	for pkg, c := range want {
		if got := cov[pkg]; got != c {
			t.Errorf("%s = %+v, want %+v", pkg, got, c)
		}
	}
}

func TestPercent(t *testing.T) {
	tests := []struct {
		c    coverage
		want float64
	}{
		{coverage{Statements: 2, Covered: 1}, 50},
		{coverage{Statements: 20, Covered: 19}, 95},
		{coverage{Statements: 5, Covered: 0}, 0},
		{coverage{}, 100},
	}
	for _, tt := range tests {
		if got := percent(tt.c); got != tt.want {
			t.Errorf("percent(%+v) = %v, want %v", tt.c, got, tt.want)
		}
	}
}

func TestThreshold(t *testing.T) {
	tests := []struct {
		pkg       string
		wantMin   float64
		wantGated bool
	}{
		{mp + "/internal/domain/brief", 95, true},
		{mp + "/internal/domain/job/area", 95, true},
		{mp + "/internal/app", 90, true},
		{mp + "/internal/adapters/fsfiles", 90, true},
		{mp + "/internal/render/text", 90, true},
		{mp + "/internal/router", 90, true},
		{mp + "/internal/cli", 90, true},
		{mp + "/internal/providers", 90, true},
		{mp + "/internal/authpage", 90, true},
		{mp + "/internal/spool", 90, true},
		{mp + "/internal/testkit/fs", 0, false},
		{mp + "/internal/archtest", 0, false},
		{mp + "/cmd/plugin-core", 0, false},
		{mp + "/scripts/covergate", 0, false},
		{mp, 0, false},
		{"example.com/other/pkg", 0, false},
	}
	for _, tt := range tests {
		min, gated := threshold(tt.pkg)
		if min != tt.wantMin || gated != tt.wantGated {
			t.Errorf("threshold(%s) = (%v, %v), want (%v, %v)", tt.pkg, min, gated, tt.wantMin, tt.wantGated)
		}
	}
}

func TestGateLine(t *testing.T) {
	cov := sampleCoverage(t)
	tests := []struct {
		pkg    string
		want   string
		wantOK bool
	}{
		{mp + "/internal/domain/brief", "FAIL " + mp + "/internal/domain/brief 40.0% (min 95%)", false},
		{mp + "/internal/domain/job", "ok   " + mp + "/internal/domain/job 100.0% (min 95%)", true},
		{mp + "/internal/adapters/fsfiles", "ok   " + mp + "/internal/adapters/fsfiles 100.0% (min 90%)", true},
		{mp + "/internal/testkit", "", false},
		{mp + "/cmd/plugin-core", "", false},
		{mp + "/scripts/covergate", "", false},
	}
	for _, tt := range tests {
		got, ok := gateLine(tt.pkg, cov[tt.pkg])
		if got != tt.want || ok != tt.wantOK {
			t.Errorf("gateLine(%s) = (%q, %v), want (%q, %v)", tt.pkg, got, ok, tt.want, tt.wantOK)
		}
	}
}

func TestGateLineBoundary(t *testing.T) {
	atMin := coverage{Statements: 20, Covered: 19}
	if _, ok := gateLine(mp+"/internal/domain/job", atMin); !ok {
		t.Error("exactly 95.0% must pass the 95% gate")
	}
	justUnder := coverage{Statements: 1000, Covered: 949}
	if _, ok := gateLine(mp+"/internal/domain/job", justUnder); ok {
		t.Error("94.9% must fail the 95% gate")
	}
	at90 := coverage{Statements: 10, Covered: 9}
	if _, ok := gateLine(mp+"/internal/adapters/fsfiles", at90); !ok {
		t.Error("exactly 90.0% must pass the 90% gate")
	}
}

// writeProfile puts a coverprofile named coverage.out in a fresh dir and returns the dir.
func writeProfile(t *testing.T, profile string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "coverage.out"), []byte(profile), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// listing is a packageLister that always returns pkgs.
func listing(pkgs ...string) packageLister {
	return func(string) ([]string, error) {
		return pkgs, nil
	}
}

// samplePackages lists every package sampleProfile has blocks for.
func samplePackages() []string {
	return []string{
		mp + "/internal/domain/brief",
		mp + "/internal/domain/job",
		mp + "/internal/adapters/fsfiles",
		mp + "/internal/testkit",
		mp + "/cmd/plugin-core",
		mp + "/scripts/covergate",
	}
}

// noGoOnPath puts a fake go first on PATH that prints a marker and fails: any
// go invocation must show up as that marker on stderr.
func noGoOnPath(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	name, content := filepath.Join(dir, "go"), "#!/bin/sh\necho covergate ran go test >&2\nexit 1\n"
	if err := os.WriteFile(name, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
}

func TestRunJudgesGivenProfile(t *testing.T) {
	dir := writeProfile(t, "mode: atomic\n"+mp+"/internal/domain/job/job.go:1.1,2.2 4 1\n")
	var stdout, stderr bytes.Buffer
	code := judge(dir, "coverage.out", listing(mp+"/internal/domain/job"), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("judge exited %d, want 0; stderr:\n%s", code, stderr.String())
	}
	want := "ok   " + mp + "/internal/domain/job 100.0% (min 95%)\n"
	if stdout.String() != want {
		t.Errorf("stdout = %q, want %q", stdout.String(), want)
	}
	if stderr.Len() != 0 {
		t.Errorf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunGivenProfileFailsBelowMinimum(t *testing.T) {
	// sampleProfile has internal/domain/brief at 40%, under its 95% minimum.
	dir := writeProfile(t, sampleProfile)
	var stdout, stderr bytes.Buffer
	code := judge(dir, "coverage.out", listing(samplePackages()...), &stdout, &stderr)
	if code != 1 {
		t.Fatalf("judge exited %d, want 1; stderr:\n%s", code, stderr.String())
	}
	want := "FAIL " + mp + "/internal/domain/brief 40.0% (min 95%)\n"
	if !strings.Contains(stdout.String(), want) {
		t.Errorf("stdout = %q, want it to contain %q", stdout.String(), want)
	}
	if stderr.Len() != 0 {
		t.Errorf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunGivenProfileFailsWhenGatedPackageMissing(t *testing.T) {
	// The lister knows internal/domain/brief; the profile has no block for it.
	dir := writeProfile(t, "mode: atomic\n"+mp+"/internal/domain/job/job.go:1.1,2.2 4 1\n")
	var stdout, stderr bytes.Buffer
	code := judge(dir, "coverage.out", listing(mp+"/internal/domain/job", mp+"/internal/domain/brief"), &stdout, &stderr)
	if code != 1 {
		t.Fatalf("judge exited %d, want 1; stderr:\n%s", code, stderr.String())
	}
	want := "FAIL " + mp + "/internal/domain/brief missing from the profile (min 95%)\n"
	if !strings.Contains(stdout.String(), want) {
		t.Errorf("stdout = %q, want it to contain %q", stdout.String(), want)
	}
	if stderr.Len() != 0 {
		t.Errorf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunGivenProfileWithEveryPackagePasses(t *testing.T) {
	profile := "mode: atomic\n" +
		mp + "/internal/domain/job/job.go:1.1,2.2 4 1\n" +
		mp + "/internal/adapters/fsfiles/fsfiles.go:5.10,6.20 4 1\n"
	dir := writeProfile(t, profile)
	var stdout, stderr bytes.Buffer
	pkgs := listing(mp+"/internal/domain/job", mp+"/internal/adapters/fsfiles", mp+"/scripts/build")
	code := judge(dir, "coverage.out", pkgs, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("judge exited %d, want 0; stderr:\n%s", code, stderr.String())
	}
	want := "ok   " + mp + "/internal/adapters/fsfiles 100.0% (min 90%)\n" +
		"ok   " + mp + "/internal/domain/job 100.0% (min 95%)\n"
	if stdout.String() != want {
		t.Errorf("stdout = %q, want %q", stdout.String(), want)
	}
	if stderr.Len() != 0 {
		t.Errorf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunGivenProfileAllowsExemptPackagesMissing(t *testing.T) {
	dir := writeProfile(t, "mode: atomic\n"+mp+"/internal/domain/job/job.go:1.1,2.2 4 1\n")
	lists := listing(
		mp+"/internal/domain/job",
		mp+"/internal/testkit", mp+"/internal/testkit/cmd/fakeclaude",
		mp+"/internal/archtest",
		mp+"/cmd/plugin-core", mp+"/scripts/covergate",
	)
	var stdout, stderr bytes.Buffer
	if code := judge(dir, "coverage.out", lists, &stdout, &stderr); code != 0 {
		t.Fatalf("judge exited %d, want 0; stderr:\n%s", code, stderr.String())
	}
	want := "ok   " + mp + "/internal/domain/job 100.0% (min 95%)\n"
	if stdout.String() != want {
		t.Errorf("stdout = %q, want %q", stdout.String(), want)
	}
	if stderr.Len() != 0 {
		t.Errorf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunGivenProfileNeverRunsGoTest(t *testing.T) {
	noGoOnPath(t)
	dir := writeProfile(t, "mode: atomic\n"+mp+"/internal/domain/job/job.go:1.1,2.2 4 1\n")
	var stdout, stderr bytes.Buffer
	code := judge(dir, "coverage.out", listing(mp+"/internal/domain/job"), &stdout, &stderr)
	if code != 0 {
		t.Fatalf("judge exited %d, want 0; stderr:\n%s", code, stderr.String())
	}
	if strings.Contains(stderr.String(), "covergate ran go test") {
		t.Error("judge started go test although a profile was given")
	}
}

func TestRunMissingProfileFile(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := judge(t.TempDir(), "nope.out", listing(), &stdout, &stderr); code != 1 {
		t.Fatalf("judge exited %d, want 1", code)
	}
	msg := stderr.String()
	if !strings.Contains(msg, "covergate:") || !strings.Contains(msg, "nope.out") {
		t.Errorf("stderr = %q, want a covergate error naming nope.out", msg)
	}
	if stdout.Len() != 0 {
		t.Errorf("stdout = %q, want empty", stdout.String())
	}
}

func TestRunUnreadableProfileFile(t *testing.T) {
	// "." resolves to the module dir itself, which is a directory, not a readable profile.
	var stdout, stderr bytes.Buffer
	if code := judge(t.TempDir(), ".", listing(), &stdout, &stderr); code != 1 {
		t.Fatalf("judge exited %d, want 1", code)
	}
	if !strings.Contains(stderr.String(), "covergate:") {
		t.Errorf("stderr = %q, want a covergate error", stderr.String())
	}
}

func TestRunFailsWhenPackageListingFails(t *testing.T) {
	dir := writeProfile(t, "mode: atomic\n"+mp+"/internal/domain/job/job.go:1.1,2.2 4 1\n")
	lister := func(string) ([]string, error) {
		return nil, errors.New("no go tool")
	}
	var stdout, stderr bytes.Buffer
	if code := judge(dir, "coverage.out", lister, &stdout, &stderr); code != 1 {
		t.Fatalf("judge exited %d, want 1", code)
	}
	msg := stderr.String()
	if !strings.Contains(msg, "covergate:") || !strings.Contains(msg, "no go tool") {
		t.Errorf("stderr = %q, want a covergate error naming the listing failure", msg)
	}
	if stdout.Len() != 0 {
		t.Errorf("stdout = %q, want empty", stdout.String())
	}
}

func TestGoListPackagesListsTheModule(t *testing.T) {
	// The package's own dir is a one-package module subtree; the real go list must find it.
	pkgs, err := goListPackages(".")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{mp + "/scripts/covergate"}
	if !reflect.DeepEqual(pkgs, want) {
		t.Errorf("goListPackages(\".\") = %v, want %v", pkgs, want)
	}
}
