package cli

import (
	"context"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// OptionType is the kind of value one command option takes.
type OptionType string

const (
	OptionTypeBoolean OptionType = "boolean"
	OptionTypeString  OptionType = "string"
)

// OptionSpec is one command-line option: a boolean flag or a string value.
type OptionSpec struct {
	Type OptionType
}

// Invocation is what a command sees: parsed flags and positionals, the deps, the caller's cwd.
type Invocation interface {
	Deps() app.Deps
	Cwd() string
	Positionals() []string
	Flag(name string) bool
	Text(name string) *string
	// Usage prints `<provider>: <message>` and the command's synopsis on stderr; exit 2.
	Usage(message string) ExitCode
	// Fail prints `<provider>: <describeError>` on stderr; returns the error's exit code.
	Fail(err *app.AppError) ExitCode
	// JSON writes value on stdout as indented JSON.
	JSON(value any) error
}

// Command is one CLI command.
type Command interface {
	Name() string
	// Synopsis lines, without the leading CLI name.
	Synopsis() []string
	Options() map[string]OptionSpec
	// Hidden says an internal entry point stays out of help.
	Hidden() bool
	Run(ctx context.Context, call Invocation) (ExitCode, error)
}

// UsageLines is a command's synopsis lines. They name no `<provider>` binary: there is none on
// PATH, the slash commands run the bundle through the plugin's launcher.
func UsageLines(_ domain.Provider, command Command) []string {
	synopsis := command.Synopsis()
	lines := make([]string, 0, len(synopsis))
	for i, line := range synopsis {
		if i == 0 {
			lines = append(lines, "usage: "+line)
		} else {
			// The usage layout is fixed: a continuation line carries six spaces of indent plus
			// the separator space, seven in all.
			lines = append(lines, "       "+line)
		}
	}
	return lines
}

// FailWith prints `<provider>: <describeError>` on stderr and returns the error's exit code.
func FailWith(deps app.Deps, err *app.AppError) ExitCode {
	deps.Out.Error(deps.Provider.Name + ": " + DescribeError(deps.Provider, err))
	return ExitFor(err)
}
