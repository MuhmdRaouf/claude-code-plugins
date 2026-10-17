package domain

import "strings"

// Every name the plugin shows its users and everything else provider-specific the shared code
// reads, as data. Each plugin defines its own and wires it into its deps, so the shared code
// spells no provider's names.

// EnvLookup is the environment a provider reads: the process environment's string values.
type EnvLookup map[string]string

// AuthStyle is how the key authenticates a request; today's only style carries it as a Bearer
// token.
type AuthStyle string

const AuthBearer AuthStyle = "bearer"

// ProviderRouter is this plugin's own router: its port, its legacy service label, its health
// path, and the model prefixes it claims.
type ProviderRouter struct {
	// The port the router takes when no env override names one.
	Port int `json:"port"`
	// zai keeps its historical `dev.muhmdraouf.zai-router`; new plugins use
	// `com.muhmdraouf.<name>-router`.
	Label string `json:"label"`
	// The GET path answering `{"ok":true,"name":…,"provider":…}`.
	HealthPath string `json:"healthPath"`
	// A request whose model id starts with one of these goes to the provider; everything else to
	// Anthropic untouched.
	ModelPrefixes []string `json:"modelPrefixes"`
}

// Provider is the provider as a plugin ships it.
type Provider struct {
	// The CLI's name: message prefix `<name>: …`, `<name> job <id>`, the synopsis, the temp index
	// dir prefix.
	Name string `json:"name"`
	// The provider as people know it, e.g. "Z.ai GLM"; setup, key and error lines name it.
	Display string `json:"display"`
	// Slash-command prefix, e.g. "/zai:" in `/zai:board`.
	Slash string `json:"slash"`
	// Agent prefix, e.g. "zai:" in `zai:glm-5.3`.
	AgentPrefix string `json:"agentPrefix"`
	// The dispatch agents (without the prefix) a run names per tier: the shipped catalog's model
	// ids, so zai's are glm-5.3 and glm-5.3-flash. DefineProvider derives them; a model bump
	// renames the agents with it. The env overrides ResolveProvider applies leave them as
	// shipped, because the agent files carry these names.
	Agents map[ModelTier]string `json:"agents"`
	// Edit jobs work on branch `<branchPrefix><id>`.
	BranchPrefix string `json:"branchPrefix"`
	// Names the harness in the commit trailer `Worked-by: <model id> via <harness>`.
	Harness string `json:"harness"`
	// The variable naming an exec job's artifacts dir, for the worker and the gates.
	ArtifactsEnv string `json:"artifactsEnv"`
	// Environment-variable prefix: `${envPrefix}_MAX_CONCURRENCY` caps the adaptive limit,
	// `${envPrefix}_MODEL_*` overrides the catalog, `${envPrefix}_BASE_URL` the endpoint.
	EnvPrefix string `json:"envPrefix"`
	// The model behind each tier; a brief names a tier by its TierNames name or by its model id.
	Catalog map[ModelTier]ModelRef `json:"catalog"`
	// The name a brief's `model:` line uses for each tier; zai's main stays "glm", so existing
	// briefs still parse.
	TierNames map[ModelTier]string `json:"tierNames"`
	// The tier a brief gets when it names none.
	DefaultTier map[Mode]ModelTier `json:"defaultTier"`
	// The tier `setup --ping` asks.
	PingTier ModelTier `json:"pingTier"`
	// What runs the model, as setup and worker errors name it.
	WorkerLabel string `json:"workerLabel"`
	// The Anthropic-compatible endpoint.
	BaseURL string `json:"baseUrl"`
	// How the key authenticates a request.
	Auth AuthStyle `json:"auth"`
	// API key environment variables in priority order (qwen also accepts DASHSCOPE_API_KEY).
	KeyEnv []string `json:"keyEnv"`
	// The key file `setup` writes and the worker and router read instead (mode 600).
	KeyFile string `json:"keyFile"`
	// Where the user tops up the account (the provider's billing or top-up page): named when the
	// provider refuses a request for lack of balance or quota.
	BillingURL string `json:"billingUrl"`
	// Where the user creates an API key (the provider's key page): linked from the one-time key
	// page.
	KeysURL string `json:"keysUrl"`
	// Request fields this provider rejects; the router strips them from provider-bound requests.
	Strip []string `json:"strip"`
	// The catalog model that serves requests carrying a web_search server tool, when only one
	// model of the catalog does: the router reroutes such requests to it, whatever model they
	// asked for. Nil: no rerouting.
	WebSearchModel *string `json:"webSearchModel,omitempty"`
	// Model caveats brief writers must heed, one sentence each, printed in the brief template.
	Caveats []string `json:"caveats"`
	// This plugin's own router.
	Router ProviderRouter `json:"router"`
}

// ProviderSpec is a provider as a plugin writes it: everything but the agent names, which come
// from its catalog.
type ProviderSpec Provider

// DefineProvider returns the provider with its agents named by its catalog's model ids: one
// place names a model, and the agents follow.
func DefineProvider(spec ProviderSpec) Provider {
	provider := Provider(spec)
	provider.Agents = map[ModelTier]string{
		ModelTierMain:  spec.Catalog[ModelTierMain].ID,
		ModelTierFlash: spec.Catalog[ModelTierFlash].ID,
	}
	return provider
}

// ModelEnvName is every model env override a provider honours, uppercased tier appended:
// `${envPrefix}_MODEL_MAIN`, `_MODEL_FLASH`.
func ModelEnvName(provider Provider, tier ModelTier) string {
	return provider.EnvPrefix + "_MODEL_" + strings.ToUpper(string(tier))
}

// RouterEnvKnob names one of the env vars the router service reads.
type RouterEnvKnob string

const (
	RouterEnvKnobPort         RouterEnvKnob = "PORT"
	RouterEnvKnobURL          RouterEnvKnob = "URL"
	RouterEnvKnobAnthropicURL RouterEnvKnob = "ANTHROPIC_URL"
)

// RouterEnvName is the env var the router service reads:
// `${envPrefix}_ROUTER_PORT`, `_ROUTER_URL`, `_ROUTER_ANTHROPIC_URL`.
func RouterEnvName(provider Provider, knob RouterEnvKnob) string {
	return provider.EnvPrefix + "_ROUTER_" + string(knob)
}

// ResolveProvider returns the provider with env overrides applied, because provider catalogs
// change faster than releases: `${envPrefix}_MODEL_MAIN`/`_MODEL_FLASH` replace the catalog's
// ids, `${envPrefix}_BASE_URL` the endpoint.
func ResolveProvider(provider Provider, env EnvLookup) Provider {
	withID := func(tier ModelTier, id string) ModelRef {
		model := provider.Catalog[tier]
		model.ID = id
		return model
	}
	resolved := provider
	resolved.Catalog = map[ModelTier]ModelRef{
		ModelTierMain:  withID(ModelTierMain, env.value(ModelEnvName(provider, ModelTierMain), provider.Catalog[ModelTierMain].ID)),
		ModelTierFlash: withID(ModelTierFlash, env.value(ModelEnvName(provider, ModelTierFlash), provider.Catalog[ModelTierFlash].ID)),
	}
	resolved.BaseURL = env.value(provider.EnvPrefix+"_BASE_URL", provider.BaseURL)
	return resolved
}

// value falls back only on a missing key: a present empty string stands.
func (e EnvLookup) value(name, fallback string) string {
	if value, present := e[name]; present {
		return value
	}
	return fallback
}

// ModelClaim says which model ids a provider's router takes: its resolved catalog ids (env
// overrides included) and its prefixes. The one answer to "is this our model?" that the worker,
// the front, the emergency passthrough and the peer registry all share.
type ModelClaim struct {
	IDs      []string `json:"ids"`
	Prefixes []string `json:"prefixes"`
}

// ModelClaim is the claim of a provider as this process runs it: pass the resolved provider
// (ResolveProvider), so an overridden model id outside the usual prefix is still this
// provider's.
func (p Provider) ModelClaim() ModelClaim {
	return ModelClaim{
		IDs:      []string{p.Catalog[ModelTierMain].ID, p.Catalog[ModelTierFlash].ID},
		Prefixes: p.Router.ModelPrefixes,
	}
}

// Claims is true when the claim covers the model: one of its ids, or an id with one of its
// prefixes. "" is nobody's.
func Claims(claim ModelClaim, model string) bool {
	if model == "" {
		return false
	}
	for _, id := range claim.IDs {
		if model == id {
			return true
		}
	}
	for _, prefix := range claim.Prefixes {
		if strings.HasPrefix(model, prefix) {
			return true
		}
	}
	return false
}
