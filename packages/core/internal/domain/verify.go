package domain

import (
	"sort"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
)

// ScopeRules are the brief's mode, scope and forbid globs, what a change set is checked against.
type ScopeRules struct {
	Mode   Mode
	Scope  []string
	Forbid []string
}

// CheckScope checks a change set against the brief's rules. Glob semantics are picomatch with
// dot: true; paths are repo-relative POSIX. edit: every changed path must match some scope glob
// and no forbid glob. exec/readonly: any change at all sets repoChanged.
func CheckScope(changes ChangeSet, rules ScopeRules) ScopeCheck {
	paths := ChangedPaths(changes)
	if rules.Mode != ModeEdit {
		return ScopeCheck{
			OutOfScope:  []string{},
			Forbidden:   []string{},
			RepoChanged: len(paths) > 0,
		}
	}
	outOfScope := make([]string, 0, len(paths))
	forbidden := make([]string, 0, len(paths))
	for _, path := range paths {
		switch {
		case anyGlob(rules.Forbid, path):
			forbidden = append(forbidden, path)
		case !anyGlob(rules.Scope, path):
			outOfScope = append(outOfScope, path)
		}
	}
	return ScopeCheck{OutOfScope: outOfScope, Forbidden: forbidden, RepoChanged: false}
}

// AnyGlob reports whether path matches at least one of the globs in picomatch's list form, the
// same matching the scope check uses; adapters reuse it for regenerate paths.
func AnyGlob(globs []string, path string) bool {
	return anyGlob(globs, path)
}

// anyGlob reports whether the path matches at least one glob, picomatch's list form: positives
// match if any does, a `!`-prefixed glob subtracts, and a list of only negations starts from
// "everything" (an empty list matches nothing).
func anyGlob(globs []string, path string) bool {
	positives := make([]string, 0, len(globs))
	negatives := make([]string, 0, len(globs))
	for _, glob := range globs {
		if strings.HasPrefix(glob, "!") {
			negatives = append(negatives, glob[1:])
		} else {
			positives = append(positives, glob)
		}
	}
	matched := false
	if len(positives) > 0 {
		matched = globListMatches(positives, path)
	} else if len(negatives) > 0 {
		matched = true
	}
	return matched && !globListMatches(negatives, path)
}

// globListMatches is the any-of over one kind of glob (positive or negative).
func globListMatches(globs []string, path string) bool {
	for _, glob := range globs {
		if matchGlob(glob, path) {
			return true
		}
	}
	return false
}

// matchGlob is one glob against one path, picomatch with dot: true. doublestar answers most of
// picomatch's semantics; the places the golden matrix catches them disagreeing are adjusted
// around it:
//   - picomatch normalizes a leading `./` on patterns but never on paths, so no pattern at all
//     matches a `./`-prefixed path;
//   - a wildcard pattern matches a trailing-slash path through its trimmed form only (`src/*`
//     matches `src/b/`), a literal pattern never does (`src` does not match `src/`);
//   - `!` inside a `[...]` class is a member (`[!a]` matches "a"), not a negation;
//   - doublestar lets a trailing `/*` match the directory itself (`src/*` against `src`);
//     picomatch requires the separator the `*` follows.
func matchGlob(pattern, path string) bool {
	if strings.HasPrefix(pattern, "./") {
		pattern = pattern[2:]
	}
	if strings.HasPrefix(path, "./") {
		return false
	}
	pattern = classBangToMember(pattern)
	// A pattern that itself ends with a slash (`docs/`, `docs/**/`) matches only slashed paths
	// (`docs/intro/`, not `docs`); any other wildcard pattern matches a slashed path through its
	// trimmed form (`src/**` matches `src/` as `src`).
	if strings.HasSuffix(pattern, "/") && !strings.HasSuffix(path, "/") {
		return false
	}
	target := path
	if !strings.HasSuffix(pattern, "/") && strings.HasSuffix(target, "/") &&
		strings.ContainsAny(pattern, "*?[{") {
		target = strings.TrimSuffix(target, "/")
	}
	if ok, _ := doublestar.Match(pattern, target); ok {
		return !(strings.HasSuffix(pattern, "/*") && target == pattern[:len(pattern)-2])
	}
	return false
}

// classBangToMember rewrites a leading ! inside a [...] class into a trailing member: picomatch
// matches `[!a]` as "a or !", while doublestar negates it; `[^a]` is the negation in both.
func classBangToMember(pattern string) string {
	var out strings.Builder
	out.Grow(len(pattern))
	for i := 0; i < len(pattern); i++ {
		if pattern[i] != '[' || i+1 >= len(pattern) || pattern[i+1] != '!' {
			out.WriteByte(pattern[i])
			continue
		}
		out.WriteByte('[')
		i++
		for i+1 < len(pattern) && pattern[i+1] != ']' {
			i++
			out.WriteByte(pattern[i])
		}
		if i+1 < len(pattern) && pattern[i+1] == ']' {
			out.WriteString("!]")
			i++
		}
	}
	return out.String()
}

// VerdictInput is everything that goes into a verdict: the worker outcome and the verification's
// three checks.
type VerdictInput struct {
	Outcome WorkerOutcome
	Gates   []GateResult
	Scope   ScopeCheck
	Report  ReportCheck
}

// DeriveVerdict is the verdict of one finished attempt. Precedence, first match wins: stopped,
// timeout, quota (an api_error the provider gave for an empty balance), worker_error (any other
// api_error | crashed), scope_violation, report_invalid, gate_fail (any non-zero exit or timed-out
// gate), pass.
func DeriveVerdict(input VerdictInput) Verdict {
	switch input.Outcome.Kind {
	case WorkerOutcomeStopped:
		return VerdictStopped
	case WorkerOutcomeTimeout:
		return VerdictTimeout
	case WorkerOutcomeAPIError:
		if input.Outcome.Quota != nil && *input.Outcome.Quota {
			return VerdictQuota
		}
		return VerdictWorkerError
	case WorkerOutcomeCrashed:
		return VerdictWorkerError
	default:
		return verificationVerdict(input)
	}
}

// verificationVerdict is the verdict of a completed attempt: the verification checks in
// precedence order.
func verificationVerdict(input VerdictInput) Verdict {
	if scopeViolated(input.Scope) {
		return VerdictScopeViolation
	}
	if !input.Report.Present || !input.Report.Valid {
		return VerdictReportInvalid
	}
	for _, gate := range input.Gates {
		if GateFailed(gate) {
			return VerdictGateFail
		}
	}
	return VerdictPass
}

// GateFailed reports whether a gate counts as failed. A gate killed by a signal has a null exit
// code and counts as failed.
func GateFailed(gate GateResult) bool {
	return gate.TimedOut || gate.ExitCode == nil || *gate.ExitCode != 0
}

// scopeViolated reports whether the scope check found any violation.
func scopeViolated(scope ScopeCheck) bool {
	return scope.RepoChanged || len(scope.OutOfScope) > 0 || len(scope.Forbidden) > 0
}

// ChangedPaths is all paths of a change set, sorted, de-duplicated.
func ChangedPaths(changes ChangeSet) []string {
	seen := make(map[string]bool, len(changes.Added)+len(changes.Modified)+len(changes.Deleted)+len(changes.Untracked))
	paths := make([]string, 0, len(seen))
	for _, list := range [][]string{changes.Added, changes.Modified, changes.Deleted, changes.Untracked} {
		for _, path := range list {
			if !seen[path] {
				seen[path] = true
				paths = append(paths, path)
			}
		}
	}
	sortStringsUTF16(paths)
	return paths
}

// sortStringsUTF16 sorts in place, by UTF-16 code units.
func sortStringsUTF16(paths []string) {
	sort.Slice(paths, func(i, j int) bool { return utf16Less(paths[i], paths[j]) })
}

// utf16Less orders strings the way JS sort does: by UTF-16 code units, not bytes or runes.
func utf16Less(a, b string) bool {
	left, right := utf16Units(a), utf16Units(b)
	for i := 0; i < len(left) && i < len(right); i++ {
		if left[i] != right[i] {
			return left[i] < right[i]
		}
	}
	return len(left) < len(right)
}

// utf16Units is the string's UTF-16 code unit sequence; a rune beyond the BMP is its surrogate
// pair.
func utf16Units(text string) []uint16 {
	units := make([]uint16, 0, len(text))
	for _, r := range text {
		if r > 0xFFFF {
			r -= 0x10000
			units = append(units, uint16(0xD800+(r>>10)), uint16(0xDC00+(r&0x3FF)))
		} else {
			units = append(units, uint16(r))
		}
	}
	return units
}
