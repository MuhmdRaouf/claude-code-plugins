package providers

import "github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"

// Zai is zai-plugin-cc's provider, matching plugins/zai-plugin-cc/test/provider.ts field for
// field.
var Zai = domain.DefineProvider(domain.ProviderSpec{
	Name:         "zai",
	Display:      "Z.ai GLM",
	Slash:        "/zai:",
	AgentPrefix:  "zai:",
	BranchPrefix: "zai/",
	Harness:      "zai",
	ArtifactsEnv: "ZAI_ARTIFACTS",
	EnvPrefix:    "ZAI",
	Catalog: map[domain.ModelTier]domain.ModelRef{
		domain.ModelTierMain: {
			Tier:            domain.ModelTierMain,
			ID:              "glm-5.3",
			Label:           "GLM 5.3",
			BehavesAs:       strPtr("claude-opus-5-5"),
			MaxOutputTokens: i64Ptr(131072),
			DefaultEffort:   effortPtr(domain.EffortLevelXhigh),
		},
		domain.ModelTierFlash: {
			Tier:            domain.ModelTierFlash,
			ID:              "glm-5.3-flash",
			Label:           "GLM 5.3 Flash",
			BehavesAs:       strPtr("claude-opus-5-5"),
			MaxOutputTokens: i64Ptr(131072),
			DefaultEffort:   effortPtr(domain.EffortLevelXhigh),
		},
	},
	TierNames: map[domain.ModelTier]string{domain.ModelTierMain: "glm", domain.ModelTierFlash: "flash"},
	DefaultTier: map[domain.Mode]domain.ModelTier{
		domain.ModeEdit:     domain.ModelTierMain,
		domain.ModeExec:     domain.ModelTierFlash,
		domain.ModeReadonly: domain.ModelTierFlash,
	},
	PingTier:    domain.ModelTierFlash,
	WorkerLabel: "claude",
	BaseURL:     "https://api.z.ai/api/anthropic",
	Auth:        domain.AuthBearer,
	KeyEnv:      []string{"ZAI_API_KEY"},
	KeyFile:     "~/.config/zai-plugin-cc/env",
	BillingURL:  "https://z.ai/manage-apikey/billing",
	KeysURL:     "https://z.ai/manage-apikey/apikey-list",
	Strip:       []string{},
	// Z.ai's probe: the web_search server tool answers 500 on glm-5.3-flash and works on glm-5.3.
	WebSearchModel: strPtr("glm-5.3"),
	Caveats:        []string{},
	Router: domain.ProviderRouter{
		Port:          18787,
		Label:         "dev.muhmdraouf.zai-router",
		HealthPath:    "/zai-router/health",
		ModelPrefixes: []string{"glm-"},
	},
})
