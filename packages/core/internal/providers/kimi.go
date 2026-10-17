package providers

import "github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"

// Kimi is kimi-plugin-cc's provider, matching plugins/kimi-plugin-cc/test/provider.ts field for
// field.
var Kimi = domain.DefineProvider(domain.ProviderSpec{
	Name:         "kimi",
	Display:      "Moonshot Kimi",
	Slash:        "/kimi:",
	AgentPrefix:  "kimi:",
	BranchPrefix: "kimi/",
	Harness:      "kimi",
	ArtifactsEnv: "KIMI_ARTIFACTS",
	EnvPrefix:    "KIMI",
	Catalog: map[domain.ModelTier]domain.ModelRef{
		domain.ModelTierMain: {
			Tier:            domain.ModelTierMain,
			ID:              "kimi-k3",
			Label:           "Kimi K3",
			BehavesAs:       strPtr("claude-opus-5-5"),
			MaxOutputTokens: i64Ptr(1048576),
			DefaultEffort:   effortPtr(domain.EffortLevelXhigh),
		},
		domain.ModelTierFlash: {
			Tier:  domain.ModelTierFlash,
			ID:    "kimi-k2.6",
			Label: "Kimi K2.6",
		},
		// Moonshot's published figures (2026-10-09): kimi-k3 runs a 1,048,576-token window
		// (https://platform.kimi.ai/docs/pricing/chat) and takes max_completion_tokens up to 1048576, with a
		// reasoning_effort of low/high/max and max the default (https://platform.kimi.ai/docs/api/chat). Kimi K2.6
		// runs a 262,144-token window; Moonshot publishes no output cap or effort control for it, so those stay unset.
	},
	TierNames: map[domain.ModelTier]string{domain.ModelTierMain: "kimi", domain.ModelTierFlash: "flash"},
	DefaultTier: map[domain.Mode]domain.ModelTier{
		domain.ModeEdit:     domain.ModelTierMain,
		domain.ModeExec:     domain.ModelTierFlash,
		domain.ModeReadonly: domain.ModelTierFlash,
	},
	PingTier:    domain.ModelTierFlash,
	WorkerLabel: "claude",
	BaseURL:     "https://api.moonshot.ai/anthropic",
	Auth:        domain.AuthBearer,
	KeyEnv:      []string{"KIMI_API_KEY"},
	KeyFile:     "~/.config/kimi-plugin-cc/env",
	BillingURL:  "https://platform.kimi.ai/console",
	KeysURL:     "https://platform.kimi.ai/console/api-keys",
	Strip:       []string{},
	Caveats:     []string{},
	Router: domain.ProviderRouter{
		Port:          18788,
		Label:         "com.muhmdraouf.kimi-router",
		HealthPath:    "/kimi-router/health",
		ModelPrefixes: []string{"kimi-"},
	},
})
