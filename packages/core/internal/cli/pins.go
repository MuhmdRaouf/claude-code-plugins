package cli

import (
	"context"
	"strconv"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// The parity pins: the environment the golden-transcript suite runs the CLI binary under. The
// golden pins a fixed clock, sequential ids and canned host answers; a subprocess CLI is wired
// from its environment alone, so those pins come in as PLUGIN_CORE_* variables that production
// never sets, and the golden transcript stays byte for byte the same file.

// Pins is what the environment pinned for this run.
type Pins struct {
	// NowMS pins the clock, epoch milliseconds; 0 is the wall clock.
	NowMS int64
	// SequentialIDs counts job and session ids in the state root instead of drawing them at
	// random.
	SequentialIDs bool
	// Runtime replaces the runtime line setup reports (the binary under test is not bun).
	Runtime string
	// RouterLine is the ensureRouter answer given without starting anything.
	RouterLine string
	// RouterKey is the router's key check's answer (the env name the key came from), given
	// without a router to ask.
	RouterKey string
}

// PinsOf reads the pins the environment carries.
func PinsOf(env domain.EnvLookup) Pins {
	now, _ := strconv.ParseInt(env["PLUGIN_CORE_NOW_MS"], 10, 64)
	return Pins{
		NowMS:         now,
		SequentialIDs: env["PLUGIN_CORE_SEQUENTIAL_IDS"] == "1",
		Runtime:       env["PLUGIN_CORE_RUNTIME"],
		RouterLine:    env["PLUGIN_CORE_ROUTER_LINE"],
		RouterKey:     env["PLUGIN_CORE_ROUTER_KEY"],
	}
}

// runtimeOf is the runtime line setup reports: the pinned one, else the real one.
func runtimeOf(pins Pins) string {
	if pins.Runtime != "" {
		return pins.Runtime
	}
	return adapters.Runtime()
}

// zeroedGates is the pinned session's gate runner: the durations it reports are zeroed, so the
// golden transcript never carries a wall-clock duration.
type zeroedGates struct {
	ports.GateRunner
}

func (g zeroedGates) Run(ctx context.Context, cwd string, gate domain.Gate, passEnv map[string]string, logPath string) domain.GateResult {
	result := g.GateRunner.Run(ctx, cwd, gate, passEnv, logPath)
	result.DurationMs = 0
	return result
}
