package render

import (
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

const lastTextChars = 160

// JobView is `show`: state, attempts so far and, while running, what the worker is doing.
func JobView(provider domain.Provider, row app.BoardRow, now int64) string {
	job := row.Job
	active := job.State == domain.JobStateRunning || job.State == domain.JobStateVerifying
	driver := ""
	if active && !row.Live {
		driver = " (stale: no live driver; " + provider.Slash + "board stops it, " + provider.Slash +
			"review " + job.ID + " then discards it)"
	}
	lines := []string{
		provider.Name + " job " + job.ID + ": " + job.Brief.Title,
		strings.Replace(string(job.State), "_", " ", 1) + driver + " · " + ModelID(provider, job) + " · " +
			string(job.Brief.Mode) + " · created " + Ago(job.CreatedAt, now) + " · updated " + Ago(job.UpdatedAt, now),
		"workspace " + workspacePath(job.Workspace),
	}
	if len(job.Attempts) == 0 {
		lines = append(lines, "Attempts: none yet")
	} else {
		lines = append(lines, "Attempts:")
		for _, attempt := range job.Attempts {
			lines = append(lines, "  "+domain.AttemptSummary(attempt))
		}
	}
	if row.Progress != nil {
		lines = append(lines, "Progress: "+ProgressText(*row.Progress))
		if row.Progress.LastText != "" {
			lines = append(lines, `  "`+OneLine(row.Progress.LastText, lastTextChars)+`"`)
		}
	}
	return strings.Join(lines, "\n")
}

// workspacePath is the job's worktree, or its repository when it has none.
func workspacePath(workspace domain.Workspace) string {
	if workspace.Worktree != nil {
		return *workspace.Worktree
	}
	return workspace.RepoRoot
}
