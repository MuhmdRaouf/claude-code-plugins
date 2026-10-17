package shared

import (
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// The environment a delegation tool starts with: the user's own, as if they had run the tool
// themselves, so the tool finds its own login, config and keys. Only what this session added on
// top is withheld — the plugin's own provider variables (its key and every `<PREFIX>_` knob,
// named by withheld) and Claude Code's routing and session variables, which can point at a plugin
// router. The plugin never adds a provider, model, endpoint or key of its own.

// claudeRouting is Claude Code's routing (its settings env can point ANTHROPIC_BASE_URL at a
// plugin router) variables.
var claudeRouting = map[string]bool{
	"ANTHROPIC_BASE_URL":         true,
	"ANTHROPIC_AUTH_TOKEN":       true,
	"ANTHROPIC_MODEL":            true,
	"ANTHROPIC_SMALL_FAST_MODEL": true,
	"ANTHROPIC_CUSTOM_HEADERS":   true,
}

// IsClaudeSessionVar says whether a name belongs to the Claude Code session the orchestrator runs
// in rather than to the user's shell.
func IsClaudeSessionVar(name string) bool {
	return claudeRouting[name] ||
		strings.HasPrefix(name, "ANTHROPIC_DEFAULT_") ||
		strings.HasPrefix(name, "CLAUDE_") ||
		name == "CLAUDECODE"
}

// ToolEnv is the parent's environment minus the withheld names and Claude's session; then the
// brief's env, minus the names a brief may not set (reserved: the tool's own variables and any
// key), since brief names are orchestrator-written.
func ToolEnv(
	parent domain.EnvLookup,
	passEnv map[string]string,
	withheld func(name string) bool,
	reserved func(name string) bool,
) map[string]string {
	env := make(map[string]string, len(parent))
	for name, value := range parent {
		if withheld(name) || IsClaudeSessionVar(name) {
			continue
		}
		env[name] = value
	}
	blocked := func(name string) bool {
		return withheld(name) || IsClaudeSessionVar(name) || reserved(name)
	}
	for name, value := range adapters.WithoutReserved(passEnv, blocked) {
		env[name] = value
	}
	return env
}
