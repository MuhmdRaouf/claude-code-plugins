package cli_test

// The runCli edge-case suite.

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakedeps"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// commandsBrief is the suite's brief: it names the fake repository itself.
const commandsBrief = "---\ntitle: Rename foo\ncwd: /repo\n---\nRename `foo` to `bar`.\n"

// commandsWrite writes a file under the fakes' root.
func commandsWrite(t *testing.T, world fakedeps.Fakes, name, text string) string {
	t.Helper()
	return cliWriteFile(t, world.Root, name, text)
}

// commandsReviewable is the suite's awaiting_review job j1.
func commandsReviewable(t *testing.T, world fakedeps.Fakes, overrides ...func(*domain.Job)) domain.Job {
	t.Helper()
	paths := world.Store.Paths("j1")
	pass := domain.VerdictPass
	completed := domain.WorkerOutcome{Kind: domain.WorkerOutcomeCompleted}
	job := testkit.AJob(func(j *domain.Job) {
		j.ID = "j1"
		j.State = domain.JobStateAwaitingReview
		worktree, branch := paths.Worktree, "zai/j1"
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
			verification := testkit.AVerification()
			a.Verification = &verification
			a.Verdict = &pass
		})}
	})
	for _, override := range overrides {
		override(&job)
	}
	return world.Store.Put(job)
}

func TestCommandsNeedTheirArgument(t *testing.T) {
	cases := []struct{ command, message string }{
		{"show", "show needs a job id"},
		{"accept", "accept needs a job id"},
		{"discard", "discard needs a job id"},
		{"return", "return needs a job id"},
		{"drive", "drive needs a job id"},
		{"run", "run needs a brief path (- reads stdin)"},
		{"batch", "batch needs a directory, a glob or a manifest file"},
	}
	for _, tt := range cases {
		t.Run(tt.command+" without its argument is a usage error", func(t *testing.T) {
			world := fakedeps.FakeDeps(t)

			if code := cliRun(t, world, tt.command); code != cli.ExitUsage {
				t.Fatalf("exit = %d, want 2", code)
			}
			if world.Out.Errors[0] != "zai: "+tt.message {
				t.Fatalf("error = %q", world.Out.Errors[0])
			}
			if !regexp.MustCompile(`^usage: ` + tt.command + `( |$)`).MatchString(world.Out.Errors[1]) {
				t.Fatalf("usage = %q", world.Out.Errors[1])
			}
		})
	}
}

func TestCommandsHelp(t *testing.T) {
	t.Run("no command at all, or `help`, and per-command --help", func(t *testing.T) {
		none := fakedeps.FakeDeps(t)
		if code := cliRun(t, none); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		if none.Out.Errors[0] != "zai: which command?" {
			t.Fatalf("error = %q", none.Out.Errors[0])
		}

		help := fakedeps.FakeDeps(t)
		if code := cliRun(t, help, "help"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if help.Out.Lines[0] != "usage: <command> [--json]   (the /zai: slash commands run these; there is no zai command on PATH)" {
			t.Fatalf("header = %q", help.Out.Lines[0])
		}
		for _, line := range help.Out.Lines[1:] {
			if !strings.HasPrefix(line, "  ") || strings.HasPrefix(line, "  zai ") {
				t.Fatalf("synopsis = %q", line)
			}
		}
		if text := help.Out.Text(); !strings.Contains(text, "  setup [--remove] [--json]") {
			t.Fatalf("setup synopsis missing from %q", text)
		}

		brief := fakedeps.FakeDeps(t)
		if code := cliRun(t, brief, "brief", "--help"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		want := []string{
			"usage: brief new <title> [--mode edit|exec|readonly]",
			"       brief lint <path>",
		}
		if !reflect.DeepEqual(brief.Out.Lines, want) {
			t.Fatalf("lines = %q, want %q", brief.Out.Lines, want)
		}
	})
}

func TestCommandsAcceptFailures(t *testing.T) {
	t.Run("accept explains a dirty working tree; other git failures are one line", func(t *testing.T) {
		dirty := fakedeps.FakeDeps(t)
		commandsReviewable(t, dirty)
		dirty.Git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		dirty.Git.LandingErr = &ports.GitError{Kind: ports.GitErrorDirty, Paths: []string{"src/a.ts"}}

		if code := cliRun(t, dirty, "accept", "j1"); code != cli.ExitConflict {
			t.Fatalf("exit = %d, want 5", code)
		}
		want := []string{
			"zai: uncommitted changes in the way: src/a.ts: nothing was applied. Commit or stash them, then accept again.",
		}
		if !reflect.DeepEqual(dirty.Out.Errors, want) {
			t.Fatalf("errors = %q", dirty.Out.Errors)
		}

		broken := fakedeps.FakeDeps(t)
		commandsReviewable(t, broken)
		broken.Git.ChangeSet = testkit.AChangeSet(func(c *domain.ChangeSet) { c.Modified = []string{"src/a.ts"} })
		broken.Git.LandingErr = &ports.GitError{
			Kind: ports.GitErrorGitFailed, Command: "git merge --ff-only", Stderr: "boom",
		}

		if code := cliRun(t, broken, "accept", "j1"); code != cli.ExitUnexpected {
			t.Fatalf("exit = %d, want 1", code)
		}
		if !reflect.DeepEqual(broken.Out.Errors, []string{"zai: git merge --ff-only: boom"}) {
			t.Fatalf("errors = %q", broken.Out.Errors)
		}

		unknown := fakedeps.FakeDeps(t)
		if code := cliRun(t, unknown, "accept", "nope"); code != cli.ExitNotFound {
			t.Fatalf("exit = %d, want 4", code)
		}
	})

	t.Run("accept, return and discard print the job with --json; discard without a reason", func(t *testing.T) {
		accepted := fakedeps.FakeDeps(t)
		commandsReviewable(t, accepted, func(j *domain.Job) {
			j.Brief = testkit.ABrief(func(b *domain.Brief) { b.Mode = domain.ModeReadonly; b.Scope = []string{} })
		})
		cliRun(t, accepted, "accept", "j1", "--json")
		parsed := jsonOf(t, accepted.Out.Text())
		if parsed["id"] != "j1" || parsed["state"] != "accepted" {
			t.Fatalf("job = %v", parsed)
		}

		returned := fakedeps.FakeDeps(t)
		commandsReviewable(t, returned)
		cliRun(t, returned, "return", "j1", "again", "--json")
		parsed = jsonOf(t, returned.Out.Text())
		if parsed["id"] != "j1" || parsed["state"] != "queued" {
			t.Fatalf("job = %v", parsed)
		}

		discarded := fakedeps.FakeDeps(t)
		commandsReviewable(t, discarded)
		cliRun(t, discarded, "discard", "j1", "--json")
		parsed = jsonOf(t, discarded.Out.Text())
		if parsed["id"] != "j1" || parsed["state"] != "discarded" {
			t.Fatalf("job = %v", parsed)
		}

		plain := fakedeps.FakeDeps(t)
		commandsReviewable(t, plain)
		if code := cliRun(t, plain, "discard", "j1", "--reason", "  "); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if !reflect.DeepEqual(plain.Out.Lines, []string{"zai job j1 discarded"}) {
			t.Fatalf("lines = %q", plain.Out.Lines)
		}
		if code := cliRun(t, plain, "return", "nope", "fix it"); code != cli.ExitNotFound {
			t.Fatalf("exit = %d, want 4", code)
		}
		if code := cliRun(t, plain, "discard", "nope"); code != cli.ExitNotFound {
			t.Fatalf("exit = %d, want 4", code)
		}
	})

	t.Run("stop reports each failure and keeps going; --all with nothing to stop says so; --json lists the stopped jobs", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		world.Store.Put(testkit.AJob(func(j *domain.Job) { j.ID = "j-idle"; j.State = domain.JobStateQueued }))

		if code := cliRun(t, world, "stop", "nope", "j-idle"); code != cli.ExitNotFound {
			t.Fatalf("exit = %d, want 4", code)
		}
		if !reflect.DeepEqual(world.Out.Errors, []string{`zai: no zai job matches "nope" (/zai:board lists them)`}) {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
		if !reflect.DeepEqual(world.Out.Lines, []string{"zai job j-idle stopped: awaiting review"}) {
			t.Fatalf("lines = %q", world.Out.Lines)
		}

		empty := fakedeps.FakeDeps(t)
		if code := cli.RunCli(context.Background(), []string{"stop", "--all"}, empty.Deps, "/elsewhere"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if !reflect.DeepEqual(empty.Out.Lines, []string{"zai: no queued or running job to stop"}) {
			t.Fatalf("lines = %q", empty.Out.Lines)
		}

		asJSON := fakedeps.FakeDeps(t)
		asJSON.Store.Put(testkit.AJob(func(j *domain.Job) { j.ID = "j-idle"; j.State = domain.JobStateQueued }))
		cliRun(t, asJSON, "stop", "--all", "--json")
		var stopped []map[string]any
		if err := json.Unmarshal([]byte(asJSON.Out.Text()), &stopped); err != nil {
			t.Fatalf("stdout: %v", err)
		}
		if len(stopped) != 1 || stopped[0]["id"] != "j-idle" || stopped[0]["state"] != "awaiting_review" {
			t.Fatalf("stopped = %v", stopped)
		}
	})

	t.Run("show --follow --json prints only the settled row; show stops following a job whose driver is gone", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		world.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))

		if code := cliRun(t, world, "show", "j1", "--follow", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		parsed := jsonOf(t, world.Out.Text())
		job := parsed["job"].(map[string]any)
		if job["id"] != "j1" || parsed["live"] != false {
			t.Fatalf("row = %v", parsed)
		}

		live := fakedeps.FakeDeps(t)
		job1 := live.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))
		live.Store.HoldLock("j1", int64(os.Getpid()))
		clock := live.Clock
		live.Deps.Clock = &cliHookClock{Clock: clock, before: func() {
			next := job1
			next.State = domain.JobStateAwaitingReview
			live.Store.Put(next)
		}}
		cliRun(t, live, "show", "j1", "--follow", "--json")
		if len(live.Out.Lines) != 1 {
			t.Fatalf("lines = %q", live.Out.Lines)
		}
	})

	t.Run("usage --json and review of an unknown job", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		commandsReviewable(t, world, func(j *domain.Job) { j.State = domain.JobStateAccepted })

		if code := cliRun(t, world, "usage", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		parsed := jsonOf(t, world.Out.Text())
		if _, has := parsed["spool"]; !has {
			t.Fatalf("spool missing from %v", parsed)
		}
		if _, has := parsed["jobs"]; !has {
			t.Fatalf("jobs missing from %v", parsed)
		}
		if code := cliRun(t, world, "review", "nope"); code != cli.ExitNotFound {
			t.Fatalf("exit = %d, want 4", code)
		}
	})

	t.Run("run --wait --json prints the settled job; run passes a submit failure through", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		brief := commandsWrite(t, world, "b.md", commandsBrief)
		deps := world.Deps
		world.Process.SetOnSpawn(func(id string) {
			_, _ = app.Drive(context.Background(), deps, id)
		})

		if code := cliRun(t, world, "run", brief, "--wait", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		parsed := jsonOf(t, world.Out.Text())
		if parsed["state"] != "awaiting_review" {
			t.Fatalf("job = %v", parsed)
		}

		outside := fakedeps.FakeDeps(t)
		elsewhere := commandsWrite(t, outside, "b.md", "---\ntitle: T\ncwd: /nowhere\n---\nDo it.\n")
		if code := cliRun(t, outside, "run", elsewhere); code != cli.ExitUnexpected {
			t.Fatalf("exit = %d, want 1", code)
		}
		// The cwd resolves before the repository lookup, so the refused line names the
		// platform-resolved path.
		if want := []string{"zai: not a git repository: " + domain.ResolvePath("/repo", "/nowhere")}; !reflect.DeepEqual(outside.Out.Errors, want) {
			t.Fatalf("errors = %q", outside.Out.Errors)
		}
	})

	t.Run("drive passes a failure through", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)

		if code := cliRun(t, world, "drive", "nope"); code != cli.ExitNotFound {
			t.Fatalf("exit = %d, want 4", code)
		}
	})

	t.Run("batch takes a single brief file; unreadable manifest entries are rejected; --json lists rejections", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		one := commandsWrite(t, world, "one.md", commandsBrief)

		if code := cliRun(t, world, "batch", one); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if !reflect.DeepEqual(world.Out.Lines, []string{"submitted 261006-job001: Rename foo (" + one + ")"}) {
			t.Fatalf("lines = %q", world.Out.Lines)
		}

		listed := fakedeps.FakeDeps(t)
		manifest := commandsWrite(t, listed, "jobs.txt", "missing.md\n")
		if code := cliRun(t, listed, "batch", manifest, "--json"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		parsed := jsonOf(t, listed.Out.Text())
		if submitted := parsed["submitted"].([]any); len(submitted) != 0 {
			t.Fatalf("submitted = %v", submitted)
		}
		rejected := parsed["rejected"].([]any)
		if len(rejected) != 1 {
			t.Fatalf("rejected = %v", rejected)
		}
		entry := rejected[0].(map[string]any)
		if entry["path"] != filepath.Join(listed.Root, "missing.md") {
			t.Fatalf("path = %v", entry["path"])
		}
		if !regexp.MustCompile(`^cannot read .*missing\.md: ENOENT`).MatchString(entry["error"].(string)) {
			t.Fatalf("error = %v", entry["error"])
		}
	})

	t.Run("brief new: a bad mode or no title is a usage error; a title without letters gets the slug brief", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)

		if code := cliRun(t, world, "brief", "new", "X", "--mode", "yolo"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		if code := cliRun(t, world, "brief", "new"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		if code := cliRun(t, world, "brief", "lint"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		var messages []string
		for _, line := range world.Out.Errors {
			if strings.HasPrefix(line, "zai: ") {
				messages = append(messages, line)
			}
		}
		want := []string{
			"zai: --mode must be edit, exec or readonly",
			"zai: brief new needs a title",
			"zai: brief lint needs a path",
		}
		if !reflect.DeepEqual(messages, want) {
			t.Fatalf("errors = %q, want %q", messages, want)
		}
		if code := cliRun(t, world, "brief", "new", "!!!"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if !reflect.DeepEqual(world.Out.Lines, []string{filepath.Join(world.Root, "briefs", "brief.md")}) {
			t.Fatalf("lines = %q", world.Out.Lines)
		}
	})

	t.Run("brief lint: an unreadable file, and a valid brief whose env names are unset", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		brief := commandsWrite(t, world, "env.md", "---\ntitle: T\nenv: [TOKEN]\n---\nDo it.\n")

		if code := cliRun(t, world, "brief", "lint", "/nope.md"); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		// The read failure names the resolved path, whose separators are the platform's own.
		if want := `^zai: cannot read ` + regexp.QuoteMeta(domain.ResolvePath("/repo", "/nope.md")) + `: ENOENT`; !regexp.MustCompile(want).MatchString(world.Out.Errors[0]) {
			t.Fatalf("error = %q", world.Out.Errors[0])
		}
		if code := cliRun(t, world, "brief", "lint", brief); code != cli.ExitUsage {
			t.Fatalf("exit = %d, want 2", code)
		}
		want := []string{brief + ": the brief's env names are not set in this environment: TOKEN"}
		if !reflect.DeepEqual(world.Out.Lines, want) {
			t.Fatalf("lines = %q, want %q", world.Out.Lines, want)
		}
	})
}

func TestCommandsSetup(t *testing.T) {
	t.Run("setup renders failed checks as text and skips the ping when not ready; a ping that cannot start fails", func(t *testing.T) {
		broken := fakedeps.FakeDeps(t)
		broken.Host.VersionErr = errors.New("spawn claude ENOENT")
		broken.Host.KeyErr = &ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "no Z.ai key: export ZAI_API_KEY"}

		if code := cliRun(t, broken, "setup", "--ping"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		if !strings.Contains(broken.Out.Text(), "  claude:   /usr/local/bin/claude: FAILED: spawn claude ENOENT") {
			t.Fatalf("report = %q", broken.Out.Text())
		}
		if !strings.Contains(broken.Out.Text(), "  key:      MISSING: no Z.ai key: export ZAI_API_KEY") {
			t.Fatalf("report = %q", broken.Out.Text())
		}
		if first := strings.SplitN(broken.Out.Lines[0], "\n", 2)[0]; first != "zai setup: not ready. The FAILED line below says why." {
			t.Fatalf("first line = %q", first)
		}
		if strings.Contains(broken.Out.Text(), "Restart Claude Code") {
			t.Fatalf("report = %q", broken.Out.Text())
		}
		if specs := broken.Worker.Specs(); len(specs) != 0 {
			t.Fatalf("the worker ran %d specs, want 0", len(specs))
		}

		unstartable := fakedeps.FakeDeps(t, fakes.WorkerScript{
			StartError: &ports.WorkerError{Kind: ports.WorkerErrorSpawnFailed, Message: "EACCES"},
		})
		if code := cliRun(t, unstartable, "setup", "--ping"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		if !strings.Contains(unstartable.Out.Text(), "  ping:     FAILED: cannot start claude: EACCES") {
			t.Fatalf("report = %q", unstartable.Out.Text())
		}
	})

	t.Run("setup prints only the plugin's own extra checks: none means no key line, and the worker's label keys the JSON", func(t *testing.T) {
		world := fakedeps.FakeDepsIn(t, nil, fakedeps.FakeWorld{Provider: &testkit.AcmeProvider})
		world.Deps.Host.ExtraChecks = func(context.Context) []app.SetupCheck { return nil }

		if code := cliRun(t, world, "setup"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if code := cliRun(t, world, "setup", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}

		want := strings.Join([]string{
			"acme setup: ready. Big Model 9 and Small Model 9 are in /model; acme:big-model-9 and acme:small-model-9 run on them.",
			"  runtime:  bun 1.3.14 (/usr/local/bin/bun)",
			"  acmebot:  /usr/local/bin/claude (2.1.289 (Claude Code))",
			"  ping:     ok: big-model-9 answered (2 turns, unpriced)",
			"  router:   running on http://127.0.0.1:18800 (pid 4242)",
			"  models:   big-model-9, small-model-9",
			"  settings: " + filepath.Join(world.Root, "home", ".claude", "settings.json") + " (updated: added Big Model 9 (big-model-9) to /model; added Small Model 9 (small-model-9) to /model; pointed HTTPS_PROXY at http://127.0.0.1:18800; turned on MCP tool search)",
			"Restart Claude Code now. This session keeps talking to Anthropic until it restarts; Big Model 9 in /model and the acme agents work from the next session.",
		}, "\n")
		if world.Out.Lines[0] != want {
			t.Fatalf("report =\n%s\nwant\n%s", world.Out.Lines[0], want)
		}
		raw := world.Out.Lines[1]
		var order []string
		for _, field := range []string{"ready", "runtime", "acmebot", "state", "cap", "ping", "router", "models", "settings"} {
			if at := strings.Index(raw, `"`+field+`":`); at < 0 {
				t.Fatalf("%s missing from %s", field, raw)
			}
			order = append(order, field)
		}
		// The member order above is positional in the loop; this pass pins the member order
		// of the document itself, which setup's JSON output keeps fixed.
		position := 0
		for _, field := range []string{"ready", "runtime", "acmebot", "state", "cap", "ping", "router", "models", "settings"} {
			at := strings.Index(raw, `"`+field+`":`)
			if at < 0 {
				t.Fatalf("%s missing from %s", field, raw)
			}
			if at < position {
				t.Fatalf("%s out of order in %s", field, raw)
			}
			position = at
		}
	})
}

func TestCommandsSetupSaysWhatIsTrue(t *testing.T) {
	t.Run("a base URL kept for the user's own proxy is not routed, not ready, and says how to fix it", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		commandsWrite(t, world, filepath.Join("home", ".claude", "settings.json"),
			`{"env":{"ANTHROPIC_BASE_URL":"http://proxy.local:9000"}}`)

		if code := cliRun(t, world, "setup"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		first := strings.SplitN(world.Out.Text(), "\n", 2)[0]
		want := "zai setup: not routed. ANTHROPIC_BASE_URL in settings.json points at your own proxy (http://proxy.local:9000), so Z.ai GLM requests never reach the zai router and its agents run on Sonnet. Point that proxy at http://127.0.0.1:18787, or remove the entry and run /zai:setup again."
		if first != want {
			t.Fatalf("first line = %q", first)
		}
		if strings.Contains(world.Out.Text(), "ready.") || strings.Contains(world.Out.Text(), "Restart Claude Code") {
			t.Fatalf("report = %q", world.Out.Text())
		}

		world.Out.Lines = nil
		if code := cliRun(t, world, "setup", "--json"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		parsed := jsonOf(t, world.Out.Text())
		if parsed["ready"] != false || parsed["routed"] != false || parsed["baseUrl"] != "http://proxy.local:9000" {
			t.Fatalf("json = %v", parsed)
		}
	})

	t.Run("the restart line only when this run changed something; it never claims /model works before a restart", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)

		if code := cliRun(t, world, "setup"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if !strings.Contains(world.Out.Text(), "This session keeps talking to Anthropic until it restarts") {
			t.Fatalf("report = %q", world.Out.Text())
		}
		if strings.Contains(world.Out.Text(), "or run /model") {
			t.Fatalf("report = %q", world.Out.Text())
		}

		world.Out.Lines = nil
		if code := cliRun(t, world, "setup"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if first := strings.SplitN(world.Out.Text(), "\n", 2)[0]; !regexp.MustCompile(`^zai setup: ready\.`).MatchString(first) {
			t.Fatalf("first line = %q", first)
		}
		if strings.Contains(world.Out.Text(), "Restart Claude Code") {
			t.Fatalf("report = %q", world.Out.Text())
		}
	})

	t.Run("the report is short: no state dir or cap line (they are in --json)", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)

		if code := cliRun(t, world, "setup"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if regexp.MustCompile(`(?m)^\s+(state|cap):`).MatchString(world.Out.Text()) {
			t.Fatalf("report = %q", world.Out.Text())
		}
		if lines := strings.Split(world.Out.Text(), "\n"); len(lines) > 9 {
			t.Fatalf("report is %d lines long: %q", len(lines), world.Out.Text())
		}
		world.Out.Lines = nil
		cliRun(t, world, "setup", "--json")
		if parsed := jsonOf(t, world.Out.Text()); parsed["cap"] == nil {
			t.Fatalf("json = %v", parsed)
		}
	})
}

func TestCommandsSecondProvider(t *testing.T) {
	t.Run("wait on a stale job names the provider's own stop and discard", func(t *testing.T) {
		world := fakedeps.FakeDepsIn(t, nil, fakedeps.FakeWorld{Provider: &testkit.AcmeProvider})
		world.Store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "j1"
			j.State = domain.JobStateRunning
			j.Attempts = []domain.Attempt{testkit.AnAttempt()}
		}))

		if code := cliRun(t, world, "wait", "j1"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		want := []string{
			"acme: job j1 is running but has no live driver; /acme:board stops it (it moves to review), /acme:review j1 then discards it.",
		}
		if !reflect.DeepEqual(world.Out.Errors, want) {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
	})

	t.Run("an unexpected failure is one line under the provider's name", func(t *testing.T) {
		world := fakedeps.FakeDepsIn(t, nil, fakedeps.FakeWorld{Provider: &testkit.AcmeProvider})
		world.Deps.Store = cliFailingFindStore{world.Store}

		if code := cliRun(t, world, "show", "x"); code != cli.ExitUnexpected {
			t.Fatalf("exit = %d, want 1", code)
		}
		if !reflect.DeepEqual(world.Out.Errors, []string{"acme: unexpected error: disk on fire"}) {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
	})
}
