package cli

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/bmatcuk/doublestar/v4"
)

// BatchCommand is `batch`: submit a directory, a glob or a manifest of briefs.
type BatchCommand struct{}

var _ Command = BatchCommand{}

func (BatchCommand) Name() string { return "batch" }
func (BatchCommand) Synopsis() []string {
	return []string{"batch <dir|glob|manifest.txt> [--wait] [--json]"}
}
func (BatchCommand) Options() map[string]OptionSpec {
	return map[string]OptionSpec{"wait": {Type: OptionTypeBoolean}}
}
func (BatchCommand) Hidden() bool { return false }

func (BatchCommand) Run(ctx context.Context, call Invocation) (ExitCode, error) {
	if call.Flag("wait") && call.Flag("json") {
		return call.Usage("--wait and --json exclude each other"), nil
	}
	positionals := call.Positionals()
	if len(positionals) == 0 {
		return call.Usage("batch needs a directory, a glob or a manifest file"), nil
	}
	target := positionals[0]
	deps := call.Deps()
	paths := batchBriefPaths(ctx, call.Cwd(), target)
	if len(paths) == 0 {
		deps.Out.Error(deps.Provider.Name + ": no briefs found for " + target)
		return ExitUsage, nil
	}
	items, unreadable := batchReadBriefs(ctx, paths)
	outcome := app.Batch(ctx, deps, items, call.Cwd())
	rejected := append(unreadable, outcome.Rejected...)
	pairs := batchPairUp(items, outcome.Submitted, rejected)
	batchReport(call, pairs, rejected)
	if call.Flag("wait") && len(pairs) > 0 {
		ids := make([]string, 0, len(pairs))
		for _, pair := range pairs {
			ids = append(ids, pair.job.ID)
		}
		followed, err := FollowAll(call, ids)
		if err != nil {
			return ExitUnexpected, err
		}
		if followed == ExitOK && len(rejected) > 0 {
			return ExitUsage, nil
		}
		return followed, nil
	}
	if len(rejected) == 0 {
		return ExitOK, nil
	}
	return ExitUsage, nil
}

// batchReadBriefs reads every brief that reads, and keeps the ones that do not as rejections.
func batchReadBriefs(ctx context.Context, paths []string) ([]app.BatchItem, []app.BatchRejection) {
	items := make([]app.BatchItem, 0, len(paths))
	var unreadable []app.BatchRejection
	for _, path := range paths {
		text, err := ReadText(ctx, path)
		if err != nil {
			var appErr *app.AppError
			if !errors.As(err, &appErr) {
				appErr = &app.AppError{Kind: app.AppErrorBriefUnreadable, Path: path, Message: err.Error()}
			}
			unreadable = append(unreadable, app.BatchRejection{Path: path, Error: appErr})
			continue
		}
		items = append(items, app.BatchItem{Path: path, Text: text})
	}
	return items, unreadable
}

// batchPair is one submitted job with the brief that produced it.
type batchPair struct {
	path string
	job  domain.Job
}

// batchReport prints what the batch did: each submitted job with its brief, each rejection.
func batchReport(call Invocation, submitted []batchPair, rejected []app.BatchRejection) {
	deps := call.Deps()
	if call.Flag("json") {
		jobs := make([]domain.Job, 0, len(submitted))
		for _, pair := range submitted {
			jobs = append(jobs, pair.job)
		}
		entries := make([]batchRejectionJSON, 0, len(rejected))
		for _, one := range rejected {
			entries = append(entries, batchRejectionJSON{
				Path: one.Path, Error: DescribeError(deps.Provider, one.Error),
			})
		}
		_ = call.JSON(struct {
			Submitted []domain.Job         `json:"submitted"`
			Rejected  []batchRejectionJSON `json:"rejected"`
		}{jobs, entries})
		return
	}
	for _, pair := range submitted {
		deps.Out.Line("submitted " + pair.job.ID + ": " + pair.job.Brief.Title + " (" + pair.path + ")")
	}
	for _, one := range rejected {
		deps.Out.Error(deps.Provider.Name + ": rejected " + one.Path + ": " +
			DescribeError(deps.Provider, one.Error))
	}
}

// batchRejectionJSON is one rejected brief under --json.
type batchRejectionJSON struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// batchPairUp walks the items in order against the submitted jobs and the rejections, so each
// submitted job gets its path.
func batchPairUp(items []app.BatchItem, submitted []domain.Job, rejected []app.BatchRejection) []batchPair {
	pairs := make([]batchPair, 0, len(submitted))
	next := 0
	skipped := 0
	for _, item := range items {
		if skipped < len(rejected) && rejected[skipped].Path == item.Path {
			skipped++
			continue
		}
		if next < len(submitted) {
			pairs = append(pairs, batchPair{path: item.Path, job: submitted[next]})
			next++
		}
	}
	return pairs
}

// batchBriefPaths is where the target's briefs are: a directory gives its *.md files; a .txt file
// is a manifest (one path per line, relative to it, # comments); any other file is one brief;
// anything else is a glob relative to cwd.
func batchBriefPaths(ctx context.Context, cwd, target string) []string {
	path := resolvePath(cwd, target)
	info, statErr := os.Stat(path)
	if statErr == nil && info.IsDir() {
		entries, err := os.ReadDir(path)
		if err != nil {
			return nil
		}
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".md") {
				names = append(names, entry.Name())
			}
		}
		sort.Strings(names)
		briefs := make([]string, 0, len(names))
		for _, name := range names {
			briefs = append(briefs, filepath.Join(path, name))
		}
		return briefs
	}
	if statErr == nil {
		if strings.HasSuffix(path, ".txt") {
			return batchManifest(ctx, path)
		}
		return []string{path}
	}
	matches, err := doublestar.Glob(os.DirFS(cwd), target)
	if err != nil {
		return nil
	}
	sort.Strings(matches)
	// doublestar.Glob walks cwd's own filesystem, so every match comes back relative to it.
	briefs := make([]string, 0, len(matches))
	for _, match := range matches {
		briefs = append(briefs, filepath.Join(cwd, filepath.FromSlash(match)))
	}
	return briefs
}

// batchManifest is the manifest's briefs: one path per line, relative to the manifest, empty
// lines and # comments skipped.
func batchManifest(ctx context.Context, path string) []string {
	text, err := ReadText(ctx, path)
	if err != nil {
		return nil
	}
	var briefs []string
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		briefs = append(briefs, resolvePath(filepath.Dir(path), line))
	}
	return briefs
}
