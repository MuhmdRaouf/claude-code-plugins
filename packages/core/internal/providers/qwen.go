package providers

import "github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"

// Qwen is qwen-plugin-cc's provider, matching plugins/qwen-plugin-cc/test/provider.ts field for
// field.
var Qwen = domain.DefineProvider(domain.ProviderSpec{
	Name:         "qwen",
	Display:      "Alibaba Qwen",
	Slash:        "/qwen:",
	AgentPrefix:  "qwen:",
	BranchPrefix: "qwen/",
	Harness:      "qwen",
	ArtifactsEnv: "QWEN_ARTIFACTS",
	EnvPrefix:    "QWEN",
	Catalog: map[domain.ModelTier]domain.ModelRef{
		domain.ModelTierMain: {
			Tier:          domain.ModelTierMain,
			ID:            "qwen3.8-max",
			Label:         "Qwen 3.8 Max",
			BehavesAs:     strPtr("claude-opus-5-5"),
			DefaultEffort: effortPtr(domain.EffortLevelXhigh),
		},
		domain.ModelTierFlash: {
			Tier:          domain.ModelTierFlash,
			ID:            "qwen3.8-flash",
			Label:         "Qwen 3.8 Flash",
			BehavesAs:     strPtr("claude-opus-5-5"),
			DefaultEffort: effortPtr(domain.EffortLevelXhigh),
		},
		// Alibaba Cloud's published figures (2026-10-09, https://help.aliyun.com/zh/model-studio/text-generation-model):
		// both models run a 1M-token window and support thinking mode. No output cap is published for either
		// (https://www.alibabacloud.com/help/en/model-studio/model-pricing), so maxOutputTokens stays unset.
	},
	TierNames: map[domain.ModelTier]string{domain.ModelTierMain: "qwen", domain.ModelTierFlash: "flash"},
	DefaultTier: map[domain.Mode]domain.ModelTier{
		domain.ModeEdit:     domain.ModelTierMain,
		domain.ModeExec:     domain.ModelTierFlash,
		domain.ModeReadonly: domain.ModelTierFlash,
	},
	PingTier:    domain.ModelTierFlash,
	WorkerLabel: "claude",
	BaseURL:     "https://dashscope-intl.aliyuncs.com/apps/anthropic",
	Auth:        domain.AuthBearer,
	KeyEnv:      []string{"QWEN_API_KEY", "DASHSCOPE_API_KEY"},
	KeyFile:     "~/.config/qwen-plugin-cc/env",
	BillingURL:  "https://usercenter2-intl.aliyun.com/billing",
	KeysURL:     "https://modelstudio.console.alibabacloud.com/?tab=playground#/api-key",
	Strip:       []string{"context_management"},
	Caveats:     []string{"Qwen ignores context_management"},
	Router: domain.ProviderRouter{
		Port:          18791,
		Label:         "com.muhmdraouf.qwen-router",
		HealthPath:    "/qwen-router/health",
		ModelPrefixes: []string{"qwen"},
	},
})
