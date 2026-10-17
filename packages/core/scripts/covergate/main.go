// covergate runs the test suite with coverage and fails unless every gated
// package reaches its statement-coverage threshold. With -profile it judges an
// existing coverprofile instead and runs no test. A gated package with no
// block in the profile fails too: a truncated profile must not pass.
package main

import (
	"bufio"
	"bytes"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

const modulePath = "github.com/MuhmdRaouf/claude-code-plugins/packages/core"

const profileName = "coverage.out"

type block struct {
	File       string
	Statements int
	Count      int
}

type coverage struct {
	Statements int
	Covered    int
}

func main() {
	profile := flag.String("profile", "", "judge this existing coverprofile instead of running the suite")
	flag.Parse()
	os.Exit(run(".", *profile, os.Stdout, os.Stderr))
}

// packageLister returns the import paths of every package under the module in dir.
type packageLister func(dir string) ([]string, error)

// goListPackages lists the module's packages with the go tool.
func goListPackages(dir string) ([]string, error) {
	list := exec.Command("go", "list", "./...")
	list.Dir = dir
	var listErr bytes.Buffer
	list.Stderr = &listErr
	out, err := list.Output()
	if err != nil {
		return nil, fmt.Errorf("go list: %v: %s", err, strings.TrimSpace(listErr.String()))
	}
	var pkgs []string
	for _, line := range strings.Split(string(out), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			pkgs = append(pkgs, line)
		}
	}
	return pkgs, nil
}

// run tests the module in dir and judges the profile the run leaves behind,
// or judges the coverprofile named by profile and runs no test.
func run(dir string, profile string, stdout, stderr io.Writer) int {
	return judge(dir, profile, goListPackages, stdout, stderr)
}

// judge is run with the package lister injected, so tests never run the go tool.
func judge(dir string, profile string, listPackages packageLister, stdout, stderr io.Writer) int {
	profilePath := profile
	if profilePath == "" {
		test := exec.Command("go", "test", "-coverprofile="+profileName, "-covermode=atomic", "./...")
		test.Dir = dir
		test.Stdout = stdout
		test.Stderr = stderr
		if err := test.Run(); err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				return exitErr.ExitCode()
			}
			fmt.Fprintln(stderr, "covergate:", err)
			return 1
		}
		profilePath = profileName
	}
	if !filepath.IsAbs(profilePath) {
		profilePath = filepath.Join(dir, profilePath)
	}

	file, err := os.Open(profilePath)
	if err != nil {
		fmt.Fprintln(stderr, "covergate:", err)
		return 1
	}
	defer file.Close()
	blocks, err := parseProfile(file)
	if err != nil {
		fmt.Fprintln(stderr, "covergate:", err)
		return 1
	}

	listed, err := listPackages(dir)
	if err != nil {
		fmt.Fprintln(stderr, "covergate:", err)
		return 1
	}
	packages := aggregate(blocks)
	seen := make(map[string]bool, len(packages))
	names := make([]string, 0, len(packages)+len(listed))
	for pkg := range packages {
		names = append(names, pkg)
		seen[pkg] = true
	}
	for _, pkg := range listed {
		if !seen[pkg] {
			names = append(names, pkg)
			seen[pkg] = true
		}
	}
	sort.Strings(names)
	failed := false
	for _, pkg := range names {
		min, gated := threshold(pkg)
		if !gated {
			continue
		}
		c, ok := packages[pkg]
		if !ok {
			// A gated package with no block in the profile has no measured
			// coverage at all: a truncated or partial profile must not pass.
			fmt.Fprintf(stdout, "FAIL %s missing from the profile (min %.0f%%)\n", pkg, min)
			failed = true
			continue
		}
		line, ok := gateLine(pkg, c)
		if line == "" {
			continue
		}
		fmt.Fprintln(stdout, line)
		if !ok {
			failed = true
		}
	}
	if failed {
		return 1
	}
	return 0
}

// parseProfile reads a go test coverprofile: "mode: <mode>" then one
// "<file>:<start>,<end> <statements> <count>" line per basic block.
func parseProfile(r io.Reader) ([]block, error) {
	scanner := bufio.NewScanner(r)
	seenMode := false
	var blocks []block
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		if !seenMode {
			if line != "mode: atomic" {
				return nil, fmt.Errorf("coverage profile is missing its atomic mode header: %q", line)
			}
			seenMode = true
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 3 {
			return nil, fmt.Errorf("bad coverage profile line: %q", line)
		}
		colon := strings.LastIndexByte(fields[0], ':')
		if colon < 0 {
			return nil, fmt.Errorf("bad coverage profile position: %q", fields[0])
		}
		file := fields[0][:colon]
		if file == "" {
			return nil, fmt.Errorf("bad coverage profile position: %q", fields[0])
		}
		statements, err := strconv.Atoi(fields[1])
		if err != nil {
			return nil, fmt.Errorf("bad coverage profile statement count: %q", fields[1])
		}
		count, err := strconv.Atoi(fields[2])
		if err != nil {
			return nil, fmt.Errorf("bad coverage profile execution count: %q", fields[2])
		}
		blocks = append(blocks, block{File: file, Statements: statements, Count: count})
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	if !seenMode {
		return nil, fmt.Errorf("coverage profile is empty")
	}
	return blocks, nil
}

// aggregate sums a package's statements and covered statements over its files.
func aggregate(blocks []block) map[string]coverage {
	packages := map[string]coverage{}
	for _, b := range blocks {
		pkg := path.Dir(b.File)
		c := packages[pkg]
		c.Statements += b.Statements
		if b.Count > 0 {
			c.Covered += b.Statements
		}
		packages[pkg] = c
	}
	return packages
}

// threshold returns the minimum coverage percentage for a package and whether
// the gate applies to it at all.
func threshold(pkg string) (float64, bool) {
	rel := strings.TrimPrefix(pkg, modulePath+"/")
	if under(rel, "internal/testkit") || rel == "internal/archtest" ||
		under(rel, "cmd") || under(rel, "scripts") {
		return 0, false
	}
	if under(rel, "internal/domain") {
		return 95.0, true
	}
	if under(rel, "internal") {
		return 90.0, true
	}
	return 0, false
}

func percent(c coverage) float64 {
	if c.Statements == 0 {
		return 100
	}
	return float64(c.Covered) / float64(c.Statements) * 100
}

// gateLine renders the package's verdict line; an exempt package has no line.
func gateLine(pkg string, c coverage) (string, bool) {
	min, gated := threshold(pkg)
	if !gated {
		return "", false
	}
	p := percent(c)
	// The epsilon keeps an exact threshold (19/20 = 95%) from failing on
	// floating-point rounding.
	if p >= min-1e-9 {
		return fmt.Sprintf("ok   %s %.1f%% (min %.0f%%)", pkg, p, min), true
	}
	return fmt.Sprintf("FAIL %s %.1f%% (min %.0f%%)", pkg, p, min), false
}

func under(pkg, prefix string) bool {
	return pkg == prefix || strings.HasPrefix(pkg, prefix+"/")
}
