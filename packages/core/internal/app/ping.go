package app

import (
	"context"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

const pingTimeoutMs = 120_000

const pingPrompt = `This is a connectivity check. Use no tools. End at once with a notes report whose summary is "pong", with no findings and no open items.`

// Ping is one tiny real request (the provider's ping tier, read-only, notes report) that proves the
// key and the route work.
func Ping(ctx context.Context, deps Deps) (domain.WorkerResult, error) {
	run, err := deps.Worker.Start(ctx, ports.WorkerSpec{
		Cwd:    deps.Host.StateRoot,
		Model:  deps.Provider.Catalog[deps.Provider.PingTier],
		Access: ports.AccessReadonly,
		Prompt: pingPrompt,
		Session: ports.WorkerSession{
			Kind: ports.SessionKindNew,
			Key:  deps.Ids.SessionID(),
		},
		Report:    BuiltinContract(domain.BuiltinReportNotes),
		AddDirs:   []string{},
		PassEnv:   map[string]string{},
		TimeoutMs: pingTimeoutMs,
		LogPath:   deps.Host.StateRoot + "/setup-ping.jsonl",
	})
	if err != nil {
		return domain.WorkerResult{}, err
	}
	var events []domain.WorkerEvent
	for event := range run.Events() {
		events = append(events, event)
	}
	exit := run.Wait()
	return domain.FinalizeWorker(events, domain.WorkerExit{
		Code:       exit.Code,
		Signal:     exit.Signal,
		StderrTail: exit.StderrTail,
	}, exit.Forced), nil
}
