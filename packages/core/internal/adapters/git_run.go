package adapters

import (
	"context"
	"maps"
	"os"
	"regexp"
	"slices"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// Every git call, over the process tool runner, without a shell. Expected failures come back
// as values.

// GitRun is one git run's outcome: Ok with its Stdout, or the failure's Code (nil when git never
// started) and Stderr message.
type GitRun struct {
	Ok     bool
	Stdout []byte
	Code   *int
	Stderr string
}

// GitRunOptions shapes a git run: Stdin is written and then stdin is closed either way, so git
// never waits on it; Env overlays the sanitized git environment.
type GitRunOptions struct {
	Stdin *string
	Env   map[string]string
}

// gitLocationVars would point git at another repository, index or work tree than the cwd passed
// explicitly (set, for example, when running inside a git hook).
var gitLocationVars = map[string]bool{
	"GIT_DIR":                          true,
	"GIT_WORK_TREE":                    true,
	"GIT_INDEX_FILE":                   true,
	"GIT_COMMON_DIR":                   true,
	"GIT_OBJECT_DIRECTORY":             true,
	"GIT_ALTERNATE_OBJECT_DIRECTORIES": true,
	"GIT_NAMESPACE":                    true,
	"GIT_PREFIX":                       true,
}

// gitEnv is the parent environment without the location variables, forced to English messages
// (classification reads stderr), never to prompt and never to open an editor; extra comes last.
func gitEnv(extra map[string]string) []string {
	overrides := map[string]string{
		"LC_ALL":              "C",
		"LANGUAGE":            "",
		"GIT_TERMINAL_PROMPT": "0",
		"GIT_EDITOR":          "true",
	}
	maps.Copy(overrides, extra)
	emitted := make(map[string]bool, len(overrides))
	env := make([]string, 0, len(overrides)+len(os.Environ()))
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		if gitLocationVars[name] || emitted[name] {
			continue
		}
		if override, ok := overrides[name]; ok {
			value = override
		}
		emitted[name] = true
		env = append(env, name+"="+value)
	}
	for _, name := range slices.Sorted(maps.Keys(overrides)) {
		if !emitted[name] {
			env = append(env, name+"="+overrides[name])
		}
	}
	return env
}

// RunGit runs `git -c core.quotepath=off <args>` in cwd, without a shell. Expected failures come
// back as values.
func RunGit(ctx context.Context, cwd string, args []string, options GitRunOptions) GitRun {
	full := append([]string{"-c", "core.quotepath=off"}, args...)
	run := process.RunTool(ctx, "git", full, process.ToolOptions{
		Cwd:   cwd,
		Env:   gitEnv(options.Env),
		Stdin: options.Stdin,
	})
	if run.Kind == process.ToolMissing {
		return GitRun{Code: nil, Stderr: run.Message}
	}
	if run.Code != nil && *run.Code == 0 {
		return GitRun{Ok: true, Stdout: run.Stdout}
	}
	// `commit` with nothing to commit explains itself on stdout only.
	output := run.Stderr
	if len(output) == 0 {
		output = run.Stdout
	}
	text := "git " + strings.Join(args, " ") + " failed"
	if len(output) > 0 {
		text = strings.TrimSpace(string(output))
	}
	return GitRun{Code: run.Code, Stderr: text}
}

// gitNotARepoText matches git's own message in any casing.
var gitNotARepoText = regexp.MustCompile(`(?i)not a git repository`)

// GitError maps a failed run to the port's error union.
func GitError(cwd string, args []string, run GitRun) *ports.GitError {
	if _, err := os.Stat(cwd); err != nil || gitNotARepoText.MatchString(run.Stderr) {
		return &ports.GitError{Kind: ports.GitErrorNotARepo, Path: cwd}
	}
	return &ports.GitError{
		Kind:    ports.GitErrorGitFailed,
		Command: "git " + strings.Join(args, " "),
		Stderr:  run.Stderr,
	}
}

// GitText runs git and returns stdout as text, or the mapped error.
func GitText(ctx context.Context, cwd string, args []string, options GitRunOptions) (string, *ports.GitError) {
	run := RunGit(ctx, cwd, args, options)
	if run.Ok {
		return string(run.Stdout), nil
	}
	return "", GitError(cwd, args, run)
}

// GitVoid runs git and keeps only its error.
func GitVoid(ctx context.Context, cwd string, args []string, options GitRunOptions) *ports.GitError {
	run := RunGit(ctx, cwd, args, options)
	if run.Ok {
		return nil
	}
	return GitError(cwd, args, run)
}

// GitValue runs a command whose output is one value (a sha, a path) on one line, and returns it
// without the newline.
func GitValue(ctx context.Context, cwd string, args []string, options GitRunOptions) (string, *ports.GitError) {
	text, err := GitText(ctx, cwd, args, options)
	if err != nil {
		return "", err
	}
	return ChompNewline(text), nil
}
