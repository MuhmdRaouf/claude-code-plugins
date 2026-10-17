// releasenotes prints a release's notes: the version's CHANGELOG.md section,
// the SHA256SUMS file in a code block and the build commit:
//
//	go run ./scripts/releasenotes -version <version> -changelog <CHANGELOG.md> -sums <SHA256SUMS> -commit <sha>
//
// The changelog defaults to the module root's CHANGELOG.md; another project's
// release passes -changelog with its own file. The release workflow pipes
// the output into `gh release create --notes-file -`, and CI runs the same
// builder on VERSION so a version without a changelog section fails before
// anything is released. GitHub renders a single newline as a line break, so
// the section's wrapped lines are joined.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	os.Exit(run(os.Args[1:], ".", os.Stdout, os.Stderr))
}

// run parses the flags and prints the notes; dir is the module root the
// default changelog and a relative -sums path resolve against.
func run(args []string, dir string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("releasenotes", flag.ContinueOnError)
	fs.SetOutput(stderr)
	version := fs.String("version", "", "the version whose CHANGELOG.md section becomes the notes")
	changelogPath := fs.String("changelog", "CHANGELOG.md", "path to the changelog holding the version's section")
	sumsPath := fs.String("sums", "", "path to the release's SHA256SUMS file")
	commit := fs.String("commit", "", "the commit the assets were built from")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() > 0 {
		fmt.Fprintf(stderr, "releasenotes: unexpected argument %q\n", fs.Arg(0))
		return 2
	}
	if *version == "" || *sumsPath == "" || *commit == "" {
		fmt.Fprintln(stderr, "releasenotes: -version, -sums and -commit are required")
		return 2
	}
	if *changelogPath == "" {
		fmt.Fprintln(stderr, "releasenotes: -changelog must not be empty")
		return 2
	}

	changelog := *changelogPath
	if !filepath.IsAbs(changelog) {
		changelog = filepath.Join(dir, changelog)
	}
	changelogBytes, err := os.ReadFile(changelog)
	if err != nil {
		fmt.Fprintln(stderr, "releasenotes:", err)
		return 1
	}
	sums := *sumsPath
	if !filepath.IsAbs(sums) {
		sums = filepath.Join(dir, sums)
	}
	sumsBytes, err := os.ReadFile(sums)
	if err != nil {
		fmt.Fprintln(stderr, "releasenotes:", err)
		return 1
	}
	section, err := findSection(string(changelogBytes), *version)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprint(stdout, notes(section, string(sumsBytes), *commit))
	return 0
}

// findSection returns the raw lines of the version's section: after its
// `## <version> ` heading, up to the next `## ` heading or the end of the
// file, with the blank padding around it dropped. A missing or empty section
// is an error naming the version, because both leave nothing to publish.
func findSection(changelog string, version string) ([]string, error) {
	lines := strings.Split(changelog, "\n")
	start := -1
	inCode := false
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			inCode = !inCode
			continue
		}
		if inCode || !strings.HasPrefix(trimmed, "## ") {
			continue
		}
		if heading := strings.Fields(strings.TrimPrefix(trimmed, "## ")); len(heading) > 0 && heading[0] == version {
			start = i + 1
			break
		}
	}
	if start < 0 {
		return nil, fmt.Errorf("no CHANGELOG.md section for %s", version)
	}
	var section []string
	inCode = false
	for _, line := range lines[start:] {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "```") {
			inCode = !inCode
		} else if !inCode && strings.HasPrefix(trimmed, "## ") {
			break
		}
		section = append(section, line)
	}
	for len(section) > 0 && strings.TrimSpace(section[0]) == "" {
		section = section[1:]
	}
	for len(section) > 0 && strings.TrimSpace(section[len(section)-1]) == "" {
		section = section[:len(section)-1]
	}
	if len(section) == 0 {
		return nil, fmt.Errorf("no CHANGELOG.md section for %s", version)
	}
	return section, nil
}

// unwrap joins a section's wrapped lines: a line that is neither blank, nor a
// bullet, nor a heading nor inside a code block joins the line before it.
func unwrap(lines []string) []string {
	var out []string
	inCode := false
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trimmed, "```"):
			inCode = !inCode
			out = append(out, line)
		case inCode:
			// Code blocks are copied verbatim: joining them would change what
			// the reader is told to run.
			out = append(out, line)
		case trimmed == "":
			out = append(out, "")
		case strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "#"):
			out = append(out, trimmed)
		default:
			// A paragraph never glues itself onto a heading or a fence: the
			// changelog blanks those lines, and joining would corrupt markup.
			if last := len(out) - 1; last >= 0 && out[last] != "" &&
				!strings.HasPrefix(out[last], "#") && !strings.HasPrefix(out[last], "```") {
				out[last] += " " + trimmed
			} else {
				out = append(out, trimmed)
			}
		}
	}
	return out
}

// notes renders the release notes: the unwrapped section, the checksums in a
// code block, then the build commit.
func notes(section []string, sums string, commit string) string {
	var b strings.Builder
	for _, line := range unwrap(section) {
		b.WriteString(line)
		b.WriteString("\n")
	}
	b.WriteString("\n### Checksums\n\n```\n")
	b.WriteString(strings.TrimRight(sums, "\n"))
	b.WriteString("\n```\nBuilt reproducibly from ")
	b.WriteString(commit)
	b.WriteString(".\n")
	return b.String()
}
