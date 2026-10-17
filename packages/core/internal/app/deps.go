// Package app holds the use cases: every decision lives here, over the ports only.
package app

import (
	"context"
	"encoding/json"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// StringResult is a setup line's outcome held as a value: OK with its text, or the failure's
// message. It marshals as the arm it is on.
type StringResult struct {
	OK    bool
	Value string
	Error string
}

// MarshalJSON writes the arm the result is on, the shape `setup --json` reports.
func (r StringResult) MarshalJSON() ([]byte, error) {
	if r.OK {
		return json.Marshal(struct {
			OK    bool   `json:"ok"`
			Value string `json:"value"`
		}{true, r.Value})
	}
	return json.Marshal(struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}{false, r.Error})
}

// SetupCheck is one `setup` line of the plugin's own (e.g. where the key comes from); setup is not
// ready while one fails.
type SetupCheck struct {
	// The line's label and its key in `setup --json`.
	Label string
	// What `setup --json` reports.
	Result StringResult
	// The line's text after the label.
	Text string
}

// HostInfo is the facts about the host that only `setup` and `brief new` need.
type HostInfo struct {
	// Absolute state root (jobs, worktrees, slots, briefs).
	StateRoot string
	// The binary that runs the model, as configured.
	WorkerBin string
	// The runtime this CLI runs on (bun by default, node as the fallback), e.g. `bun 1.3.14
	// (/usr/local/bin/bun)`.
	Runtime       string
	WorkerVersion func(ctx context.Context) (string, error)
	ExtraChecks   func(ctx context.Context) []SetupCheck
	// The provider key loader; the setup wiring checks it (only its source is ever printed).
	LoadKey func(ctx context.Context) (ports.ProviderKey, error)
	// Starts this plugin's own router when it is down (a detached process the hooks keep alive); ok
	// says where it runs.
	EnsureRouter func(ctx context.Context) (string, error)
	// Starts the session watchdog for the Claude Code process pid (a detached process that keeps
	// the router answering for the whole session); nil: none (tests).
	StartWatchdog func(ctx context.Context, sessionPid int64)
	// Retires the router for setup --remove (it keeps serving the sessions already open); ok carries
	// the one-line outcome.
	RetireRouter func(ctx context.Context) (string, error)
	// Setup's way to get a key in without the chat (the OS store and the one-time page); nil: setup
	// only reports.
	KeyEntry ports.KeyEntry
	// Whether the running router can read the provider key itself (its source, never the key).
	RouterKey func(ctx context.Context) (string, error)
}

// EngineWorkers is the delegation engines' workers, built from the provider: each tool runs as the
// user set it up, the plugin only bridges a job to it.
type EngineWorkers struct {
	// The tool's worker: the tool as the user set it up, bridged to a job.
	Worker func(tool domain.EngineTool) ports.Worker
	// The tool's binary as configured: an override path, or the name looked up on PATH.
	Bin func(tool domain.EngineTool) string
}

// Config is the fixed part of the wiring: the limiter, the prompt limits and the stop grace.
type Config struct {
	Limiter     domain.LimiterConfig
	Prompt      domain.PromptLimits
	StopGraceMs int64
}

// Deps is everything a use case may touch. Built once in the CLI from adapters; tests build it
// from fakes.
type Deps struct {
	// The claude engine's worker; a job on another engine runs on Engines.Worker(tool) instead.
	Worker ports.Worker
	// omp, opencode, pi and zcode; nil where only claude runs.
	Engines *EngineWorkers
	Git     ports.Git
	Gates   ports.GateRunner
	Store   ports.JobStore
	// The files beside each job's record, and the ones a job names.
	Files        ports.JobFiles
	EngineConfig ports.EngineConfigStore
	// What the routers served, for the board and the usage windows.
	Spool     ports.RouteSpool
	Semaphore ports.Semaphore
	Limiter   ports.LimiterStore
	Clock     ports.Clock
	Ids       ports.Ids
	Process   ports.ProcessControl
	Out       ports.Output
	Host      HostInfo
	// This plugin's CLI bundle: the detached driver re-runs it, and the router copy and the agents
	// sit beside it.
	BundlePath string
	// Every name the plugin shows its users.
	Provider domain.Provider
	// The orchestrator's environment, read only for brief `env` names.
	Env    map[string]string
	Config Config
}
