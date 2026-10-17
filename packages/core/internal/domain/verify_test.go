package domain

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// aChangeSet builds a change set with sensible defaults and shallow overrides.
func aChangeSet(overrides ...func(*ChangeSet)) ChangeSet {
	changes := ChangeSet{
		Added:     []string{},
		Modified:  []string{},
		Deleted:   []string{},
		Untracked: []string{},
	}
	for _, override := range overrides {
		override(&changes)
	}
	return changes
}

// aGateResult builds a gate result with sensible defaults and shallow overrides.
func aGateResult(overrides ...func(*GateResult)) GateResult {
	gate := GateResult{Run: "npm test", ExitCode: i64Ptr(0), DurationMs: 1000}
	for _, override := range overrides {
		override(&gate)
	}
	return gate
}

// aScopeCheck builds a scope check with sensible defaults and shallow overrides.
func aScopeCheck(overrides ...func(*ScopeCheck)) ScopeCheck {
	check := ScopeCheck{OutOfScope: []string{}, Forbidden: []string{}}
	for _, override := range overrides {
		override(&check)
	}
	return check
}

// aReportCheck builds a report check with sensible defaults and shallow overrides.
func aReportCheck(overrides ...func(*ReportCheck)) ReportCheck {
	check := ReportCheck{Present: true, Valid: true, Problems: []string{}}
	for _, override := range overrides {
		override(&check)
	}
	return check
}

func editRules(scope, forbid []string) ScopeRules {
	return ScopeRules{Mode: ModeEdit, Scope: scope, Forbid: forbid}
}

func boolPtr(b bool) *bool { return &b }

func TestCheckScope(t *testing.T) {
	t.Run("edit: paths matching scope and no forbid glob are clean", func(t *testing.T) {
		changes := aChangeSet(func(c *ChangeSet) { c.Modified = []string{"src/a.ts", "src/b/c.ts"} })
		rules := editRules([]string{"src/**"}, []string{"src/secret/**"})
		if got, want := CheckScope(changes, rules), aScopeCheck(); !reflect.DeepEqual(got, want) {
			t.Errorf("CheckScope = %+v, want %+v", got, want)
		}
	})

	t.Run("edit: a path matching no scope glob is outOfScope", func(t *testing.T) {
		changes := aChangeSet(func(c *ChangeSet) { c.Modified = []string{"src/a.ts", "README.md"} })
		rules := editRules([]string{"src/**"}, nil)
		want := aScopeCheck(func(s *ScopeCheck) { s.OutOfScope = []string{"README.md"} })
		if got := CheckScope(changes, rules); !reflect.DeepEqual(got, want) {
			t.Errorf("CheckScope = %+v, want %+v", got, want)
		}
	})

	t.Run("edit: a forbidden path is reported as forbidden even when inside scope (and not double-listed as outOfScope)", func(t *testing.T) {
		changes := aChangeSet(func(c *ChangeSet) {
			c.Modified = []string{"src/a.ts", "src/secret/key.ts", "vendor/x.js"}
		})
		rules := editRules([]string{"src/**"}, []string{"src/secret/**", "vendor/**"})
		want := aScopeCheck(func(s *ScopeCheck) { s.Forbidden = []string{"src/secret/key.ts", "vendor/x.js"} })
		if got := CheckScope(changes, rules); !reflect.DeepEqual(got, want) {
			t.Errorf("CheckScope = %+v, want %+v", got, want)
		}
	})

	t.Run("covers added, modified, deleted and untracked paths alike", func(t *testing.T) {
		changes := aChangeSet(func(c *ChangeSet) {
			c.Added = []string{"docs/1-added.md"}
			c.Modified = []string{"docs/2-modified.md"}
			c.Deleted = []string{"docs/3-deleted.md"}
			c.Untracked = []string{"docs/4-untracked.md"}
		})
		rules := editRules([]string{"src/**"}, []string{"docs/4-*"})
		want := aScopeCheck(func(s *ScopeCheck) {
			s.OutOfScope = []string{"docs/1-added.md", "docs/2-modified.md", "docs/3-deleted.md"}
			s.Forbidden = []string{"docs/4-untracked.md"}
		})
		if got := CheckScope(changes, rules); !reflect.DeepEqual(got, want) {
			t.Errorf("CheckScope = %+v, want %+v", got, want)
		}
	})

	t.Run("matches dotfiles (dot: true) and nested globs (**/x.ts)", func(t *testing.T) {
		changes := aChangeSet(func(c *ChangeSet) {
			c.Modified = []string{"src/.eslintrc.json", "x.ts", "a/b/x.ts", "src/.keys/id.pem"}
		})
		rules := editRules([]string{"src/**", "**/x.ts"}, []string{"**/*.pem"})
		want := aScopeCheck(func(s *ScopeCheck) { s.Forbidden = []string{"src/.keys/id.pem"} })
		if got := CheckScope(changes, rules); !reflect.DeepEqual(got, want) {
			t.Errorf("CheckScope = %+v, want %+v", got, want)
		}
	})

	t.Run("exec/readonly: any change sets repoChanged; no change keeps it false", func(t *testing.T) {
		for _, mode := range []Mode{ModeExec, ModeReadonly} {
			rules := ScopeRules{Mode: mode}
			changed := aChangeSet(func(c *ChangeSet) { c.Untracked = []string{"notes.txt"} })
			wantChanged := aScopeCheck(func(s *ScopeCheck) { s.RepoChanged = true })
			if got := CheckScope(changed, rules); !reflect.DeepEqual(got, wantChanged) {
				t.Errorf("%s: CheckScope(changed) = %+v, want %+v", mode, got, wantChanged)
			}
			if got, want := CheckScope(aChangeSet(), rules), aScopeCheck(); !reflect.DeepEqual(got, want) {
				t.Errorf("%s: CheckScope(clean) = %+v, want %+v", mode, got, want)
			}
		}
	})

	t.Run("results are sorted and de-duplicated", func(t *testing.T) {
		changes := aChangeSet(func(c *ChangeSet) {
			c.Added = []string{"z.md", "b/.env"}
			c.Modified = []string{"a.md", "z.md"}
			c.Untracked = []string{"a/.env", "b/.env"}
		})
		rules := editRules([]string{"src/**"}, []string{"**/.env"})
		want := aScopeCheck(func(s *ScopeCheck) {
			s.OutOfScope = []string{"a.md", "z.md"}
			s.Forbidden = []string{"a/.env", "b/.env"}
		})
		if got := CheckScope(changes, rules); !reflect.DeepEqual(got, want) {
			t.Errorf("CheckScope = %+v, want %+v", got, want)
		}
	})
}

func TestDeriveVerdict(t *testing.T) {
	// Every verification check failing at once: the outcome alone decides which verdict wins.
	everythingFailing := VerdictInput{
		Gates:  []GateResult{aGateResult(func(g *GateResult) { g.ExitCode = i64Ptr(1) })},
		Scope:  aScopeCheck(func(s *ScopeCheck) { s.OutOfScope = []string{"README.md"} }),
		Report: aReportCheck(func(r *ReportCheck) { r.Present = false; r.Valid = false }),
	}
	allClean := VerdictInput{
		Gates:  []GateResult{aGateResult()},
		Scope:  aScopeCheck(),
		Report: aReportCheck(),
	}

	withOutcome := func(input VerdictInput, outcome WorkerOutcome) VerdictInput {
		input.Outcome = outcome
		return input
	}

	t.Run("stopped beats everything", func(t *testing.T) {
		stopped := WorkerOutcome{Kind: WorkerOutcomeStopped}
		if got := DeriveVerdict(withOutcome(everythingFailing, stopped)); got != VerdictStopped {
			t.Errorf("DeriveVerdict(stopped, everything failing) = %q, want stopped", got)
		}
		if got := DeriveVerdict(withOutcome(allClean, stopped)); got != VerdictStopped {
			t.Errorf("DeriveVerdict(stopped, all clean) = %q, want stopped", got)
		}
	})

	t.Run("timeout beats worker_error and verification failures", func(t *testing.T) {
		timeout := WorkerOutcome{Kind: WorkerOutcomeTimeout}
		if got := DeriveVerdict(withOutcome(everythingFailing, timeout)); got != VerdictTimeout {
			t.Errorf("DeriveVerdict(timeout, everything failing) = %q, want timeout", got)
		}
	})

	t.Run("an api_error the provider gave for an empty balance → quota", func(t *testing.T) {
		outcome := WorkerOutcome{
			Kind:    WorkerOutcomeAPIError,
			Message: "Insufficient balance",
			Status:  i64Ptr(429),
			Quota:   boolPtr(true),
		}
		if got := DeriveVerdict(withOutcome(everythingFailing, outcome)); got != VerdictQuota {
			t.Errorf("DeriveVerdict(quota api_error) = %q, want quota", got)
		}
	})

	t.Run("api_error and crashed → worker_error", func(t *testing.T) {
		outcomes := []WorkerOutcome{
			{Kind: WorkerOutcomeAPIError, Message: "429 Too Many Requests", Status: i64Ptr(429)},
			{Kind: WorkerOutcomeCrashed, ExitCode: i64Ptr(1), StderrTail: "boom"},
		}
		for _, outcome := range outcomes {
			if got := DeriveVerdict(withOutcome(everythingFailing, outcome)); got != VerdictWorkerError {
				t.Errorf("%s: DeriveVerdict(everything failing) = %q, want worker_error", outcome.Kind, got)
			}
			if got := DeriveVerdict(withOutcome(allClean, outcome)); got != VerdictWorkerError {
				t.Errorf("%s: DeriveVerdict(all clean) = %q, want worker_error", outcome.Kind, got)
			}
		}
	})

	t.Run("scope violation (outOfScope, forbidden or repoChanged) → scope_violation before report and gates", func(t *testing.T) {
		scopes := []ScopeCheck{
			aScopeCheck(func(s *ScopeCheck) { s.OutOfScope = []string{"README.md"} }),
			aScopeCheck(func(s *ScopeCheck) { s.Forbidden = []string{".env"} }),
			aScopeCheck(func(s *ScopeCheck) { s.RepoChanged = true }),
		}
		for _, scope := range scopes {
			failing := everythingFailing
			failing.Scope = scope
			if got := DeriveVerdict(withOutcome(failing, WorkerOutcome{Kind: WorkerOutcomeCompleted})); got != VerdictScopeViolation {
				t.Errorf("%+v: DeriveVerdict(everything failing) = %q, want scope_violation", scope, got)
			}
			clean := allClean
			clean.Scope = scope
			if got := DeriveVerdict(withOutcome(clean, WorkerOutcome{Kind: WorkerOutcomeCompleted})); got != VerdictScopeViolation {
				t.Errorf("%+v: DeriveVerdict(all clean) = %q, want scope_violation", scope, got)
			}
		}
	})

	t.Run("missing or invalid report → report_invalid before gates", func(t *testing.T) {
		reports := []ReportCheck{
			aReportCheck(func(r *ReportCheck) { r.Present = false; r.Valid = false }),
			aReportCheck(func(r *ReportCheck) { r.Valid = false; r.Problems = []string{"summary: Required"} }),
			aReportCheck(func(r *ReportCheck) { r.Present = false; r.Valid = true }),
		}
		for _, report := range reports {
			failingGates := allClean
			failingGates.Gates = []GateResult{aGateResult(func(g *GateResult) { g.ExitCode = i64Ptr(2) })}
			failingGates.Report = report
			outcome := WorkerOutcome{Kind: WorkerOutcomeCompleted}
			if got := DeriveVerdict(withOutcome(failingGates, outcome)); got != VerdictReportInvalid {
				t.Errorf("%+v: DeriveVerdict(failing gates) = %q, want report_invalid", report, got)
			}
			clean := allClean
			clean.Report = report
			if got := DeriveVerdict(withOutcome(clean, outcome)); got != VerdictReportInvalid {
				t.Errorf("%+v: DeriveVerdict(all clean) = %q, want report_invalid", report, got)
			}
		}
	})

	t.Run("any gate with non-zero exit or timedOut → gate_fail", func(t *testing.T) {
		gates := [][]GateResult{
			{aGateResult(), aGateResult(func(g *GateResult) { g.Run = "npm run lint"; g.ExitCode = i64Ptr(1) })},
			{aGateResult(func(g *GateResult) { g.ExitCode = nil; g.TimedOut = true })},
			{aGateResult(func(g *GateResult) { g.ExitCode = i64Ptr(0); g.TimedOut = true })},
			{aGateResult(func(g *GateResult) { g.ExitCode = nil; g.TimedOut = false })},
		}
		for _, failingGates := range gates {
			input := allClean
			input.Gates = failingGates
			if got := DeriveVerdict(withOutcome(input, WorkerOutcome{Kind: WorkerOutcomeCompleted})); got != VerdictGateFail {
				t.Errorf("%+v: DeriveVerdict = %q, want gate_fail", failingGates, got)
			}
		}
	})

	t.Run("completed + clean scope + valid report + all gates 0 → pass (also with zero gates)", func(t *testing.T) {
		passing := allClean
		passing.Gates = []GateResult{aGateResult(), aGateResult(func(g *GateResult) { g.Run = "npm run lint" })}
		outcome := WorkerOutcome{Kind: WorkerOutcomeCompleted}
		if got := DeriveVerdict(withOutcome(passing, outcome)); got != VerdictPass {
			t.Errorf("DeriveVerdict = %q, want pass", got)
		}
		noGates := allClean
		noGates.Gates = []GateResult{}
		if got := DeriveVerdict(withOutcome(noGates, outcome)); got != VerdictPass {
			t.Errorf("DeriveVerdict(zero gates) = %q, want pass", got)
		}
	})
}

func TestChangedPaths(t *testing.T) {
	t.Run("unions all four lists, sorted, without duplicates", func(t *testing.T) {
		changes := aChangeSet(func(c *ChangeSet) {
			c.Added = []string{"b.ts", "a.ts"}
			c.Modified = []string{"c.ts", "a.ts"}
			c.Deleted = []string{"old.ts"}
			c.Untracked = []string{".env", "b.ts"}
		})
		want := []string{".env", "a.ts", "b.ts", "c.ts", "old.ts"}
		if got := ChangedPaths(changes); !reflect.DeepEqual(got, want) {
			t.Errorf("ChangedPaths = %v, want %v", got, want)
		}
		if got := ChangedPaths(aChangeSet()); len(got) != 0 {
			t.Errorf("ChangedPaths(empty) = %v, want empty", got)
		}
	})

	t.Run("sorts by UTF-16 code units, the unit JS sort compares", func(t *testing.T) {
		changes := aChangeSet(func(c *ChangeSet) {
			c.Added = []string{"\U0001F600.ts", "￿.ts", "a.ts.bak"}
			c.Modified = []string{"old.ts", "a.ts"}
		})
		want := []string{"a.ts", "a.ts.bak", "old.ts", "\U0001F600.ts", "￿.ts"}
		if got := ChangedPaths(changes); !reflect.DeepEqual(got, want) {
			t.Errorf("ChangedPaths = %q, want %q", got, want)
		}
	})
}

// The goldens are picomatch's own answers over a fixed matrix of patterns x paths
// (picomatch([pattern], { dot: true })). The Go matcher must answer the same.
func TestGlobMatrix(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "glob", "matrix.json"))
	if err != nil {
		t.Fatalf("read matrix: %v", err)
	}
	var rows []struct {
		Pattern string `json:"pattern"`
		Path    string `json:"path"`
		Match   bool   `json:"match"`
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("decode matrix: %v", err)
	}
	if len(rows) < 25*25 {
		t.Fatalf("matrix has %d rows, want at least 25 x 25", len(rows))
	}
	for _, row := range rows {
		if got := anyGlob([]string{row.Pattern}, row.Path); got != row.Match {
			t.Errorf("anyGlob([%q], %q) = %v, want %v", row.Pattern, row.Path, got, row.Match)
		}
	}
}
