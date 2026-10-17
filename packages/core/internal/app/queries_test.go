package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// put stores a job under id, its createdAt stamped so the listing order is the id order.
func put(w *appWorld, id string, overrides ...func(*domain.Job)) domain.Job {
	stamp := append([]func(*domain.Job){func(job *domain.Job) {
		job.ID = id
		job.CreatedAt = fmt.Sprintf("2026-10-06T00:00:0%s.000Z", id[len(id)-1:])
	}}, overrides...)
	return w.store.Put(testkit.AJob(stamp...))
}

func TestBoard(t *testing.T) {
	ctx := context.Background()

	t.Run("lists repo jobs newest first; --all includes other repos", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		put(w, "j1")
		put(w, "j2", func(job *domain.Job) { job.Workspace.RepoRoot = "/other" })
		put(w, "j3")

		repo := Board(ctx, deps, Scope{RepoRoot: strPtr("/repo"), All: false})
		all := Board(ctx, deps, Scope{RepoRoot: strPtr("/repo"), All: true})

		if ids := jobIDs(repo); !reflect.DeepEqual(ids, []string{"j3", "j1"}) {
			t.Errorf("repo rows = %v, want [j3 j1]", ids)
		}
		if ids := jobIDs(all); !reflect.DeepEqual(ids, []string{"j3", "j2", "j1"}) {
			t.Errorf("all rows = %v, want [j3 j2 j1]", ids)
		}
		for _, row := range repo {
			if row.Progress != nil || row.Live {
				t.Errorf("row %s = %+v, want no progress and no live driver", row.Job.ID, row)
			}
		}
	})

	t.Run("folds progress from the running attempt's log", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		put(w, "j1", func(job *domain.Job) {
			job.State = domain.JobStateRunning
			job.Attempts = []domain.Attempt{testkit.AnAttempt(), testkit.AnAttempt(func(a *domain.Attempt) {
				a.N = 2
				a.Kind = domain.AttemptKindAutoFix
			})}
		})
		log := strings.Join([]string{
			fakes.Wire.Init("s-2"),
			fakes.Wire.Tool("Bash", fakes.ToolArg{Key: "command", Value: "npm test"}),
			fakes.Wire.Retry(strPtr(int64(429))),
			"{torn",
		}, "\n")
		if err := os.WriteFile(w.store.Paths("j1").AttemptLog(2), []byte(log), 0o644); err != nil {
			t.Fatal(err)
		}

		rows := Board(ctx, deps, Scope{RepoRoot: strPtr("/repo"), All: false})

		if len(rows) != 1 {
			t.Fatalf("rows = %d, want one", len(rows))
		}
		want := domain.Progress{
			SessionID:        strPtr("s-2"),
			Phase:            domain.ProgressPhaseRateLimited,
			LastTool:         strPtr("Bash npm test"),
			ToolCalls:        1,
			RateLimitRetries: 1,
		}
		if !reflect.DeepEqual(rows[0].Progress, &want) {
			t.Errorf("progress = %+v, want %+v", rows[0].Progress, want)
		}
	})

	t.Run("prefers the driver's progress snapshot of the running attempt over its log", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		put(w, "j1", func(job *domain.Job) {
			job.State = domain.JobStateRunning
			job.Attempts = []domain.Attempt{testkit.AnAttempt()}
		})
		paths := w.store.Paths("j1")
		if err := os.WriteFile(paths.AttemptLog(1), []byte(fakes.Wire.Init("s-1")+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := deps.Files.WriteProgress(ctx, paths, 1, domain.Progress{
			Phase: domain.ProgressPhaseWriting, LastText: "almost", Turns: 3,
		}); err != nil {
			t.Fatal(err)
		}

		rows := Board(ctx, deps, Scope{All: true})

		if len(rows) != 1 {
			t.Fatalf("rows = %d, want one", len(rows))
		}
		want := domain.Progress{Phase: domain.ProgressPhaseWriting, LastText: "almost", Turns: 3}
		if !reflect.DeepEqual(rows[0].Progress, &want) {
			t.Errorf("progress = %+v, want the snapshot %+v", rows[0].Progress, want)
		}
	})

	t.Run("marks running/verifying jobs without a live driver as live=false", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		withAttempt := func(job *domain.Job) { job.Attempts = []domain.Attempt{testkit.AnAttempt()} }
		put(w, "j1", func(job *domain.Job) {
			job.State = domain.JobStateRunning
			withAttempt(job)
		})
		put(w, "j2", func(job *domain.Job) {
			job.State = domain.JobStateVerifying
			withAttempt(job)
		})
		put(w, "j3")
		w.store.HoldLock("j1", 4242)
		w.process.MarkAlive(4242)
		w.store.HoldLock("j2", 4343)

		rows := Board(ctx, deps, Scope{RepoRoot: strPtr("/repo"), All: false})

		got := make([][2]any, len(rows))
		for i, row := range rows {
			got[i] = [2]any{row.Job.ID, row.Live}
		}
		want := [][2]any{{"j3", false}, {"j2", false}, {"j1", true}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("rows = %v, want %v", got, want)
		}
		if rows[2].Progress != nil {
			t.Errorf("a verifying job has no progress to fold, got %+v", rows[2].Progress)
		}
	})
}

func jobIDs(rows []BoardRow) []string {
	ids := make([]string, len(rows))
	for i, row := range rows {
		ids[i] = row.Job.ID
	}
	return ids
}

func TestReviewPacket(t *testing.T) {
	ctx := context.Background()

	t.Run("includes diff stat always and the full diff only on request, truncated to maxDiffChars with a marker", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		job := put(w, "j1", func(j *domain.Job) { j.State = domain.JobStateAwaitingReview })
		w.git.DiffText = strings.Repeat("x", 30)

		plain, err := ReviewPacketOf(ctx, deps, "j1", ReviewOptions{Diff: false, MaxDiffChars: 10})
		if err != nil {
			t.Fatal(err)
		}
		full, err := ReviewPacketOf(ctx, deps, "j1", ReviewOptions{Diff: true, MaxDiffChars: 100})
		if err != nil {
			t.Fatal(err)
		}
		cut, err := ReviewPacketOf(ctx, deps, "j1", ReviewOptions{Diff: true, MaxDiffChars: 10})
		if err != nil {
			t.Fatal(err)
		}

		if !reflect.DeepEqual(plain, ReviewPacket{Job: job, DiffStat: strPtr(w.git.DiffStat)}) {
			t.Errorf("plain packet = %+v, want the diff stat only", plain)
		}
		wantFull := strings.Repeat("x", 30)
		if !reflect.DeepEqual(full, ReviewPacket{
			Job: job, DiffStat: strPtr(w.git.DiffStat), Diff: &wantFull,
		}) {
			t.Errorf("full packet = %+v, want the whole diff", full)
		}
		wantCut := strings.Repeat("x", 10) + "\n[diff truncated: 20 more characters]\n"
		if cut.Diff == nil || *cut.Diff != wantCut {
			t.Errorf("cut diff = %v, want the marker after 10 characters", cut.Diff)
		}
		if calls := w.git.Called("diff"); len(calls) == 0 || !reflect.DeepEqual(calls[0], []any{
			*job.Workspace.Worktree, job.Workspace.BaseSha, ports.DiffOptions{Stat: true},
		}) {
			t.Errorf("first diff call = %v, want the stat first", calls)
		}
	})

	t.Run("truncation counts UTF-16 code units, as JS slice does", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		put(w, "j1", func(j *domain.Job) { j.State = domain.JobStateAwaitingReview })
		// The emoji is two UTF-16 units; a byte cut would split its surrogate pair.
		w.git.DiffText = "😀x"

		cut, err := ReviewPacketOf(ctx, deps, "j1", ReviewOptions{Diff: true, MaxDiffChars: 2})
		if err != nil {
			t.Fatal(err)
		}

		if cut.Diff == nil || *cut.Diff != "😀\n[diff truncated: 1 more characters]\n" {
			t.Errorf("cut diff = %v, want the whole emoji and the marker", cut.Diff)
		}
	})

	t.Run("has no diff for exec/readonly jobs or decided jobs whose worktree is gone", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		exec := put(w, "j1", func(job *domain.Job) {
			job.Brief = testkit.ABrief(func(b *domain.Brief) {
				b.Mode = domain.ModeExec
				b.Scope = []string{}
			})
			job.Workspace = domain.Workspace{
				RepoRoot: "/repo", BaseSha: strings.Repeat("b", 40), ArtifactsDir: "/state/jobs/j1/artifacts",
			}
		})
		accepted := put(w, "j2", func(j *domain.Job) { j.State = domain.JobStateAccepted })

		execPacket, err := ReviewPacketOf(ctx, deps, "j1", ReviewOptions{Diff: true, MaxDiffChars: 10})
		if err != nil {
			t.Fatal(err)
		}
		acceptedPacket, err := ReviewPacketOf(ctx, deps, "j2", ReviewOptions{Diff: true, MaxDiffChars: 10})
		if err != nil {
			t.Fatal(err)
		}

		if !reflect.DeepEqual(execPacket, ReviewPacket{Job: exec}) {
			t.Errorf("exec packet = %+v, want the job only", execPacket)
		}
		if !reflect.DeepEqual(acceptedPacket, ReviewPacket{Job: accepted}) {
			t.Errorf("accepted packet = %+v, want the job only", acceptedPacket)
		}
		if calls := w.git.Called("diff"); len(calls) != 0 {
			t.Errorf("diff calls = %v, want none", calls)
		}
	})

	t.Run("not_found for an unknown id", func(t *testing.T) {
		deps, _ := newWorld(t, nil)

		_, err := ReviewPacketOf(ctx, deps, "nope", ReviewOptions{Diff: false, MaxDiffChars: 10})

		want := &AppError{Kind: AppErrorStore, StoreError: &ports.StoreError{
			Kind: ports.StoreErrorNotFound, ID: "nope",
		}}
		var appErr *AppError
		if !errors.As(err, &appErr) || !reflect.DeepEqual(appErr, want) {
			t.Errorf("error = %+v, want not_found nope", err)
		}
	})

	t.Run("a diff that fails is the git error, for the stat and the patch alike", func(t *testing.T) {
		deps, w := newWorld(t, nil)
		put(w, "j1", func(j *domain.Job) { j.State = domain.JobStateAwaitingReview })
		conflict := &ports.GitError{Kind: ports.GitErrorGitFailed, Command: "git diff", Stderr: "boom"}
		deps.Git = failingDiffGit{FakeGit: w.git, statErr: conflict}
		_, err := ReviewPacketOf(ctx, deps, "j1", ReviewOptions{Diff: false, MaxDiffChars: 10})
		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Kind != AppErrorGit || appErr.GitError != conflict {
			t.Errorf("error = %+v, want the git failure", err)
		}

		deps, w = newWorld(t, nil)
		put(w, "j1", func(j *domain.Job) { j.State = domain.JobStateAwaitingReview })
		// A failure the git port did not explain still fails the packet, with no git error to show.
		deps.Git = failingDiffGit{FakeGit: w.git, fullErr: errors.New("git vanished")}
		_, unexplained := ReviewPacketOf(ctx, deps, "j1", ReviewOptions{Diff: true, MaxDiffChars: 10})
		var unexplainedErr *AppError
		if !errors.As(unexplained, &unexplainedErr) || unexplainedErr.Kind != AppErrorGit || unexplainedErr.GitError != nil {
			t.Errorf("error = %+v, want the git kind with no error detail", unexplained)
		}
	})
}

// failingDiffGit is the fake git with a scripted diff failure; nil leaves that side succeeding.
type failingDiffGit struct {
	*fakes.FakeGit
	statErr error
	fullErr error
}

func (g failingDiffGit) Diff(ctx context.Context, dir, baseSha string, opts ports.DiffOptions) (string, error) {
	if opts.Stat {
		return "", g.statErr
	}
	return "", g.fullErr
}

func TestBatch(t *testing.T) {
	t.Run("submits valid briefs, reports invalid ones with their errors, spawns one driver per submitted job", func(t *testing.T) {
		ctx := context.Background()
		deps, w := newWorld(t, nil)
		good := func(title string) string {
			return fmt.Sprintf("---\ntitle: %s\n---\nDo it.\n", title)
		}

		outcome := Batch(ctx, deps, []BatchItem{
			{Path: "/briefs/a.md", Text: good("A")},
			{Path: "/briefs/bad.md", Text: "no front matter"},
			{Path: "/briefs/b.md", Text: good("B")},
		}, "/repo")

		titles := make([]string, len(outcome.Submitted))
		for i, job := range outcome.Submitted {
			titles[i] = job.Brief.Title
		}
		if !reflect.DeepEqual(titles, []string{"A", "B"}) {
			t.Errorf("submitted titles = %v, want [A B]", titles)
		}
		wantRejected := []BatchRejection{{
			Path: "/briefs/bad.md",
			Error: &AppError{Kind: AppErrorBrief, BriefErrors: []domain.BriefError{
				{Kind: domain.BriefErrorNoFrontMatter},
			}},
		}}
		if !reflect.DeepEqual(outcome.Rejected, wantRejected) {
			t.Errorf("rejected = %+v, want the no-front-matter brief", outcome.Rejected)
		}
		spawned := make([]string, len(outcome.Submitted))
		for i, job := range outcome.Submitted {
			spawned[i] = job.ID
		}
		if !reflect.DeepEqual(w.process.Spawned(), spawned) {
			t.Errorf("spawned = %v, want one driver per submitted job", w.process.Spawned())
		}
	})
}

func TestUsage(t *testing.T) {
	t.Run("summarizes the store's jobs via domain summarizeUsage, repo-filtered unless all", func(t *testing.T) {
		ctx := context.Background()
		deps, w := newWorld(t, nil)
		here := put(w, "j1", func(job *domain.Job) {
			job.State = domain.JobStateAccepted
			job.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) {
				verdict := domain.VerdictPass
				a.Verdict = &verdict
			})}
		})
		there := put(w, "j2", func(job *domain.Job) {
			job.Brief = testkit.ABrief(func(b *domain.Brief) { b.Model = domain.ModelTierFlash })
			job.Workspace.RepoRoot = "/other"
		})

		repo := Usage(ctx, deps, Scope{RepoRoot: strPtr("/repo"), All: false})
		all := Usage(ctx, deps, Scope{RepoRoot: strPtr("/repo"), All: true})

		if !reflect.DeepEqual(repo, domain.SummarizeUsage([]domain.Job{here})) {
			t.Errorf("repo usage = %+v, want the repo's jobs only", repo)
		}
		if !reflect.DeepEqual(all, domain.SummarizeUsage([]domain.Job{there, here})) {
			t.Errorf("all usage = %+v, want every job", all)
		}
	})
}

func TestEngineUsage(t *testing.T) {
	t.Run("summarizes each delegation engine's jobs via domain summarizeEngines", func(t *testing.T) {
		ctx := context.Background()
		deps, w := newWorld(t, nil)
		onOmp := put(w, "j1", func(job *domain.Job) {
			job.Brief.Engine = strPtr(domain.EngineToolOmp)
		})
		onPi := put(w, "j2", func(job *domain.Job) {
			job.Brief.Engine = strPtr(domain.EngineToolPi)
		})

		got := EngineUsage(ctx, deps, Scope{All: true})

		if !reflect.DeepEqual(got, domain.SummarizeEngines([]domain.Job{onOmp, onPi})) {
			t.Errorf("engine usage = %+v, want the domain's own summary", got)
		}
	})
}
