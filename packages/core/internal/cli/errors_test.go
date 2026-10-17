package cli_test

import (
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// One AppError per case, with its one line and its exit code.
func TestDescribeErrorExitFor(t *testing.T) {
	gateFail := domain.VerdictGateFail
	cases := []struct {
		name string
		err  *app.AppError
		line string
		code cli.ExitCode
	}{
		{
			"brief",
			&app.AppError{Kind: app.AppErrorBrief, BriefErrors: []domain.BriefError{{Kind: domain.BriefErrorYaml, Message: "bad indent"}}},
			"invalid brief: YAML: bad indent",
			cli.ExitUsage,
		},
		{
			"brief_unreadable",
			&app.AppError{Kind: app.AppErrorBriefUnreadable, Path: "/b.md", Message: "EACCES"},
			"cannot read /b.md: EACCES",
			cli.ExitUsage,
		},
		{
			"missing_env",
			&app.AppError{Kind: app.AppErrorMissingEnv, Names: []string{"TOKEN", "URL"}},
			"the brief's env names are not set in this environment: TOKEN, URL",
			cli.ExitUsage,
		},
		{
			"wrong_state",
			&app.AppError{Kind: app.AppErrorWrongState, ID: "j1", State: domain.JobStateQueued, Allowed: []domain.JobState{domain.JobStateAwaitingReview}},
			"job j1 is queued; this only works on a job that awaits review",
			cli.ExitUsage,
		},
		{
			"lifecycle",
			&app.AppError{Kind: app.AppErrorLifecycle, LifecycleError: domain.LifecycleError{Kind: domain.IllegalTransition, From: domain.JobStateAccepted, Event: domain.EventReturned}},
			"the job was already accepted, so it cannot be returned",
			cli.ExitUnexpected,
		},
		{
			"git not_a_repo",
			&app.AppError{Kind: app.AppErrorGit, GitError: &ports.GitError{Kind: ports.GitErrorNotARepo, Path: "/x"}},
			"not a git repository: /x",
			cli.ExitUnexpected,
		},
		{
			"git bad_ref",
			&app.AppError{Kind: app.AppErrorGit, GitError: &ports.GitError{Kind: ports.GitErrorBadRef, Ref: "nope"}},
			"unknown git ref: nope",
			cli.ExitUnexpected,
		},
		{
			"git dirty",
			&app.AppError{Kind: app.AppErrorGit, GitError: &ports.GitError{Kind: ports.GitErrorDirty, Paths: []string{"a", "b"}}},
			"uncommitted changes in the way: a, b",
			cli.ExitConflict,
		},
		{
			"store locked",
			&app.AppError{Kind: app.AppErrorStore, StoreError: &ports.StoreError{Kind: ports.StoreErrorLocked, ID: "j1", HolderPid: 42}},
			"job j1 is held by the driver with pid 42",
			cli.ExitUnexpected,
		},
		{
			"store version_conflict",
			&app.AppError{Kind: app.AppErrorStore, StoreError: &ports.StoreError{Kind: ports.StoreErrorVersionConflict, ID: "j1", Expected: 1, Actual: 2}},
			"job j1 changed meanwhile; run the command again",
			cli.ExitUnexpected,
		},
		{
			"store io",
			&app.AppError{Kind: app.AppErrorStore, StoreError: &ports.StoreError{Kind: ports.StoreErrorIO, Message: "EIO"}},
			"state store: EIO",
			cli.ExitUnexpected,
		},
		{
			"worker insecure_key_file",
			&app.AppError{Kind: app.AppErrorWorker, WorkerError: &ports.WorkerError{Kind: ports.WorkerErrorInsecureKeyFile, Label: "Z.ai key file", Path: "/k", Mode: "0644"}},
			"Z.ai key file /k has mode 0644: run chmod 600 on it",
			cli.ExitUnexpected,
		},
		{
			"worker spawn_failed",
			&app.AppError{Kind: app.AppErrorWorker, WorkerError: &ports.WorkerError{Kind: ports.WorkerErrorSpawnFailed, Message: "ENOENT"}},
			"cannot start claude: ENOENT",
			cli.ExitUnexpected,
		},
		{
			"worker protocol",
			&app.AppError{Kind: app.AppErrorWorker, WorkerError: &ports.WorkerError{Kind: ports.WorkerErrorProtocol, Message: "no ready frame within 45s"}},
			"claude does not speak the expected protocol: no ready frame within 45s",
			cli.ExitUnexpected,
		},
		{
			"worker unsupported",
			&app.AppError{Kind: app.AppErrorWorker, WorkerError: &ports.WorkerError{Kind: ports.WorkerErrorUnsupported, Message: "effort medium"}},
			"claude cannot do this: effort medium",
			cli.ExitUnexpected,
		},
		{
			"empty_feedback",
			&app.AppError{Kind: app.AppErrorEmptyFeedback},
			"the feedback must not be empty",
			cli.ExitUsage,
		},
		{
			"not_pass",
			&app.AppError{Kind: app.AppErrorNotPass, ID: "j1"},
			"job j1 has verdict none, not pass: accept --force to accept it anyway",
			cli.ExitNotPass,
		},
		// The kinds the other suites cover; same one line and exit code shape.
		{
			"store not_found",
			&app.AppError{Kind: app.AppErrorStore, StoreError: &ports.StoreError{Kind: ports.StoreErrorNotFound, ID: "j1"}},
			`no zai job matches "j1" (/zai:board lists them)`,
			cli.ExitNotFound,
		},
		{
			"git conflict",
			&app.AppError{Kind: app.AppErrorGit, GitError: &ports.GitError{Kind: ports.GitErrorConflict, Paths: []string{"a", "b"}}},
			"conflict in a, b",
			cli.ExitConflict,
		},
		{
			"land_conflict",
			&app.AppError{Kind: app.AppErrorLandConflict, Paths: []string{"a", "b"}},
			"conflict in a, b",
			cli.ExitConflict,
		},
		{
			"land_verify_failed",
			&app.AppError{Kind: app.AppErrorLandVerifyFailed, Command: "npm test"},
			"verification in a fresh checkout failed: npm test",
			cli.ExitConflict,
		},
		{
			"engine_not_enabled",
			&app.AppError{Kind: app.AppErrorEngineNotEnabled, Engine: domain.EngineToolOmp},
			"the omp engine is not enabled: run /zai:setup:omp first",
			cli.ExitNotReady,
		},
		{
			"not_pass with a verdict",
			&app.AppError{Kind: app.AppErrorNotPass, ID: "j1", Verdict: &gateFail},
			"job j1 has verdict gate_fail, not pass: accept --force to accept it anyway",
			cli.ExitNotPass,
		},
		{
			"brief with every field error",
			&app.AppError{Kind: app.AppErrorBrief, BriefErrors: []domain.BriefError{{Kind: domain.BriefErrorNoFrontMatter}, {Kind: domain.BriefErrorField, Field: "title", Message: "is required"}, {Kind: domain.BriefErrorEmptyBody}}},
			"invalid brief: no YAML front matter (start the file with ---); title: is required; the body (the task) is empty",
			cli.ExitUsage,
		},
		{
			"missing_env with one name",
			&app.AppError{Kind: app.AppErrorMissingEnv, Names: []string{"TOKEN"}},
			"the brief's env names are not set in this environment: TOKEN",
			cli.ExitUsage,
		},
		{
			"wrong_state with several allowed states",
			&app.AppError{Kind: app.AppErrorWrongState, ID: "j1", State: domain.JobStateQueued, Allowed: []domain.JobState{domain.JobStateRunning, domain.JobStateVerifying}},
			"job j1 is queued; this only works on a job that is running or is being verified",
			cli.ExitUsage,
		},
		{
			"lifecycle with a state and an event outside the tables",
			&app.AppError{Kind: app.AppErrorLifecycle, LifecycleError: domain.LifecycleError{Kind: domain.IllegalTransition, From: domain.JobState("stuck_in_review"), Event: domain.JobEventType("mystery_event")}},
			// JS replace swaps only the first underscore; later ones stay.
			"the job is stuck in_review, so it cannot be mystery event",
			cli.ExitUnexpected,
		},
		// Unknown kinds still render and exit unexpectedly, as the port's own error tables do.
		{
			"brief with an unknown kind",
			&app.AppError{Kind: app.AppErrorBrief, BriefErrors: []domain.BriefError{{Kind: domain.BriefErrorKind("weird")}}},
			"invalid brief: brief error: weird",
			cli.ExitUsage,
		},
		{
			"store with an unknown kind",
			&app.AppError{Kind: app.AppErrorStore, StoreError: &ports.StoreError{Kind: ports.StoreErrorKind("weird"), ID: "j1"}},
			"state store error: weird",
			cli.ExitUnexpected,
		},
		{
			"app error with an unknown kind",
			&app.AppError{Kind: app.AppErrorKind("weird")},
			"app error: weird",
			cli.ExitUnexpected,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name+" → its one line and exit code", func(t *testing.T) {
			if got := cli.DescribeError(testkit.ReferenceProvider, tc.err); got != tc.line {
				t.Fatalf("DescribeError = %q, want %q", got, tc.line)
			}
			if got := cli.ExitFor(tc.err); got != tc.code {
				t.Fatalf("ExitFor = %d, want %d", got, tc.code)
			}
		})
	}
}

// The provider's own names reach the worker error lines.
func TestDescribeErrorWorkerNamesComeFromOutside(t *testing.T) {
	t.Run("renders worker errors in the provider's own names: the key-file label and the worker name come from outside", func(t *testing.T) {
		insecure := cli.DescribeError(testkit.AcmeProvider, &app.AppError{
			Kind:        app.AppErrorWorker,
			WorkerError: &ports.WorkerError{Kind: ports.WorkerErrorInsecureKeyFile, Label: "acme key file", Path: "/k", Mode: "0644"},
		})
		if insecure != "acme key file /k has mode 0644: run chmod 600 on it" {
			t.Fatalf("insecure = %q", insecure)
		}
		spawn := cli.DescribeError(testkit.AcmeProvider, &app.AppError{
			Kind:        app.AppErrorWorker,
			WorkerError: &ports.WorkerError{Kind: ports.WorkerErrorSpawnFailed, Message: "ENOENT"},
		})
		if spawn != "cannot start acmebot: ENOENT" {
			t.Fatalf("spawn = %q", spawn)
		}
	})
}
