package domain

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The prompt builder and its three section files. The snapshots live in testdata/prompt/, one
// file per snapshot, compared byte for byte.

const promptArtifacts = "/state/jobs/j1/artifacts"

// promptVerification builds a verification with sensible defaults and shallow overrides.
func promptVerification(overrides ...func(*Verification)) Verification {
	verification := Verification{
		Gates:   []GateResult{},
		Changes: aChangeSet(),
		Scope:   aScopeCheck(),
		Report:  aReportCheck(),
	}
	for _, override := range overrides {
		override(&verification)
	}
	return verification
}

// promptFailedAttempt is a finished attempt that failed verification in the given ways (everything else
// clean).
func promptFailedAttempt(verdict Verdict, overrides ...func(*Verification)) Attempt {
	completed := WorkerOutcome{Kind: WorkerOutcomeCompleted}
	verification := promptVerification(overrides...)
	return anAttempt(func(a *Attempt) {
		a.Outcome = &completed
		a.Verification = &verification
		a.Verdict = &verdict
	})
}

func requireContains(t *testing.T, text, substr string) {
	t.Helper()
	if !strings.Contains(text, substr) {
		t.Fatalf("text does not contain %q; text: %q", substr, text)
	}
}

func requireNotContains(t *testing.T, text, substr string) {
	t.Helper()
	if strings.Contains(text, substr) {
		t.Fatalf("text must not contain %q; text: %q", substr, text)
	}
}

func requireMatches(t *testing.T, pattern, text string) {
	t.Helper()
	if !regexp.MustCompile(pattern).MatchString(text) {
		t.Fatalf("text does not match %s; text: %q", pattern, text)
	}
}

// snapshotFile maps a test name to its golden filename: lowercased, every run of characters
// outside [a-z0-9] folded to one '-', trimmed at both ends.
func snapshotFile(name string) string {
	var out strings.Builder
	dash := false
	for _, r := range strings.ToLower(name) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			out.WriteRune(r)
			dash = false
			continue
		}
		if !dash && out.Len() > 0 {
			out.WriteByte('-')
			dash = true
		}
	}
	return strings.Trim(out.String(), "-") + ".txt"
}

func TestSnapshotFile(t *testing.T) {
	cases := []struct{ name, file string }{
		{"is stable: snapshot per mode (edit)", "is-stable-snapshot-per-mode-edit.txt"},
		{"names the verdict: 'timed out', a/b", "names-the-verdict-timed-out-a-b.txt"},
		{"  - leading and trailing runs: gone!  ", "leading-and-trailing-runs-gone.txt"},
	}
	for _, c := range cases {
		if got := snapshotFile(c.name); got != c.file {
			t.Fatalf("snapshotFile(%q) = %q, want %q", c.name, got, c.file)
		}
	}
}

// requireGolden compares bytes with the test's snapshot file under testdata/prompt/.
func requireGolden(t *testing.T, name, text string) {
	t.Helper()
	golden, err := os.ReadFile(filepath.Join("..", "..", "testdata", "prompt", snapshotFile(name)))
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	if !bytes.Equal(golden, []byte(text)) {
		t.Fatalf("%s: got:\n%s\nwant:\n%s", name, text, string(golden))
	}
}

func TestInitialPrompt(t *testing.T) {
	t.Run("starts with the brief body verbatim and ends with the contract footer", func(t *testing.T) {
		body := "Rename `foo` to `bar`.\n\n  - keep the *exact* spacing  \n"
		prompt := InitialPrompt(aBrief(func(b *Brief) { b.Body = body }), promptArtifacts, referenceProvider)
		if !strings.HasPrefix(prompt, body) {
			t.Fatalf("prompt does not start with the body: %q", prompt)
		}
		requireMatches(t, `^\n## zai contract\n`, prompt[len(body):])
		if !strings.HasSuffix(prompt, "\n") {
			t.Fatalf("prompt does not end with a newline: %q", prompt)
		}
		requireMatches(t, `^No trailing newline\n\n## zai contract\n`,
			InitialPrompt(aBrief(func(b *Brief) { b.Body = "No trailing newline" }), promptArtifacts, referenceProvider))
	})

	t.Run("edit footer: names the worktree rule, lists scope and forbid globs, says do not commit", func(t *testing.T) {
		brief := aBrief(func(b *Brief) {
			b.Mode = ModeEdit
			b.Scope = []string{"src/**", "test/**"}
			b.Forbid = []string{"src/generated/**"}
		})
		prompt := InitialPrompt(brief, promptArtifacts, referenceProvider)
		requireContains(t, prompt, "isolated git worktree")
		requireContains(t, prompt, "Change only files matching these globs:\n- `src/**`\n- `test/**`\n")
		requireContains(t, prompt, "Never touch files matching these globs, even inside scope:\n- `src/generated/**`\n")
		requireContains(t, prompt, "Do not commit")
		requireNotContains(t,
			InitialPrompt(aBrief(func(b *Brief) { b.Forbid = []string{} }), promptArtifacts, referenceProvider),
			"Never touch")
	})

	t.Run("exec footer: says the repository must stay unchanged and names the artifacts dir", func(t *testing.T) {
		prompt := InitialPrompt(aBrief(func(b *Brief) { b.Mode = ModeExec; b.Scope = []string{} }),
			promptArtifacts, referenceProvider)
		requireContains(t, prompt, "The repository must stay unchanged")
		requireContains(t, prompt, "Write every output file to "+promptArtifacts+" (also in $ZAI_ARTIFACTS).")
		requireNotContains(t, prompt, "worktree")
		requireNotContains(t, prompt, "Change only files matching")
		requireContains(t, prompt, "Do not commit")
	})

	t.Run("readonly footer: says read-only investigation, no file changes", func(t *testing.T) {
		prompt := InitialPrompt(aBrief(func(b *Brief) { b.Mode = ModeReadonly; b.Scope = []string{} }),
			promptArtifacts, referenceProvider)
		requireContains(t, prompt, "This is a read-only investigation.")
		requireContains(t, prompt, "Do not create, edit or delete any file.")
		requireNotContains(t, prompt, "worktree")
		requireNotContains(t, prompt, promptArtifacts)
	})

	t.Run("lists every gate command exactly as the plugin will run it, or says there are none", func(t *testing.T) {
		gates := []Gate{
			{Run: "npm test -- --reporter=dot", TimeoutMs: 600_000},
			{Run: "test \"$(git status --porcelain)\" = ''", TimeoutMs: 60_000},
		}
		prompt := InitialPrompt(aBrief(func(b *Brief) { b.Gates = gates }), promptArtifacts, referenceProvider)
		requireContains(t, prompt, "```sh\nnpm test -- --reporter=dot\ntest \"$(git status --porcelain)\" = ''\n```\n")
		requireContains(t, prompt, "Each must exit 0.")
		withFence := InitialPrompt(
			aBrief(func(b *Brief) { b.Gates = []Gate{{Run: "echo '```'", TimeoutMs: 1}} }),
			promptArtifacts, referenceProvider)
		requireContains(t, withFence, "````sh\necho '```'\n````\n")
		none := InitialPrompt(aBrief(), promptArtifacts, referenceProvider)
		requireContains(t, none, "No gates: the plugin runs no checks after you finish.")
		requireNotContains(t, none, "```sh")
	})

	briefs := []Brief{
		aBrief(),
		aBrief(func(b *Brief) {
			b.Mode = ModeExec
			b.Scope = []string{}
			b.Report = Report{Kind: ReportKindBuiltin, Name: BuiltinReportSweep}
		}),
		aBrief(func(b *Brief) {
			b.Mode = ModeReadonly
			b.Scope = []string{}
			b.Report = Report{Kind: ReportKindFile, Path: "/repo/schemas/audit.json"}
		}),
	}
	for _, brief := range briefs {
		t.Run("always says never print or write secrets and to finish with the structured report", func(t *testing.T) {
			prompt := InitialPrompt(brief, promptArtifacts, referenceProvider)
			requireContains(t, prompt, "Never print, log or write secrets")
			requireMatches(t, `End your run with the structured report[^\n]*\n$`, prompt)
			if brief.Report.Kind == ReportKindBuiltin {
				requireContains(t, prompt, "(schema: "+string(brief.Report.Name)+")")
			} else {
				requireContains(t, prompt, "(schema file: "+brief.Report.Path+")")
			}
		})
	}

	t.Run("is stable: snapshot of an edit brief without forbid globs or gates", func(t *testing.T) {
		requireGolden(t, "is stable: snapshot of an edit brief without forbid globs or gates",
			InitialPrompt(aBrief(), promptArtifacts, referenceProvider))
	})

	t.Run("is stable: snapshot per mode", func(t *testing.T) {
		gates := []Gate{
			{Run: "npm test", TimeoutMs: 600_000},
			{Run: "npm run lint", TimeoutMs: 300_000},
		}
		requireGolden(t, "is stable: snapshot per mode (edit)", InitialPrompt(aBrief(func(b *Brief) {
			b.Mode = ModeEdit
			b.Scope = []string{"src/**"}
			b.Forbid = []string{"src/generated/**"}
			b.Gates = gates
		}), promptArtifacts, referenceProvider))
		requireGolden(t, "is stable: snapshot per mode (exec)", InitialPrompt(aBrief(func(b *Brief) {
			b.Mode = ModeExec
			b.Scope = []string{}
			b.Gates = gates
			b.Report = Report{Kind: ReportKindBuiltin, Name: BuiltinReportSweep}
		}), promptArtifacts, referenceProvider))
		requireGolden(t, "is stable: snapshot per mode (readonly)", InitialPrompt(aBrief(func(b *Brief) {
			b.Mode = ModeReadonly
			b.Scope = []string{}
			b.Report = Report{Kind: ReportKindBuiltin, Name: BuiltinReportNotes}
		}), promptArtifacts, referenceProvider))
	})
}

func TestAutoFixPrompt(t *testing.T) {
	t.Run("names the verdict and quotes each failing gate with command, exit code or 'timed out', and its tail", func(t *testing.T) {
		failed := promptFailedAttempt(VerdictGateFail, func(v *Verification) {
			v.Gates = []GateResult{
				aGateResult(func(g *GateResult) { g.Run = "npm run build"; g.ExitCode = i64Ptr(0); g.Tail = "built" }),
				aGateResult(func(g *GateResult) {
					g.Run = "npm test"
					g.ExitCode = i64Ptr(1)
					g.Tail = "FAIL src/a.test.ts\n  expected 2, got 3"
				}),
				aGateResult(func(g *GateResult) {
					g.Run = "npm run e2e"
					g.ExitCode = nil
					g.TimedOut = true
					g.Tail = "waiting for server"
				}),
				aGateResult(func(g *GateResult) { g.Run = "make lint"; g.ExitCode = nil }),
			}
		})
		prompt := AutoFixPrompt(aBrief(), failed)
		requireMatches(t, `^Verification failed: gate_fail\.\n`, prompt)
		requireContains(t, prompt,
			"Gate failed: `npm test` (exit 1)\n```text\nFAIL src/a.test.ts\n  expected 2, got 3\n```\n")
		requireContains(t, prompt, "Gate failed: `npm run e2e` (timed out)\n```text\nwaiting for server\n```\n")
		requireContains(t, prompt, "Gate failed: `make lint` (killed, no exit code)\n```text\n(no output)\n```\n")
		requireNotContains(t, prompt, "npm run build")
	})

	t.Run("bounds each tail to limits.gateTailChars, keeping the END of the output, with a truncation marker", func(t *testing.T) {
		tail := strings.Repeat("x", 30) + "THE END"
		failed := promptFailedAttempt(VerdictGateFail, func(v *Verification) {
			v.Gates = []GateResult{aGateResult(func(g *GateResult) { g.ExitCode = i64Ptr(1); g.Tail = tail })}
		})
		prompt := AutoFixPrompt(aBrief(), failed, PromptLimits{GateTailChars: 10, PathsListed: 50})
		requireContains(t, prompt, "```text\n[27 earlier characters cut]\nxxxTHE END\n```")
		exact := promptFailedAttempt(VerdictGateFail, func(v *Verification) {
			v.Gates = []GateResult{aGateResult(func(g *GateResult) { g.ExitCode = i64Ptr(1); g.Tail = "0123456789" })}
		})
		requireContains(t, AutoFixPrompt(aBrief(), exact, PromptLimits{GateTailChars: 10, PathsListed: 50}),
			"```text\n0123456789\n```")
		// The cut counts UTF-16 code units, as JavaScript does: an emoji is two units, so a
		// 3-unit budget keeps "abc" and reports 2 cut.
		emoji := promptFailedAttempt(VerdictGateFail, func(v *Verification) {
			v.Gates = []GateResult{aGateResult(func(g *GateResult) { g.ExitCode = i64Ptr(1); g.Tail = "😀abc" })}
		})
		requireContains(t, AutoFixPrompt(aBrief(), emoji, PromptLimits{GateTailChars: 3, PathsListed: 50}),
			"```text\n[2 earlier characters cut]\nabc\n```")
	})

	t.Run("lists outOfScope and forbidden paths up to limits.pathsListed with an 'and N more' line", func(t *testing.T) {
		failed := promptFailedAttempt(VerdictScopeViolation, func(v *Verification) {
			v.Scope = aScopeCheck(func(s *ScopeCheck) {
				s.OutOfScope = []string{"README.md", "docs/a.md", "docs/b.md"}
				s.Forbidden = []string{".env"}
			})
		})
		prompt := AutoFixPrompt(aBrief(), failed, PromptLimits{GateTailChars: 4000, PathsListed: 2})
		requireContains(t, prompt,
			"Changed outside scope. Revert these changes:\n- `README.md`\n- `docs/a.md`\n- and 1 more\n")
		requireContains(t, prompt, "Changed forbidden paths. Revert these changes:\n- `.env`\n")
		requireNotContains(t, prompt, "and 0 more")
		exactlyMax := promptFailedAttempt(VerdictScopeViolation, func(v *Verification) {
			v.Scope = aScopeCheck(func(s *ScopeCheck) { s.OutOfScope = []string{"a.md", "b.md"} })
		})
		requireContains(t, AutoFixPrompt(aBrief(), exactlyMax, PromptLimits{GateTailChars: 4000, PathsListed: 2}),
			"Revert these changes:\n- `a.md`\n- `b.md`\n\nMake the smallest change")
	})

	t.Run("says repository changed for exec/readonly scope violations", func(t *testing.T) {
		for _, mode := range []Mode{ModeExec, ModeReadonly} {
			failed := promptFailedAttempt(VerdictScopeViolation, func(v *Verification) {
				v.Changes = aChangeSet(func(c *ChangeSet) {
					c.Modified = []string{"src/a.ts"}
					c.Untracked = []string{"out.json", "notes.md"}
				})
				v.Scope = aScopeCheck(func(s *ScopeCheck) { s.RepoChanged = true })
			})
			prompt := AutoFixPrompt(aBrief(func(b *Brief) { b.Mode = mode; b.Scope = []string{} }), failed,
				PromptLimits{GateTailChars: 4000, PathsListed: 2})
			requireContains(t, prompt,
				"The repository changed, but this job must leave it unchanged. Revert these changes:\n- `notes.md`\n- `out.json`\n- and 1 more\n")
		}
	})

	t.Run("for report_invalid quotes the report problems", func(t *testing.T) {
		invalid := promptFailedAttempt(VerdictReportInvalid, func(v *Verification) {
			v.Report = aReportCheck(func(r *ReportCheck) {
				r.Valid = false
				r.Problems = []string{"summary: Required", "files.0.why: Expected string"}
			})
		})
		requireContains(t, AutoFixPrompt(aBrief(), invalid),
			"The structured report is invalid:\n- summary: Required\n- files.0.why: Expected string\n")
		missing := promptFailedAttempt(VerdictReportInvalid, func(v *Verification) {
			v.Report = aReportCheck(func(r *ReportCheck) { r.Present = false; r.Valid = false })
		})
		requireContains(t, AutoFixPrompt(aBrief(), missing), "The structured report is missing.")
	})

	t.Run("does not repeat the brief body", func(t *testing.T) {
		brief := aBrief(func(b *Brief) { b.Body = "UNIQUE-BRIEF-BODY: rename every helper." })
		failed := promptFailedAttempt(VerdictGateFail, func(v *Verification) {
			v.Gates = []GateResult{aGateResult(func(g *GateResult) { g.ExitCode = i64Ptr(1); g.Tail = "boom" })}
		})
		prompt := AutoFixPrompt(brief, failed)
		requireNotContains(t, prompt, "UNIQUE-BRIEF-BODY")
		requireNotContains(t, prompt, "## zai contract")
	})

	t.Run("asks for the smallest change that fixes exactly these failures", func(t *testing.T) {
		failed := promptFailedAttempt(VerdictGateFail, func(v *Verification) {
			v.Gates = []GateResult{aGateResult(func(g *GateResult) { g.ExitCode = i64Ptr(1); g.Tail = "boom" })}
		})
		requireMatches(t,
			`\n\nMake the smallest change that fixes exactly these failures\. Keep everything else as it is\.\n[^\n]*structured report[^\n]*\n$`,
			AutoFixPrompt(aBrief(), failed))
	})

	t.Run("names only the verdict when the attempt was never verified", func(t *testing.T) {
		crashed := anAttempt(func(a *Attempt) {
			verdict := VerdictWorkerError
			a.Verdict = &verdict
			timeout := WorkerOutcome{Kind: WorkerOutcomeTimeout}
			a.Outcome = &timeout
		})
		requireMatches(t, `^Verification failed: worker_error\.\n\nMake the smallest change`,
			AutoFixPrompt(aBrief(), crashed))
		requireMatches(t, `^Verification failed: no verdict\.\n`, AutoFixPrompt(aBrief(), anAttempt()))
	})

	t.Run("does not add a blank line inside the fence when the tail already ends with a newline", func(t *testing.T) {
		failed := promptFailedAttempt(VerdictGateFail, func(v *Verification) {
			v.Gates = []GateResult{aGateResult(func(g *GateResult) { g.ExitCode = i64Ptr(2); g.Tail = "boom\n" })}
		})
		requireContains(t, AutoFixPrompt(aBrief(), failed), "(exit 2)\n```text\nboom\n```\n")
	})

	t.Run("is stable: snapshot of a mixed failure", func(t *testing.T) {
		failed := promptFailedAttempt(VerdictScopeViolation, func(v *Verification) {
			v.Gates = []GateResult{
				aGateResult(func(g *GateResult) { g.Run = "npm run build" }),
				aGateResult(func(g *GateResult) { g.Run = "npm test"; g.ExitCode = i64Ptr(1); g.Tail = "1 failed" }),
			}
			v.Changes = aChangeSet(func(c *ChangeSet) { c.Modified = []string{"src/a.ts", "README.md"} })
			v.Scope = aScopeCheck(func(s *ScopeCheck) { s.OutOfScope = []string{"README.md"} })
			v.Report = aReportCheck(func(r *ReportCheck) {
				r.Valid = false
				r.Problems = []string{"summary: Required"}
			})
		})
		requireGolden(t, "is stable: snapshot of a mixed failure", AutoFixPrompt(aBrief(), failed))
	})

	t.Run("is stable: snapshot of a single gate failure (no scope or report sections)", func(t *testing.T) {
		failed := promptFailedAttempt(VerdictGateFail, func(v *Verification) {
			v.Gates = []GateResult{aGateResult(func(g *GateResult) { g.ExitCode = i64Ptr(1); g.Tail = "1 failed" })}
		})
		requireGolden(t, "is stable: snapshot of a single gate failure (no scope or report sections)",
			AutoFixPrompt(aBrief(), failed))
	})
}

func TestReviewFixPrompt(t *testing.T) {
	t.Run("carries the reviewer feedback verbatim, clearly delimited", func(t *testing.T) {
		feedback := "Also rename the CLI flag.\n\n```ts\nconst bar = 1;\n```\n  Keep the old flag as an alias."
		prompt := ReviewFixPrompt(aBrief(), promptFailedAttempt(VerdictPass), feedback)
		requireMatches(t, `^The reviewer returned your work with this feedback:\n`, prompt)
		requireContains(t, prompt, "````text\n"+feedback+"\n````\n")
	})

	t.Run("includes a one-line verification summary of the last attempt", func(t *testing.T) {
		passed := anAttempt(func(a *Attempt) {
			a.N = 2
			a.Kind = AttemptKindAutoFix
			verdict := VerdictPass
			a.Verdict = &verdict
			verification := promptVerification(func(v *Verification) {
				v.Gates = []GateResult{aGateResult(), aGateResult(func(g *GateResult) { g.Run = "npm run lint" })}
				v.Changes = aChangeSet(func(c *ChangeSet) {
					c.Modified = []string{"src/a.ts", "src/b.ts"}
					c.Added = []string{"src/c.ts"}
				})
			})
			a.Verification = &verification
		})
		requireContains(t, ReviewFixPrompt(aBrief(), passed, "Rename the flag too."),
			"\n\nLast attempt #2 (auto_fix): pass; gates 2/2 passed; 3 changed paths, in scope; report valid.\n")
	})

	t.Run("quotes the last attempt's failures, bounded by limits, when it did not pass", func(t *testing.T) {
		failed := promptFailedAttempt(VerdictGateFail, func(v *Verification) {
			v.Gates = []GateResult{aGateResult(func(g *GateResult) { g.ExitCode = i64Ptr(1); g.Tail = "0123456789" })}
		})
		prompt := ReviewFixPrompt(aBrief(), failed, "Fix the test.", PromptLimits{GateTailChars: 4, PathsListed: 50})
		requireContains(t, prompt, "Gate failed: `npm test` (exit 1)\n```text\n[6 earlier characters cut]\n6789\n```\n")
		requireNotContains(t, ReviewFixPrompt(aBrief(), promptFailedAttempt(VerdictPass), "Fix the test."), "Gate failed")
	})

	t.Run("ends by asking for the smallest change that addresses the feedback, under the same contract", func(t *testing.T) {
		requireMatches(t,
			`\n\nAddress the feedback with the smallest change that satisfies it\. Keep everything else as it is\.\nThe contract from your first message still applies\. End your run with the structured report\.\n$`,
			ReviewFixPrompt(aBrief(), promptFailedAttempt(VerdictPass), "Rename the flag too."))
	})
}

func TestSelfContainedPrompt(t *testing.T) {
	t.Run("contains the brief body, one line per previous attempt (n, kind, verdict) and the new instruction", func(t *testing.T) {
		history := []Attempt{
			promptFailedAttempt(VerdictGateFail, func(v *Verification) {
				v.Gates = []GateResult{aGateResult(func(g *GateResult) { g.ExitCode = i64Ptr(1) })}
			}),
			anAttempt(func(a *Attempt) {
				a.N = 2
				a.Kind = AttemptKindAutoFix
				verdict := VerdictWorkerError
				a.Verdict = &verdict
				timeout := WorkerOutcome{Kind: WorkerOutcomeTimeout}
				a.Outcome = &timeout
			}),
			anAttempt(func(a *Attempt) {
				a.N = 3
				a.Kind = AttemptKindInfraRetry
				verdict := VerdictPass
				a.Verdict = &verdict
				verification := promptVerification()
				a.Verification = &verification
			}),
		}
		brief := aBrief(func(b *Brief) { b.Body = "Rename `foo` to `bar` everywhere.\n" })
		prompt := SelfContainedPrompt(brief, history,
			"Also rename the CLI flag; keep --foo as an alias.", promptArtifacts, referenceProvider)
		if !strings.HasPrefix(prompt, brief.Body) {
			t.Fatalf("prompt does not start with the body: %q", prompt)
		}
		requireContains(t, prompt, strings.Join([]string{
			"## Earlier attempts",
			"",
			"This task was attempted before in another session. Results:",
			"- #1 (initial): gate_fail; gates 0/1 passed (failing: `npm test`); 0 changed paths, in scope; report valid.",
			"- #2 (auto_fix): worker_error; not verified.",
			"- #3 (infra_retry): pass; no gates; 0 changed paths, in scope; report valid.",
			"",
			"## Now",
			"",
			"Also rename the CLI flag; keep --foo as an alias.",
			"",
		}, "\n"))
	})

	t.Run("includes the footer, artifacts dir named, so the fresh session knows the contract", func(t *testing.T) {
		edit := aBrief(func(b *Brief) { b.Gates = []Gate{{Run: "npm test", TimeoutMs: 600_000}} })
		prompt := SelfContainedPrompt(edit, []Attempt{promptFailedAttempt(VerdictGateFail)},
			"Fix the failing test.", promptArtifacts, referenceProvider)
		requireMatches(t, `\nFix the failing test\.\n\n## zai contract\n`, prompt)
		initial := InitialPrompt(edit, promptArtifacts, referenceProvider)
		if !strings.HasSuffix(prompt, initial[len(edit.Body)+1:]) {
			t.Fatalf("prompt does not end with the contract footer: %q", prompt)
		}
		exec := SelfContainedPrompt(aBrief(func(b *Brief) { b.Mode = ModeExec; b.Scope = []string{} }),
			nil, "Retry.", promptArtifacts, referenceProvider)
		requireContains(t, exec, "Write every output file to "+promptArtifacts+" (also in $ZAI_ARTIFACTS).")
	})

	t.Run("omits the history section when there were no earlier attempts", func(t *testing.T) {
		prompt := SelfContainedPrompt(aBrief(), nil, "Start over.", promptArtifacts, referenceProvider)
		requireNotContains(t, prompt, "Earlier attempts")
		requireMatches(t, "^Rename `foo` to `bar` everywhere\\.\\n\\n## Now\\n\\nStart over\\.\\n\\n## zai contract\\n", prompt)
	})

	t.Run("separates the body from the next section by exactly one blank line", func(t *testing.T) {
		prompt := SelfContainedPrompt(aBrief(func(b *Brief) { b.Body = "Do it.\n\n\n" }),
			nil, "Again.", promptArtifacts, referenceProvider)
		requireMatches(t, `^Do it\.\n\n## Now\n`, prompt)
	})
}

func TestAttemptSummary(t *testing.T) {
	cases := []struct {
		attempt Attempt
		line    string
	}{
		{anAttempt(func(a *Attempt) { a.N = 4; a.Kind = AttemptKindReviewFix }),
			"#4 (review_fix): no verdict; not verified."},
		{promptFailedAttempt(VerdictScopeViolation, func(v *Verification) {
			v.Changes = aChangeSet(func(c *ChangeSet) { c.Modified = []string{"a.ts"} })
			v.Scope = aScopeCheck(func(s *ScopeCheck) {
				s.OutOfScope = []string{"a.ts"}
				s.Forbidden = []string{".env", "b.pem"}
			})
			v.Report = aReportCheck(func(r *ReportCheck) { r.Present = false; r.Valid = false })
		}), "#1 (initial): scope_violation; no gates; 1 changed path, 1 out of scope, 2 forbidden; report missing."},
		{promptFailedAttempt(VerdictScopeViolation, func(v *Verification) {
			v.Changes = aChangeSet(func(c *ChangeSet) { c.Untracked = []string{"out.txt"} })
			v.Scope = aScopeCheck(func(s *ScopeCheck) { s.RepoChanged = true })
			v.Report = aReportCheck(func(r *ReportCheck) {
				r.Valid = false
				r.Problems = []string{"summary: Required"}
			})
		}), "#1 (initial): scope_violation; no gates; 1 changed path, repository changed; report invalid."},
		{promptFailedAttempt(VerdictScopeViolation, func(v *Verification) {
			v.Scope = aScopeCheck(func(s *ScopeCheck) { s.Forbidden = []string{".env"} })
		}), "#1 (initial): scope_violation; no gates; 0 changed paths, 1 forbidden; report valid."},
		{promptFailedAttempt(VerdictGateFail, func(v *Verification) {
			v.Gates = []GateResult{
				aGateResult(func(g *GateResult) { g.Run = "a"; g.ExitCode = i64Ptr(1) }),
				aGateResult(func(g *GateResult) { g.Run = "b"; g.TimedOut = true }),
			}
		}), "#1 (initial): gate_fail; gates 0/2 passed (failing: `a`, `b`); 0 changed paths, in scope; report valid."},
	}
	t.Run("summarises verdict, gates, scope and report on one line", func(t *testing.T) {
		for _, c := range cases {
			if got := AttemptSummary(c.attempt); got != c.line {
				t.Fatalf("attemptSummary = %q, want %q", got, c.line)
			}
		}
	})
}
