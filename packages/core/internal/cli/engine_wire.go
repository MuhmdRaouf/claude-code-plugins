// The delegation engines as workers: the plugin does not own omp, opencode, pi or zcode. Each
// runs exactly as the user set it up — its own login, provider, default model and config — with
// the user's own environment, minus what belongs to this plugin's provider (its key variables and
// every `<PREFIX>_` knob) and Claude Code's routing. The adapters only bridge: the job's worktree
// as the cwd, the brief as the prompt, the events translated, the access narrowed, the deadline
// kept and the process group reaped.
package cli

import (
	"runtime"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/omprpc"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/opencode"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/pirpc"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/zcode"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// engineHandshakeTimeoutMs: omp and pi answer the RPC handshake within seconds; a cold first start
// (omp's "Still starting after 10s") gets a minute before the attempt counts as an infrastructure
// failure.
const engineHandshakeTimeoutMs int64 = 60_000

// EngineWireOptions shape EngineWorkers.
type EngineWireOptions struct {
	// Provider names the plugin's provider: only its names, to withhold its variables from the
	// tools and name the bin overrides.
	Provider    domain.Provider
	Env         domain.EnvLookup
	StopGraceMs int64
}

// engineBinEnv is the variable naming a tool's binary, for tests and unusual installs:
// `${envPrefix}_OMP_BIN` and so on.
func engineBinEnv(provider domain.Provider, tool domain.EngineTool) string {
	return provider.EnvPrefix + "_" + strings.ToUpper(string(tool)) + "_BIN"
}

// engineProviderVar names what is this plugin's provider's own (its key variables, its
// `<PREFIX>_` knobs): never a tool's.
func engineProviderVar(provider domain.Provider) func(name string) bool {
	return func(name string) bool {
		for _, key := range provider.KeyEnv {
			if name == key {
				return true
			}
		}
		return strings.HasPrefix(name, provider.EnvPrefix+"_")
	}
}

// EngineWorkers wires every delegation engine in as a worker. The engines' own adapters record
// each run's process group beside the attempt log and clear it on exit — ports.WorkerRun carries
// no pid a wrapper here could read — so the wiring hands each tool its worker as it is.
func EngineWorkers(options EngineWireOptions) *app.EngineWorkers {
	withheld := engineProviderVar(options.Provider)
	bin := func(tool domain.EngineTool) string {
		override := options.Env[engineBinEnv(options.Provider, tool)]
		if tool == domain.EngineToolZcode {
			return zcode.ZcodeBinary(options.Env, override, nodePlatform())
		}
		if override != "" {
			return override
		}
		return string(tool)
	}
	return &app.EngineWorkers{
		Bin: bin,
		Worker: func(tool domain.EngineTool) ports.Worker {
			switch tool {
			case domain.EngineToolOmp:
				return omprpc.NewOmpRpcWorker(omprpc.OmpRpcWorkerOptions{
					Bin:                bin(tool),
					ParentEnv:          options.Env,
					Withheld:           withheld,
					StopGraceMs:        options.StopGraceMs,
					HandshakeTimeoutMs: engineHandshakeTimeoutMs,
				})
			case domain.EngineToolPi:
				return pirpc.NewPiRpcWorker(pirpc.PiRpcWorkerOptions{
					Bin:                bin(tool),
					ParentEnv:          options.Env,
					Withheld:           withheld,
					StopGraceMs:        options.StopGraceMs,
					HandshakeTimeoutMs: engineHandshakeTimeoutMs,
				})
			case domain.EngineToolZcode:
				return zcode.NewZcodeWorker(zcode.Options{
					Bin:         bin(tool),
					ParentEnv:   options.Env,
					Withheld:    withheld,
					StopGraceMs: options.StopGraceMs,
				})
			case domain.EngineToolOpencode:
				return opencode.NewOpenCodeWorker(opencode.OpenCodeOptions{
					Bin:         bin(tool),
					ParentEnv:   options.Env,
					Withheld:    withheld,
					StopGraceMs: options.StopGraceMs,
				})
			}
			return nil
		},
	}
}

// nodePlatform is the host platform in Node's process.platform spelling, which matches GOOS.
func nodePlatform() string {
	return runtime.GOOS
}
