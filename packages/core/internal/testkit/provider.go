package testkit

import (
	"regexp"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// The shared suites came from zai and assert its output, so they run on a copy of zai's names (the
// reference provider) and of the claude worker's terms. zai's own tests check its real provider
// and worker still equal these.

// ReferenceProvider is the reference provider: a copy of zai's.
var ReferenceProvider = domain.DefineProvider(domain.ProviderSpec{
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

// ReferenceCaps is the reference worker's capabilities: the claude worker's.
var ReferenceCaps = ports.WorkerCapabilities{
	WorkerTerms: domain.WorkerTerms{
		Efforts: []string{"low", "high", "max"},
		Budget:  true,
		BriefNotes: domain.BriefNotes{
			Effort:    "passed to claude --effort",
			AddDirs:   "passed as --add-dir",
			BudgetUSD: "passed as --max-budget-usd",
			Readonly:  "plan mode, read tools only",
		},
	},
	Name:         ports.WorkerNameClaudeHeadless,
	SessionKey:   ports.SessionKeyCaller,
	NativeSchema: true,
}

// AcmeProvider shares no name with zai: rendering with it proves nothing zai-specific is
// hardcoded.
var AcmeProvider = domain.DefineProvider(domain.ProviderSpec{
	Name:         "acme",
	Display:      "Acme Models",
	Slash:        "/acme:",
	AgentPrefix:  "acme:",
	BranchPrefix: "acme-jobs/",
	Harness:      "acme-harness",
	ArtifactsEnv: "ACME_OUT",
	EnvPrefix:    "ACME",
	Catalog: map[domain.ModelTier]domain.ModelRef{
		domain.ModelTierMain:  {Tier: domain.ModelTierMain, ID: "big-model-9", Label: "Big Model 9"},
		domain.ModelTierFlash: {Tier: domain.ModelTierFlash, ID: "small-model-9", Label: "Small Model 9"},
	},
	TierNames: map[domain.ModelTier]string{domain.ModelTierMain: "big", domain.ModelTierFlash: "quick"},
	DefaultTier: map[domain.Mode]domain.ModelTier{
		domain.ModeEdit:     domain.ModelTierMain,
		domain.ModeExec:     domain.ModelTierFlash,
		domain.ModeReadonly: domain.ModelTierFlash,
	},
	PingTier:    domain.ModelTierMain,
	WorkerLabel: "acmebot",
	BaseURL:     "https://api.acme.test/anthropic",
	Auth:        domain.AuthBearer,
	KeyEnv:      []string{"ACME_API_KEY"},
	KeyFile:     "~/.config/acme/env",
	BillingURL:  "https://billing.example.test/top-up",
	KeysURL:     "https://keys.example.test/api-keys",
	Strip:       []string{"trace"},
	Caveats:     []string{"acme ignores the trace field"},
	Router: domain.ProviderRouter{
		Port:          18800,
		Label:         "test.acme-router",
		HealthPath:    "/acme-router/health",
		ModelPrefixes: []string{"big-", "small-"},
	},
})

// AcmeWorker shares no term with the claude worker, and has no spending cap.
var AcmeWorker = domain.WorkerTerms{
	Efforts: []string{"gentle", "firm", "fierce"},
	Budget:  false,
	BriefNotes: domain.BriefNotes{
		Effort:    "sent as acmebot --zeal",
		AddDirs:   "mounted read-only",
		BudgetUSD: "refused: acmebot has no spending cap",
		Readonly:  "answered from the repo, nothing written",
	},
}

// ZaiNames is text with zai's own names: what an ACME rendering must never contain.
var ZaiNames = regexp.MustCompile(`(?i)zai|z\.ai|glm-5\.3|claude`)

func strPtr(text string) *string { return &text }

func i64Ptr(value int64) *int64 { return &value }

func effortPtr(effort domain.EffortLevel) *domain.EffortLevel { return &effort }
