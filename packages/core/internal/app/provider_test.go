package app

import (
	"context"
	"encoding/json"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// The provider suite: the use cases name branches, trailers, env and the pinged model after the
// provider they are given.

// providerBrief is a brief document with extra front matter.
func providerBrief(front string) string {
	return "---\ntitle: Rename foo\n" + front + "\n---\nRename `foo` to `bar`.\n"
}

// acmeWorld is the drive world on the acme provider, which shares no name with zai.
func acmeWorld(t *testing.T, scripts []fakes.WorkerScript) (Deps, *driveWorld) {
	t.Helper()
	return newDriveWorld(t, scripts, nil, workerWorld{provider: &testkit.AcmeProvider})
}

// zaiName matches zai's own names, which a rendering for the acme provider must never contain.
var zaiName = regexp.MustCompile(`(?i)zai`)

func TestUseCasesTakeEveryNameFromTheProvider(t *testing.T) {
	ctx := context.Background()

	t.Run("submit puts an edit job on branch <branchPrefix><id>", func(t *testing.T) {
		deps, w := acmeWorld(t, nil)

		submitted, err := Submit(ctx, deps, SubmitInput{Text: providerBrief("mode: edit"), Cwd: "/repo"})

		if err != nil {
			t.Fatal(err)
		}
		if submitted.Workspace.Branch == nil || *submitted.Workspace.Branch != "acme-jobs/261006-job001" {
			t.Errorf("branch = %v, want the provider-prefixed one", submitted.Workspace.Branch)
		}
		if calls := w.git.Called("addWorktree"); len(calls) != 1 || calls[0][2] != "acme-jobs/261006-job001" {
			t.Errorf("addWorktree calls = %v, want the worktree on the provider's branch", calls)
		}
	})

	t.Run("drive passes the artifacts dir under the provider's variable and writes the provider's contract footer", func(t *testing.T) {
		deps, w := acmeWorld(t, nil)
		submitted, err := Submit(ctx, deps, SubmitInput{Text: providerBrief("mode: exec\ngates: [ls]"), Cwd: "/repo"})
		if err != nil {
			t.Fatal(err)
		}

		if _, err := Drive(ctx, deps, submitted.ID); err != nil {
			t.Fatal(err)
		}

		wantEnv := map[string]string{"ACME_OUT": submitted.Workspace.ArtifactsDir}
		spec := w.worker.Specs()[0]
		if !reflect.DeepEqual(spec.PassEnv, wantEnv) {
			t.Errorf("worker passEnv = %v, want %v", spec.PassEnv, wantEnv)
		}
		// The drive may retry its attempt; the first gate call already says whose env it ran with.
		if len(w.gates.Calls) == 0 || !reflect.DeepEqual(w.gates.Calls[0].PassEnv, wantEnv) {
			t.Errorf("gate passEnv = %+v, want %v", w.gates.Calls, wantEnv)
		}
		if !strings.Contains(spec.Prompt, "\n## acme contract\n") {
			t.Errorf("prompt = %q, want the provider's contract footer", spec.Prompt)
		}
		if want := "Write every output file to " + submitted.Workspace.ArtifactsDir + " (also in $ACME_OUT)."; !strings.Contains(spec.Prompt, want) {
			t.Errorf("prompt = %q, want %q", spec.Prompt, want)
		}
		if masked := strings.ReplaceAll(spec.Prompt, submitted.Workspace.ArtifactsDir, "<artifacts>"); zaiName.MatchString(masked) {
			t.Errorf("prompt = %q, want nothing of zai's in it", masked)
		}
	})

	t.Run("accept commits with the trailer `Worked-by: <catalog id> via <harness>`", func(t *testing.T) {
		deps, w := acmeWorld(t, nil)
		submitted, err := Submit(ctx, deps, SubmitInput{Text: providerBrief("mode: edit"), Cwd: "/repo"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := Drive(ctx, deps, submitted.ID); err != nil {
			t.Fatal(err)
		}

		if _, err := Accept(ctx, deps, submitted.ID, AcceptOptions{Mode: AcceptModeCommit, Force: false, Verify: true}); err != nil {
			t.Fatal(err)
		}

		calls := w.git.Called("commitAll")
		if len(calls) != 1 || calls[0][1] != "Rename foo\n\nRenamed foo to bar\n\nWorked-by: big-model-9 via acme-harness\n" {
			t.Errorf("commitAll calls = %v, want the provider's trailer", calls)
		}
	})

	t.Run("a worktree that cannot be removed is reported under the provider's name", func(t *testing.T) {
		deps, w := acmeWorld(t, nil)
		submitted, err := Submit(ctx, deps, SubmitInput{Text: providerBrief("mode: edit"), Cwd: "/repo"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := Drive(ctx, deps, submitted.ID); err != nil {
			t.Fatal(err)
		}
		w.git.RemoveWorktreeErr = &ports.GitError{Kind: ports.GitErrorGitFailed, Command: "git worktree", Stderr: "busy"}

		if _, err := Accept(ctx, deps, submitted.ID, AcceptOptions{Mode: AcceptModeCommit, Force: false, Verify: true}); err != nil {
			t.Fatal(err)
		}

		if !reflect.DeepEqual(w.out.Errors, []string{
			"acme: job 261006-job001 is accepted, but its worktree could not be removed: git worktree: busy",
		}) {
			t.Errorf("errors = %v, want the report under the provider's name", w.out.Errors)
		}
	})

	t.Run("ping asks the provider's ping tier", func(t *testing.T) {
		pong := json.RawMessage(`{"summary":"pong","findings":[],"open_items":[]}`)
		deps, w := acmeWorld(t, []fakes.WorkerScript{fakes.Completes(pong)})

		if _, err := Ping(ctx, deps); err != nil {
			t.Fatal(err)
		}

		specs := w.worker.Specs()
		if len(specs) != 1 || specs[0].Model.Tier != domain.ModelTierMain {
			t.Errorf("model = %+v, want the provider's ping tier (main)", specs)
		}
	})
}
