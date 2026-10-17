package providers

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// The cases are the five plugins' test/provider.ts files: each provider pinned field for field,
// agents included (what DefineProvider derives from the catalog). The by-name rows cover ByName
// for every name and for an unknown one.

func TestZaiIsCoresReferenceProvider(t *testing.T) {
	t.Run("core's shared suites assert zai's names, its state root and the claude worker's terms", func(t *testing.T) {
		requireProvider(t, "zai", Zai, domain.Provider{
			Name:         "zai",
			Display:      "Z.ai GLM",
			Slash:        "/zai:",
			AgentPrefix:  "zai:",
			BranchPrefix: "zai/",
			Harness:      "zai",
			ArtifactsEnv: "ZAI_ARTIFACTS",
			Agents: map[domain.ModelTier]string{
				domain.ModelTierMain:  "glm-5.3",
				domain.ModelTierFlash: "glm-5.3-flash",
			},
			EnvPrefix: "ZAI",
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
			PingTier:       domain.ModelTierFlash,
			WorkerLabel:    "claude",
			BaseURL:        "https://api.z.ai/api/anthropic",
			Auth:           domain.AuthBearer,
			KeyEnv:         []string{"ZAI_API_KEY"},
			KeyFile:        "~/.config/zai-plugin-cc/env",
			BillingURL:     "https://z.ai/manage-apikey/billing",
			KeysURL:        "https://z.ai/manage-apikey/apikey-list",
			Strip:          []string{},
			WebSearchModel: strPtr("glm-5.3"),
			Caveats:        []string{},
			Router: domain.ProviderRouter{
				Port:          18787,
				Label:         "dev.muhmdraouf.zai-router",
				HealthPath:    "/zai-router/health",
				ModelPrefixes: []string{"glm-"},
			},
		})
	})
}

func TestKimiIsTheDataKimiPluginCcShips(t *testing.T) {
	t.Run("names its provider, models, endpoint, key variables, billing page, router port and the fields it strips", func(t *testing.T) {
		requireProvider(t, "kimi", Kimi, domain.Provider{
			Name:         "kimi",
			Display:      "Moonshot Kimi",
			Slash:        "/kimi:",
			AgentPrefix:  "kimi:",
			BranchPrefix: "kimi/",
			Harness:      "kimi",
			ArtifactsEnv: "KIMI_ARTIFACTS",
			Agents: map[domain.ModelTier]string{
				domain.ModelTierMain:  "kimi-k3",
				domain.ModelTierFlash: "kimi-k2.6",
			},
			EnvPrefix: "KIMI",
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
	})
}

func TestDeepseekIsTheDataDeepseekPluginCcShips(t *testing.T) {
	t.Run("names its provider, models, endpoint, key variables, billing page, router port and the fields it strips", func(t *testing.T) {
		requireProvider(t, "deepseek", Deepseek, domain.Provider{
			Name:         "deepseek",
			Display:      "DeepSeek",
			Slash:        "/deepseek:",
			AgentPrefix:  "deepseek:",
			BranchPrefix: "deepseek/",
			Harness:      "deepseek",
			ArtifactsEnv: "DEEPSEEK_ARTIFACTS",
			Agents: map[domain.ModelTier]string{
				domain.ModelTierMain:  "deepseek-v4-pro",
				domain.ModelTierFlash: "deepseek-flash",
			},
			EnvPrefix: "DEEPSEEK",
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
	})
}

func TestMinimaxIsTheDataMinimaxPluginCcShips(t *testing.T) {
	t.Run("names its provider, models, endpoint, key variables, billing page, router port and the fields it strips", func(t *testing.T) {
		requireProvider(t, "minimax", Minimax, domain.Provider{
			Name:         "minimax",
			Display:      "MiniMax",
			Slash:        "/minimax:",
			AgentPrefix:  "minimax:",
			BranchPrefix: "minimax/",
			Harness:      "minimax",
			ArtifactsEnv: "MINIMAX_ARTIFACTS",
			Agents: map[domain.ModelTier]string{
				domain.ModelTierMain:  "MiniMax-M3",
				domain.ModelTierFlash: "MiniMax-M2.7-highspeed",
			},
			EnvPrefix: "MINIMAX",
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
	})
}

func TestQwenIsTheDataQwenPluginCcShips(t *testing.T) {
	t.Run("names its provider, models, endpoint, key variables, billing page, router port and the fields it strips", func(t *testing.T) {
		requireProvider(t, "qwen", Qwen, domain.Provider{
			Name:         "qwen",
			Display:      "Alibaba Qwen",
			Slash:        "/qwen:",
			AgentPrefix:  "qwen:",
			BranchPrefix: "qwen/",
			Harness:      "qwen",
			ArtifactsEnv: "QWEN_ARTIFACTS",
			Agents: map[domain.ModelTier]string{
				domain.ModelTierMain:  "qwen3.8-max",
				domain.ModelTierFlash: "qwen3.8-flash",
			},
			EnvPrefix: "QWEN",
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
	})
}

func TestByName(t *testing.T) {
	t.Run("finds each provider by name", func(t *testing.T) {
		want := map[string]domain.Provider{
			"zai":      Zai,
			"kimi":     Kimi,
			"deepseek": Deepseek,
			"minimax":  Minimax,
			"qwen":     Qwen,
		}
		for _, name := range Names {
			got, ok := ByName(name)
			if !ok {
				t.Fatalf("ByName(%q) found nothing", name)
			}
			if !reflect.DeepEqual(got, want[name]) {
				t.Fatalf("ByName(%q) = %s, want %s", name, mustJSON(got), mustJSON(want[name]))
			}
		}
	})

	t.Run("returns false for an unknown name", func(t *testing.T) {
		got, ok := ByName("nope")
		if ok {
			t.Fatalf("ByName(\"nope\") found %s", mustJSON(got))
		}
		if !reflect.DeepEqual(got, domain.Provider{}) {
			t.Fatalf("ByName(\"nope\") = %s, want the zero provider", mustJSON(got))
		}
	})
}

func TestNames(t *testing.T) {
	t.Run("lists the five providers in port order", func(t *testing.T) {
		want := []string{"zai", "kimi", "deepseek", "minimax", "qwen"}
		if !reflect.DeepEqual(Names, want) {
			t.Fatalf("Names = %v, want %v", Names, want)
		}
	})
}

func requireProvider(t *testing.T, name string, got, want domain.Provider) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s = %s, want %s", name, mustJSON(got), mustJSON(want))
	}
}

func mustJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err.Error()
	}
	return string(encoded)
}
