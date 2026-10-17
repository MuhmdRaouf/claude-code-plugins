// Package providers holds the five provider plugins' providers as data: one file per plugin, each
// matching its plugins/<name>-plugin-cc/test/provider.ts field for field (the plugin ships no
// runtime source of its own), plus the by-name lookup a plugin-core invocation's first argument
// goes through.
package providers

import "github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"

// Names is every provider a plugin-core invocation may name first, in router-port order.
var Names = []string{"zai", "kimi", "deepseek", "minimax", "qwen"}

var byName = map[string]domain.Provider{
	Zai.Name:      Zai,
	Kimi.Name:     Kimi,
	Deepseek.Name: Deepseek,
	Minimax.Name:  Minimax,
	Qwen.Name:     Qwen,
}

// ByName is the provider a plugin-core invocation names, or false when the name is nobody's.
func ByName(name string) (domain.Provider, bool) {
	provider, ok := byName[name]
	return provider, ok
}

func strPtr(s string) *string { return &s }

func i64Ptr(n int64) *int64 { return &n }

func effortPtr(e domain.EffortLevel) *domain.EffortLevel { return &e }
