package cli_test

// The runCli suite: every command through the dispatch, over the shared fakes.

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakedeps"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// cliBrief is the brief every run of the suite submits.
const cliBrief = "---\ntitle: Rename foo\ngates: [npm test]\n---\nRename `foo` to `bar`.\n"

// cliWriteFile writes a file under the fakes' root, making its directory.
func cliWriteFile(t *testing.T, root, name, text string) string {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// cliBriefFile is a brief file under the fakes' root.
func cliBriefFile(t *testing.T, world fakedeps.Fakes, text ...string) string {
	t.Helper()
	brief := cliBrief
	if len(text) > 0 {
		brief = text[0]
	}
	name := "brief.md"
	if len(text) > 1 {
		name = text[1]
	}
	return cliWriteFile(t, world.Root, name, brief)
}

// cliReviewable is the awaiting_review job the review commands read, with one passing attempt.
func cliReviewable(t *testing.T, world fakedeps.Fakes, overrides ...func(*domain.Job)) domain.Job {
	t.Helper()
	id := "261006-review"
	paths := world.Store.Paths(id)
	completed := domain.WorkerOutcome{Kind: domain.WorkerOutcomeCompleted}
	verification := testkit.AVerification(func(v *domain.Verification) {
		v.Changes = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
	})
	pass := domain.VerdictPass
	job := testkit.AJob(func(j *domain.Job) {
		j.ID = id
		j.State = domain.JobStateAwaitingReview
		worktree, branch := paths.Worktree, "zai/"+id
		j.Workspace = domain.Workspace{
			RepoRoot:     "/repo",
			BaseSha:      fakes.BASE_SHA,
			Worktree:     &worktree,
			Branch:       &branch,
			ArtifactsDir: paths.Artifacts,
		}
		j.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) {
			a.Outcome = &completed
			a.Report = fakes.VALID_CHANGE_REPORT
			a.Verification = &verification
			a.Verdict = &pass
		})}
	})
	for _, override := range overrides {
		override(&job)
	}
	return world.Store.Put(job)
}

// cliRun is one runCli call in the fake repository.
func cliRun(t *testing.T, world fakedeps.Fakes, args ...string) cli.ExitCode {
	t.Helper()
	return cli.RunCli(context.Background(), args, world.Deps, "/repo")
}

// cliDrivesOnSpawn makes the fake spawn drive the job in this process, as the detached
// `zai drive <id>` would.
func cliDrivesOnSpawn(t *testing.T, world *fakedeps.Fakes) {
	t.Helper()
	deps := world.Deps
	world.Process.SetOnSpawn(func(id string) {
		_, _ = app.Drive(context.Background(), deps, id)
	})
}

// cliAfterSleeps runs then once, right before the n-th clock sleep.
func cliAfterSleeps(world *fakedeps.Fakes, n int, then func()) {
	count := 0
	clock := world.Clock
	world.Deps.Clock = &cliHookClock{Clock: clock, before: func() {
		count++
		if count == n {
			then()
		}
	}}
}

// cliHookClock wraps a clock, running before ahead of every sleep. A multi-follow sleeps from
// several goroutines at once, so the hook carries its own lock.
type cliHookClock struct {
	ports.Clock
	mu     sync.Mutex
	before func()
}

func (c *cliHookClock) Sleep(ctx context.Context, ms int64) error {
	c.mu.Lock()
	c.before()
	c.mu.Unlock()
	return c.Clock.Sleep(ctx, ms)
}

// withTTY runs run with stdout claimed to be (or not to be) a terminal.
func withTTY(t *testing.T, tty bool, run func() cli.ExitCode) cli.ExitCode {
	t.Helper()
	was := cli.StdoutIsTTY
	cli.StdoutIsTTY = func() bool { return tty }
	t.Cleanup(func() { cli.StdoutIsTTY = was })
	return run()
}

// jsonOf parses the fakes' stdout as one JSON document.
func jsonOf(t *testing.T, text string) map[string]any {
	t.Helper()
	var parsed map[string]any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		t.Fatalf("stdout is not one JSON object: %v\n%s", err, text)
	}
	return parsed
}

func TestRunCliUnknownCommandOrMissingArgs(t *testing.T) {
	t.Run("unknown command or missing args → exit 2 and the synopsis", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)

		if code := cliRun(t, world, "frobnicate"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		if world.Out.Errors[0] != `zai: unknown command "frobnicate"` {
			t.Fatalf("error = %q", world.Out.Errors[0])
		}
		if joined := strings.Join(world.Out.Errors, "\n"); !strings.Contains(joined, "  run <brief.md|->") {
			t.Fatalf("synopsis missing from %q", joined)
		}
		if code := cliRun(t, world); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}

		missing := fakedeps.FakeDeps(t)
		if code := cliRun(t, missing, "review"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		want := []string{
			"zai: review needs a job id",
			"usage: review <id> [--diff] [--summary] [--json]",
		}
		if reflect.DeepEqual(missing.Out.Errors, want) != true {
			t.Fatalf("errors = %q, want %q", missing.Out.Errors, want)
		}

		badFlag := fakedeps.FakeDeps(t)
		if code := cliRun(t, badFlag, "board", "--bogus"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		if !regexp.MustCompile(`^zai: Unknown option '--bogus'`).MatchString(badFlag.Out.Errors[0]) {
			t.Fatalf("error = %q", badFlag.Out.Errors[0])
		}
		if badFlag.Out.Errors[1] != "usage: board [--all] [--watch] [--json]" {
			t.Fatalf("usage = %q", badFlag.Out.Errors[1])
		}
	})
}

func TestRunCliHelp(t *testing.T) {
	t.Run("help prints every command's synopsis on stdout", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)

		if code := cliRun(t, world, "--help"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if text := world.Out.Text(); !strings.Contains(text, "  accept <id> [--no-commit] [--force] [--no-verify] [--json]") {
			t.Fatalf("accept synopsis missing from %q", text)
		} else if strings.Contains(text, "drive <id>") {
			t.Fatalf("hidden drive synopsis in %q", text)
		}
	})
}

func TestRunCliRunWait(t *testing.T) {
	t.Run("run --wait starts a detached driver, follows the job and exits 0 on pass, 3 on any other verdict", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		world.Git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		cliDrivesOnSpawn(t, &world)

		code := cliRun(t, world, "run", cliBriefFile(t, world), "--wait")

		if code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0; errors = %q; lines = %q", code, world.Out.Errors, world.Out.Lines)
		}
		if got := world.Process.Spawned(); !reflect.DeepEqual(got, []string{"261006-job001"}) {
			t.Fatalf("spawned = %q", got)
		}
		if world.Out.Lines[0] != "zai job 261006-job001 started: Rename foo (glm-5.3, edit)" {
			t.Fatalf("started = %q", world.Out.Lines[0])
		}
		if !regexp.MustCompile(`^zai job 261006-job001: verdict pass \(awaiting review\)\n`).MatchString(world.Out.Lines[1]) {
			t.Fatalf("summary = %q", world.Out.Lines[1])
		}
		if !strings.Contains(world.Out.Lines[1], "\nNext: /zai:review 261006-job001 ") {
			t.Fatalf("next actions missing from %q", world.Out.Lines[1])
		}
		if len(world.Out.Lines) != 2 {
			t.Fatalf("lines = %q", world.Out.Lines)
		}

		failing := fakedeps.FakeDeps(t, fakes.WorkerScript{Lines: []string{
			fakes.Wire.Result(fakes.ResultFields{Report: fakes.VALID_CHANGE_REPORT}),
		}})
		one := int64(1)
		failing.Gates.Results["npm test"] = []fakes.GateAnswer{{ExitCode: &one}}
		cliDrivesOnSpawn(t, &failing)
		failed := cliRun(t, failing, "run", cliBriefFile(t, failing), "--wait", "--flash")

		if failed != cli.ExitNotPass {
			t.Fatalf("exit = %d, want 3", failed)
		}
		if failing.Out.Lines[0] != "zai job 261006-job001 started: Rename foo (glm-5.3-flash, edit)" {
			t.Fatalf("started = %q", failing.Out.Lines[0])
		}
		if !strings.Contains(failing.Out.Lines[1], "verdict gate_fail") {
			t.Fatalf("summary = %q", failing.Out.Lines[1])
		}
	})

	t.Run("run --wait on a worker that cannot start prints the summary of the landed job, exit 3", func(t *testing.T) {
		world := fakedeps.FakeDeps(t, fakes.WorkerScript{
			StartError: &ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "no Z.ai key: export ZAI_API_KEY"},
		})
		cliDrivesOnSpawn(t, &world)

		code := cliRun(t, world, "run", cliBriefFile(t, world), "--wait")

		if code != cli.ExitNotPass {
			t.Fatalf("exit = %d, want 3", code)
		}
		if !strings.Contains(world.Out.Lines[1], "verdict worker_error") {
			t.Fatalf("summary = %q", world.Out.Lines[1])
		}
	})

	t.Run("run --wait --json prints only the landed job as JSON", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		cliDrivesOnSpawn(t, &world)

		cliRun(t, world, "run", cliBriefFile(t, world), "--wait", "--json")

		parsed := jsonOf(t, world.Out.Text())
		if parsed["id"] != "261006-job001" || parsed["state"] != "awaiting_review" {
			t.Fatalf("job = %v", parsed)
		}
	})

	t.Run("run --wait whose driver dies reports the stale job with the stop/discard advice and exits 6", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		world.Process.SetOnSpawn(func(id string) {
			job, err := world.Store.Get(context.Background(), id)
			if err == nil {
				job.State = domain.JobStateRunning
				job.Attempts = []domain.Attempt{testkit.AnAttempt()}
				world.Store.Put(job)
			}
			world.Store.HoldLock(id, 99_999)
		})

		code := cliRun(t, world, "run", cliBriefFile(t, world), "--wait")

		if code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		if got := world.Out.Lines; !reflect.DeepEqual(got, []string{"zai job 261006-job001 started: Rename foo (glm-5.3, edit)"}) {
			t.Fatalf("lines = %q", got)
		}
		want := []string{
			"zai: job 261006-job001 is running but has no live driver; /zai:board stops it (it moves to review), /zai:review 261006-job001 then discards it.",
		}
		if !reflect.DeepEqual(world.Out.Errors, want) {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
	})
}

func TestRunCliWait(t *testing.T) {
	t.Run("wait follows an existing job to review and prints the summary", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		pass := domain.VerdictPass
		verification := testkit.AVerification()
		job := world.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))
		world.Store.HoldLock("j1", int64(os.Getpid()))
		cliAfterSleeps(&world, 3, func() {
			world.Store.Put(func() domain.Job {
				next := job
				next.State = domain.JobStateAwaitingReview
				next.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) {
					a.Verification = &verification
					a.Verdict = &pass
				})}
				return next
			}())
		})

		if code := cliRun(t, world, "wait", "j1"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if len(world.Out.Lines) != 1 {
			t.Fatalf("lines = %q", world.Out.Lines)
		}
		if !regexp.MustCompile(`^zai job j1: verdict pass \(awaiting review\)\n`).MatchString(world.Out.Lines[0]) {
			t.Fatalf("summary = %q", world.Out.Lines[0])
		}
	})

	t.Run("wait on a job already in review, accepted or discarded prints its summary at once", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		cliReviewable(t, world)
		polls := 0
		cliAfterSleeps(&world, 1, func() { polls++ })

		if code := cliRun(t, world, "wait", "261006-rev"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if !regexp.MustCompile(`^zai job 261006-review: verdict pass \(awaiting review\)\n`).MatchString(world.Out.Lines[0]) {
			t.Fatalf("summary = %q", world.Out.Lines[0])
		}

		accepted := fakedeps.FakeDeps(t)
		cliReviewable(t, accepted, func(j *domain.Job) { j.State = domain.JobStateAccepted })
		if code := cliRun(t, accepted, "wait", "261006-review", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if parsed := jsonOf(t, accepted.Out.Text()); parsed["state"] != "accepted" {
			t.Fatalf("state = %v", parsed["state"])
		}

		discarded := fakedeps.FakeDeps(t)
		gateFail := domain.VerdictGateFail
		verification := testkit.AVerification()
		cliReviewable(t, discarded, func(j *domain.Job) {
			j.State = domain.JobStateDiscarded
			j.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) {
				a.Verdict = &gateFail
				a.Verification = &verification
			})}
		})
		if code := cliRun(t, discarded, "wait", "261006-review"); code != cli.ExitNotPass {
			t.Fatalf("exit = %d, want 3", code)
		}
		if !regexp.MustCompile(`^zai job 261006-review: verdict gate_fail \(discarded\)\n`).MatchString(discarded.Out.Lines[0]) {
			t.Fatalf("summary = %q", discarded.Out.Lines[0])
		}
		if polls != 0 {
			t.Fatalf("polls = %d, want 0", polls)
		}
	})

	t.Run("wait on a stale job gives the stop/discard advice and exits 6; --json still prints the job", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		world.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateVerifying
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))

		if code := cliRun(t, world, "wait", "j1"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		if len(world.Out.Lines) != 0 {
			t.Fatalf("lines = %q", world.Out.Lines)
		}
		want := []string{
			"zai: job j1 is verifying but has no live driver; /zai:board stops it (it moves to review), /zai:review j1 then discards it.",
		}
		if !reflect.DeepEqual(world.Out.Errors, want) {
			t.Fatalf("errors = %q", world.Out.Errors)
		}

		asJSON := fakedeps.FakeDeps(t)
		asJSON.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))
		if code := cliRun(t, asJSON, "wait", "j1", "--json"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		if parsed := jsonOf(t, asJSON.Out.Text()); parsed["state"] != "running" {
			t.Fatalf("state = %v", parsed["state"])
		}
	})

	t.Run("wait on an unknown id exits 4; without an id it is a usage error", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)

		if code := cliRun(t, world, "wait", "nope"); code != cli.ExitNotFound {
			t.Fatalf("exit = %d, want 4", code)
		}
		want := []string{`zai: no zai job matches "nope" (/zai:board lists them)`}
		if !reflect.DeepEqual(world.Out.Errors, want) {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
		if code := cliRun(t, world, "wait"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		rest := []string{
			"zai: wait needs a job id",
			"usage: wait <id> [<id>…] [--json]",
		}
		if !reflect.DeepEqual(world.Out.Errors[1:], rest) {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
	})

	t.Run("wait on many jobs follows them all: one compact line per job as it lands, then a totals line", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		cliReviewable(t, world)
		cliReviewable(t, world, func(j *domain.Job) {
			j.ID = "j2"
			j.Attempts = []domain.Attempt{cliGateFailAttempt()}
		})

		if code := cliRun(t, world, "wait", "261006-review", "j2"); code != cli.ExitNotPass {
			t.Fatalf("exit = %d, want 3", code)
		}
		// Both jobs land on the first poll, so their lines race: one line each, either order,
		// the totals always last.
		if len(world.Out.Lines) != 3 {
			t.Fatalf("lines = %q", world.Out.Lines)
		}
		first := append([]string{}, world.Out.Lines[:2]...)
		sort.Strings(first)
		want := []string{
			"261006-review pass Rename the helper gates none est. $0.0000",
			"j2 gate_fail Rename the helper gates 1/2 est. $0.0002",
			"2 jobs: 1 pass, 1 not pass · est. $0.0002",
		}
		if !reflect.DeepEqual(append(first, world.Out.Lines[2]), want) {
			t.Fatalf("lines = %q, want %q", world.Out.Lines, want)
		}

		asJSON := fakedeps.FakeDeps(t)
		cliReviewable(t, asJSON)
		cliReviewable(t, asJSON, func(j *domain.Job) { j.ID = "j2" })
		if code := cliRun(t, asJSON, "wait", "261006-review", "j2", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		var jobs []map[string]any
		if err := json.Unmarshal([]byte(asJSON.Out.Text()), &jobs); err != nil {
			t.Fatalf("stdout is not a JSON array: %v", err)
		}
		if len(jobs) != 2 || jobs[0]["id"] != "261006-review" || jobs[1]["id"] != "j2" {
			t.Fatalf("jobs = %v", jobs)
		}
	})

	t.Run("wait on a sweep brief counts its items; a stale job among them is reported and fails the wait", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		gateFail := domain.VerdictGateFail
		sweep := json.RawMessage(`{"summary":"4 sites swept","items":[` +
			`{"id":"src/a.ts","status":"ok","detail":"no foo left"},` +
			`{"id":"src/b.ts","status":"ok","detail":""},` +
			`{"id":"src/c.ts","status":"fail","detail":"still calls foo"},` +
			`{"id":"src/d.ts","status":"gap","detail":"not checked"}],"open_items":[]}`)
		completed := domain.WorkerOutcome{Kind: domain.WorkerOutcomeCompleted}
		verification := testkit.AVerification()
		cliReviewable(t, world, func(j *domain.Job) {
			j.Brief = testkit.ABrief(func(b *domain.Brief) {
				b.Mode = domain.ModeExec
				b.Report = domain.Report{Kind: domain.ReportKindBuiltin, Name: domain.BuiltinReportSweep}
				b.Title = "Sweep call sites"
			})
			j.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) {
				a.Outcome = &completed
				a.Report = sweep
				a.Verification = &verification
				a.Verdict = &gateFail
			})}
		})
		world.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j-stale"
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))

		if code := cliRun(t, world, "wait", "261006-review", "j-stale"); code != cli.ExitNotPass {
			t.Fatalf("exit = %d, want 3", code)
		}
		want := []string{
			"261006-review gate_fail Sweep call sites sweep 2/1/1 est. $0.0000",
			"j-stale stale Rename the helper gates ? est. $0.0000",
			"2 jobs: 0 pass, 2 not pass · est. $0.0000",
		}
		if !reflect.DeepEqual(world.Out.Lines, want) {
			t.Fatalf("lines = %q, want %q", world.Out.Lines, want)
		}
		wantErrors := []string{
			"zai: job j-stale is running but has no live driver; /zai:board stops it (it moves to review), /zai:review j-stale then discards it.",
		}
		if !reflect.DeepEqual(world.Out.Errors, wantErrors) {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
	})
}

// cliGateFailAttempt is the finished gate-failing attempt with its own usage.
func cliGateFailAttempt() domain.Attempt {
	gateFail := domain.VerdictGateFail
	completed := domain.WorkerOutcome{Kind: domain.WorkerOutcomeCompleted}
	lintFailure := int64(1)
	verification := testkit.AVerification(func(v *domain.Verification) {
		v.Gates = []domain.GateResult{
			testkit.AGateResult(),
			testkit.AGateResult(func(g *domain.GateResult) {
				g.Run = "npm run lint"
				g.ExitCode = &lintFailure
			}),
		}
		v.Changes = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
	})
	return testkit.AnAttempt(func(a *domain.Attempt) {
		a.Outcome = &completed
		a.Report = fakes.VALID_CHANGE_REPORT
		usage := &domain.Usage{
			Turns: 2, InputTokens: 100, OutputTokens: 20,
			CacheReadTokens: 50, CacheWriteTokens: 10,
			CostUSD: 2, DurationMs: 1500,
		}
		a.Usage = usage
		a.Verification = &verification
		a.Verdict = &gateFail
	})
}

func TestRunCliRunBg(t *testing.T) {
	t.Run("run --bg submits, spawns a driver, prints the job id, exits 0", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)

		code := cliRun(t, world, "run", cliBriefFile(t, world), "--mode", "exec")

		if code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if got := world.Process.Spawned(); !reflect.DeepEqual(got, []string{"261006-job001"}) {
			t.Fatalf("spawned = %q", got)
		}
		want := []string{
			"zai job 261006-job001 started: Rename foo (glm-5.3-flash, exec)",
			"Running detached: /zai:board shows it, /zai:review 261006-job001 once it awaits review.",
		}
		if !reflect.DeepEqual(world.Out.Lines, want) {
			t.Fatalf("lines = %q, want %q", world.Out.Lines, want)
		}
		if got := world.Worker.Specs(); len(got) != 0 {
			t.Fatalf("the worker ran %d specs, want 0", len(got))
		}
	})

	t.Run("run rejects bad input before submitting: an unreadable brief, an invalid one, --wait with --bg, a bad mode", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)

		if code := cliRun(t, world, "run", "/nope/brief.md"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		// The read failure names the resolved path, whose separators are the platform's own.
		if want := `^zai: cannot read ` + regexp.QuoteMeta(domain.ResolvePath("/repo", "/nope/brief.md")) + `: ENOENT`; !regexp.MustCompile(want).MatchString(world.Out.Errors[0]) {
			t.Fatalf("error = %q", world.Out.Errors[0])
		}
		if code := cliRun(t, world, "run", cliBriefFile(t, world, "---\nmode: edit\n---\n\n")); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		if last := world.Out.Errors[len(world.Out.Errors)-1]; last != "zai: invalid brief: title: required; the body (the task) is empty" {
			t.Fatalf("error = %q", last)
		}
		if code := cliRun(t, world, "run", cliBriefFile(t, world), "--wait", "--bg"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		if code := cliRun(t, world, "run", cliBriefFile(t, world), "--mode", "yolo"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		if !containsLine(world.Out.Errors, "zai: --mode must be edit, exec or readonly") {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
		if jobs := world.Store.List(context.Background(), ports.ListFilter{}); len(jobs) != 0 {
			t.Fatalf("store kept %d jobs, want 0", len(jobs))
		}
	})

	t.Run("run --json prints the submitted job as JSON", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)

		cliRun(t, world, "run", cliBriefFile(t, world), "--bg", "--json")

		parsed := jsonOf(t, world.Out.Text())
		if parsed["id"] != "261006-job001" || parsed["state"] != "queued" {
			t.Fatalf("job = %v", parsed)
		}
	})
}

// containsLine says whether text is one of the list's items.
func containsLine(list []string, text string) bool {
	for _, item := range list {
		if item == text {
			return true
		}
	}
	return false
}

func TestRunCliReview(t *testing.T) {
	t.Run("review prints the packet; --json prints the ReviewPacket as JSON", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		cliReviewable(t, world)

		if code := cliRun(t, world, "review", "261006-rev", "--diff"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		text := world.Out.Text()
		if !regexp.MustCompile(`^zai job 261006-review: Rename the helper\nverdict pass`).MatchString(text) {
			t.Fatalf("packet = %q", text)
		}
		if !strings.Contains(text, "```diff\ndiff --git a/src/a.ts b/src/a.ts\n+bar\n```") {
			t.Fatalf("diff missing from %q", text)
		}

		asJSON := fakedeps.FakeDeps(t)
		cliReviewable(t, asJSON)
		cliRun(t, asJSON, "review", "261006-review", "--json")

		parsed := jsonOf(t, asJSON.Out.Text())
		if _, has := parsed["job"]; !has {
			t.Fatalf("packet = %v", parsed)
		}
		job := parsed["job"].(map[string]any)
		if job["id"] != "261006-review" {
			t.Fatalf("job = %v", job)
		}
		if parsed["diffStat"] != asJSON.Git.DiffStat {
			t.Fatalf("diffStat = %v, want %q", parsed["diffStat"], asJSON.Git.DiffStat)
		}
		if _, has := parsed["diff"]; has {
			t.Fatalf("packet carries a diff: %v", parsed)
		}
	})

	t.Run("review --summary prints verdict, gates and report — no diff, changes or next actions", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		gateFail := domain.VerdictGateFail
		lintFailure := int64(1)
		cliReviewable(t, world, func(j *domain.Job) {
			verification := testkit.AVerification(func(v *domain.Verification) {
				v.Gates = []domain.GateResult{
					testkit.AGateResult(),
					testkit.AGateResult(func(g *domain.GateResult) {
						g.Run = "npm run lint"
						g.ExitCode = &lintFailure
						g.Tail = "lint: 1 problem\n"
					}),
				}
				v.Changes = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
			})
			j.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) {
				a.Outcome = &domain.WorkerOutcome{Kind: domain.WorkerOutcomeCompleted}
				a.Report = json.RawMessage(`{"summary":"Renamed foo to bar","files":[{"path":"src/a.ts","why":"rename"}],"tests_added":[],"open_items":["docs lag"]}`)
				a.Verification = &verification
				a.Verdict = &gateFail
			})}
		})

		if code := cliRun(t, world, "review", "261006-review", "--summary"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		text := world.Out.Text()
		if !regexp.MustCompile(`^zai job 261006-review: Rename the helper\nverdict gate_fail · glm-5\.3 · edit · attempt 1 \(initial\) · awaiting review\n`).MatchString(text) {
			t.Fatalf("summary = %q", text)
		}
		for _, want := range []string{"Gates (1/2 passed)", "npm run lint", "Report", "- docs lag"} {
			if !strings.Contains(text, want) {
				t.Fatalf("%s missing from %q", want, text)
			}
		}
		for _, absent := range []string{"```diff", "Diff stat", "Changes (", "Next"} {
			if strings.Contains(text, absent) {
				t.Fatalf("%s in %q", absent, text)
			}
		}

		if code := cliRun(t, world, "review", "261006-review", "--diff", "--summary"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		want := []string{
			"zai: --diff and --summary exclude each other",
			"usage: review <id> [--diff] [--summary] [--json]",
		}
		if !reflect.DeepEqual(world.Out.Errors, want) {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
	})

	t.Run("review --summary on a sweep shows only the failing items", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		gateFail := domain.VerdictGateFail
		cliReviewable(t, world, func(j *domain.Job) {
			j.Brief = testkit.ABrief(func(b *domain.Brief) {
				b.Mode = domain.ModeExec
				b.Report = domain.Report{Kind: domain.ReportKindBuiltin, Name: domain.BuiltinReportSweep}
				b.Title = "Sweep call sites"
			})
			j.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) {
				a.Outcome = &domain.WorkerOutcome{Kind: domain.WorkerOutcomeCompleted}
				a.Report = json.RawMessage(`{"summary":"4 sites swept","items":[` +
					`{"id":"src/a.ts","status":"ok","detail":"no foo left"},` +
					`{"id":"src/b.ts","status":"ok","detail":""},` +
					`{"id":"src/c.ts","status":"fail","detail":"still calls foo"},` +
					`{"id":"src/d.ts","status":"gap","detail":"not checked"}],"open_items":[]}`)
				verification := testkit.AVerification()
				a.Verification = &verification
				a.Verdict = &gateFail
			})}
		})

		if code := cliRun(t, world, "review", "261006-review", "--summary"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		text := world.Out.Text()
		for _, want := range []string{"Sweep (failing only)", "src/c.ts: fail — still calls foo", "src/d.ts: gap — not checked"} {
			if !strings.Contains(text, want) {
				t.Fatalf("%s missing from %q", want, text)
			}
		}
		for _, absent := range []string{"src/a.ts: ok", "src/b.ts: ok"} {
			if strings.Contains(text, absent) {
				t.Fatalf("%s in %q", absent, text)
			}
		}
	})
}

func TestRunCliDecide(t *testing.T) {
	t.Run("accept exits 5 on conflict; return requires feedback text; ids resolve by prefix; unknown id → 4", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		cliReviewable(t, world)
		world.Git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		world.Git.Ancestor = false
		world.Git.RebaseErr = &ports.GitError{Kind: ports.GitErrorConflict, Paths: []string{"src/a.ts"}}

		if code := cliRun(t, world, "accept", "261006-r"); code != cli.ExitConflict {
			t.Fatalf("exit = %d, want 5", code)
		}
		want := []string{
			"zai: conflict in src/a.ts: nothing was applied. The worker cannot rebase (it never commits or switches branches): discard the job with /zai:review and run the brief again on the current branch, or merge the job's branch by hand.",
		}
		if !reflect.DeepEqual(world.Out.Errors, want) {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
		if code := cliRun(t, world, "return", "261006-r"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		if code := cliRun(t, world, "return", "261006-r", "Rename", "the", "tests", "too."); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		job, err := world.Store.Get(context.Background(), "261006-review")
		if err != nil {
			t.Fatal(err)
		}
		last := job.Attempts[len(job.Attempts)-1]
		if last.Feedback == nil || *last.Feedback != "Rename the tests too." {
			t.Fatalf("feedback = %v", last.Feedback)
		}
		if got := world.Process.Spawned(); !reflect.DeepEqual(got, []string{"261006-review"}) {
			t.Fatalf("spawned = %q", got)
		}
		if lastLine := world.Out.Lines[len(world.Out.Lines)-1]; lastLine !=
			"zai job 261006-review returned with feedback: attempt 2 runs detached. /zai:review 261006-review once it awaits review again." {
			t.Fatalf("line = %q", lastLine)
		}
		if code := cliRun(t, world, "show", "999"); code != cli.ExitNotFound {
			t.Fatalf("exit = %d, want 4", code)
		}
		if last := world.Out.Errors[len(world.Out.Errors)-1]; last != `zai: no zai job matches "999" (/zai:board lists them)` {
			t.Fatalf("error = %q", last)
		}
	})

	t.Run("accept lands the job and says where; --force accepts a non-pass verdict; --no-verify skips commit hooks", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		gateFail := domain.VerdictGateFail
		cliReviewable(t, world, func(j *domain.Job) {
			j.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) {
				a.Verdict = &gateFail
				verification := testkit.AVerification()
				a.Verification = &verification
			})}
		})
		world.Git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })

		if code := cliRun(t, world, "accept", "261006-review"); code != cli.ExitNotPass {
			t.Fatalf("exit = %d, want 3", code)
		}
		want := []string{
			"zai: job 261006-review has verdict gate_fail, not pass: accept --force to accept it anyway",
		}
		if !reflect.DeepEqual(world.Out.Errors, want) {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
		if code := cliRun(t, world, "accept", "261006-review", "--force", "--no-verify"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		commits := world.Git.Called("commitAll")
		if len(commits) != 1 || commits[0][2].(ports.CommitOptions) != (ports.CommitOptions{Verify: false}) {
			t.Fatalf("commitAll = %v", commits)
		}
		wantLines := []string{
			"zai job 261006-review accepted: commit cccccccccccc on the current branch of /repo",
		}
		if !reflect.DeepEqual(world.Out.Lines, wantLines) {
			t.Fatalf("lines = %q, want %q", world.Out.Lines, wantLines)
		}
	})

	t.Run("accept --no-commit applies to the working tree; a failing commit hook explains how to proceed", func(t *testing.T) {
		applied := fakedeps.FakeDeps(t)
		cliReviewable(t, applied)
		cliRun(t, applied, "accept", "261006-review", "--no-commit")
		want := []string{
			"zai job 261006-review accepted: applied to the working tree of /repo, not committed",
		}
		if !reflect.DeepEqual(applied.Out.Lines, want) {
			t.Fatalf("lines = %q, want %q", applied.Out.Lines, want)
		}

		hooked := fakedeps.FakeDeps(t)
		cliReviewable(t, hooked)
		hooked.Git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		hooked.Git.CommitErr = &ports.GitError{Kind: ports.GitErrorGitFailed, Command: "git commit", Stderr: "lint: 2 problems"}

		if code := cliRun(t, hooked, "accept", "261006-review"); code != cli.ExitUnexpected {
			t.Fatalf("exit = %d, want 1", code)
		}
		wantErrors := []string{
			"zai: git commit: lint: 2 problems",
			"zai: the job still awaits review. Fix what the commit hook reports, then accept it again.",
		}
		if !reflect.DeepEqual(hooked.Out.Errors, wantErrors) {
			t.Fatalf("errors = %q", hooked.Out.Errors)
		}

		exec := fakedeps.FakeDeps(t)
		cliReviewable(t, exec, func(j *domain.Job) {
			j.Brief = testkit.ABrief(func(b *domain.Brief) { b.Mode = domain.ModeExec; b.Scope = []string{} })
		})
		cliRun(t, exec, "accept", "261006-review")
		if !reflect.DeepEqual(exec.Out.Lines, []string{"zai job 261006-review accepted (exec: nothing to merge)"}) {
			t.Fatalf("lines = %q", exec.Out.Lines)
		}
	})

	t.Run("discard --reason records why; stop asks a live driver and stops an idle job at once", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		cliReviewable(t, world)

		if code := cliRun(t, world, "discard", "261006-review", "--reason", "wrong approach"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		job, err := world.Store.Get(context.Background(), "261006-review")
		if err != nil {
			t.Fatal(err)
		}
		if job.Decision == nil || job.Decision.Reason == nil || *job.Decision.Reason != "wrong approach" {
			t.Fatalf("decision = %+v", job.Decision)
		}
		if !reflect.DeepEqual(world.Out.Lines, []string{"zai job 261006-review discarded: wrong approach"}) {
			t.Fatalf("lines = %q", world.Out.Lines)
		}

		stops := fakedeps.FakeDeps(t)
		stops.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j-live"
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))
		stops.Store.HoldLock("j-live", 4242)
		stops.Store.Put(testkit.AJob(func(j *domain.Job) { j.ID = "j-idle"; j.State = domain.JobStateQueued }))
		stops.Store.Put(testkit.AJob(func(j *domain.Job) { j.ID = "j-done"; j.State = domain.JobStateAccepted }))

		if code := cliRun(t, stops, "stop", "--all"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		want := []string{
			`zai job j-live: stopping; it will wait for your review as "stopped"`,
			"zai job j-idle stopped: awaiting review",
		}
		if !reflect.DeepEqual(stops.Out.Lines, want) {
			t.Fatalf("lines = %q, want %q", stops.Out.Lines, want)
		}
		if code := cliRun(t, stops, "stop", "j-done"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		wantErrors := []string{
			"zai: job j-done was already accepted; this only works on a job that is queued, is running or is being verified",
		}
		if !reflect.DeepEqual(stops.Out.Errors, wantErrors) {
			t.Fatalf("errors = %q", stops.Out.Errors)
		}
		if code := cliRun(t, stops, "stop"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
	})
}

func TestRunCliBoardAndQueries(t *testing.T) {
	t.Run("board lists this repository's jobs; board --hook prints one line only when jobs await review or run", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		cliReviewable(t, world)
		world.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j-elsewhere"
			j.Workspace.RepoRoot = "/other"
		}))

		if code := cliRun(t, world, "board"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if !regexp.MustCompile(`^KIND +ID`).MatchString(world.Out.Text()) {
			t.Fatalf("board = %q", world.Out.Text())
		}
		if strings.Contains(world.Out.Text(), "j-elsewhere") {
			t.Fatalf("board carries another repository's job: %q", world.Out.Text())
		}
		if code := cliRun(t, world, "board", "--hook"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if last := world.Out.Lines[len(world.Out.Lines)-1]; last !=
			"zai: 1 job awaits review (/zai:review 261006-review). /zai:board lists them." {
			t.Fatalf("hook line = %q", last)
		}

		quiet := fakedeps.FakeDeps(t)
		quiet.Store.Put(testkit.AJob(func(j *domain.Job) { j.State = domain.JobStateAccepted }))
		if code := cliRun(t, quiet, "board", "--hook"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if len(quiet.Out.Lines) != 0 {
			t.Fatalf("lines = %q", quiet.Out.Lines)
		}

		broken := fakedeps.FakeDeps(t)
		broken.Deps.Store = cliPanickingStore{broken.Store}
		if code := cli.RunCli(context.Background(), []string{"board", "--hook"}, broken.Deps, "/elsewhere"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if code := cli.RunCli(context.Background(), []string{"board", "--hook"}, broken.Deps, "/repo"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if len(broken.Out.Lines)+len(broken.Out.Errors) != 0 {
			t.Fatalf("output = %q %q", broken.Out.Lines, broken.Out.Errors)
		}
	})

	t.Run("board --all and --json; show prints one job; usage prints the ledger after the spool windows", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		cliReviewable(t, world)
		world.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j-elsewhere"
			j.Workspace.RepoRoot = "/other"
		}))

		cliRun(t, world, "board", "--all", "--json")
		var rows []map[string]any
		if err := json.Unmarshal([]byte(world.Out.Text()), &rows); err != nil {
			t.Fatalf("rows: %v", err)
		}
		kinds := []string{}
		for _, row := range rows {
			kinds = append(kinds, row["kind"].(string)+" "+row["id"].(string))
		}
		if !reflect.DeepEqual(kinds, []string{"job j-elsewhere", "job 261006-review"}) {
			t.Fatalf("rows = %q", kinds)
		}

		show := fakedeps.FakeDeps(t)
		cliReviewable(t, show)
		if code := cliRun(t, show, "show", "261006-review"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if !regexp.MustCompile(`^zai job 261006-review: Rename the helper\nawaiting review · glm-5\.3 · edit · created just now · updated just now\n`).MatchString(show.Out.Text()) {
			t.Fatalf("show = %q", show.Out.Text())
		}

		usage := fakedeps.FakeDeps(t)
		cliReviewable(t, usage, func(j *domain.Job) { j.State = domain.JobStateAccepted })
		if code := cliRun(t, usage, "usage"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if !regexp.MustCompile(`^Z\.ai GLM usage\nEst\. cost: today \$`).MatchString(usage.Out.Text()) {
			t.Fatalf("usage = %q", usage.Out.Text())
		}
		if !strings.Contains(usage.Out.Text(), "\nToday: no agent or /model requests.\n") {
			t.Fatalf("usage = %q", usage.Out.Text())
		}
		if !strings.Contains(usage.Out.Text(), "\nzai jobs in this repository\n") {
			t.Fatalf("usage = %q", usage.Out.Text())
		}
		if code := cliRun(t, usage, "usage", "--all"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}

		asJSON := fakedeps.FakeDeps(t)
		cliReviewable(t, asJSON, func(j *domain.Job) { j.State = domain.JobStateAccepted })
		cliRun(t, asJSON, "usage", "--json")
		parsed := jsonOf(t, asJSON.Out.Text())
		var labels []string
		for _, window := range parsed["spool"].([]any) {
			labels = append(labels, window.(map[string]any)["label"].(string))
		}
		if !reflect.DeepEqual(labels, []string{"Today", "Last 7 days", "Last 30 days"}) {
			t.Fatalf("labels = %q", labels)
		}
		if _, has := parsed["jobs"]; !has {
			t.Fatalf("jobs missing from %v", parsed)
		}
	})

	t.Run("show --follow prints progress changes until the job leaves running, then the job", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		job := world.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))
		world.Store.HoldLock("j1", int64(os.Getpid()))
		polls := 0
		clock := world.Clock
		// The second poll appends one tool call to the attempt log, the fourth settles the job.
		world.Deps.Clock = &cliHookClock{Clock: clock, before: func() {
			polls++
			if polls == 2 {
				if err := os.MkdirAll(filepath.Dir(world.Store.Paths("j1").AttemptLog(1)), 0o755); err != nil {
					t.Fatal(err)
				}
				line := fakes.Wire.Tool("Bash", fakes.ToolArg{Key: "command", Value: "ls"}) + "\n"
				if err := os.WriteFile(world.Store.Paths("j1").AttemptLog(1), []byte(line), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if polls == 4 {
				next := job
				next.State = domain.JobStateAwaitingReview
				world.Store.Put(next)
			}
		}}

		if code := cliRun(t, world, "show", "j1", "--follow"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if !reflect.DeepEqual(world.Out.Lines[:2], []string{"running", "running · tool Bash ls · 1 tool call"}) {
			t.Fatalf("lines = %q", world.Out.Lines)
		}
		if last := world.Out.Lines[len(world.Out.Lines)-1]; !regexp.MustCompile(`^zai job j1: Rename the helper\nawaiting review`).MatchString(last) {
			t.Fatalf("job = %q", last)
		}
	})
}

// cliPanickingStore is a store whose listing blows up, as a broken disk does.
type cliPanickingStore struct {
	ports.JobStore
}

func (s cliPanickingStore) List(context.Context, ports.ListFilter) []domain.Job {
	panic("disk on fire")
}

func TestRunCliBatch(t *testing.T) {
	t.Run("batch submits a directory or manifest of briefs, spawning a driver per job; rejected ones exit 2", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		dir := filepath.Join(world.Root, "briefs")
		cliBriefFile(t, world, cliBrief, "briefs/a.md")
		cliBriefFile(t, world, "not a brief", "briefs/b.md")
		cliBriefFile(t, world, "ignored", "briefs/notes.txt")

		if code := cliRun(t, world, "batch", dir); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		want := []string{"submitted 261006-job001: Rename foo (" + filepath.Join(dir, "a.md") + ")"}
		if !reflect.DeepEqual(world.Out.Lines, want) {
			t.Fatalf("lines = %q, want %q", world.Out.Lines, want)
		}
		wantErrors := []string{
			"zai: rejected " + filepath.Join(dir, "b.md") + ": invalid brief: no YAML front matter (start the file with ---)",
		}
		if !reflect.DeepEqual(world.Out.Errors, wantErrors) {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
		if got := world.Process.Spawned(); !reflect.DeepEqual(got, []string{"261006-job001"}) {
			t.Fatalf("spawned = %q", got)
		}

		listed := fakedeps.FakeDeps(t)
		cliBriefFile(t, listed, cliBrief, "one.md")
		cliBriefFile(t, listed, cliBrief, "two.md")
		manifest := cliBriefFile(t, listed, "# the list\none.md\n\ntwo.md\n", "jobs.txt")
		if code := cliRun(t, listed, "batch", manifest); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if got := listed.Process.Spawned(); len(got) != 2 {
			t.Fatalf("spawned = %q", got)
		}

		globbed := fakedeps.FakeDeps(t)
		cliBriefFile(t, globbed, strings.Replace(cliBrief, "title:", "cwd: /repo\ntitle:", 1), "g1.md")
		if code := cli.RunCli(context.Background(), []string{"batch", "*.md", "--json"}, globbed.Deps, globbed.Root); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		parsed := jsonOf(t, globbed.Out.Text())
		if submitted := parsed["submitted"].([]any); len(submitted) != 1 {
			t.Fatalf("submitted = %v", submitted)
		}

		empty := fakedeps.FakeDeps(t)
		if code := cli.RunCli(context.Background(), []string{"batch", "*.md"}, empty.Deps, empty.Root); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		if !reflect.DeepEqual(empty.Out.Errors, []string{"zai: no briefs found for *.md"}) {
			t.Fatalf("errors = %q", empty.Out.Errors)
		}
	})

	t.Run("batch --wait follows every submitted job: submitted lines, one compact line each as they land, then totals", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		world.Git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		dir := filepath.Join(world.Root, "briefs")
		cliBriefFile(t, world, cliBrief, "briefs/one.md")
		cliBriefFile(t, world, cliBrief, "briefs/two.md")
		cliDrivesOnSpawn(t, &world)

		if code := cliRun(t, world, "batch", dir, "--wait"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		// The jobs run concurrently, so their lines come in landing order: compare that middle
		// part as a set.
		if len(world.Out.Lines) != 5 {
			t.Fatalf("lines = %q", world.Out.Lines)
		}
		submitted := world.Out.Lines[:2]
		wantSubmitted := []string{
			"submitted 261006-job001: Rename foo (" + filepath.Join(dir, "one.md") + ")",
			"submitted 261006-job002: Rename foo (" + filepath.Join(dir, "two.md") + ")",
		}
		if !reflect.DeepEqual(submitted, wantSubmitted) {
			t.Fatalf("submitted = %q, want %q", submitted, wantSubmitted)
		}
		landed := append([]string{}, world.Out.Lines[2:4]...)
		sort.Strings(landed)
		wantLanded := []string{
			"261006-job001 pass Rename foo gates 1/1 est. $0.0002",
			"261006-job002 pass Rename foo gates 1/1 est. $0.0002",
		}
		if !reflect.DeepEqual(landed, wantLanded) {
			t.Fatalf("landed = %q, want %q", landed, wantLanded)
		}
		if totals := world.Out.Lines[4]; totals != "2 jobs: 2 pass, 0 not pass · est. $0.0005" {
			t.Fatalf("totals = %q", totals)
		}

		mixed := fakedeps.FakeDeps(t)
		mixedDir := filepath.Join(mixed.Root, "briefs")
		cliBriefFile(t, mixed, cliBrief, "briefs/one.md")
		cliBriefFile(t, mixed, "not a brief", "briefs/two.md")
		cliDrivesOnSpawn(t, &mixed)
		if code := cliRun(t, mixed, "batch", mixedDir, "--wait"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		want := []string{
			"submitted 261006-job001: Rename foo (" + filepath.Join(mixedDir, "one.md") + ")",
			"261006-job001 pass Rename foo gates 1/1 est. $0.0002",
			"1 job: 1 pass, 0 not pass · est. $0.0002",
		}
		if !reflect.DeepEqual(mixed.Out.Lines, want) {
			t.Fatalf("lines = %q, want %q", mixed.Out.Lines, want)
		}

		clashing := fakedeps.FakeDeps(t)
		if code := cliRun(t, clashing, "batch", "briefs", "--wait", "--json"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		wantErrors := []string{
			"zai: --wait and --json exclude each other",
			"usage: batch <dir|glob|manifest.txt> [--wait] [--json]",
		}
		if !reflect.DeepEqual(clashing.Out.Errors, wantErrors) {
			t.Fatalf("errors = %q", clashing.Out.Errors)
		}
	})
}

func TestRunCliBrief(t *testing.T) {
	t.Run("brief new prints a path to a fresh template; brief lint reports errors with exit 2", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)

		if code := cliRun(t, world, "brief", "new", "Rename foo/bar!", "--mode", "exec"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		path := filepath.Join(world.Root, "briefs", "rename-foo-bar.md")
		if world.Out.Lines[0] != path {
			t.Fatalf("path = %q, want %q", world.Out.Lines[0], path)
		}
		if len(world.Out.Lines) != 1 {
			t.Fatalf("lines = %q", world.Out.Lines)
		}
		text, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(text), "title: \"Rename foo/bar!\"\n# edit:") {
			t.Fatalf("template = %q", text)
		}
		if !strings.Contains(string(text), "mode: exec") {
			t.Fatalf("template = %q", text)
		}
		cliRun(t, world, "brief", "new", "Rename foo/bar!")
		if second := world.Out.Lines[1]; second != filepath.Join(world.Root, "briefs", "rename-foo-bar-2.md") {
			t.Fatalf("path = %q", second)
		}

		if code := cliRun(t, world, "brief", "lint", path); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		want := []string{path + ": the body still has the TODO placeholder"}
		if !reflect.DeepEqual(world.Out.Lines[2:], want) {
			t.Fatalf("lines = %q, want %q", world.Out.Lines[2:], want)
		}
		if code := cliRun(t, world, "brief", "lint", cliBriefFile(t, world, "---\nmodel: gpt\n---\n")); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		invalid := filepath.Join(world.Root, "brief.md")
		wantInvalid := []string{
			invalid + ": title: required",
			invalid + ": model: must be one of glm, glm-5.3, flash, glm-5.3-flash",
			invalid + ": the body (the task) is empty",
		}
		if !reflect.DeepEqual(world.Out.Lines[3:], wantInvalid) {
			t.Fatalf("lines = %q, want %q", world.Out.Lines[3:], wantInvalid)
		}
		if code := cliRun(t, world, "brief", "lint", cliBriefFile(t, world)); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if last := world.Out.Lines[len(world.Out.Lines)-1]; last != "ok: Rename foo (glm-5.3, edit, 1 gate)" {
			t.Fatalf("line = %q", last)
		}
		if code := cliRun(t, world, "brief", "frob"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
	})
}

func TestRunCliSetup(t *testing.T) {
	t.Run("setup reports the runtime, binary, version, key present (never the value), state dir, cap; exit 6 when not ready", func(t *testing.T) {
		world := fakedeps.FakeDepsIn(t, map[string]string{"ZAI_API_KEY": "sk-zai-secret"}, fakedeps.FakeWorld{})

		if code := cliRun(t, world, "setup"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		settings := filepath.Join(world.Root, "home", ".claude", "settings.json")
		want := []string{
			"zai setup: ready. GLM 5.3 and GLM 5.3 Flash are in /model; zai:glm-5.3 and zai:glm-5.3-flash run on them.",
			"  runtime:  bun 1.3.14 (/usr/local/bin/bun)",
			"  claude:   /usr/local/bin/claude (2.1.289 (Claude Code))",
			"  key:      present (ZAI_API_KEY)",
			"  ping:     ok: glm-5.3-flash answered (2 turns, est. $0.0000)",
			"  router:   running on http://127.0.0.1:18787 (pid 4242)",
			"  models:   glm-5.3, glm-5.3-flash",
			"  settings: " + settings + " (updated: added GLM 5.3 (glm-5.3) to /model; added GLM 5.3 Flash (glm-5.3-flash) to /model; set GLM 5.3 default effort to xhigh; set GLM 5.3 Flash default effort to xhigh; pointed ANTHROPIC_BASE_URL at http://127.0.0.1:18787; turned on MCP tool search)",
			"Restart Claude Code now. This session keeps talking to Anthropic until it restarts; GLM 5.3 in /model and the zai agents work from the next session.",
		}
		if world.Out.Text() != strings.Join(want, "\n") {
			t.Fatalf("setup report =\n%s\nwant\n%s", world.Out.Text(), strings.Join(want, "\n"))
		}
		if strings.Contains(world.Out.Text(), "sk-zai-secret") {
			t.Fatal("the key leaked into the report")
		}

		broken := fakedeps.FakeDeps(t)
		broken.Host.VersionErr = errors.New("spawn claude ENOENT")
		broken.Host.KeyErr = &ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "no Z.ai key: export ZAI_API_KEY"}

		if code := cliRun(t, broken, "setup", "--json"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		parsed := jsonOf(t, broken.Out.Text())
		if parsed["ready"] != false {
			t.Fatalf("ready = %v", parsed["ready"])
		}
		if parsed["runtime"] != "bun 1.3.14 (/usr/local/bin/bun)" {
			t.Fatalf("runtime = %v", parsed["runtime"])
		}
		claude := parsed["claude"].(map[string]any)
		if claude["ok"] != false || claude["error"] != "spawn claude ENOENT" {
			t.Fatalf("claude = %v", claude)
		}
		key := parsed["key"].(map[string]any)
		if key["ok"] != false || key["error"] != "no Z.ai key: export ZAI_API_KEY" {
			t.Fatalf("key = %v", key)
		}
	})

	t.Run("setup --ping makes one tiny readonly flash call and reports it", func(t *testing.T) {
		world := fakedeps.FakeDeps(t, fakes.Completes(json.RawMessage(`{"summary":"pong","findings":[],"open_items":[]}`)))

		if code := cliRun(t, world, "setup", "--ping"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		specs := world.Worker.Specs()
		if len(specs) != 1 {
			t.Fatalf("the worker ran %d specs, want 1", len(specs))
		}
		spec := specs[0]
		if spec.Model.Tier != domain.ModelTierFlash {
			t.Fatalf("tier = %s", spec.Model.Tier)
		}
		if spec.Access != ports.AccessReadonly {
			t.Fatalf("access = %s", spec.Access)
		}
		if spec.Cwd != world.Root {
			t.Fatalf("cwd = %s", spec.Cwd)
		}
		if !reflect.DeepEqual(spec.PassEnv, map[string]string{}) {
			t.Fatalf("passEnv = %v", spec.PassEnv)
		}
		if !strings.Contains(world.Out.Text(), "  ping:     ok: glm-5.3-flash answered (2 turns, est. $0.0000)") {
			t.Fatalf("report = %q", world.Out.Text())
		}

		failing := fakedeps.FakeDeps(t, fakes.WorkerScript{Lines: []string{
			fakes.Wire.Result(fakes.ResultFields{IsError: true, Text: "API Error: 401 bad key"}),
		}})
		if code := cliRun(t, failing, "setup", "--ping"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		if !strings.Contains(failing.Out.Text(), "  ping:     FAILED: API error: API Error: 401 bad key") {
			t.Fatalf("report = %q", failing.Out.Text())
		}
	})

	t.Run("drive runs a queued job to review (the detached driver's entry)", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		worktree := filepath.Join(world.Root, "wt")
		world.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.Workspace.Worktree = &worktree
		}))

		if code := cliRun(t, world, "drive", "j1"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		job, err := world.Store.Get(context.Background(), "j1")
		if err != nil {
			t.Fatal(err)
		}
		if job.State != domain.JobStateAwaitingReview {
			t.Fatalf("state = %s", job.State)
		}
		if code := cliRun(t, world, "drive", "j1"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
	})

	t.Run("an unexpected failure is one line on stderr and exit 1", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		world.Deps.Store = cliFailingFindStore{world.Store}

		if code := cliRun(t, world, "show", "x"); code != cli.ExitUnexpected {
			t.Fatalf("exit = %d, want 1", code)
		}
		if !reflect.DeepEqual(world.Out.Errors, []string{"zai: unexpected error: disk on fire"}) {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
	})
}

// cliFailingFindStore is a store whose lookups fail, as a broken disk does.
type cliFailingFindStore struct {
	ports.JobStore
}

func (s cliFailingFindStore) Find(context.Context, string) (domain.Job, error) {
	return domain.Job{}, errors.New("disk on fire")
}
