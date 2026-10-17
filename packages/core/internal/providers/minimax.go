package providers

import "github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"

// Minimax is minimax-plugin-cc's provider, matching
// plugins/minimax-plugin-cc/test/provider.ts field for field.
var Minimax = domain.DefineProvider(domain.ProviderSpec{
	Name:         "minimax",
	Display:      "MiniMax",
	Slash:        "/minimax:",
	AgentPrefix:  "minimax:",
	BranchPrefix: "minimax/",
	Harness:      "minimax",
	ArtifactsEnv: "MINIMAX_ARTIFACTS",
	EnvPrefix:    "MINIMAX",
	Catalog: map[domain.ModelTier]domain.ModelRef{
		domain.ModelTierMain: {
			Tier:          domain.ModelTierMain,
			ID:            "MiniMax-M3",
			Label:         "MiniMax M3",
			BehavesAs:     strPtr("claude-opus-5-5"),
			DefaultEffort: effortPtr(domain.EffortLevelXhigh),
		},
		domain.ModelTierFlash: {
			Tier:          domain.ModelTierFlash,
			ID:            "MiniMax-M2.7-highspeed",
			Label:         "MiniMax M2.7 Highspeed",
			DefaultEffort: effortPtr(domain.EffortLevelXhigh),
		},
		// MiniMax's published figures (2026-10-09, https://platform.minimax.io/docs/api-reference/text-anthropic-api):
		// MiniMax-M3 runs a 1,000,000-token window with thinking off by default (adaptive turns it on);
		// MiniMax-M2.7-highspeed runs 204,800 tokens and cannot stop thinking. No output cap is published for either
		// model (https://platform.minimax.io/docs/guides/models-intro), so maxOutputTokens stays unset. M3 is also the
		// cheaper model per token (https://platform.minimax.io/docs/guides/pricing-paygo), so everything defaults to it.
	},
	TierNames: map[domain.ModelTier]string{domain.ModelTierMain: "minimax", domain.ModelTierFlash: "flash"},
	DefaultTier: map[domain.Mode]domain.ModelTier{
		domain.ModeEdit:     domain.ModelTierMain,
		domain.ModeExec:     domain.ModelTierMain,
		domain.ModeReadonly: domain.ModelTierMain,
	},
	PingTier:    domain.ModelTierMain,
	WorkerLabel: "claude",
	BaseURL:     "https://api.minimax.io/anthropic",
	Auth:        domain.AuthBearer,
	KeyEnv:      []string{"MINIMAX_API_KEY"},
	KeyFile:     "~/.config/minimax-plugin-cc/env",
	BillingURL:  "https://platform.minimax.io/user-center/payment/balance",
	KeysURL:     "https://platform.minimax.io/console/access",
	Strip:       []string{"context_management"},
	Caveats:     []string{"MiniMax ignores context_management"},
	Router: domain.ProviderRouter{
		Port:          18790,
		Label:         "com.muhmdraouf.minimax-router",
		HealthPath:    "/minimax-router/health",
		ModelPrefixes: []string{"MiniMax-"},
	},
})
