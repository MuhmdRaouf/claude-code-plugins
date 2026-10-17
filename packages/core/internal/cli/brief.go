package cli

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/render"
)

// briefSlugMax bounds a new brief's slug.
const briefSlugMax = 60

// BriefCommand is `brief`: write a brief from the template, or check one.
type BriefCommand struct{}

var _ Command = BriefCommand{}

func (BriefCommand) Name() string {
	return "brief"
}
func (BriefCommand) Synopsis() []string {
	return []string{
		"brief new <title> [--mode edit|exec|readonly]",
		"brief lint <path>",
	}
}
func (BriefCommand) Options() map[string]OptionSpec {
	return map[string]OptionSpec{"mode": {Type: OptionTypeString}}
}
func (BriefCommand) Hidden() bool { return false }

func (BriefCommand) Run(ctx context.Context, call Invocation) (ExitCode, error) {
	positionals := call.Positionals()
	action := ""
	if len(positionals) > 0 {
		action = positionals[0]
	}
	switch {
	case action == "new":
		return newBrief(call, strings.TrimSpace(strings.Join(positionals[1:], " ")))
	case action == "lint" && len(positionals) > 1:
		return lintBrief(ctx, call, positionals[1])
	case action == "lint":
		return call.Usage("brief lint needs a path"), nil
	default:
		return call.Usage("brief needs new or lint"), nil
	}
}

// newBrief writes the template to <state>/briefs/<slug>.md (-2, -3… when taken) and prints only
// its path.
func newBrief(call Invocation, title string) (ExitCode, error) {
	if title == "" {
		return call.Usage("brief new needs a title"), nil
	}
	mode, ok, usage := ModeOption(call)
	if usage != "" {
		return call.Usage(usage), nil
	}
	if !ok {
		mode = domain.ModeEdit
	}
	deps := call.Deps()
	dir := filepath.Join(deps.Host.StateRoot, "briefs")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ExitUnexpected, err
	}
	text := domain.BriefTemplate(title, mode, deps.Provider, deps.Worker.Caps().WorkerTerms)
	for n := 1; ; n++ {
		name := briefSlug(title) + ".md"
		if n > 1 {
			name = briefSlug(title) + "-" + strconv.Itoa(n) + ".md"
		}
		path := filepath.Join(dir, name)
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			if os.IsExist(err) {
				continue
			}
			return ExitUnexpected, err
		}
		_, writeErr := file.WriteString(text)
		closeErr := file.Close()
		if writeErr != nil {
			return ExitUnexpected, writeErr
		}
		if closeErr != nil {
			return ExitUnexpected, closeErr
		}
		deps.Out.Line(path)
		return ExitOK, nil
	}
}

// briefSlug is the title as a file name: lower case, runs of anything else one dash, no leading
// or trailing dash, "brief" when nothing is left.
func briefSlug(title string) string {
	lower := strings.ToLower(title)
	dashed := briefSlugRuns.ReplaceAllString(lower, "-")
	if len(dashed) > briefSlugMax {
		dashed = dashed[:briefSlugMax]
	}
	slug := strings.Trim(dashed, "-")
	if slug == "" {
		return "brief"
	}
	return slug
}

// briefSlugRuns is any run of characters a slug keeps none of.
var briefSlugRuns = regexp.MustCompile(`[^a-z0-9]+`)

// lintBrief checks exactly what `run` would check, plus the untouched template's placeholder
// body. One problem per line on stdout.
func lintBrief(ctx context.Context, call Invocation, path string) (ExitCode, error) {
	deps := call.Deps()
	absolute := resolvePath(call.Cwd(), path)
	text, err := ReadText(ctx, absolute)
	if err != nil {
		return appFail(call, err)
	}
	brief, briefErr := app.ValidBrief(ctx, deps, app.SubmitInput{Text: text, SourcePath: &absolute, Cwd: call.Cwd()})
	var problems []string
	if briefErr != nil {
		problems = briefProblems(deps, briefErr)
	} else {
		problems = briefPlaceholder(deps, text)
	}
	for _, problem := range problems {
		deps.Out.Line(path + ": " + problem)
	}
	if len(problems) > 0 || briefErr != nil {
		return ExitUsage, nil
	}
	deps.Out.Line("ok: " + brief.Title + " (" +
		deps.Provider.Catalog[brief.Model].ID + ", " + string(brief.Mode) + ", " +
		render.Plural(int64(len(brief.Gates)), "gate") + ")")
	return ExitOK, nil
}

// briefProblems is every way the brief document failed, one line each.
func briefProblems(deps app.Deps, err error) []string {
	var appErr *app.AppError
	if !errors.As(err, &appErr) || appErr.Kind != app.AppErrorBrief {
		return []string{DescribeError(deps.Provider, appErr)}
	}
	lines := make([]string, 0, len(appErr.BriefErrors))
	for _, briefErr := range appErr.BriefErrors {
		lines = append(lines, DescribeBriefError(briefErr))
	}
	return lines
}

// briefPlaceholder says whether the body is still the template's.
func briefPlaceholder(deps app.Deps, text string) []string {
	template, _ := domain.SplitFrontMatter(domain.BriefTemplate(
		"", domain.ModeEdit, deps.Provider, deps.Worker.Caps().WorkerTerms))
	body, _ := domain.SplitFrontMatter(text)
	if strings.TrimSpace(body.Body) == strings.TrimSpace(template.Body) {
		return []string{"the body still has the TODO placeholder"}
	}
	return nil
}
