package cli

import (
	"context"
	"errors"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/render"
)

// commands is every CLI command, in help order. Treat as read-only.
var commands = []Command{
	RunCommand{},
	WaitCommand{},
	BatchCommand{},
	BoardCommand{},
	ShowCommand{},
	ReviewCommand{},
	AcceptCommand{},
	ReturnCommand{},
	DiscardCommand{},
	StopCommand{},
	UsageCommand{},
	SetupCommand{},
	BriefCommand{},
	DriveCommand{},
	AuthServeCommand{},
}

// RunCli is the CLI: one command name and its arguments over the wired deps.
func RunCli(ctx context.Context, argv []string, deps app.Deps, cwd string) ExitCode {
	var name string
	var rest []string
	if len(argv) > 0 {
		name, rest = argv[0], argv[1:]
	}
	if !isAgentHook(name, rest) {
		app.CleanupWorkspace(ctx, deps)
	}
	if isHelp(name) {
		for _, line := range Synopsis(deps.Provider) {
			deps.Out.Line(line)
		}
		return ExitOK
	}
	cli := deps.Provider.Name
	command := findCommand(name)
	if command == nil {
		if name == "" {
			deps.Out.Error(cli + ": which command?")
		} else {
			deps.Out.Error(cli + ": unknown command \"" + name + "\"")
		}
		for _, line := range Synopsis(deps.Provider) {
			deps.Out.Error(line)
		}
		return ExitUsage
	}
	code, err := invoke(ctx, command, rest, deps, cwd)
	if err != nil {
		deps.Out.Error(cli + ": unexpected error: " + err.Error())
		return ExitUnexpected
	}
	return code
}

func isHelp(name string) bool {
	return name == "--help" || name == "-h" || name == "help"
}

// isAgentHook: the SubagentStop hook has under a second, so the workspace cleanup waits for the
// next real command.
func isAgentHook(name string, rest []string) bool {
	return name == "usage" && containsArg(rest, "--hook")
}

func containsArg(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

func findCommand(name string) Command {
	for _, candidate := range commands {
		if candidate.Name() == name {
			return candidate
		}
	}
	return nil
}

// Synopsis is the help: every public command's synopsis, under a header saying how they are
// reached (there is no `<provider>` command on PATH; the plugin's slash commands run them).
func Synopsis(provider domain.Provider) []string {
	lines := []string{
		"usage: <command> [--json]   (the " + provider.Slash +
			" slash commands run these; there is no " + provider.Name + " command on PATH)",
	}
	for _, command := range commands {
		if command.Hidden() {
			continue
		}
		for _, line := range command.Synopsis() {
			lines = append(lines, "  "+line)
		}
	}
	return lines
}

// invocation is what a command sees: the parsed flags and positionals, the deps, the cwd.
type invocation struct {
	deps        app.Deps
	cwd         string
	positionals []string
	values      map[string]any
	command     Command
}

var _ Invocation = invocation{}

func (i invocation) Deps() app.Deps        { return i.deps }
func (i invocation) Cwd() string           { return i.cwd }
func (i invocation) Positionals() []string { return i.positionals }
func (i invocation) Flag(name string) bool { value, _ := i.values[name].(bool); return value }
func (i invocation) Text(name string) *string {
	text, ok := i.values[name].(string)
	if !ok {
		return nil
	}
	return &text
}

func (i invocation) Usage(message string) ExitCode {
	i.deps.Out.Error(i.deps.Provider.Name + ": " + message)
	for _, line := range UsageLines(i.deps.Provider, i.command) {
		i.deps.Out.Error(line)
	}
	return ExitUsage
}

func (i invocation) Fail(err *app.AppError) ExitCode { return FailWith(i.deps, err) }

func (i invocation) JSON(value any) error {
	data, err := domain.MarshalIndentJSON(value)
	if err != nil {
		return err
	}
	// JSON.stringify carried no trailing newline of its own; the output port's line adds the one
	// the transcript shows, so the state-file marshaler's newline is trimmed here.
	i.deps.Out.Line(strings.TrimSuffix(string(data), "\n"))
	return nil
}

// invoke parses one command's arguments and runs it; the error reaches RunCli's one
// unexpected-failure line.
func invoke(ctx context.Context, command Command, argv []string, deps app.Deps, cwd string) (ExitCode, error) {
	call := invocation{deps: deps, cwd: cwd, command: command}
	options := map[string]OptionSpec{
		"json": {Type: OptionTypeBoolean},
		"help": {Type: OptionTypeBoolean},
	}
	for name, spec := range command.Options() {
		options[name] = spec
	}
	parsed, err := Parse(argv, options)
	if err != nil {
		return call.Usage(err.Error()), nil
	}
	call.positionals = parsed.Positionals
	call.values = parsed.Values
	if call.Flag("help") {
		for _, line := range UsageLines(deps.Provider, command) {
			deps.Out.Line(line)
		}
		return ExitOK, nil
	}
	return command.Run(ctx, call)
}

// resolvePath is Node's path.resolve from cwd: an absolute path stands, anything else joins
// and cleans.
func resolvePath(cwd, path string) string {
	return domain.ResolvePath(cwd, path)
}

// appFail prints one app error the way the CLI reports it; anything else is unexpected and
// reaches RunCli's one line.
func appFail(call Invocation, err error) (ExitCode, error) {
	var appErr *app.AppError
	if errors.As(err, &appErr) {
		return call.Fail(appErr), nil
	}
	return ExitUnexpected, err
}

// ── run and drive ────────────────────────────────────────────────────────────────────────────

// RunCommand is `run`: submit a brief, a detached driver works it (--wait follows it).
type RunCommand struct{}

var _ Command = RunCommand{}

func (RunCommand) Name() string { return "run" }

func (RunCommand) Synopsis() []string {
	return []string{"run <brief.md|-> [--flash] [--mode edit|exec|readonly] [--wait|--bg] [--json]"}
}

func (RunCommand) Options() map[string]OptionSpec {
	return map[string]OptionSpec{
		"flash":  {Type: OptionTypeBoolean},
		"mode":   {Type: OptionTypeString},
		"wait":   {Type: OptionTypeBoolean},
		"bg":     {Type: OptionTypeBoolean},
		"engine": {Type: OptionTypeString},
	}
}

func (RunCommand) Hidden() bool { return false }

func (RunCommand) Run(ctx context.Context, call Invocation) (ExitCode, error) {
	positionals := call.Positionals()
	if len(positionals) == 0 {
		return call.Usage("run needs a brief path (- reads stdin)"), nil
	}
	path := positionals[0]
	if call.Flag("wait") && call.Flag("bg") {
		return call.Usage("--wait and --bg exclude each other"), nil
	}
	overrides, usageErr := runOverrides(call)
	if usageErr != "" {
		return call.Usage(usageErr), nil
	}
	high := domain.PriorityHigh
	readPath := "-"
	if path != "-" {
		readPath = resolvePath(call.Cwd(), path)
	}
	text, err := ReadBrief(ctx, readPath, ReadStdin)
	if err != nil {
		return appFail(call, err)
	}
	input := app.SubmitInput{
		Text:            text,
		Cwd:             call.Cwd(),
		Overrides:       &overrides,
		DefaultPriority: &high,
	}
	if path != "-" {
		source := readPath
		input.SourcePath = &source
	}
	deps := call.Deps()
	job, err := app.Submit(ctx, deps, input)
	if err != nil {
		return appFail(call, err)
	}
	if !call.Flag("json") {
		deps.Out.Line(render.RenderStarted(deps.Provider, job))
	}
	if !call.Flag("wait") {
		return runDetach(call, job), nil
	}
	deps.Process.SpawnDriver(job.ID)
	return FollowAndReport(ctx, call, job.ID)
}

// runOverrides is --flash, --mode and --engine as brief overrides, or the usage error.
func runOverrides(call Invocation) (app.BriefOverrides, string) {
	var overrides app.BriefOverrides
	mode, ok, usage := ModeOption(call)
	if usage != "" {
		return overrides, usage
	}
	if ok {
		overrides.Mode = &mode
	}
	if engine := call.Text("engine"); engine != nil {
		if !domain.IsEngine(*engine) {
			return overrides, "--engine must be one of " + enginesList()
		}
		named := domain.Engine(*engine)
		overrides.Engine = &named
	}
	if call.Flag("flash") {
		flash := domain.ModelTierFlash
		overrides.Model = &flash
	}
	return overrides, ""
}

// enginesList is every engine a brief or --engine may name.
func enginesList() string {
	names := make([]string, 0, len(domain.ENGINES))
	for _, engine := range domain.ENGINES {
		names = append(names, string(engine))
	}
	return strings.Join(names, ", ")
}

// runDetach hands the job to a detached driver and says where to watch it.
func runDetach(call Invocation, job domain.Job) ExitCode {
	deps := call.Deps()
	deps.Process.SpawnDriver(job.ID)
	if call.Flag("json") {
		_ = call.JSON(job)
		return ExitOK
	}
	deps.Out.Line("Running detached: " + deps.Provider.Slash + "board shows it, " +
		deps.Provider.Slash + "review " + job.ID + " once it awaits review.")
	return ExitOK
}

// DriveCommand is `drive`: the detached driver's own entry.
type DriveCommand struct{}

var _ Command = DriveCommand{}

func (DriveCommand) Name() string                   { return "drive" }
func (DriveCommand) Synopsis() []string             { return []string{"drive <id>"} }
func (DriveCommand) Options() map[string]OptionSpec { return map[string]OptionSpec{} }
func (DriveCommand) Hidden() bool                   { return true }

func (DriveCommand) Run(ctx context.Context, call Invocation) (ExitCode, error) {
	positionals := call.Positionals()
	if len(positionals) == 0 {
		return call.Usage("drive needs a job id"), nil
	}
	driven, err := UntilInterrupted(func(signal context.Context) (domain.Job, error) {
		return app.Drive(signal, call.Deps(), positionals[0])
	})
	if err != nil {
		return appFail(call, err)
	}
	call.Deps().Out.Line(render.RenderSummary(call.Deps().Provider, driven))
	return ExitOK, nil
}
