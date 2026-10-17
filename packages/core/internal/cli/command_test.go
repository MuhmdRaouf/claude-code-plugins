package cli_test

import (
	"context"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakedeps"
)

type stubCommand struct {
	name     string
	synopsis []string
}

func (c stubCommand) Name() string                       { return c.name }
func (c stubCommand) Synopsis() []string                 { return c.synopsis }
func (c stubCommand) Options() map[string]cli.OptionSpec { return nil }
func (c stubCommand) Hidden() bool                       { return false }
func (c stubCommand) Run(context.Context, cli.Invocation) (cli.ExitCode, error) {
	return cli.ExitOK, nil
}

func TestUsageLines(t *testing.T) {
	command := stubCommand{name: "run", synopsis: []string{"run <brief.md|-> [--flash] [--wait|--bg]", "wait <id> [<id>]"}}
	got := cli.UsageLines(testkit.ReferenceProvider, command)
	want := []string{
		"usage: run <brief.md|-> [--flash] [--wait|--bg]",
		"       wait <id> [<id>]",
	}
	if len(got) != len(want) {
		t.Fatalf("lines = %q, want %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("line %d = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestFailWith(t *testing.T) {
	fakes := fakedeps.FakeDeps(t)

	code := cli.FailWith(fakes.Deps, &app.AppError{Kind: app.AppErrorNotPass, ID: "j1"})
	if code != cli.ExitNotPass {
		t.Fatalf("code = %d, want %d", code, cli.ExitNotPass)
	}
	if len(fakes.Out.Errors) != 1 {
		t.Fatalf("errors = %q, want one line", fakes.Out.Errors)
	}
	want := "zai: job j1 has verdict none, not pass: accept --force to accept it anyway"
	if fakes.Out.Errors[0] != want {
		t.Fatalf("error = %q, want %q", fakes.Out.Errors[0], want)
	}
}
