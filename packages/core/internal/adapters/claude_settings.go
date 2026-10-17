// The Claude Code settings merge: `setup` puts the provider's models in `/model` and routes
// Claude Code through the plugin's router — proxy mode where it can (the three proxy keys at the
// router and its local CA, so Remote Control keeps working), base-URL mode as the fallback —
// owning exactly the entries whose `model` is in its catalog so `setup --remove`
// (and the router's own uninstall cleanup) can take those back out. Everything else in the file survives. Every write
// is careful: only a missing file counts as empty (any other read error writes nothing), the first write ever keeps a
// `settings.json.<name>-backup`, the result must survive a JSON round trip, the file's mode and a symlink are kept,
// writers on this machine take turns through a lock, and a file that changed on disk while it was being edited is
// re-read and redone once, else left alone.
package adapters

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/localca"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// ClaudeConfigDir is Claude Code's config dir: $CLAUDE_CONFIG_DIR (an empty one counts as unset),
// else ~/.claude.
func ClaudeConfigDir(env domain.EnvLookup) string {
	if dir, ok := env["CLAUDE_CONFIG_DIR"]; ok && dir != "" {
		return dir
	}
	return filepath.Join(homeDir(env), ".claude")
}

// ClaudeSettingsPath is the settings file Claude Code reads, in its config dir.
func ClaudeSettingsPath(env domain.EnvLookup) string {
	return filepath.Join(ClaudeConfigDir(env), "settings.json")
}

// SettingsDelta is what one ApplyProviderSettings changed, for the uninstall ledger: enough to
// put back exactly what was there.
type SettingsDelta struct {
	// BaseURLBefore is the base URL before a run that changed it; nil when there was none or the
	// run left the base URL alone.
	BaseURLBefore *string `json:"baseUrlBefore,omitempty"`
	// ProxyBefore, CABefore and NoProxyBefore are the proxy-mode values before a run that changed
	// them; nil when there was none or the run left the keys alone.
	ProxyBefore       *string  `json:"proxyBefore,omitempty"`
	CABefore          *string  `json:"caBefore,omitempty"`
	NoProxyBefore     *string  `json:"noProxyBefore,omitempty"`
	OptionsAdded      []string `json:"optionsAdded"`
	AvailableAppended []string `json:"availableAppended"`
	// Containers this run created, removed again when they end up empty.
	CreatedModelPicker bool `json:"createdModelPicker"`
	CreatedOptions     bool `json:"createdOptions"`
	CreatedEnv         bool `json:"createdEnv"`
	CreatedProxy       bool `json:"createdProxy"`
	CreatedToolSearch  bool `json:"createdToolSearch"`
	// EffortsAdded are the catalog ids whose modelSettings effort level this run set, with the
	// value written, in catalog order.
	EffortsAdded *StringMap `json:"effortsAdded"`
}

// ApplyProviderOptions are the options of ApplyProviderSettings.
type ApplyProviderOptions struct {
	// LivePluginURLs are the plugin router URLs answering health checks now.
	LivePluginURLs []string
	// CADir is the local CA's directory; proxy mode needs it to name the CA file. Empty, or a
	// directory the CA cannot be loaded from, keeps base-URL mode.
	CADir string
	// EnvProxy is the proxy variable the caller's own process environment applies, lowercase
	// before uppercase the way Claude Code reads them; nil when there is none. A value that is
	// not a plugin router is the user's own proxy and keeps base-URL mode.
	EnvProxy *string
	// OwnOptions are the ids the ledger says earlier runs added to /model: their rows are
	// setup's, however they look now, so an upgrade brings them up to what setup writes today
	// (their behavesAs).
	OwnOptions []string
	// Record runs on every edit pass, changed or not, and receives only what changed.
	Record func(SettingsDelta)
}

// ApplyProviderSettings merges one modelPicker.options entry per catalog model, appends the ids
// to availableModels only when that list already exists, and routes Claude Code per the plan:
// proxy mode (the three proxy keys at the router and its CA) when it can be had, base-URL mode
// otherwise. Idempotent: a second run changes nothing. Returns the report lines, or an error and
// writes nothing when the file is unparsable or a touched key has the wrong type. Record gets
// what changed (only when something did).
func ApplyProviderSettings(ctx context.Context, path string, provider domain.Provider, routerURL string, options ApplyProviderOptions) ([]string, error) {
	caPath, caNote := proxyCAPath(ctx, options.CADir)
	return editSettings(ctx, path, provider.Name, func(root *jsonNode) ([]string, error) {
		return applyProviderEdit(root, path, provider, routerURL, options, caPath, caNote)
	}, false)
}

// proxyCAPath loads the local CA the proxy keys name; the returned note (nil when proxy mode is
// on) says why base-URL mode took over.
func proxyCAPath(ctx context.Context, dir string) (string, *string) {
	if dir == "" {
		return "", nil
	}
	ca, err := localca.LoadOrCreate(ctx, dir, time.Now())
	if err != nil {
		note := fmt.Sprintf("the local CA is unusable (%s): routing keeps ANTHROPIC_BASE_URL", err)
		return "", &note
	}
	return ca.CertPath(), nil
}

func applyProviderEdit(root *jsonNode, path string, provider domain.Provider, routerURL string, options ApplyProviderOptions, caPath string, caNote *string) ([]string, error) {
	createdModelPicker := root.get("modelPicker") == nil
	picker, err := ensureObject(root, "modelPicker", path)
	if err != nil {
		return nil, err
	}
	createdOptions := picker.get("options") == nil
	modelOptions, err := ensureArray(picker, "options", path+": modelPicker.options")
	if err != nil {
		return nil, err
	}
	before := knownModels(modelOptions)
	available, err := appendAvailableModels(root, provider, path)
	if err != nil {
		return nil, err
	}
	createdEnv := root.get("env") == nil
	baseURLBefore, err := currentBaseUrl(root, path)
	if err != nil {
		return nil, err
	}
	toolSearchBefore, err := currentToolSearch(root, path)
	if err != nil {
		return nil, err
	}
	efforts, err := applyEfforts(root, provider, path)
	if err != nil {
		return nil, err
	}
	created := createdContainers{modelPicker: createdModelPicker, options: createdOptions, env: createdEnv}
	// Proxy mode when the CA is usable and nothing of the user's own stands in the way; the
	// fallbacks below keep base-URL mode, each saying why in the plan's own report.
	var proxyNote *string
	if caPath != "" && !userProxyInEnv(options.EnvProxy) {
		proxyBefore, err := currentProxySettings(root, path)
		if err != nil {
			return nil, err
		}
		plan := domain.PlanProxy(proxyBefore, routerURL, caPath, options.LivePluginURLs)
		if plan.Kind != domain.ProxyPlanBaseURL && !userBaseURL(baseURLBefore) {
			// "Routing through a router of ours" is a fresh set, or keys kept naming this router
			// or another live one (which forwards here).
			routed := proxyRouted(plan, proxyBefore, routerURL, options.LivePluginURLs)
			var lines []string
			lines = append(lines, mergeModelOptions(modelOptions, provider, options.OwnOptions)...)
			lines = append(lines, efforts.lines...)
			lines = append(lines, available.lines...)
			lines = append(lines, applyProxy(root, plan, path)...)
			lines = append(lines, applyToolSearch(root, routed, toolSearchBefore, path)...)
			if options.Record != nil {
				options.Record(recordedProxyDelta(plan, proxyBefore, before, provider, available.appended,
					created, routed, toolSearchBefore, efforts.added))
			}
			return lines, nil
		}
		if plan.Kind == domain.ProxyPlanBaseURL {
			proxyNote = plan.Report
		}
	}
	plan := domain.PlanBaseUrl(baseURLBefore, routerURL, options.LivePluginURLs)
	// "Routing through this router" is a fresh set, a move from a dead plugin router — or the
	// base URL an earlier run already pointed here.
	routed := routedThrough(plan, baseURLBefore, routerURL)
	var lines []string
	if caNote != nil {
		lines = append(lines, *caNote)
	}
	if proxyNote != nil {
		lines = append(lines, *proxyNote)
	}
	lines = append(lines, mergeModelOptions(modelOptions, provider, options.OwnOptions)...)
	lines = append(lines, efforts.lines...)
	lines = append(lines, available.lines...)
	lines = append(lines, applyBaseUrl(root, plan, path)...)
	lines = append(lines, applyToolSearch(root, routed, toolSearchBefore, path)...)
	if options.Record != nil {
		options.Record(recordedDelta(plan, baseURLBefore, before, provider, available.appended, created,
			routed, toolSearchBefore, efforts.added))
	}
	return lines, nil
}

// userProxyInEnv is whether the caller's own environment applies a proxy that is not a plugin
// router's: the user exported their own proxy, and Claude Code reads it before anything the
// settings could add.
func userProxyInEnv(envProxy *string) bool {
	return envProxy != nil && !domain.IsPluginRouterProxy(*envProxy)
}

// userBaseURL is whether the settings point Claude at a base URL that is not one of the plugin
// routers: the user's own gateway. Proxy mode would put every one of their requests on our
// router, so it stays off until the base URL goes.
func userBaseURL(baseURL *string) bool {
	return baseURL != nil && !domain.IsPluginRouterURL(*baseURL)
}

// proxyRouted is true when the settings end up routing Claude Code through a router of ours that
// can route the provider's ids: the proxy keys freshly set on this router, or kept naming this
// router or another live one (which forwards here).
func proxyRouted(plan domain.ProxyPlan, before domain.ProxySettings, routerURL string, live []string) bool {
	if plan.Kind == domain.ProxyPlanSet {
		return true
	}
	if plan.Kind != domain.ProxyPlanKeep || before.HTTPSProxy == nil {
		return false
	}
	name := domain.ProxyRouterName(*before.HTTPSProxy)
	ours := name != "" && name == domain.PluginRouters[domain.PortOf(routerURL)]
	return ours || domain.ProxyRouterIsLive(live, name)
}

// routedThrough is true when the settings end up routing Claude Code through this router: a fresh
// set, a move from a dead plugin router, or the base URL an earlier run already pointed here.
func routedThrough(plan domain.BaseUrlPlan, baseURLBefore *string, routerURL string) bool {
	return plan.Kind == domain.BaseUrlPlanSet || (baseURLBefore != nil && *baseURLBefore == routerURL)
}

// recordedDelta is the delta to record for the ledger: what this run set (with what was there
// before) and the containers it created.
func recordedDelta(plan domain.BaseUrlPlan, baseURLBefore *string, before map[string]bool, provider domain.Provider, appended []string, created createdContainers, routed bool, toolSearchBefore *string, efforts *StringMap) SettingsDelta {
	availableAppended := appended
	if availableAppended == nil {
		availableAppended = []string{}
	}
	delta := SettingsDelta{
		AvailableAppended:  availableAppended,
		CreatedModelPicker: created.modelPicker,
		CreatedOptions:     created.options,
		// The env container only counts as this run's when this run is the one that filled it.
		CreatedEnv:        created.env && plan.Kind == domain.BaseUrlPlanSet,
		CreatedToolSearch: toolSearchBefore == nil && routed,
		EffortsAdded:      efforts,
	}
	if plan.Kind == domain.BaseUrlPlanSet {
		delta.BaseURLBefore = baseURLBefore
	}
	delta.OptionsAdded = make([]string, 0, 2)
	for _, id := range catalogIDs(provider) {
		if !before[id] {
			delta.OptionsAdded = append(delta.OptionsAdded, id)
		}
	}
	return delta
}

type createdContainers struct {
	modelPicker bool
	options     bool
	env         bool
}

// recordedProxyDelta is the delta to record for the ledger in proxy mode: what this run set (with
// what was there before) and the containers it created. A keep that changed something (a NO_PROXY
// it appended to) records the before-values too: the undo puts the user's entries back.
func recordedProxyDelta(plan domain.ProxyPlan, before domain.ProxySettings, beforeModels map[string]bool, provider domain.Provider, appended []string, created createdContainers, routed bool, toolSearchBefore *string, efforts *StringMap) SettingsDelta {
	availableAppended := appended
	if availableAppended == nil {
		availableAppended = []string{}
	}
	delta := SettingsDelta{
		AvailableAppended:  availableAppended,
		CreatedModelPicker: created.modelPicker,
		CreatedOptions:     created.options,
		// The env container counts as this run's when this run is the one that filled it: the
		// proxy keys' undo and the tool-search undo each empty it when they take the last key.
		CreatedEnv:        created.env && plan.Kind == domain.ProxyPlanSet,
		CreatedProxy:      created.env && plan.Kind == domain.ProxyPlanSet,
		CreatedToolSearch: toolSearchBefore == nil && routed,
		EffortsAdded:      efforts,
	}
	if plan.Kind == domain.ProxyPlanSet || (plan.Kind == domain.ProxyPlanKeep && plan.Report != nil) {
		delta.ProxyBefore = before.HTTPSProxy
		delta.CABefore = before.CA
		delta.NoProxyBefore = before.NoProxy
	}
	delta.OptionsAdded = make([]string, 0, 2)
	for _, id := range catalogIDs(provider) {
		if !beforeModels[id] {
			delta.OptionsAdded = append(delta.OptionsAdded, id)
		}
	}
	return delta
}

// RemoveProviderSettings removes exactly the entries whose model is one of this provider's
// catalog ids (an emptied list stays an empty array) and clears the routing env per the plans:
// the proxy keys and the base URL naming this router go (each repointed at another live plugin
// router when there is any), anything else is not ours to touch.
func RemoveProviderSettings(ctx context.Context, path string, provider domain.Provider, routerURL string, othersRegistered []string) ([]string, error) {
	return editSettings(ctx, path, provider.Name, func(root *jsonNode) ([]string, error) {
		ids := catalogIDs(provider)
		entries, err := removeModelEntries(root, ids, path)
		if err != nil {
			return nil, err
		}
		available, err := removeAvailableModels(root, ids, path)
		if err != nil {
			return nil, err
		}
		proxy, err := currentProxySettings(root, path)
		if err != nil {
			return nil, err
		}
		var lines []string
		lines = append(lines, entries...)
		lines = append(lines, available...)
		// The base URL first, so the proxy plan's stale-base-URL removal finds nothing left to
		// report twice.
		lines = append(lines, applyBaseUrl(root, domain.PlanBaseUrlRemoval(proxy.BaseURL, routerURL, othersRegistered), path)...)
		lines = append(lines, applyProxy(root, domain.PlanProxyRemoval(proxy, routerURL, othersRegistered), path)...)
		return lines, nil
	}, false)
}

// ClearBaseUrl is the hook's half-measure: clear or repoint env.ANTHROPIC_BASE_URL only, leaving
// every model entry alone. The caller names the router; setups pass "provider-router".
func ClearBaseUrl(ctx context.Context, path string, routerURL string, othersRegistered []string, name string) ([]string, error) {
	return editSettings(ctx, path, name, func(root *jsonNode) ([]string, error) {
		current, err := currentBaseUrl(root, path)
		if err != nil {
			return nil, err
		}
		return applyBaseUrl(root, domain.PlanBaseUrlRemoval(current, routerURL, othersRegistered), path), nil
	}, false)
}

// ClearProxy is ClearBaseUrl for proxy mode: clear or repoint the three proxy keys only, leaving
// every model entry alone. The caller names the router; setups pass "provider-router".
func ClearProxy(ctx context.Context, path string, routerURL string, othersRegistered []string, name string) ([]string, error) {
	return editSettings(ctx, path, name, func(root *jsonNode) ([]string, error) {
		current, err := currentProxySettings(root, path)
		if err != nil {
			return nil, err
		}
		return applyProxy(root, domain.PlanProxyRemoval(current, routerURL, othersRegistered), path), nil
	}, false)
}

// ReadBaseUrl is the current env.ANTHROPIC_BASE_URL; ok is false when unset or the file cannot be
// read.
func ReadBaseUrl(path string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	root, err := parseJSON(string(data))
	if err != nil {
		return "", false
	}
	env := root.get("env")
	if !env.isObject() {
		return "", false
	}
	url, ok := env.get("ANTHROPIC_BASE_URL").text()
	return url, ok
}

// ReadProxySettings is the file's proxy-mode shape (the four env values the proxy plan decides
// on); ok is false when the file cannot be read or an env key has the wrong shape. Which of the
// values are set is the caller's question.
func ReadProxySettings(path string) (domain.ProxySettings, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return domain.ProxySettings{}, false
	}
	root, err := parseJSON(string(data))
	if err != nil {
		return domain.ProxySettings{}, false
	}
	settings, err := currentProxySettings(root, path)
	if err != nil {
		return domain.ProxySettings{}, false
	}
	return settings, true
}

// SettingsUndo is what setup changed, as the ledger recorded it (see SettingsDelta, merged across
// runs).
type SettingsUndo struct {
	BaseURLBefore      *string    `json:"baseUrlBefore,omitempty"`
	ProxyBefore        *string    `json:"proxyBefore,omitempty"`
	CABefore           *string    `json:"caBefore,omitempty"`
	NoProxyBefore      *string    `json:"noProxyBefore,omitempty"`
	OptionsAdded       []string   `json:"optionsAdded"`
	AvailableAppended  []string   `json:"availableAppended"`
	CreatedModelPicker bool       `json:"createdModelPicker"`
	CreatedOptions     bool       `json:"createdOptions"`
	CreatedEnv         bool       `json:"createdEnv"`
	CreatedProxy       bool       `json:"createdProxy"`
	CreatedToolSearch  bool       `json:"createdToolSearch"`
	EffortsAdded       *StringMap `json:"effortsAdded"`
}

// UndoProviderSettings is the uninstall's settings step: takes out the /model entries and
// availableModels ids setup added (an entry the user removed or changed meanwhile is theirs),
// removes the containers setup created when they end up empty, and puts the base URL back only if
// it still points at this router: the ledger's previous value (unless that is a plugin router
// that is not running), else another live plugin router, else none. When the result equals the
// backup taken before the first write ever, the backup's own bytes are restored.
func UndoProviderSettings(ctx context.Context, path string, name string, undo SettingsUndo, routerURL string, livePluginURLs []string) ([]string, error) {
	return editSettings(ctx, path, name, func(root *jsonNode) ([]string, error) {
		var lines []string
		lines = append(lines, undoPicker(root, undo)...)
		lines = append(lines, undoAvailable(root, undo)...)
		baseURL, err := undoBaseUrl(root, undo, routerURL, livePluginURLs, path)
		if err != nil {
			return nil, err
		}
		lines = append(lines, baseURL...)
		lines = append(lines, undoProxy(root, undo, routerURL, livePluginURLs)...)
		lines = append(lines, undoToolSearch(root, undo)...)
		lines = append(lines, undoEfforts(root, undo)...)
		return lines, nil
	}, true)
}

// undoPicker takes setup's /model entries out, and the containers it created once they are empty.
func undoPicker(root *jsonNode, undo SettingsUndo) []string {
	picker := root.get("modelPicker")
	if !picker.isObject() {
		return nil
	}
	var lines []string
	if options := picker.get("options"); options.isArray() {
		kept := make([]*jsonNode, 0, len(options.items))
		for _, entry := range options.items {
			if model, ok := entryModel(entry); ok && slices.Contains(undo.OptionsAdded, model) {
				continue
			}
			kept = append(kept, entry)
		}
		if len(kept) != len(options.items) {
			lines = append(lines, fmt.Sprintf("took %s out of /model", strings.Join(undo.OptionsAdded, " and ")))
		}
		picker.set("options", newArray(kept...))
		if undo.CreatedOptions && len(kept) == 0 {
			picker.del("options")
		}
	}
	if undo.CreatedModelPicker && picker.size() == 0 {
		root.del("modelPicker")
	}
	return lines
}

// undoAvailable takes the ids setup appended out of availableModels.
func undoAvailable(root *jsonNode, undo SettingsUndo) []string {
	available := root.get("availableModels")
	if !available.isArray() || len(undo.AvailableAppended) == 0 {
		return nil
	}
	kept := make([]*jsonNode, 0, len(available.items))
	for _, item := range available.items {
		if id, ok := item.text(); ok && slices.Contains(undo.AvailableAppended, id) {
			continue
		}
		kept = append(kept, item)
	}
	changed := len(kept) != len(available.items)
	root.set("availableModels", newArray(kept...))
	if changed {
		return []string{"took the appended ids out of availableModels"}
	}
	return nil
}

// undoBaseUrl puts the base URL back, only while it still points at this router (see
// UndoProviderSettings).
func undoBaseUrl(root *jsonNode, undo SettingsUndo, routerURL string, livePluginURLs []string, path string) ([]string, error) {
	current, err := currentBaseUrl(root, path)
	if err != nil {
		return nil, err
	}
	if current == nil || *current != routerURL {
		return nil, nil
	}
	restore := ""
	if undo.BaseURLBefore != nil && (!domain.IsPluginRouterURL(*undo.BaseURLBefore) || slices.Contains(livePluginURLs, *undo.BaseURLBefore)) {
		restore = *undo.BaseURLBefore
	} else {
		for _, url := range livePluginURLs {
			if url != routerURL {
				restore = url
				break
			}
		}
	}
	env := root.get("env")
	if restore != "" {
		env.set("ANTHROPIC_BASE_URL", newText(restore))
		return []string{fmt.Sprintf("set ANTHROPIC_BASE_URL back to %s", restore)}, nil
	}
	env.del("ANTHROPIC_BASE_URL")
	if undo.CreatedEnv && env.size() == 0 {
		root.del("env")
	}
	return []string{fmt.Sprintf("removed ANTHROPIC_BASE_URL (%s)", routerURL)}, nil
}

// undoProxy puts the proxy keys back while they are still ours: HTTPS_PROXY naming this router is
// the ownership test, and a proxy the user changed since takes its CA and NO_PROXY with it. The
// before-values go back; a key with nothing before it goes (see UndoProviderSettings), and an env
// this undo created and emptied goes with them.
func undoProxy(root *jsonNode, undo SettingsUndo, routerURL string, livePluginURLs []string) []string {
	env := root.get("env")
	if !env.isObject() {
		return nil
	}
	current, ok := env.get("HTTPS_PROXY").text()
	if !ok || !proxyIsOurs(current, routerURL) {
		return nil
	}
	var lines []string
	restore := ""
	if undo.ProxyBefore != nil {
		if name := domain.ProxyRouterName(*undo.ProxyBefore); name == "" || domain.ProxyRouterIsLive(livePluginURLs, name) {
			restore = *undo.ProxyBefore
		}
	}
	if restore == "" {
		// The before router is gone or was never recorded: another live plugin router takes over
		// when there is one.
		for _, url := range livePluginURLs {
			if domain.PluginRouters[domain.PortOf(url)] != domain.PluginRouters[domain.PortOf(routerURL)] {
				restore = url
				break
			}
		}
	}
	if restore != "" {
		env.set("HTTPS_PROXY", newText(restore))
		lines = append(lines, "set HTTPS_PROXY back to "+restore)
	} else {
		env.del("HTTPS_PROXY")
		lines = append(lines, "removed HTTPS_PROXY ("+routerURL+")")
	}
	// A key with a recorded before goes back to it; one that is still there without a before goes;
	// a key the user already took away is not reported.
	if undo.CABefore != nil {
		env.set("NODE_EXTRA_CA_CERTS", newText(*undo.CABefore))
		lines = append(lines, "set NODE_EXTRA_CA_CERTS back to "+*undo.CABefore)
	} else if _, there := env.get("NODE_EXTRA_CA_CERTS").text(); there {
		env.del("NODE_EXTRA_CA_CERTS")
		lines = append(lines, "removed NODE_EXTRA_CA_CERTS")
	}
	if undo.NoProxyBefore != nil {
		env.set("NO_PROXY", newText(*undo.NoProxyBefore))
		lines = append(lines, "set NO_PROXY back to "+*undo.NoProxyBefore)
	} else if _, there := env.get("NO_PROXY").text(); there {
		env.del("NO_PROXY")
		lines = append(lines, "removed NO_PROXY")
	}
	if undo.CreatedProxy && env.size() == 0 {
		root.del("env")
	}
	return lines
}

// proxyIsOurs is whether an HTTPS_PROXY value points at this plugin's router: its loopback host
// with this router's port, canonical or overridden.
func proxyIsOurs(current, routerURL string) bool {
	return domain.ProxyIsThisRouter(current, routerURL)
}

// undoToolSearch takes env.ENABLE_TOOL_SEARCH out when setup set it and it still says so: a value
// the user had before, or changed it to meanwhile, stays. Runs after undoBaseUrl, so an env this
// undo empties goes with it.
func undoToolSearch(root *jsonNode, undo SettingsUndo) []string {
	if !undo.CreatedToolSearch {
		return nil
	}
	env := root.get("env")
	if !env.isObject() {
		return nil
	}
	if value, _ := env.get("ENABLE_TOOL_SEARCH").text(); value != "true" {
		return nil
	}
	env.del("ENABLE_TOOL_SEARCH")
	if undo.CreatedEnv && env.size() == 0 {
		root.del("env")
	}
	return []string{"removed ENABLE_TOOL_SEARCH"}
}

// undoEfforts takes the modelSettings effort levels setup set out when they still say so: a value
// the user had before, or changed to meanwhile, stays. An entry object this empties goes, and so
// does modelSettings itself when it ends up empty.
func undoEfforts(root *jsonNode, undo SettingsUndo) []string {
	added := undo.EffortsAdded
	if added.Len() == 0 {
		return nil
	}
	settings := root.get("modelSettings")
	if !settings.isObject() {
		return nil
	}
	var taken []string
	for _, id := range added.Keys() {
		value, _ := added.Get(id)
		taken = append(taken, undoOneEffort(settings, id, value)...)
	}
	if settings.size() == 0 {
		root.del("modelSettings")
	}
	if len(taken) == 0 {
		return nil
	}
	return []string{fmt.Sprintf("took %s out of modelSettings", strings.Join(taken, " and "))}
}

// undoOneEffort takes one id's effort level out when it still says what setup wrote, the id's
// emptied entry with it; returns the id when it was taken.
func undoOneEffort(settings *jsonNode, id, value string) []string {
	entry := settings.get(id)
	if !entry.isObject() {
		return nil
	}
	if level, _ := entry.get("effortLevel").text(); level != value {
		return nil
	}
	entry.del("effortLevel")
	if entry.size() == 0 {
		settings.del(id)
	}
	return []string{id}
}

// ── the merge's moving parts ─────────────────────────────────────────────────────────────────────────────────────────

// The key as a mutable object, an empty one created when missing (objectAt then cannot miss).
func ensureObject(root *jsonNode, key, path string) (*jsonNode, error) {
	if root.get(key) == nil {
		root.set(key, emptyObject())
	}
	return objectAt(root, key, path)
}

// The key as a mutable array, an empty one created when missing (arrayAt then cannot miss).
func ensureArray(root *jsonNode, key, path string) (*jsonNode, error) {
	if root.get(key) == nil {
		root.set(key, newArray())
	}
	return arrayAt(root, key, path)
}

// The key as an object when it is one, nil when it is missing; an error, never a write, when it
// is neither.
func objectAt(root *jsonNode, key, path string) (*jsonNode, error) {
	value := root.get(key)
	if value == nil {
		return nil, nil
	}
	if !value.isObject() {
		return nil, fmt.Errorf("%s: %s must be an object; nothing changed", path, key)
	}
	return value, nil
}

func arrayAt(root *jsonNode, key, path string) (*jsonNode, error) {
	value := root.get(key)
	if value == nil {
		return nil, nil
	}
	if !value.isArray() {
		return nil, fmt.Errorf("%s: %s must be an array; nothing changed", path, key)
	}
	return value, nil
}

type appendedModels struct {
	lines    []string
	appended []string
}

func appendAvailableModels(root *jsonNode, provider domain.Provider, path string) (appendedModels, error) {
	available := root.get("availableModels")
	if available == nil {
		return appendedModels{}, nil
	}
	if !available.isArray() {
		return appendedModels{}, fmt.Errorf("%s: availableModels must be an array; nothing changed", path)
	}
	var result appendedModels
	for _, ref := range catalogRefs(provider) {
		if availableContains(available, ref.ID) {
			continue
		}
		available.items = append(available.items, newText(ref.ID))
		result.appended = append(result.appended, ref.ID)
		result.lines = append(result.lines, fmt.Sprintf("added %s to availableModels", ref.ID))
	}
	return result, nil
}

func availableContains(available *jsonNode, id string) bool {
	for _, item := range available.items {
		if text, ok := item.text(); ok && text == id {
			return true
		}
	}
	return false
}

// mergeModelOptions adds (or relabels) one modelPicker.options entry per catalog model, carrying
// the catalog's behavesAs when it has one; returns what changed. A row that is already there
// keeps whatever else the user put on it — unless it is setup's own (its id is in the ledger, or
// it is exactly what setup writes minus the behavesAs field, the shape an older setup left
// behind), in which case an upgrade brings that field up to the catalog.
func mergeModelOptions(options *jsonNode, provider domain.Provider, own []string) []string {
	var lines []string
	for _, ref := range catalogRefs(provider) {
		lines = append(lines, mergeOneOption(options, ref, own)...)
	}
	return lines
}

// mergeOneOption adds, or brings up to date, the one entry for ref (see mergeModelOptions);
// returns what changed.
func mergeOneOption(options *jsonNode, ref domain.ModelRef, own []string) []string {
	var existing *jsonNode
	for _, entry := range options.items {
		if model, ok := entryModel(entry); ok && model == ref.ID {
			existing = entry
			break
		}
	}
	if existing == nil {
		entry := emptyObject()
		entry.set("model", newText(ref.ID))
		entry.set("label", newText(ref.Label))
		if ref.BehavesAs != nil {
			entry.set("behavesAs", newText(*ref.BehavesAs))
		}
		options.items = append(options.items, entry)
		return []string{fmt.Sprintf("added %s (%s) to /model", ref.Label, ref.ID)}
	}
	// Own row is judged before the relabel below: a user's row with its own label must not start
	// looking like setup's.
	ownRow := slices.Contains(own, ref.ID) || setupShaped(existing, ref)
	var changes []string
	if label, _ := existing.get("label").text(); label != ref.Label {
		existing.set("label", newText(ref.Label))
		changes = append(changes, fmt.Sprintf("updated the %s (%s) label in /model", ref.Label, ref.ID))
	}
	if ownRow && ref.BehavesAs != nil {
		if behavesAs, _ := existing.get("behavesAs").text(); behavesAs != *ref.BehavesAs {
			existing.set("behavesAs", newText(*ref.BehavesAs))
			changes = append(changes, fmt.Sprintf("set behavesAs on the %s (%s) row in /model", ref.Label, ref.ID))
		}
	}
	return changes
}

// setupShaped is true when the row is exactly what setup writes, its behavesAs field aside:
// {model, label} plus nothing but a behavesAs. Any other key of its own makes it the user's,
// however similar the rest looks.
func setupShaped(record *jsonNode, ref domain.ModelRef) bool {
	if label, _ := record.get("label").text(); label != ref.Label {
		return false
	}
	for _, key := range record.keys {
		if key != "model" && key != "label" && key != "behavesAs" {
			return false
		}
	}
	return true
}

// removeModelEntries takes the ids' entries out of modelPicker.options (an emptied list stays an
// empty array).
func removeModelEntries(root *jsonNode, ids []string, path string) ([]string, error) {
	picker, err := objectAt(root, "modelPicker", path)
	if err != nil {
		return nil, err
	}
	if picker == nil {
		return nil, nil
	}
	options, err := arrayAt(picker, "options", path+": modelPicker.options")
	if err != nil {
		return nil, err
	}
	if options == nil || !hasModelEntry(options, ids) {
		return nil, nil
	}
	kept := make([]*jsonNode, 0, len(options.items))
	for _, entry := range options.items {
		if model, ok := entryModel(entry); ok && slices.Contains(ids, model) {
			continue
		}
		kept = append(kept, entry)
	}
	options.items = kept
	return []string{fmt.Sprintf("took %s out of /model", strings.Join(ids, " and "))}, nil
}

func hasModelEntry(options *jsonNode, ids []string) bool {
	for _, entry := range options.items {
		if model, ok := entryModel(entry); ok && slices.Contains(ids, model) {
			return true
		}
	}
	return false
}

// removeAvailableModels takes the ids out of availableModels when that list exists at all.
func removeAvailableModels(root *jsonNode, ids []string, path string) ([]string, error) {
	available := root.get("availableModels")
	if available == nil {
		return nil, nil
	}
	if !available.isArray() {
		return nil, fmt.Errorf("%s: availableModels must be an array; nothing changed", path)
	}
	kept := make([]*jsonNode, 0, len(available.items))
	for _, item := range available.items {
		if id, ok := item.text(); ok && slices.Contains(ids, id) {
			continue
		}
		kept = append(kept, item)
	}
	if len(kept) == len(available.items) {
		return nil, nil
	}
	root.set("availableModels", newArray(kept...))
	return []string{fmt.Sprintf("took %s out of availableModels", strings.Join(ids, " and "))}, nil
}

func currentBaseUrl(root *jsonNode, path string) (*string, error) {
	return currentEnvString(root, "ANTHROPIC_BASE_URL", path)
}

// currentToolSearch is the current env.ENABLE_TOOL_SEARCH, or nil when unset; the same wrong-shape
// errors as the base URL.
func currentToolSearch(root *jsonNode, path string) (*string, error) {
	return currentEnvString(root, "ENABLE_TOOL_SEARCH", path)
}

func currentEnvString(root *jsonNode, key, path string) (*string, error) {
	env := root.get("env")
	if env == nil {
		return nil, nil
	}
	if !env.isObject() {
		return nil, fmt.Errorf("%s: env must be an object; nothing changed", path)
	}
	current := env.get(key)
	if current == nil {
		return nil, nil
	}
	value, ok := current.text()
	if !ok || value == "" {
		return nil, fmt.Errorf("%s: env.%s must be a string; nothing changed", path, key)
	}
	return &value, nil
}

// currentProxySettings reads the four env values the proxy plan decides on; the same wrong-shape
// errors as the base URL.
func currentProxySettings(root *jsonNode, path string) (domain.ProxySettings, error) {
	// Claude Code reads https_proxy before HTTPS_PROXY, so the lowercase one, when set, is in force.
	proxy, err := currentEnvString(root, "https_proxy", path)
	if err != nil {
		return domain.ProxySettings{}, err
	}
	if proxy == nil {
		if proxy, err = currentEnvString(root, "HTTPS_PROXY", path); err != nil {
			return domain.ProxySettings{}, err
		}
	}
	ca, err := currentEnvString(root, "NODE_EXTRA_CA_CERTS", path)
	if err != nil {
		return domain.ProxySettings{}, err
	}
	noProxy, err := currentEnvString(root, "NO_PROXY", path)
	if err != nil {
		return domain.ProxySettings{}, err
	}
	baseURL, err := currentBaseUrl(root, path)
	if err != nil {
		return domain.ProxySettings{}, err
	}
	return domain.ProxySettings{HTTPSProxy: proxy, CA: ca, NoProxy: noProxy, BaseURL: baseURL}, nil
}

func applyBaseUrl(root *jsonNode, plan domain.BaseUrlPlan, path string) []string {
	if plan.Kind == domain.BaseUrlPlanKeep {
		if plan.Report == nil {
			return nil
		}
		return []string{*plan.Report}
	}
	var env *jsonNode
	var err error
	if plan.Kind == domain.BaseUrlPlanSet {
		env, err = ensureObject(root, "env", path)
	} else {
		env, err = objectAt(root, "env", path)
	}
	if err != nil || env == nil {
		return []string{*plan.Report}
	}
	if plan.Kind == domain.BaseUrlPlanRemove {
		env.del("ANTHROPIC_BASE_URL")
		if env.size() == 0 {
			root.del("env")
		}
	} else {
		env.set("ANTHROPIC_BASE_URL", newText(plan.URL))
	}
	return []string{*plan.Report}
}

// applyProxy writes the proxy plan into env, mirroring applyBaseUrl: a set writes its keys, a keep
// only writes the NO_PROXY it appends and takes a stale plugin-router base URL out, a remove takes
// the three keys out (an emptied env with them).
func applyProxy(root *jsonNode, plan domain.ProxyPlan, path string) []string {
	var lines []string
	if plan.Report != nil {
		lines = append(lines, *plan.Report)
	}
	if plan.RemoveBaseURL {
		lines = append(lines, takeOutBaseURL(root)...)
	}
	switch plan.Kind {
	case domain.ProxyPlanRemove:
		env, err := objectAt(root, "env", path)
		if err != nil || env == nil {
			return lines
		}
		for _, key := range []string{"HTTPS_PROXY", "NODE_EXTRA_CA_CERTS"} {
			env.del(key)
		}
		if env.size() == 0 {
			root.del("env")
		}
	case domain.ProxyPlanSet:
		env, err := ensureObject(root, "env", path)
		if err != nil || env == nil {
			return lines
		}
		env.set("HTTPS_PROXY", newText(plan.Proxy))
		if plan.CA != "" {
			env.set("NODE_EXTRA_CA_CERTS", newText(plan.CA))
		}
		if plan.NoProxy != "" {
			env.set("NO_PROXY", newText(plan.NoProxy))
		}
	case domain.ProxyPlanKeep:
		if plan.NoProxy == "" {
			return lines
		}
		env, err := objectAt(root, "env", path)
		if err != nil || env == nil {
			return lines
		}
		env.set("NO_PROXY", newText(plan.NoProxy))
	}
	return lines
}

// takeOutBaseURL removes the base URL the proxy mode replaces and says so.
func takeOutBaseURL(root *jsonNode) []string {
	env := root.get("env")
	if !env.isObject() {
		return nil
	}
	current, ok := env.get("ANTHROPIC_BASE_URL").text()
	if !ok {
		return nil
	}
	env.del("ANTHROPIC_BASE_URL")
	return []string{"removed ANTHROPIC_BASE_URL (" + current + ")"}
}

// applyToolSearch sets env.ENABLE_TOOL_SEARCH when the settings end up pointing Claude Code at
// this router (Claude Code turns MCP tool search off for a non-Anthropic base URL, and the router
// answers it for the provider's models) and there is no value yet — a value the user set, even
// "false", stays, here and on undo.
func applyToolSearch(root *jsonNode, routed bool, before *string, path string) []string {
	if !routed || before != nil {
		return nil
	}
	env, err := objectAt(root, "env", path)
	if err != nil || env == nil {
		return nil
	}
	env.set("ENABLE_TOOL_SEARCH", newText("true"))
	return []string{"turned on MCP tool search"}
}

type appliedEfforts struct {
	lines []string
	added *StringMap
}

// applyEfforts sets modelSettings.<id>.effortLevel to the catalog's defaultEffort per model that
// declares one, when that id has no effort level yet — a level the user set (e.g. saved by
// /effort) is never overwritten, here or on undo. modelSettings and the id's entry are created
// only on the way to a write.
func applyEfforts(root *jsonNode, provider domain.Provider, path string) (appliedEfforts, error) {
	efforts := appliedEfforts{added: NewStringMap()}
	for _, ref := range catalogRefs(provider) {
		if ref.DefaultEffort == nil {
			continue
		}
		settings, err := effortSettingsAt(root, path)
		if err != nil {
			return appliedEfforts{}, err
		}
		entry, err := effortEntryAt(settings, ref.ID, path)
		if err != nil {
			return appliedEfforts{}, err
		}
		if entry != nil && entry.get("effortLevel") != nil {
			continue
		}
		record := entry
		if record == nil {
			record = emptyObject()
			settings.set(ref.ID, record)
		}
		record.set("effortLevel", newText(string(*ref.DefaultEffort)))
		efforts.added.Set(ref.ID, string(*ref.DefaultEffort))
		efforts.lines = append(efforts.lines, fmt.Sprintf("set %s default effort to %s", ref.Label, *ref.DefaultEffort))
	}
	return efforts, nil
}

// effortSettingsAt is the modelSettings object, an empty one created when missing — which happens
// only on the way to a write, since a missing container has no entry for a level the user set to
// sit in.
func effortSettingsAt(root *jsonNode, path string) (*jsonNode, error) {
	if root.get("modelSettings") == nil {
		root.set("modelSettings", emptyObject())
	}
	return objectAt(root, "modelSettings", path)
}

// effortEntryAt is the modelSettings entry of id as a mutable object, nil when missing; an error,
// never a write, when it is another type.
func effortEntryAt(settings *jsonNode, id, path string) (*jsonNode, error) {
	entry := settings.get(id)
	if entry == nil {
		return nil, nil
	}
	if !entry.isObject() {
		return nil, fmt.Errorf("%s: modelSettings.%s must be an object; nothing changed", path, id)
	}
	return entry, nil
}

func catalogRefs(provider domain.Provider) []domain.ModelRef {
	return []domain.ModelRef{provider.Catalog[domain.ModelTierMain], provider.Catalog[domain.ModelTierFlash]}
}

func catalogIDs(provider domain.Provider) []string {
	return []string{provider.Catalog[domain.ModelTierMain].ID, provider.Catalog[domain.ModelTierFlash].ID}
}

// knownModels is the set of /model ids the file already carries.
func knownModels(options *jsonNode) map[string]bool {
	models := make(map[string]bool, len(options.items))
	for _, entry := range options.items {
		if model, ok := entryModel(entry); ok {
			models[model] = true
		}
	}
	return models
}

// entryModel is the model field of a /model options entry, or !ok for anything not shaped like
// one.
func entryModel(entry *jsonNode) (string, bool) {
	if entry == nil || entry.kind != jsonObject {
		return "", false
	}
	return entry.get("model").text()
}

// ── the ordered JSON value ───────────────────────────────────────────────────────────────────────────────────────────

// jsonKind discriminates a jsonNode.
type jsonKind uint8

const (
	jsonObject jsonKind = iota
	jsonArray
	jsonString
	jsonNumber
	jsonBool
	jsonNull
)

// jsonNode is one JSON value of a settings file. An object keeps its keys in file order and an
// array its items, because Go maps lose order and the user's file must survive a rewrite with its
// keys where they were. A nil node is an absent key; a present JSON null is a node of kind
// jsonNull.
type jsonNode struct {
	kind    jsonKind
	str     string
	num     json.Number
	boolean bool
	keys    []string
	fields  map[string]*jsonNode
	items   []*jsonNode
}

func newText(value string) *jsonNode {
	return &jsonNode{kind: jsonString, str: value}
}

func newArray(items ...*jsonNode) *jsonNode {
	return &jsonNode{kind: jsonArray, items: items}
}

func emptyObject() *jsonNode {
	return &jsonNode{kind: jsonObject, fields: make(map[string]*jsonNode)}
}

func (n *jsonNode) isObject() bool { return n != nil && n.kind == jsonObject }
func (n *jsonNode) isArray() bool  { return n != nil && n.kind == jsonArray }

// text is the node as a string, !ok for anything else (a missing key reads as not-a-string too).
func (n *jsonNode) text() (string, bool) {
	if n == nil || n.kind != jsonString {
		return "", false
	}
	return n.str, true
}

// get is the key's value; nil when the object does not carry it.
func (n *jsonNode) get(key string) *jsonNode {
	if n == nil || n.kind != jsonObject {
		return nil
	}
	return n.fields[key]
}

// set assigns the key, appending it when the object does not carry it: a JS assignment, where an
// existing key keeps its position.
func (n *jsonNode) set(key string, value *jsonNode) {
	if n.fields == nil {
		n.fields = make(map[string]*jsonNode)
	}
	if _, exists := n.fields[key]; !exists {
		n.keys = append(n.keys, key)
	}
	n.fields[key] = value
}

// del removes the key.
func (n *jsonNode) del(key string) {
	if _, exists := n.fields[key]; !exists {
		return
	}
	delete(n.fields, key)
	for i, k := range n.keys {
		if k == key {
			n.keys = append(n.keys[:i], n.keys[i+1:]...)
			return
		}
	}
}

// size is the object's key count.
func (n *jsonNode) size() int {
	if n == nil || n.kind != jsonObject {
		return 0
	}
	return len(n.keys)
}

// parseJSON is JSON.parse: the whole text as one value, and nothing after it.
func parseJSON(text string) (*jsonNode, error) {
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	node, err := decodeJSONValue(decoder)
	if err != nil {
		return nil, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, fmt.Errorf("trailing content")
	}
	return node, nil
}

func decodeJSONValue(decoder *json.Decoder) (*jsonNode, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch token := token.(type) {
	case json.Delim:
		// A closing delimiter never starts a value: Token() rejects one before it gets here.
		if token == '[' {
			return decodeJSONArray(decoder)
		}
		return decodeJSONObject(decoder)
	case string:
		return newText(token), nil
	case json.Number:
		return &jsonNode{kind: jsonNumber, num: token}, nil
	case bool:
		return &jsonNode{kind: jsonBool, boolean: token}, nil
	}
	// The one shape left is nil: JSON's null.
	return &jsonNode{kind: jsonNull}, nil
}

func decodeJSONObject(decoder *json.Decoder) (*jsonNode, error) {
	node := emptyObject()
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		// Token() only ever yields a string for an object member name.
		key := keyToken.(string)
		value, err := decodeJSONValue(decoder)
		if err != nil {
			return nil, err
		}
		// A duplicate key overwrites the earlier value in place, as JSON.parse does.
		node.set(key, value)
	}
	// More() is only false at the closing delimiter (EOF keeps it true), so this consumes it.
	_, _ = decoder.Token()
	return node, nil
}

func decodeJSONArray(decoder *json.Decoder) (*jsonNode, error) {
	node := newArray()
	for decoder.More() {
		item, err := decodeJSONValue(decoder)
		if err != nil {
			return nil, err
		}
		node.items = append(node.items, item)
	}
	// The closing bracket, as above.
	_, _ = decoder.Token()
	return node, nil
}

// marshalSettings is JSON.stringify(root, null, 2) without the trailing newline: numbers keep the
// literals the file had, and only ", \ and the C0 controls are escaped.
func marshalSettings(root *jsonNode) string {
	var b strings.Builder
	writeJSONValue(&b, root, "")
	return b.String()
}

func writeJSONValue(b *strings.Builder, node *jsonNode, indent string) {
	inner := indent + "  "
	switch node.kind {
	case jsonObject:
		if len(node.keys) == 0 {
			b.WriteString("{}")
			return
		}
		b.WriteString("{\n")
		for i, key := range node.keys {
			b.WriteString(inner)
			writeJSONString(b, key)
			b.WriteString(": ")
			writeJSONValue(b, node.fields[key], inner)
			if i < len(node.keys)-1 {
				b.WriteString(",")
			}
			b.WriteString("\n")
		}
		b.WriteString(indent)
		b.WriteString("}")
	case jsonArray:
		if len(node.items) == 0 {
			b.WriteString("[]")
			return
		}
		b.WriteString("[\n")
		for i, item := range node.items {
			b.WriteString(inner)
			writeJSONValue(b, item, inner)
			if i < len(node.items)-1 {
				b.WriteString(",")
			}
			b.WriteString("\n")
		}
		b.WriteString(indent)
		b.WriteString("]")
	case jsonString:
		writeJSONString(b, node.str)
	case jsonNumber:
		b.WriteString(string(node.num))
	case jsonBool:
		if node.boolean {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case jsonNull:
		b.WriteString("null")
	}
}

// writeJSONString writes s quoted the way JSON.stringify quotes it: only ", \ and the C0 controls
// are escaped (\b \t \n \f \r as their two-character forms, the rest as lowercase \u00xx); nothing
// else (<, >, &, U+2028, U+2029) is.
func writeJSONString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if c < 0x20 {
				fmt.Fprintf(b, `\u%04x`, c)
			} else {
				b.WriteByte(c)
			}
		}
	}
	b.WriteByte('"')
}

// nodesEqual compares two values the way comparing their JSON.stringify texts would: key order
// included.
func nodesEqual(a, b *jsonNode) bool {
	if a == nil || b == nil {
		return a == b
	}
	if a.kind != b.kind {
		return false
	}
	switch a.kind {
	case jsonObject:
		if len(a.keys) != len(b.keys) {
			return false
		}
		for i, key := range a.keys {
			if key != b.keys[i] || !nodesEqual(a.fields[key], b.fields[key]) {
				return false
			}
		}
		return true
	case jsonArray:
		if len(a.items) != len(b.items) {
			return false
		}
		for i, item := range a.items {
			if !nodesEqual(item, b.items[i]) {
				return false
			}
		}
		return true
	case jsonString:
		return a.str == b.str
	case jsonNumber:
		return a.num == b.num
	case jsonBool:
		return a.boolean == b.boolean
	}
	return true // null
}

// StringMap is a string map with its key order kept: Go maps forget order, and both the ledger's
// bytes and the undo's report lines ("took a and b out of modelSettings") read it back in the
// order setup wrote it.
type StringMap struct {
	keys   []string
	values map[string]string
}

// NewStringMap returns an empty ordered map.
func NewStringMap() *StringMap {
	return &StringMap{values: make(map[string]string)}
}

// Set stores value under key, appending the key when it is new (a JS assignment: an existing key
// keeps its position).
func (m *StringMap) Set(key, value string) {
	if m.values == nil {
		m.values = make(map[string]string)
	}
	if _, exists := m.values[key]; !exists {
		m.keys = append(m.keys, key)
	}
	m.values[key] = value
}

// Get returns the key's value; !ok when the map does not carry it.
func (m *StringMap) Get(key string) (string, bool) {
	if m == nil {
		return "", false
	}
	value, ok := m.values[key]
	return value, ok
}

// Len is how many keys the map holds.
func (m *StringMap) Len() int {
	if m == nil {
		return 0
	}
	return len(m.keys)
}

// Keys are the keys in insertion order.
func (m *StringMap) Keys() []string {
	if m == nil {
		return nil
	}
	return m.keys
}

// MarshalJSON writes the map as a JSON object in insertion order.
func (m *StringMap) MarshalJSON() ([]byte, error) {
	var b strings.Builder
	b.WriteByte('{')
	for i, key := range m.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		writeJSONString(&b, key)
		b.WriteByte(':')
		writeJSONString(&b, m.values[key])
	}
	b.WriteByte('}')
	return []byte(b.String()), nil
}

// UnmarshalJSON reads a JSON object keeping its key order; a later duplicate key overwrites the
// earlier value in place, as JSON.parse does.
func (m *StringMap) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return fmt.Errorf("not an object")
	}
	*m = StringMap{values: make(map[string]string)}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return err
		}
		// Token() only ever yields a string for an object member name.
		key := keyToken.(string)
		valueToken, err := decoder.Token()
		if err != nil {
			return err
		}
		value, ok := valueToken.(string)
		if !ok {
			return fmt.Errorf("value of %q is not a string", key)
		}
		m.Set(key, value)
	}
	// The closing brace; More() is only false there (EOF keeps it true).
	_, _ = decoder.Token()
	return nil
}

// ── the careful write ───────────────────────────────────────────────────────────────────────────────────────────────

// SettingsBackupPath is the backup kept of the file from before this plugin first wrote it.
func SettingsBackupPath(path, name string) string {
	return path + "." + name + "-backup"
}

// settingsSnapshot is the file as read: its text ({} for a missing file), its stat (nil when
// missing), where writes go.
type settingsSnapshot struct {
	text   string
	stat   os.FileInfo
	target string
}

// snapshotSettings reads the file; only a missing file counts as empty, any other read error is an
// error and nothing is written. A symlinked settings.json is read and written through its target,
// so the link stays a link.
func snapshotSettings(path string) (settingsSnapshot, error) {
	target := path
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		target = resolved
	} else if fsutil.ErrnoCode(err) != "ENOENT" {
		return settingsSnapshot{}, cannotRead(path, err)
	}
	// The stat and the read share one error check: only a missing file counts as empty, any
	// other failure (a directory, no permission) is an error and nothing is written.
	var data []byte
	stat, err := os.Stat(target)
	if err == nil {
		data, err = os.ReadFile(target)
	}
	if err != nil {
		if fsutil.ErrnoCode(err) == "ENOENT" {
			return settingsSnapshot{text: "{}", target: target}, nil
		}
		return settingsSnapshot{}, cannotRead(path, err)
	}
	return settingsSnapshot{text: string(data), stat: stat, target: target}, nil
}

func cannotRead(path string, err error) error {
	return fmt.Errorf("%s: cannot read (%s); nothing changed", path, fsutil.ErrorMessage(err))
}

// unchanged is the compare of the write's compare-and-swap: the target still has the size and
// mtime it had when it was read.
func unchanged(target string, before os.FileInfo) bool {
	now, err := os.Stat(target)
	if err != nil {
		return before == nil && fsutil.ErrnoCode(err) == "ENOENT"
	}
	return before != nil && now.Size() == before.Size() && now.ModTime().Equal(before.ModTime())
}

// replaceSettings writes atomically with the file's mode, renamed over the target only when the
// target is still what was read.
func replaceSettings(ctx context.Context, snap settingsSnapshot, text string) (bool, error) {
	mode := fs.FileMode(0o600)
	if snap.stat != nil {
		mode = snap.stat.Mode().Perm()
	}
	return fsutil.WriteFileAtomic(ctx, snap.target, []byte(text), fsutil.WriteOptions{
		Mode:     func(string) fs.FileMode { return mode },
		Mkdir:    true,
		CommitIf: func() bool { return unchanged(snap.target, snap.stat) },
	})
}

// settingsEdit is one edit over the parsed settings object.
type settingsEdit func(root *jsonNode) ([]string, error)

// parseSettings is the file parsed into a settings object, or why it cannot be edited.
func parseSettings(path, text string) (*jsonNode, error) {
	root, err := parseJSON(text)
	if err != nil {
		return nil, fmt.Errorf("%s: not valid JSON; nothing changed", path)
	}
	if !root.isObject() {
		return nil, fmt.Errorf("%s: not a settings object; nothing changed", path)
	}
	return root, nil
}

// serializedSettings is the text to write, only when it survives a JSON round trip unchanged.
func serializedSettings(path string, root *jsonNode) (string, error) {
	text := marshalSettings(root) + "\n"
	lost := fmt.Errorf("%s: the edited settings did not survive a JSON round trip; nothing changed", path)
	reparsed, err := parseJSON(text)
	if err != nil || !nodesEqual(reparsed, root) {
		return "", lost
	}
	return text, nil
}

// backupOnce copies the file to its backup the first time this plugin ever writes it.
func backupOnce(snap settingsSnapshot, backup string) error {
	if snap.stat == nil || exists(backup) {
		return nil
	}
	data, err := os.ReadFile(snap.target)
	if err != nil {
		return err
	}
	if err := os.WriteFile(backup, data, 0o600); err != nil {
		return err
	}
	return os.Chmod(backup, 0o600)
}

// backupBytesIfEqual is the backup's own text when its JSON equals the edited settings (an exact
// undo restores the exact bytes).
func backupBytesIfEqual(backup string, parsed *jsonNode) (string, bool) {
	data, err := os.ReadFile(backup)
	if err != nil {
		return "", false
	}
	node, err := parseJSON(string(data))
	if err != nil || !nodesEqual(node, parsed) {
		return "", false
	}
	return string(data), true
}

// editOnce is one read-edit-write pass; changed is true when the file moved under it before the
// rename.
func editOnce(ctx context.Context, path, name string, edit settingsEdit, restoreBackup bool) ([]string, bool, error) {
	snap, err := snapshotSettings(path)
	if err != nil {
		return nil, false, err
	}
	root, err := parseSettings(path, snap.text)
	if err != nil {
		return nil, false, err
	}
	before := marshalSettings(root)
	lines, err := edit(root)
	if err != nil || marshalSettings(root) == before {
		return lines, false, err
	}
	text, err := serializedSettings(path, root)
	if err != nil {
		return nil, false, err
	}
	backup := SettingsBackupPath(path, name)
	if err := backupOnce(snap, backup); err != nil {
		return nil, false, fmt.Errorf("%s: %s; nothing changed", path, fsutil.ErrorMessage(err))
	}
	final := text
	if restoreBackup {
		if bytes, ok := backupBytesIfEqual(backup, root); ok {
			final = bytes
		}
	}
	committed, err := replaceSettings(ctx, snap, final)
	if err != nil {
		return nil, false, fmt.Errorf("%s: %s; nothing changed", path, fsutil.ErrorMessage(err))
	}
	if !committed {
		return nil, true, nil
	}
	return lines, false, nil
}

// editSettings reads, applies one edit and writes the result back (see the header), under a lock
// all five plugins share.
func editSettings(ctx context.Context, path, name string, edit settingsEdit, restoreBackup bool) (lines []string, err error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("%s: %s; nothing changed", path, fsutil.ErrorMessage(err))
	}
	lock, lockErr := WaitLock(ctx, path+".provider-routers.lock", int64(os.Getpid()), process.IsAlive, 5000)
	if lockErr != nil {
		return nil, fmt.Errorf("%s: another plugin is editing it; nothing changed", path)
	}
	// A release failure outranks the success it follows.
	defer func() {
		if releaseErr := lock(ctx); releaseErr != nil && err == nil {
			lines, err = nil, releaseErr
		}
	}()
	for attempt := 0; attempt < 2; attempt++ {
		var changed bool
		lines, changed, err = editOnce(ctx, path, name, edit, restoreBackup)
		if !changed {
			return lines, err
		}
	}
	return nil, fmt.Errorf("%s: changed on disk while being edited; nothing changed", path)
}
