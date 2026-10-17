// The setup wiring: plain `setup` starts the plugin's router (a background process its hooks keep
// alive), adds the provider's two models to `/model` and routes Claude Code through the router —
// proxy mode where it can (HTTPS_PROXY at the router and its local CA, so Remote Control keeps
// working), base-URL mode as the fallback beside a proxy or CA of the user's own — so picking one
// routes through it while every `claude-*` request still reaches Anthropic untouched.
// Every change it makes outside the plugin goes into the ledger, so the router can undo exactly
// those when the plugin is uninstalled. `setup --remove` undoes all of it; the SessionStart hook
// re-applies it after plugin updates (and after a re-enable), never pings the provider, and falls
// back to Sonnet when the router cannot come back.

package cli

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/keystore"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/router"
)

// routeTiers are both model tiers: they always get a `model:` line, the agents being the only thing
// the choice rewrites. Treat as read-only.
var routeTiers = []domain.ModelTier{domain.ModelTierMain, domain.ModelTierFlash}

// shippedModel is the model every shipped agent file names before setup touches it.
const shippedModel = "sonnet"

// AgentModels is whose models the agents' `model:` lines name: this provider's ids, or Sonnet
// (works with no key and no router).
type AgentModels string

const (
	AgentModelsProvider AgentModels = "provider"
	AgentModelsSonnet   AgentModels = "sonnet"
)

// AgentSource is where remove took the agents' models from: the ledger's record of them before
// setup, or (no ledger: a setup from before the ledger kept them) the shipped default.
type AgentSource string

const (
	AgentSourceLedger  AgentSource = "ledger"
	AgentSourceDefault AgentSource = "default"
)

// AgentModel is one agent's `model:` line, as the setup report names it; Changed says whether this
// run rewrote it, Before is the value it had (nil: no `model:` line). The tier agents are named by
// their catalog tier, the engine wrapper agents by their tool.
type AgentModel struct {
	Tier    string
	Agent   string
	Model   string
	Changed bool
	Before  *string
}

// LinesResult is a Result<readonly string[], string> as a value: the report lines a step produced,
// or the failure's message.
type LinesResult struct {
	OK    bool
	Value []string
	Error string
}

// AgentsResult is a Result<readonly AgentModel[], string> as a value: the applied agent models, or
// the failure's message.
type AgentsResult struct {
	OK    bool
	Value []AgentModel
	Error string
}

// stringResult is one Result<string, string> step's outcome from a Go (string, error).
func stringResult(value string, err error) app.StringResult {
	if err != nil {
		return app.StringResult{Error: err.Error()}
	}
	return app.StringResult{OK: true, Value: value}
}

// linesResult is one Result<readonly string[], string> step's outcome from a Go ([]string, error).
func linesResult(value []string, err error) LinesResult {
	if err != nil {
		return LinesResult{Error: err.Error()}
	}
	return LinesResult{OK: true, Value: value}
}

// ReadSetupDone is whether setup has run: the `setup-done` mark, or the `route: provider` record an
// older install carries.
func ReadSetupDone(stateRoot string) bool {
	layout := domain.NewStateLayout(stateRoot)
	if _, err := os.Stat(layout.SetupDone); err == nil {
		return true
	}
	data, err := os.ReadFile(layout.LegacyRouteMark)
	if err != nil {
		return false
	}
	return strings.TrimSpace(string(data)) == "provider"
}

// RecordSetupDone drops the legacy `route` mark and writes the `setup-done` mark.
func RecordSetupDone(stateRoot string) {
	layout := domain.NewStateLayout(stateRoot)
	_ = os.Remove(layout.LegacyRouteMark)
	_ = os.WriteFile(layout.SetupDone, []byte("true\n"), 0o600)
}

// ClearSetupDone removes the `setup-done` mark and the legacy route mark.
func ClearSetupDone(stateRoot string) {
	layout := domain.NewStateLayout(stateRoot)
	_ = os.Remove(layout.SetupDone)
	_ = os.Remove(layout.LegacyRouteMark)
}

// AgentsDir is where the agents sit beside the dist bundle: `<plugin>/agents` above
// `<plugin>/dist/<name>.js`.
func AgentsDir(bundlePath string) string {
	return filepath.Join(filepath.Dir(bundlePath), "..", "agents")
}

// modelLineFor is the `model:` line one tier gets for the choice.
func modelLineFor(tier domain.ModelTier, provider domain.Provider, models AgentModels, env domain.EnvLookup) string {
	if models == AgentModelsProvider {
		return domain.ResolveProvider(provider, env).Catalog[tier].ID
	}
	return shippedModel
}

// ApplyAgentModels rewrites each agent's first `model:` line for the choice; the result lists what
// was applied.
func ApplyAgentModels(ctx context.Context, bundlePath string, provider domain.Provider, models AgentModels, env domain.EnvLookup) AgentsResult {
	applied := make([]AgentModel, 0, len(routeTiers))
	for _, tier := range routeTiers {
		agent := provider.Agents[tier]
		file := filepath.Join(AgentsDir(bundlePath), agent+".md")
		before, found, _ := adapters.ReadModelLine(file)
		model := modelLineFor(tier, provider, models, env)
		changed, err := adapters.WriteModelLine(ctx, file, &model)
		if err != nil {
			return AgentsResult{Error: err.Error()}
		}
		applied = append(applied, AgentModel{
			Tier:    string(tier),
			Agent:   agent,
			Model:   model,
			Changed: changed,
			Before:  nil,
		})
		if found {
			applied[len(applied)-1].Before = &before
		}
	}
	return AgentsResult{OK: true, Value: applied}
}

// RestoreAgentModels puts each agent's `model:` line back: the two tier agents and the engine
// wrapper agents `--engine-enable` rewrote, each the value the ledger recorded before setup first
// changed it, untouched when setup never changed it, or the shipped default when there is no ledger
// at all.
func RestoreAgentModels(ctx context.Context, bundlePath string, provider domain.Provider, before *router.LedgerAgents, hasLedger bool) AgentsResult {
	// With no ledger there is no record, so every agent falls back to the shipped default.
	var recorded *router.LedgerAgents
	if hasLedger {
		if before != nil {
			recorded = before
		} else {
			recorded = router.NewLedgerAgents()
		}
	}
	agents := make([]struct{ tier, agent string }, 0, len(routeTiers)+len(domain.ENGINE_TOOLS))
	for _, tier := range routeTiers {
		agents = append(agents, struct{ tier, agent string }{string(tier), provider.Agents[tier]})
	}
	for _, tool := range domain.ENGINE_TOOLS {
		agents = append(agents, struct{ tier, agent string }{string(tool), string(tool)})
	}
	restored := make([]AgentModel, 0, len(agents))
	for _, one := range agents {
		back, err := restoreAgent(ctx, bundlePath, one.agent, one.tier, recorded)
		if err != nil {
			return AgentsResult{Error: err.Error()}
		}
		restored = append(restored, back)
	}
	return AgentsResult{OK: true, Value: restored}
}

// restoreAgent is one agent back: the recorded value, as it is when nothing was recorded, the
// shipped default without a ledger.
func restoreAgent(ctx context.Context, bundlePath, agent, tier string, before *router.LedgerAgents) (AgentModel, error) {
	file := filepath.Join(AgentsDir(bundlePath), agent+".md")
	current, found, read := adapters.ReadModelLine(file)
	if !read {
		return AgentModel{}, fmt.Errorf("%s: not found", file)
	}
	if before != nil && !before.Has(agent) {
		model := "(none)"
		if found {
			model = current
		}
		return AgentModel{Tier: tier, Agent: agent, Model: model, Changed: false}, nil
	}
	sonnet := shippedModel
	var model *string
	if before == nil {
		model = &sonnet
	} else {
		model, _ = before.Get(agent)
	}
	changed, err := adapters.WriteModelLine(ctx, file, model)
	if err != nil {
		return AgentModel{}, err
	}
	named := "(none)"
	if model != nil {
		named = *model
	}
	return AgentModel{Tier: tier, Agent: agent, Model: named, Changed: changed}, nil
}

// RestoredAgentText is the remove report's `models` line: where the agents' models came from, and
// what each agent now runs.
func RestoredAgentText(applied RoutingApplied) string {
	if !applied.Agents.OK {
		return "FAILED: " + applied.Agents.Error
	}
	each := make([]string, 0, len(applied.Agents.Value))
	for _, one := range applied.Agents.Value {
		each = append(each, one.Agent+": "+one.Model)
	}
	joined := strings.Join(each, ", ")
	if applied.Restored == AgentSourceDefault {
		return "set to the shipped default (" + joined + ")"
	}
	return "restored to their models before setup (" + joined + ")"
}

// recordAgentsBefore records, in the ledger, each agent's model before setup first changed it: a
// later run (a plugin update resets the files) never overwrites that first record.
func recordAgentsBefore(ctx context.Context, deps SetupDeps, applied AgentsResult) {
	if !applied.OK {
		return
	}
	path := domain.NewStateLayout(deps.StateRoot).Ledger
	ledger, ok := router.ReadLedger(ctx, path)
	if !ok {
		return
	}
	if ledger.Agents == nil {
		ledger.Agents = router.NewLedgerAgents()
	}
	added := false
	for _, one := range applied.Value {
		if !one.Changed || ledger.Agents.Has(one.Agent) {
			continue
		}
		ledger.Agents.Set(one.Agent, one.Before)
		added = true
	}
	if !added {
		return
	}
	// Without the record, remove falls back to leaving these agents as they are.
	_ = router.WriteLedger(ctx, path, ledger)
}

// RecordEngineAgentBefore records, in the ledger, an engine wrapper agent's `model:` line before
// `--engine-enable` first changes it, the way the tier agents' first change is recorded, so remove
// can put it back.
func RecordEngineAgentBefore(ctx context.Context, stateRoot string, agent domain.EngineTool, changed bool, before *string) {
	if !changed {
		return
	}
	path := domain.NewStateLayout(stateRoot).Ledger
	ledger, ok := router.ReadLedger(ctx, path)
	if !ok {
		return
	}
	if ledger.Agents.Has(string(agent)) {
		return
	}
	if ledger.Agents == nil {
		ledger.Agents = router.NewLedgerAgents()
	}
	ledger.Agents.Set(string(agent), before)
	// Without the record, remove falls back to leaving these agents as they are.
	_ = router.WriteLedger(ctx, path, ledger)
}

// AgentText is the `models` report line, one entry per tier: the model alone when the agent named
// after it runs it, else `agent → model` (on Sonnet, or an env override's id), or the failure.
func AgentText(applied AgentsResult) string {
	if !applied.OK {
		return "FAILED: " + applied.Error
	}
	each := make([]string, 0, len(applied.Value))
	for _, one := range applied.Value {
		if one.Agent == one.Model {
			each = append(each, one.Model)
		} else {
			each = append(each, one.Agent+" → "+one.Model)
		}
	}
	return strings.Join(each, ", ")
}

// RouterUp is whether this plugin's router answers its health path with its own name (any other
// 200 is someone else).
func RouterUp(ctx context.Context, provider domain.Provider, env domain.EnvLookup) bool {
	callCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(callCtx, http.MethodGet,
		domain.RouterBaseURL(provider, env)+provider.Router.HealthPath, nil)
	if err != nil {
		return false
	}
	answer, err := http.DefaultClient.Do(request)
	if err != nil {
		return false
	}
	body, readErr := io.ReadAll(answer.Body)
	closeErr := answer.Body.Close()
	if readErr != nil || closeErr != nil {
		return false
	}
	if answer.StatusCode < 200 || answer.StatusCode >= 300 {
		return false
	}
	_, ours := router.OurHealth(string(body), provider.Name, provider.Display)
	return ours
}

// BaseUrlReport is what ANTHROPIC_BASE_URL points at: ok only when it is this plugin's router; the
// text names the fix setup applies itself, never a line to export.
func BaseUrlReport(provider domain.Provider, env domain.EnvLookup) (bool, string) {
	expected := domain.RouterBaseURL(provider, env)
	actual, has := env["ANTHROPIC_BASE_URL"]
	if has && actual == expected {
		return true, "points at the " + provider.Name + " router (" + expected + ")"
	}
	fix := "run " + provider.Slash + "setup to point Claude Code at the " + provider.Name + " router"
	other := ""
	if has {
		other = domain.PluginRouters[domain.PortOf(actual)]
	}
	if other != "" {
		return false, "points at the " + other + " plugin's router; " + fix
	}
	return false, "unset or elsewhere; " + fix
}

// SetupDeps is the slice `setup`, `setup --remove` and their hook need; the CLI maps it out of
// Deps, tests build it directly.
type SetupDeps struct {
	Provider   domain.Provider
	Env        domain.EnvLookup
	StateRoot  string
	BundlePath string
	Out        ports.Output
	// SettingsPath is the Claude Code settings file the merge owns its own entries in.
	SettingsPath string
	// EngineConfig is the delegation engines' config (the state root's engines.json): remove
	// disables what engine setup enabled.
	EngineConfig ports.EngineConfigStore
	LoadKey      func(ctx context.Context) (ports.ProviderKey, error)
	EnsureRouter func(ctx context.Context) (string, error)
	// StartWatchdog starts the session watchdog once the router is up (the SessionStart hook's
	// own); nil: none.
	StartWatchdog func(ctx context.Context, sessionPid int64)
	RetireRouter  func(ctx context.Context) (string, error)
	// RouterKey is the running router's own view of the key: its source, or why it cannot read one.
	RouterKey func(ctx context.Context) (string, error)
}

// NewSetupDeps maps the setup wiring's slice out of Deps.
func NewSetupDeps(deps app.Deps) SetupDeps {
	return SetupDeps{
		Provider:      deps.Provider,
		Env:           domain.EnvLookup(deps.Env),
		StateRoot:     deps.Host.StateRoot,
		BundlePath:    deps.BundlePath,
		Out:           deps.Out,
		SettingsPath:  adapters.ClaudeSettingsPath(domain.EnvLookup(deps.Env)),
		EngineConfig:  deps.EngineConfig,
		LoadKey:       deps.Host.LoadKey,
		EnsureRouter:  deps.Host.EnsureRouter,
		StartWatchdog: deps.Host.StartWatchdog,
		RetireRouter:  deps.Host.RetireRouter,
		RouterKey:     deps.Host.RouterKey,
	}
}

// RoutingApplied is what one wiring pass did: where the router runs (or why it does not), what
// changed in settings, which agents were rewritten.
type RoutingApplied struct {
	Router   app.StringResult
	Settings LinesResult
	Agents   AgentsResult
	// Restored is, on remove, where the agents' models came from.
	Restored AgentSource
}

// liveOthers is the live plugin routers other than this one, as base URLs.
func liveOthers(ctx context.Context, deps SetupDeps) []string {
	entries := router.LiveRouters(ctx, deps.Env, deps.Provider.Name, nil)
	urls := make([]string, 0, len(entries))
	for _, entry := range entries {
		urls = append(urls, fmt.Sprintf("http://127.0.0.1:%d", entry.Port))
	}
	return urls
}

// routesProvider is where Claude Code's settings point now, and whether that is a router of ours
// that will route the provider's ids: the proxy keys naming this router (when it is up) or
// another live plugin router (which forwards them here), or — base-URL mode, beside a proxy of
// the user's own — the base URL on this router or another live one.
func routesProvider(deps SetupDeps, routerOk bool, live []string) bool {
	settings, ok := adapters.ReadProxySettings(deps.SettingsPath)
	if ok && settings.HTTPSProxy != nil {
		port := proxyPortOf(*settings.HTTPSProxy)
		if port == domain.PortOf(domain.RouterBaseURL(deps.Provider, deps.Env)) {
			return routerOk
		}
		for _, url := range live {
			if domain.PortOf(url) == port {
				return true
			}
		}
	}
	current, ok := adapters.ReadBaseUrl(deps.SettingsPath)
	if !ok {
		return false
	}
	if current == domain.RouterBaseURL(deps.Provider, deps.Env) && routerOk {
		return true
	}
	return slices.Contains(live, current)
}

// proxyPortOf is the port a proxy variable's value names, a missing scheme added the way a proxy
// URL is read; -1 when it names none.
func proxyPortOf(raw string) int64 {
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	return domain.PortOf(raw)
}

// installedMarker is `${CLAUDE_PLUGIN_DATA}/installed` when the data dir is this plugin's own.
// It is the one deliberate data-dir read: the state root itself is $<P>_STATE_DIR or ~/.agents for
// every caller (ResolveStateRoot), but the marker must sit where Claude Code deletes it on
// uninstall, which is how the router tells an uninstall from an update.
func installedMarker(deps SetupDeps) *string {
	data, has := deps.Env["CLAUDE_PLUGIN_DATA"]
	if !has || data == "" || !strings.HasPrefix(filepath.Base(data), deps.Provider.Name+"-") {
		return nil
	}
	marker := filepath.Join(data, adapters.UninstallMarkerName)
	if err := os.MkdirAll(data, 0o700); err != nil {
		return nil
	}
	if _, err := os.Stat(marker); err != nil {
		if err := os.WriteFile(marker, []byte("installed by setup\n"), 0o600); err != nil {
			return nil
		}
	}
	return &marker
}

// recordLedger folds what this run changed into the ledger, so the router can undo exactly that on
// uninstall.
func recordLedger(ctx context.Context, deps SetupDeps, delta *adapters.SettingsDelta, storedKey bool) {
	layout := domain.NewStateLayout(deps.StateRoot)
	previous, hadPrevious := router.ReadLedger(ctx, layout.Ledger)
	if !hadPrevious {
		previous, hadPrevious = router.ReadLedger(ctx, layout.DisabledLedger)
	}
	var previousUndo *adapters.SettingsUndo
	previousCreated := false
	if hadPrevious {
		undo := previous.Settings
		previousUndo = &undo
		previousCreated = previous.Keystore.Created
	}
	ledger := router.Ledger{
		Version:      1,
		Plugin:       deps.Provider.Name,
		RouterURL:    domain.RouterBaseURL(deps.Provider, deps.Env),
		SettingsPath: deps.SettingsPath,
		Settings:     router.MergeSettingsUndo(previousUndo, delta),
		Keystore:     router.LedgerKeystore{Created: previousCreated || storedKey},
		RouterFiles:  []string{layout.RouterDir},
	}
	if hadPrevious {
		ledger.LegacyRemoved = previous.LegacyRemoved
		ledger.Marker = previous.Marker
		ledger.Agents = previous.Agents
	}
	if marker := installedMarker(deps); marker != nil {
		ledger.Marker = marker
	}
	agentsDir := AgentsDir(deps.BundlePath)
	ledger.AgentsDir = &agentsDir
	ledger.StateRoot = deps.StateRoot
	if err := os.MkdirAll(deps.StateRoot, 0o700); err != nil {
		return
	}
	if err := router.WriteLedger(ctx, layout.Ledger, ledger); err != nil {
		// Without a ledger the router has nothing to undo on uninstall; setup itself still worked.
		return
	}
	router.RemoveLedger(layout.DisabledLedger)
}

// mergeSettings merges the settings under the shared lock, the ledger updated with exactly what
// changed.
func mergeSettings(ctx context.Context, deps SetupDeps, live []string) LinesResult {
	var delta *adapters.SettingsDelta
	// What earlier runs own in /model, so this run can bring those rows up to what setup writes
	// today.
	layout := domain.NewStateLayout(deps.StateRoot)
	previous, hadPrevious := router.ReadLedger(ctx, layout.Ledger)
	if !hadPrevious {
		previous, hadPrevious = router.ReadLedger(ctx, layout.DisabledLedger)
	}
	options := adapters.ApplyProviderOptions{
		LivePluginURLs: live,
		CADir:          layout.CA,
		EnvProxy:       ownProxyInEnv(deps.Env),
		Record: func(recorded adapters.SettingsDelta) {
			delta = &recorded
		},
	}
	if hadPrevious {
		options.OwnOptions = previous.Settings.OptionsAdded
	}
	lines, err := adapters.ApplyProviderSettings(ctx, deps.SettingsPath, deps.Provider,
		domain.RouterBaseURL(deps.Provider, deps.Env), options)
	if err != nil {
		return LinesResult{Error: err.Error()}
	}
	recordLedger(ctx, deps, delta, keyInStore(ctx, deps))
	return LinesResult{OK: true, Value: lines}
}

// ownProxyInEnv is the proxy variable this process's own environment applies, lowercase before
// uppercase the way Claude Code reads them: a user who exported their own proxy keeps base-URL
// mode even where the settings carry none of it. A value naming a plugin router is ours.
func ownProxyInEnv(env domain.EnvLookup) *string {
	for _, name := range []string{"https_proxy", "HTTPS_PROXY"} {
		value, ok := env[name]
		if !ok || value == "" {
			continue
		}
		if domain.IsPluginRouterProxy(value) {
			return nil
		}
		return &value
	}
	return nil
}

// keyInStore is whether the key comes from this plugin's own entry in the OS store: only setup's
// key page and its move from the key file write there, so the router may delete it when the plugin
// is uninstalled.
func keyInStore(ctx context.Context, deps SetupDeps) bool {
	store := keystore.PlatformKeyStore(deps.Provider, deps.Env, keystore.PlatformOptions{})
	if store == nil {
		return false
	}
	key, err := deps.LoadKey(ctx)
	return err == nil && key.Source == store.Label()
}

// withRouterKey is the router line, told whether the router itself can read the key: setup must not
// say ready when it cannot.
func withRouterKey(ctx context.Context, deps SetupDeps, started app.StringResult) app.StringResult {
	if !started.OK {
		return started
	}
	_, err := deps.RouterKey(ctx)
	if err == nil {
		return started
	}
	message := fmt.Sprintf(
		"%s, but it cannot read the %s key (%s): %s models are not ready; put the key where setup finds it (%s in the environment Claude Code starts from, or %s)",
		started.Value, deps.Provider.Display, err.Error(), deps.Provider.Display,
		strings.Join(deps.Provider.KeyEnv, " or "), deps.Provider.KeyFile)
	return app.StringResult{Error: message}
}

// ApplyRouting is `setup`'s wiring, in order: router, registry, settings merge (and ledger),
// agents, the setupDone mark. The agents name the provider's ids only when Claude Code's settings
// point at a router of ours that can route them.
func ApplyRouting(ctx context.Context, deps SetupDeps) RoutingApplied {
	startedLine, startedErr := deps.EnsureRouter(ctx)
	if startedErr == nil {
		// The router announces itself when it starts; setup's copy only covers the
		// installed-but-not-running case.
		_ = router.SaveRegistryEntry(ctx, deps.Env, router.RegistryEntryFor(deps.Provider, deps.Env, nil))
	}
	live := liveOthers(ctx, deps)
	settings := mergeSettings(ctx, deps, live)
	started := withRouterKey(ctx, deps, stringResult(startedLine, startedErr))
	models := AgentModelsSonnet
	if started.OK && routesProvider(deps, startedErr == nil, live) {
		models = AgentModelsProvider
	}
	agents := ApplyAgentModels(ctx, deps.BundlePath, deps.Provider, models, deps.Env)
	recordAgentsBefore(ctx, deps, agents)
	if startedErr == nil && agents.OK {
		RecordSetupDone(deps.StateRoot)
	}
	return RoutingApplied{Router: started, Settings: settings, Agents: agents}
}

// RemoveRouting is `setup --remove`: the agents back on their models before setup, this plugin's
// entries out of settings and the registry, the router retired (it keeps serving the Claude Code
// sessions already open, which hold its URL until they exit), the ledger gone (nothing is left for
// the router to undo).
func RemoveRouting(ctx context.Context, deps SetupDeps) RoutingApplied {
	layout := domain.NewStateLayout(deps.StateRoot)
	others := liveOthers(ctx, deps)
	// With a ledger, setup's own record is undone, so settings.json ends as it was before setup
	// (byte for byte when nothing else changed it); without one (an install set up before setup
	// kept a ledger), this provider's entries are taken out.
	ledger, hasLedger := router.ReadLedger(ctx, layout.Ledger)
	if !hasLedger {
		ledger, hasLedger = router.ReadLedger(ctx, layout.DisabledLedger)
	}
	var settings LinesResult
	if hasLedger && ledger.SettingsPath == deps.SettingsPath {
		settings = linesResult(adapters.UndoProviderSettings(ctx, deps.SettingsPath, deps.Provider.Name,
			ledger.Settings, ledger.RouterURL, others))
	} else {
		lines, err := adapters.RemoveProviderSettings(ctx, deps.SettingsPath, deps.Provider,
			domain.RouterBaseURL(deps.Provider, deps.Env), others)
		settings = linesResult(lines, err)
	}
	var ledgerAgents *router.LedgerAgents
	if hasLedger {
		ledgerAgents = ledger.Agents
	}
	agents := RestoreAgentModels(ctx, deps.BundlePath, deps.Provider, ledgerAgents, hasLedger)
	// Engine setup is undone too: the wrapper agents above, and the recorded engines disabled, so
	// the setup menu reports them not enabled.
	engines := deps.EngineConfig.Read()
	if len(engines.Engines) > 0 {
		deps.EngineConfig.Write(domain.EngineConfig{Engines: map[domain.EngineTool]domain.EngineSetting{}, DefaultEngine: engines.DefaultEngine})
	}
	retiredLine, retireErr := deps.RetireRouter(ctx)
	ClearSetupDone(deps.StateRoot)
	router.RemoveRegistryEntry(deps.Env, deps.Provider.Name)
	router.RemoveLedger(layout.Ledger)
	router.RemoveLedger(layout.DisabledLedger)
	restored := AgentSourceDefault
	if hasLedger {
		restored = AgentSourceLedger
	}
	return RoutingApplied{
		Router:   stringResult(retiredLine, retireErr),
		Settings: settings,
		Agents:   agents,
		Restored: restored,
	}
}

// UserMessage is a hook's message for the user: Claude Code shows a `systemMessage` to the user and
// keeps it out of Claude's context, where a warning would only be noise Claude may or may not pass
// on.
func UserMessage(out ports.Output, text string) {
	data, _ := domain.MarshalCompactJSON(struct {
		SystemMessage string `json:"systemMessage"`
	}{text})
	// As invocation.JSON: the marshaler's trailing newline is trimmed; the output port adds it.
	out.Line(strings.TrimSuffix(string(data), "\n"))
}

// RoutingHook is the SessionStart hook: brings the router up first (every Claude request depends
// on it), starts the session watchdog that keeps it answering for the whole session, then
// re-applies the wiring a plugin update undid (agents rewritten, settings reshaped), silently: a
// repair is nobody's business. It never pings the provider. A plugin re-enabled after the router
// cleaned up for its disable is set up again. Once set up, the agents always name the provider's
// models: a router that cannot start or a missing key is said to the user, never papered over by
// moving the agents to Sonnet.
func RoutingHook(ctx context.Context, deps SetupDeps) ExitCode {
	if !ReadSetupDone(deps.StateRoot) {
		return reEnable(ctx, deps)
	}
	if _, err := deps.EnsureRouter(ctx); err != nil {
		return hookFallback(ctx, deps, fmt.Sprintf(
			"the %s router could not start, so the %s agents cannot reach %s this session. Run %ssetup to see why.",
			deps.Provider.Name, deps.Provider.Name, deps.Provider.Display, deps.Provider.Slash), nil, true)
	}
	startWatchdog(ctx, deps)
	live := liveOthers(ctx, deps)
	settings := mergeSettings(ctx, deps, live)
	var repaired []string
	if settings.OK {
		for _, line := range settings.Value {
			if !strings.HasPrefix(line, domain.KeptPrefix) {
				repaired = append(repaired, line)
			}
		}
	}
	if _, err := deps.LoadKey(ctx); err != nil {
		return hookFallback(ctx, deps, fmt.Sprintf(
			"no %s key found, so the %s agents cannot reach %s. Run %ssetup to enter it.",
			deps.Provider.Display, deps.Provider.Name, deps.Provider.Display, deps.Provider.Slash), repaired, false)
	}
	recordAgentsBefore(ctx, deps, ApplyAgentModels(ctx, deps.BundlePath, deps.Provider, AgentModelsProvider, deps.Env))
	return ExitOK
}

// reEnable is a plugin the router cleaned up after its disable, enabled again: set up again, said
// in one line to the user.
func reEnable(ctx context.Context, deps SetupDeps) ExitCode {
	if _, ok := router.ReadLedger(ctx, domain.NewStateLayout(deps.StateRoot).DisabledLedger); !ok {
		return ExitOK
	}
	applied := ApplyRouting(ctx, deps)
	name, slash := deps.Provider.Name, deps.Provider.Slash
	if applied.Router.OK {
		startWatchdog(ctx, deps)
		UserMessage(deps.Out, name+": enabled again and set up again; restart Claude Code to route through the "+name+" router.")
	} else {
		UserMessage(deps.Out, name+": enabled again, but the "+name+" router could not start; run "+slash+"setup to see why.")
	}
	return ExitOK
}

// startWatchdog starts the session watchdog for the Claude Code process this hook serves: the
// nearest ancestor that is not a shell or the launcher (router.SessionPid's walk). A missing
// watchdog or an unidentifiable session (pid 0) starts nothing; the hooks remain the recovery.
func startWatchdog(ctx context.Context, deps SetupDeps) {
	if deps.StartWatchdog == nil {
		return
	}
	deps.StartWatchdog(ctx, router.SessionPid(ctx))
}

// hookFallback is the router being down or the key missing: the agents keep the provider's models
// (asking for GLM gets GLM or an honest failure, never Sonnet in its place). With the router down,
// the settings come off it — the proxy keys, or the base URL a fallback mode kept — onto another
// live plugin router when there is one, so Claude itself keeps working. A missing key leaves the
// router and the settings alone: Claude traffic does not need the key. The user hears why at every
// session start until it is fixed. The repaired lines parameter is kept for the signature and unused.
func hookFallback(ctx context.Context, deps SetupDeps, message string, repaired []string, routerDown bool) ExitCode {
	recordAgentsBefore(ctx, deps, ApplyAgentModels(ctx, deps.BundlePath, deps.Provider, AgentModelsProvider, deps.Env))
	if routerDown {
		others := liveOthers(ctx, deps)
		lines, err := adapters.ClearProxy(ctx, deps.SettingsPath,
			domain.RouterBaseURL(deps.Provider, deps.Env), others, deps.Provider.Name)
		if err != nil || len(lines) == 0 {
			// Base-URL mode beside a proxy of the user's own: the base URL is the one on the dead router.
			_, _ = adapters.ClearBaseUrl(ctx, deps.SettingsPath,
				domain.RouterBaseURL(deps.Provider, deps.Env), others, deps.Provider.Name)
		}
	}
	UserMessage(deps.Out, deps.Provider.Name+": "+message)
	return ExitOK
}
