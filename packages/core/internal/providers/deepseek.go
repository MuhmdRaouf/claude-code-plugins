package providers

import "github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"

// Deepseek is deepseek-plugin-cc's provider, matching
// plugins/deepseek-plugin-cc/test/provider.ts field for field.
var Deepseek = domain.DefineProvider(domain.ProviderSpec{
	Name:         "deepseek",
	Display:      "DeepSeek",
	Slash:        "/deepseek:",
	AgentPrefix:  "deepseek:",
	BranchPrefix: "deepseek/",
	Harness:      "deepseek",
	ArtifactsEnv: "DEEPSEEK_ARTIFACTS",
	EnvPrefix:    "DEEPSEEK",
	Catalog: map[domain.ModelTier]domain.ModelRef{
		domain.ModelTierMain: {
			Tier:            domain.ModelTierMain,
			ID:              "deepseek-v4-pro",
			Label:           "DeepSeek V4 Pro",
			BehavesAs:       strPtr("claude-opus-5-5"),
			MaxOutputTokens: i64Ptr(393216),
			DefaultEffort:   effortPtr(domain.EffortLevelXhigh),
		},
		domain.ModelTierFlash: {
			Tier:            domain.ModelTierFlash,
			ID:              "deepseek-flash",
			Label:           "DeepSeek Flash",
			BehavesAs:       strPtr("claude-opus-5-5"),
			MaxOutputTokens: i64Ptr(393216),
			DefaultEffort:   effortPtr(domain.EffortLevelXhigh),
		},
		// DeepSeek's published figures (2026-10-09, https://api-docs.deepseek.com/quick_start/pricing): both models
		// carry a 1M context length and a "MAXIMUM: 384K" output, and run in thinking mode by default.
	},
	TierNames: map[domain.ModelTier]string{domain.ModelTierMain: "deepseek", domain.ModelTierFlash: "flash"},
	DefaultTier: map[domain.Mode]domain.ModelTier{
		domain.ModeEdit:     domain.ModelTierMain,
		domain.ModeExec:     domain.ModelTierFlash,
		domain.ModeReadonly: domain.ModelTierFlash,
	},
	PingTier:    domain.ModelTierFlash,
	WorkerLabel: "claude",
	BaseURL:     "https://api.deepseek.com/anthropic",
	Auth:        domain.AuthBearer,
	KeyEnv:      []string{"DEEPSEEK_API_KEY"},
	KeyFile:     "~/.config/deepseek-plugin-cc/env",
	BillingURL:  "https://platform.deepseek.com/top_up",
	KeysURL:     "https://platform.deepseek.com/api_keys",
	Strip:       []string{"cache_control"},
	Caveats:     []string{"DeepSeek ignores cache_control"},
	Router: domain.ProviderRouter{
		Port:          18789,
		Label:         "com.muhmdraouf.deepseek-router",
		HealthPath:    "/deepseek-router/health",
		ModelPrefixes: []string{"deepseek-"},
	},
})
