package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const sampleChangelog = "# plugin-core changelog\n" +
	"Intro.\n" +
	"\n" +
	"## 0.2.0 (2026-11-01)\n" +
	"\n" +
	"Second release, wrapping onto\n" +
	"a second line.\n" +
	"\n" +
	"- A bullet that wraps\n" +
	"  onto a second line.\n" +
	"- Another bullet.\n" +
	"\n" +
	"### Sub heading\n" +
	"\n" +
	"Paragraph under the heading\n" +
	"still wraps.\n" +
	"\n" +
	"```sh\n" +
	"sha256sum -c SHA256SUMS\n" +
	"  an indented fence line\n" +
	"```\n" +
	"\n" +
	"## 0.1.0 (2026-10-14)\n" +
	"\n" +
	"First release,\n" +
	"two lines.\n" +
	"\n" +
	"## 0.0.0 (2026-10-01)\n" +
	"\n" +
	"## earlier\n" +
	"\n" +
	"Not a version heading, never matched.\n"

// section020 is 0.2.0's raw section: everything between its heading and the
// next one, with the surrounding blank lines dropped.
var section020 = []string{
	"Second release, wrapping onto",
	"a second line.",
	"",
	"- A bullet that wraps",
	"  onto a second line.",
	"- Another bullet.",
	"",
	"### Sub heading",
	"",
	"Paragraph under the heading",
	"still wraps.",
	"",
	"```sh",
	"sha256sum -c SHA256SUMS",
	"  an indented fence line",
	"```",
}

func TestFindSection(t *testing.T) {
	got, err := findSection(sampleChangelog, "0.2.0")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, "\n") != strings.Join(section020, "\n") {
		t.Errorf("findSection(0.2.0) =\n%q\nwant\n%q", got, section020)
	}
}

func TestFindSectionLastRunsToEndOfFile(t *testing.T) {
	got, err := findSection(sampleChangelog, "earlier")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"Not a version heading, never matched."}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("findSection(earlier) = %q, want %q", got, want)
	}
}

func TestFindSectionMissing(t *testing.T) {
	for _, version := range []string{"9.9.9", "0.2", "0.20"} {
		_, err := findSection(sampleChangelog, version)
		if err == nil {
			t.Fatalf("findSection(%q) succeeded, want the missing-section error", version)
		}
		if err.Error() != "no CHANGELOG.md section for "+version {
			t.Errorf("findSection(%q) error = %q, want %q", version, err, "no CHANGELOG.md section for "+version)
		}
	}
}

func TestFindSectionEmpty(t *testing.T) {
	// 0.0.0's heading is followed by nothing but a blank line before the next heading.
	_, err := findSection(sampleChangelog, "0.0.0")
	if err == nil || err.Error() != "no CHANGELOG.md section for 0.0.0" {
		t.Errorf("empty section error = %v, want %q", err, "no CHANGELOG.md section for 0.0.0")
	}
}

func TestUnwrapJoinsWrappedLines(t *testing.T) {
	got := unwrap([]string{
		"A paragraph that wraps",
		"onto two lines.",
		"",
		"- a bullet that wraps",
		"  onto two lines",
		"  and three",
		"- a one-line bullet",
	})
	want := []string{
		"A paragraph that wraps onto two lines.",
		"",
		"- a bullet that wraps onto two lines and three",
		"- a one-line bullet",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("unwrap =\n%q\nwant\n%q", got, want)
	}
}

func TestUnwrapKeepsHeadingsAndCodeBlocks(t *testing.T) {
	got := unwrap(section020)
	want := []string{
		"Second release, wrapping onto a second line.",
		"",
		"- A bullet that wraps onto a second line.",
		"- Another bullet.",
		"",
		"### Sub heading",
		"",
		"Paragraph under the heading still wraps.",
		"",
		"```sh",
		"sha256sum -c SHA256SUMS",
		"  an indented fence line",
		"```",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("unwrap =\n%q\nwant\n%q", got, want)
	}
}

func TestUnwrapNeverJoinsAHeadingOrFence(t *testing.T) {
	// A continuation line directly after a heading or a closing fence starts a
	// new line instead of gluing itself onto markup.
	got := unwrap([]string{"### Heading", "its text", "```", "inside", "```", "after the fence"})
	want := []string{"### Heading", "its text", "```", "inside", "```", "after the fence"}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("unwrap = %q, want %q", got, want)
	}
}

func TestNotes(t *testing.T) {
	sums := "abc123  plugin-core-darwin-arm64\ndef456  plugin-core-linux-amd64\n"
	got := notes(section020, sums, "012abcd")
	want := "Second release, wrapping onto a second line.\n" +
		"\n" +
		"- A bullet that wraps onto a second line.\n" +
		"- Another bullet.\n" +
		"\n" +
		"### Sub heading\n" +
		"\n" +
		"Paragraph under the heading still wraps.\n" +
		"\n" +
		"```sh\n" +
		"sha256sum -c SHA256SUMS\n" +
		"  an indented fence line\n" +
		"```\n" +
		"\n" +
		"### Checksums\n" +
		"\n" +
		"```\n" +
		"abc123  plugin-core-darwin-arm64\n" +
		"def456  plugin-core-linux-amd64\n" +
		"```\n" +
		"Built reproducibly from 012abcd.\n"
	if got != want {
		t.Errorf("notes =\n%q\nwant\n%q", got, want)
	}
}

// writeCheckout puts a CHANGELOG.md and a sums file in a fresh dir and returns the dir.
func writeCheckout(t *testing.T, changelog string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "CHANGELOG.md"), []byte(changelog), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SHA256SUMS"), []byte("abc123  plugin-core-darwin-arm64\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// TestRunPrintsTheNotesFromTheChangelogFlag points -changelog at a changelog
// beside the module root, the way another project's release passes its own
// file. The default CHANGELOG.md holds a different version,
// so the section in the output proves the flag picked the file.
func TestRunPrintsTheNotesFromTheChangelogFlag(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "CHANGELOG.md"), []byte("## 0.1.0 (2026-10-14)\n\nWrong file.\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "plugin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "plugin", "CHANGELOG.md"), []byte(sampleChangelog), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SHA256SUMS"), []byte("abc123  plugin-core-darwin-arm64\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	args := []string{"-version", "0.2.0", "-changelog", "plugin/CHANGELOG.md", "-sums", "SHA256SUMS", "-commit", "deadbeef"}
	var stdout, stderr bytes.Buffer
	if code := run(args, dir, &stdout, &stderr); code != 0 {
		t.Fatalf("run exited %d, want 0; stderr:\n%s", code, stderr.String())
	}
	want := notes(section020, "abc123  plugin-core-darwin-arm64\n", "deadbeef")
	if stdout.String() != want {
		t.Errorf("stdout =\n%q\nwant\n%q", stdout.String(), want)
	}
	if stderr.Len() != 0 {
		t.Errorf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunPrintsTheNotes(t *testing.T) {
	dir := writeCheckout(t, sampleChangelog)
	args := []string{"-version", "0.2.0", "-sums", "SHA256SUMS", "-commit", "deadbeef"}
	var stdout, stderr bytes.Buffer
	if code := run(args, dir, &stdout, &stderr); code != 0 {
		t.Fatalf("run exited %d, want 0; stderr:\n%s", code, stderr.String())
	}
	want := notes(section020, "abc123  plugin-core-darwin-arm64\n", "deadbeef")
	if stdout.String() != want {
		t.Errorf("stdout =\n%q\nwant\n%q", stdout.String(), want)
	}
	if stderr.Len() != 0 {
		t.Errorf("stderr = %q, want empty", stderr.String())
	}
}

func TestRunFailsWithoutTheSection(t *testing.T) {
	dir := writeCheckout(t, sampleChangelog)
	var stdout, stderr bytes.Buffer
	code := run([]string{"-version", "9.9.9", "-sums", "SHA256SUMS", "-commit", "deadbeef"}, dir, &stdout, &stderr)
	if code != 1 {
		t.Fatalf("run exited %d, want 1", code)
	}
	if stderr.String() != "no CHANGELOG.md section for 9.9.9\n" {
		t.Errorf("stderr = %q, want the missing-section message", stderr.String())
	}
	if stdout.Len() != 0 {
		t.Errorf("stdout = %q, want empty", stdout.String())
	}
}

func TestRunFailsWithUnreadableInputs(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{"no CHANGELOG.md", []string{"-version", "0.2.0", "-sums", "SHA256SUMS", "-commit", "deadbeef"}},
		{"no sums file", []string{"-version", "0.2.0", "-sums", "nope", "-commit", "deadbeef"}},
		{"no changelog at the flag path", []string{"-version", "0.2.0", "-changelog", "plugin/CHANGELOG.md", "-sums", "SHA256SUMS", "-commit", "deadbeef"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			if tt.name == "no sums file" || tt.name == "no changelog at the flag path" {
				if err := os.WriteFile(filepath.Join(dir, "CHANGELOG.md"), []byte(sampleChangelog), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if tt.name == "no changelog at the flag path" {
				if err := os.WriteFile(filepath.Join(dir, "SHA256SUMS"), []byte("abc123  plugin-core-darwin-arm64\n"), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			var stdout, stderr bytes.Buffer
			if code := run(tt.args, dir, &stdout, &stderr); code != 1 {
				t.Fatalf("run exited %d, want 1", code)
			}
			if !strings.Contains(stderr.String(), "releasenotes:") {
				t.Errorf("stderr = %q, want a releasenotes error", stderr.String())
			}
		})
	}
}

func TestRunUsageErrors(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{"no version", []string{"-sums", "SHA256SUMS", "-commit", "deadbeef"}},
		{"no sums", []string{"-version", "0.2.0", "-commit", "deadbeef"}},
		{"no commit", []string{"-version", "0.2.0", "-sums", "SHA256SUMS"}},
		{"empty changelog path", []string{"-version", "0.2.0", "-sums", "SHA256SUMS", "-commit", "deadbeef", "-changelog", ""}},
		{"positional argument", []string{"-version", "0.2.0", "-sums", "SHA256SUMS", "-commit", "x", "extra"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := writeCheckout(t, sampleChangelog)
			var stdout, stderr bytes.Buffer
			if code := run(tt.args, dir, &stdout, &stderr); code != 2 {
				t.Fatalf("run exited %d, want 2", code)
			}
			if stdout.Len() != 0 {
				t.Errorf("stdout = %q, want empty", stdout.String())
			}
		})
	}
}

// TestRunAgainstTheCommittedChangelog proves the committed VERSION always has
// its CHANGELOG.md section: the same fact CI checks on every core change.
func TestRunAgainstTheCommittedChangelog(t *testing.T) {
	version, err := os.ReadFile(filepath.Join("..", "..", "VERSION"))
	if err != nil {
		t.Fatal(err)
	}
	sums := filepath.Join(t.TempDir(), "empty-sums")
	if err := os.WriteFile(sums, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	args := []string{"-version", strings.TrimSpace(string(version)), "-sums", sums, "-commit", "x"}
	if code := run(args, "../..", &stdout, &stderr); code != 0 {
		t.Fatalf("run exited %d, want 0; stderr:\n%s", code, stderr.String())
	}
	out := stdout.String()
	if !strings.Contains(out, "### Checksums\n") || !strings.HasSuffix(out, "Built reproducibly from x.\n") {
		t.Errorf("stdout =\n%q\nwant the checksums block and the commit line", out)
	}
	if strings.Count(out, "### ") < 2 {
		t.Errorf("stdout =\n%q\nwant the changelog section's own headings kept", out)
	}
}
