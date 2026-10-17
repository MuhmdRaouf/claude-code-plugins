package domain

import (
	"reflect"
	"testing"
)

// ModelEnvName's cases.
func TestModelEnvName(t *testing.T) {
	t.Run("uppercases the tier after the provider's env prefix", func(t *testing.T) {
		if got := ModelEnvName(acmeProvider, ModelTierMain); got != "ACME_MODEL_MAIN" {
			t.Fatalf("modelEnvName(acme, main) = %q, want ACME_MODEL_MAIN", got)
		}
		if got := ModelEnvName(referenceProvider, ModelTierFlash); got != "ZAI_MODEL_FLASH" {
			t.Fatalf("modelEnvName(reference, flash) = %q, want ZAI_MODEL_FLASH", got)
		}
	})
}

func TestResolveProvider(t *testing.T) {
	t.Run("returns the provider unchanged when no override is set", func(t *testing.T) {
		if !reflect.DeepEqual(ResolveProvider(acmeProvider, EnvLookup{}), acmeProvider) {
			t.Fatalf("resolveProvider(acme, {}) changed the provider")
		}
	})

	t.Run("replaces only the catalog ids the env names", func(t *testing.T) {
		resolved := ResolveProvider(acmeProvider, EnvLookup{"ACME_MODEL_FLASH": "small-model-9-turbo"})
		wantCatalog := map[ModelTier]ModelRef{
			ModelTierMain:  {Tier: ModelTierMain, ID: "big-model-9", Label: "Big Model 9"},
			ModelTierFlash: {Tier: ModelTierFlash, ID: "small-model-9-turbo", Label: "Small Model 9"},
		}
		if !reflect.DeepEqual(resolved.Catalog, wantCatalog) {
			t.Fatalf("catalog = %s, want %s", mustJSON(resolved.Catalog), mustJSON(wantCatalog))
		}
		if !reflect.DeepEqual(resolved.TierNames, acmeProvider.TierNames) {
			t.Fatalf("tierNames = %s, want unchanged", mustJSON(resolved.TierNames))
		}
	})

	t.Run("overrides the endpoint when the env names one", func(t *testing.T) {
		resolved := ResolveProvider(acmeProvider, EnvLookup{"ACME_BASE_URL": "https://mirror.acme.test/anthropic"})
		if resolved.BaseURL != "https://mirror.acme.test/anthropic" {
			t.Fatalf("baseUrl = %q, want the mirror", resolved.BaseURL)
		}
	})
}

// Direct rows for the provider's derived data and the router port/base-url helpers: no other
// layer's tests reach them.
func TestProviderDerivedData(t *testing.T) {
	t.Run("defineProvider names the agents after the catalog's model ids", func(t *testing.T) {
		want := map[ModelTier]string{ModelTierMain: "glm-5.3", ModelTierFlash: "glm-5.3-flash"}
		if !reflect.DeepEqual(referenceProvider.Agents, want) {
			t.Fatalf("agents = %s, want %s", mustJSON(referenceProvider.Agents), mustJSON(want))
		}
	})

	t.Run("routerEnvName appends the knob after the prefix", func(t *testing.T) {
		if got := RouterEnvName(referenceProvider, RouterEnvKnobPort); got != "ZAI_ROUTER_PORT" {
			t.Fatalf("port knob = %q", got)
		}
		if got := RouterEnvName(referenceProvider, RouterEnvKnobURL); got != "ZAI_ROUTER_URL" {
			t.Fatalf("url knob = %q", got)
		}
		if got := RouterEnvName(referenceProvider, RouterEnvKnobAnthropicURL); got != "ZAI_ROUTER_ANTHROPIC_URL" {
			t.Fatalf("anthropic url knob = %q", got)
		}
	})

	t.Run("routerPort takes the env override, else the provider's port", func(t *testing.T) {
		if got := RouterPort(referenceProvider, EnvLookup{}); got != 18787 {
			t.Fatalf("default port = %d, want 18787", got)
		}
		if got := RouterPort(referenceProvider, EnvLookup{"ZAI_ROUTER_PORT": "19000"}); got != 19000 {
			t.Fatalf("overridden port = %d, want 19000", got)
		}
		// Number("not-a-port") is NaN, and NaN || port is the provider's port.
		if got := RouterPort(referenceProvider, EnvLookup{"ZAI_ROUTER_PORT": "not-a-port"}); got != 18787 {
			t.Fatalf("invalid override = %d, want 18787", got)
		}
	})

	t.Run("routerBaseURL points at the loopback router", func(t *testing.T) {
		if got := RouterBaseURL(referenceProvider, EnvLookup{}); got != "http://127.0.0.1:18787" {
			t.Fatalf("baseUrl = %q", got)
		}
		if got := RouterBaseURL(acmeProvider, EnvLookup{"ACME_ROUTER_PORT": "19001"}); got != "http://127.0.0.1:19001" {
			t.Fatalf("baseUrl = %q", got)
		}
	})

	t.Run("modelClaim covers the resolved catalog ids and the prefixes", func(t *testing.T) {
		claim := ResolveProvider(acmeProvider, EnvLookup{"ACME_MODEL_MAIN": "huge-model-10"}).ModelClaim()
		if !reflect.DeepEqual(claim, ModelClaim{IDs: []string{"huge-model-10", "small-model-9"}, Prefixes: []string{"big-", "small-"}}) {
			t.Fatalf("claim = %s", mustJSON(claim))
		}
	})

	t.Run("claims covers ids, prefixes and nobody's empty model", func(t *testing.T) {
		claim := referenceProvider.ModelClaim()
		if !Claims(claim, "glm-5.3") || !Claims(claim, "glm-6-preview") || Claims(claim, "") || Claims(claim, "claude-opus-5-5") {
			t.Fatalf("claim = %s decides wrongly", mustJSON(claim))
		}
	})
}
