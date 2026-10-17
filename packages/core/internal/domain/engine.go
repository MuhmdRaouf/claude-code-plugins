package domain

import "slices"

// Engine is an engine a job can run on: `claude` (headless Claude Code on the provider's
// Anthropic-compatible endpoint) or one of the four delegation tools — omp, opencode, pi and
// zcode. The plugin does not own the tools: each runs exactly as the user set it up (its own
// login, provider, default model and config), and the plugin only bridges a job to it — the
// worktree, the brief, the events, the access, the deadline and the process group. Every provider
// plugin offers all four the same way; the provider's model only watches the run (the wrapper
// agent).
type Engine string

const (
	EngineClaude   Engine = "claude"
	EngineOmp      Engine = "omp"
	EngineOpencode Engine = "opencode"
	EnginePi       Engine = "pi"
	EngineZcode    Engine = "zcode"
)

// ENGINES lists every engine a job can run on. Treat it as read-only.
var ENGINES = []Engine{EngineClaude, EngineOmp, EngineOpencode, EnginePi, EngineZcode}

// EngineTool is a delegation tool: every engine but claude, which is always enabled.
type EngineTool string

const (
	EngineToolOmp      EngineTool = "omp"
	EngineToolOpencode EngineTool = "opencode"
	EngineToolPi       EngineTool = "pi"
	EngineToolZcode    EngineTool = "zcode"
)

// ENGINE_TOOLS lists the delegation tools. Treat it as read-only.
var ENGINE_TOOLS = []EngineTool{EngineToolOmp, EngineToolOpencode, EngineToolPi, EngineToolZcode}

func IsEngine(value any) bool {
	text, ok := value.(string)
	return ok && slices.Contains(ENGINES, Engine(text))
}

func IsEngineTool(value any) bool {
	text, ok := value.(string)
	return ok && slices.Contains(ENGINE_TOOLS, EngineTool(text))
}

// Watcher names who runs an engine's wrapper agent: the provider's main model (through the
// router) or Claude Sonnet.
type Watcher string

const (
	WatcherProvider Watcher = "provider"
	WatcherSonnet   Watcher = "sonnet"
)

// EngineSetting is one enabled engine's config.
type EngineSetting struct {
	Watcher Watcher `json:"watcher"`
	// What `<tool> --version` printed when the engine was enabled.
	Version string `json:"version"`
	// The binary the engine was found at.
	Path string `json:"path"`
}

// EngineConfig says which delegation engines are enabled, who watches each one's runs, and the
// default engine. claude is implicit and always enabled; a plugin set up before engines existed
// has the config of claude only.
type EngineConfig struct {
	Engines map[EngineTool]EngineSetting `json:"engines"`
	// The engine a job runs on when neither `run --engine` nor the brief names one; claude when
	// unset.
	DefaultEngine *Engine `json:"defaultEngine,omitempty"`
}

// WithEngine returns the config with one engine enabled (or its watcher changed); every other
// engine stays as it was.
func WithEngine(config EngineConfig, tool EngineTool, setting EngineSetting) EngineConfig {
	engines := make(map[EngineTool]EngineSetting, len(config.Engines)+1)
	for name, existing := range config.Engines {
		engines[name] = existing
	}
	engines[tool] = setting
	config.Engines = engines
	return config
}

// EngineEnabled reports whether a job may run on the engine: claude always, a tool once its setup
// command enabled it.
func EngineEnabled(config EngineConfig, engine Engine) bool {
	if engine == EngineClaude {
		return true
	}
	_, ok := config.Engines[EngineTool(engine)]
	return ok
}
