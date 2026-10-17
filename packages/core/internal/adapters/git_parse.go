package adapters

import (
	"sort"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// Splitting and classifying git's machine-readable output.

// ChompNewline drops one trailing newline: single-value outputs (a sha, a path) end with exactly
// one; a path may itself end in whitespace.
func ChompNewline(text string) string {
	if strings.HasSuffix(text, "\n") {
		return text[:len(text)-1]
	}
	return text
}

// SplitNul splits git's -z output into its NUL-terminated records.
func SplitNul(text string) []string {
	records := strings.Split(text, "\x00")
	if len(records) > 0 && records[len(records)-1] == "" {
		records = records[:len(records)-1]
	}
	return records
}

// ParseNameStatus parses `git diff --name-status -z --no-renames` into added/modified/deleted, each
// sorted. Records alternate status, path. Without rename detection every status but A and D (M, T,
// U) is a modification of a path that exists on both sides. Untracked stays empty: name-status
// lists only tracked paths.
func ParseNameStatus(text string) domain.ChangeSet {
	added := make([]string, 0)
	modified := make([]string, 0)
	deleted := make([]string, 0)
	status := ""
	pending := false
	for _, record := range SplitNul(text) {
		if !pending {
			status = record
			pending = true
			continue
		}
		switch status {
		case "A":
			added = append(added, record)
		case "D":
			deleted = append(deleted, record)
		default:
			modified = append(modified, record)
		}
		pending = false
	}
	sort.Strings(added)
	sort.Strings(modified)
	sort.Strings(deleted)
	return domain.ChangeSet{Added: added, Modified: modified, Deleted: deleted}
}

// StatusEntry is one path in git's porcelain status.
type StatusEntry struct {
	Path string
	// Staged: the index differs from HEAD for this path (X column).
	Staged bool
}

// ParseStatus parses `git status --porcelain=v1 -z --no-renames`: each record is `XY <path>`.
func ParseStatus(text string) []StatusEntry {
	records := SplitNul(text)
	entries := make([]StatusEntry, 0, len(records))
	for _, record := range records {
		staged := false
		if len(record) > 0 {
			staged = record[0] != ' ' && record[0] != '?'
		}
		path := ""
		if len(record) >= 3 {
			path = record[3:]
		}
		entries = append(entries, StatusEntry{Path: path, Staged: staged})
	}
	return entries
}

// UnmergedPaths parses `git ls-files -u -z` (`<mode> <object> <stage>\t<path>` per stage) into the
// unmerged paths, sorted, once each.
func UnmergedPaths(text string) []string {
	seen := make(map[string]bool)
	paths := make([]string, 0)
	for _, record := range SplitNul(text) {
		path := record
		if i := strings.IndexByte(record, '\t'); i >= 0 {
			path = record[i+1:]
		}
		if !seen[path] {
			seen[path] = true
			paths = append(paths, path)
		}
	}
	sort.Strings(paths)
	return paths
}
