package adapters

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// The files beside a job's record (the state layout's JobPaths): the stop request, the driver's
// progress snapshot (written often, so it stays out of job.json), the driver lock the store
// maintains (read here only to tell live drivers from dead ones), the engine's process group,
// the brief, and the accepts' leftover checkouts.

// progressFileShape is progress.json as written: the optional pointers mark the keys the zod
// schema made optional, every other field being required.
type progressFileShape struct {
	Attempt  *int64         `json:"attempt"`
	Progress *progressShape `json:"progress"`
}

type progressShape struct {
	SessionID        *string `json:"sessionId"`
	Phase            *string `json:"phase"`
	Turns            *int64  `json:"turns"`
	LastTool         *string `json:"lastTool"`
	LastText         *string `json:"lastText"`
	RateLimitRetries *int64  `json:"rateLimitRetries"`
	ToolCalls        *int64  `json:"toolCalls"`
	ToolErrors       *int64  `json:"toolErrors"`
}

var progressPhases = []domain.ProgressPhase{
	domain.ProgressPhaseStarting, domain.ProgressPhaseThinking, domain.ProgressPhaseTool,
	domain.ProgressPhaseWriting, domain.ProgressPhaseRateLimited, domain.ProgressPhaseDone,
}

type fsJobFiles struct {
	checkouts string
}

// CreateFsJobFiles is the sidecar files of the jobs under one state root.
func CreateFsJobFiles(stateRoot string) ports.JobFiles {
	return &fsJobFiles{checkouts: domain.NewStateLayout(stateRoot).Checkouts}
}

func (f *fsJobFiles) WriteBrief(ctx context.Context, paths domain.JobPaths, text string) error {
	if err := os.MkdirAll(paths.Artifacts, 0o755); err != nil {
		return err
	}
	return os.WriteFile(paths.Brief, []byte(text), 0o644)
}

func (f *fsJobFiles) RequestStop(ctx context.Context, paths domain.JobPaths) error {
	return os.WriteFile(paths.Stop, nil, 0o644)
}

func (f *fsJobFiles) StopRequested(ctx context.Context, paths domain.JobPaths) bool {
	_, err := os.ReadFile(paths.Stop)
	return err == nil
}

func (f *fsJobFiles) ClearStop(ctx context.Context, paths domain.JobPaths) error {
	return removeForce(paths.Stop)
}

func (f *fsJobFiles) WriteProgress(ctx context.Context, paths domain.JobPaths, attempt int64, progress domain.Progress) error {
	// Plain numbers and strings; the marshal cannot fail.
	data, _ := json.Marshal(struct {
		Attempt  int64           `json:"attempt"`
		Progress domain.Progress `json:"progress"`
	}{attempt, progress})
	return os.WriteFile(paths.Progress, append(data, '\n'), 0o644)
}

func (f *fsJobFiles) ReadProgress(ctx context.Context, paths domain.JobPaths, attempt int64) *domain.Progress {
	text, err := os.ReadFile(paths.Progress)
	if err != nil {
		return nil
	}
	var snapshot progressFileShape
	if err := json.Unmarshal(text, &snapshot); err != nil {
		return nil
	}
	shape := snapshot.Progress
	if snapshot.Attempt == nil || *snapshot.Attempt != attempt || shape == nil ||
		shape.Phase == nil || shape.Turns == nil || shape.LastText == nil ||
		shape.RateLimitRetries == nil || shape.ToolCalls == nil || shape.ToolErrors == nil ||
		!slices.Contains(progressPhases, domain.ProgressPhase(*shape.Phase)) {
		return nil
	}
	return &domain.Progress{
		SessionID: shape.SessionID, Phase: domain.ProgressPhase(*shape.Phase), Turns: *shape.Turns,
		LastTool: shape.LastTool, LastText: *shape.LastText,
		RateLimitRetries: *shape.RateLimitRetries, ToolCalls: *shape.ToolCalls, ToolErrors: *shape.ToolErrors,
	}
}

func (f *fsJobFiles) ReadText(ctx context.Context, path string) (string, error) {
	text, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return string(text), nil
}

// readLockFile is DriverPid's read of the driver lock, a var so its test can answer one busy.
var readLockFile = os.ReadFile

func (f *fsJobFiles) DriverPid(ctx context.Context, paths domain.JobPaths) (int64, bool) {
	var text []byte
	err := retryBusy(func() error {
		var readErr error
		text, readErr = readLockFile(paths.DriverLock)
		return readErr
	})
	if err != nil {
		return 0, false
	}
	return domain.ParsePid(string(text))
}

func (f *fsJobFiles) EnginePid(paths domain.JobPaths) (int64, bool) {
	return ReadEnginePid(paths.EnginePid)
}

func (f *fsJobFiles) ClearEnginePid(paths domain.JobPaths) {
	ClearEnginePid(paths.EnginePid)
}

func (f *fsJobFiles) CheckoutIds() []string {
	entries, err := os.ReadDir(f.checkouts)
	if err != nil {
		return nil
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		ids = append(ids, entry.Name())
	}
	return ids
}

// CheckoutRepo is the repository a detached checkout belongs to, read from its `.git` file: the
// worktree registration it points at, `<repo>/.git/worktrees/<name>`.
func (f *fsJobFiles) CheckoutRepo(checkout string) (string, bool) {
	text, err := os.ReadFile(filepath.Join(checkout, ".git"))
	if err != nil {
		return "", false
	}
	git := strings.TrimSpace(string(text))
	if !strings.HasPrefix(git, "gitdir:") {
		return "", false
	}
	gitdir := strings.TrimSpace(strings.TrimPrefix(git, "gitdir:"))
	return filepath.Dir(filepath.Dir(gitdir)), true
}

func (f *fsJobFiles) Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func (f *fsJobFiles) RemoveTree(path string) {
	_ = os.RemoveAll(path)
}

// WriteEnginePid writes a job's engine.pid (`file` is JobPaths.EnginePid): the engine wiring
// writes it while the engine runs.
func WriteEnginePid(file string, pid int64) {
	_ = os.WriteFile(file, []byte(fmt.Sprintf("%d\n", pid)), 0o600)
}

// ClearEnginePid removes the engine pid file; a missing one is fine.
func ClearEnginePid(file string) {
	_ = removeForce(file)
}

// ReadEnginePid is the running engine's group leader, when the file names one.
func ReadEnginePid(file string) (int64, bool) {
	text, err := os.ReadFile(file)
	if err != nil {
		return 0, false
	}
	return domain.ParsePid(string(text))
}
