package cli

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/render"
)

// setupSilent drops every line: the hook's repairs stay out of the session it starts.
type setupSilent struct{}

func (s setupSilent) Line(text string)  { s.drop(text) }
func (s setupSilent) Error(text string) { s.drop(text) }

// drop is the sink both streams share; it writes nowhere.
func (setupSilent) drop(text string) {
	_, _ = io.WriteString(io.Discard, text)
}

// SetupCommand is `setup`: the checks and the ping, then — only when both pass — the routing
// wiring, all of it reported.
type SetupCommand struct{}

var _ Command = SetupCommand{}

// Name is the command's.
func (SetupCommand) Name() string { return "setup" }

// Synopsis is the command's lines.
func (SetupCommand) Synopsis() []string {
	return []string{
		"setup [--remove] [--json]",
		"setup --engines [--json]",
		"setup --engine-check <omp|opencode|pi|zcode> [--json]",
		"setup --engine-enable <omp|opencode|pi|zcode> --watcher provider|sonnet",
	}
}

// Options: --ping is an undocumented no-op alias (plain setup always pings).
func (SetupCommand) Options() map[string]OptionSpec {
	options := map[string]OptionSpec{
		"ping":   {Type: OptionTypeBoolean},
		"hook":   {Type: OptionTypeBoolean},
		"remove": {Type: OptionTypeBoolean},
	}
	for name, spec := range EngineOptions() {
		options[name] = spec
	}
	return options
}

// Hidden: setup is a user command.
func (SetupCommand) Hidden() bool { return false }

// Run dispatches the hook, the engine flags, remove and the plain run.
func (SetupCommand) Run(ctx context.Context, call Invocation) (ExitCode, error) {
	// The engines' repairs stay silent like the router's: only a user message (JSON) may reach
	// stdout.
	if call.Flag("hook") {
		hookDeps := call.Deps()
		hookDeps.Out = setupSilent{}
		return WithEngineHook(ctx, hookDeps, func(ctx context.Context) ExitCode {
			return RoutingHook(ctx, NewSetupDeps(hookDeps))
		}), nil
	}
	if code, ran := EngineSetup(ctx, call, setupRun); ran {
		return code, nil
	}
	if call.Flag("remove") {
		return setupRemove(ctx, call), nil
	}
	return setupRun(ctx, call), nil
}

// setupNotRouted is wired, yet the agents still name Sonnet: the router only routes when Claude
// Code's base URL is a router of ours, and setup kept the user's own proxy there.
type setupNotRouted struct {
	BaseURL   string `json:"baseUrl"`
	RouterURL string `json:"routerUrl"`
}

// setupWorkerCheck is the worker line's Check plus the binary it ran.
type setupWorkerCheck struct {
	app.StringResult
	Bin string
}

// MarshalJSON writes the check's arm and then the binary, the member order setup's JSON report
// pins.
// The two encodes cannot fail (a Result of strings and one string), so their errors are dropped.
func (c setupWorkerCheck) MarshalJSON() ([]byte, error) {
	inner, _ := domain.MarshalCompactJSON(c.StringResult)
	bin, _ := domain.MarshalCompactJSON(c.Bin)
	joined := make([]byte, 0, len(inner)+len(bin)+8)
	joined = append(joined, inner[:len(inner)-1]...) // drop the closing brace
	joined = append(joined, `,"bin":`...)
	joined = append(joined, bin...)
	return append(joined, '}'), nil
}

// setupCap is the limiter's current cap and its ceiling.
type setupCap struct {
	Now int `json:"now"`
	Max int `json:"max"`
}

// setupSettingsCheck is the settings line's Check plus the file and whether this run changed it.
type setupSettingsCheck struct {
	OK      bool
	Value   string
	Error   string
	Path    string
	Changed bool
}

// MarshalJSON writes the arm the check is on, its own members in the pinned order.
func (c setupSettingsCheck) MarshalJSON() ([]byte, error) {
	if c.OK {
		return setupJSONObject{
			{"ok", true}, {"path", c.Path}, {"changed", c.Changed}, {"value", c.Value},
		}.MarshalJSON()
	}
	return setupJSONObject{
		{"ok", false}, {"path", c.Path}, {"changed", false}, {"error", c.Error},
	}.MarshalJSON()
}

// setupReport is everything one plain setup run learned.
type setupReport struct {
	Ready     bool
	NotRouted *setupNotRouted
	// Whether this run changed settings.json or an agent: the running session keeps its old
	// settings until restart.
	Changed  *bool
	Runtime  string
	Worker   setupWorkerCheck
	Extra    []app.SetupCheck
	State    string
	Cap      setupCap
	Ping     *app.StringResult
	Router   *app.StringResult
	Models   *app.StringResult
	Settings *setupSettingsCheck
}

// setupRun is plain `setup`.
func setupRun(ctx context.Context, call Invocation) ExitCode {
	deps := call.Deps()
	if keyed, ended := EnsureKey(ctx, call); ended {
		return keyed
	}
	base := setupBase(ctx, call)
	checked := base.Worker.OK && setupExtraOK(base.Extra)
	if !checked {
		base.Ready = false
		return setupFinish(ctx, call, base)
	}
	pinged := setupPingCheck(ctx, call)
	base.Ping = &pinged
	if !pinged.OK {
		base.Ready = false
		return setupFinish(ctx, call, base)
	}
	applied := ApplyRouting(ctx, NewSetupDeps(deps))
	wired := applied.Router.OK && applied.Settings.OK && applied.Agents.OK
	if wired {
		base.NotRouted = setupNotRoutedBy(call, applied)
	}
	base.Ready = wired && base.NotRouted == nil
	changed := (applied.Settings.OK && setupChangedLines(applied.Settings)) ||
		(applied.Agents.OK && setupChangedAgents(applied.Agents))
	base.Changed = &changed
	base.Router = &applied.Router
	models := app.StringResult{OK: true, Value: AgentText(applied.Agents)}
	if !applied.Agents.OK {
		models = app.StringResult{Error: applied.Agents.Error}
	}
	base.Models = &models
	settings := setupSettingsCheckOf(adapters.ClaudeSettingsPath(domain.EnvLookup(deps.Env)), applied.Settings)
	base.Settings = &settings
	return setupFinish(ctx, call, base)
}

// setupNotRoutedBy reports a wiring the user's own proxy keeps from routing.
func setupNotRoutedBy(call Invocation, applied RoutingApplied) *setupNotRouted {
	if !applied.Agents.OK || !setupAnySonnet(applied.Agents) {
		return nil
	}
	deps := call.Deps()
	baseURL, _ := adapters.ReadBaseUrl(adapters.ClaudeSettingsPath(domain.EnvLookup(deps.Env)))
	return &setupNotRouted{
		BaseURL:   baseUrlOrUnset(baseURL),
		RouterURL: domain.RouterBaseURL(deps.Provider, domain.EnvLookup(deps.Env)),
	}
}

// baseUrlOrUnset names an absent base URL the way the not-routed report reads it.
func baseUrlOrUnset(baseURL string) string {
	if baseURL == "" {
		return "unset"
	}
	return baseURL
}

// setupRemove is `setup --remove`.
func setupRemove(ctx context.Context, call Invocation) ExitCode {
	deps := call.Deps()
	env := domain.EnvLookup(deps.Env)
	removed := RemoveRouting(ctx, NewSetupDeps(deps))
	RemoveStoredKey(ctx, call)
	settings := adapters.ClaudeSettingsPath(env)
	if call.Flag("json") {
		models := app.StringResult{OK: true, Value: RestoredAgentText(removed)}
		if !removed.Agents.OK {
			models = app.StringResult{Error: removed.Agents.Error}
		}
		_ = call.JSON(setupJSONObject{
			{"removed", true},
			{"router", removed.Router},
			{"models", models},
			{"settings", setupSettingsCheckOf(settings, removed.Settings)},
		})
	} else {
		deps.Out.Line(renderRemove(deps.Provider, settings, removed))
	}
	return ExitOK
}

// setupFinish reports and exits: ready is 0, everything else 6.
func setupFinish(ctx context.Context, call Invocation, report setupReport) ExitCode {
	if call.Flag("json") {
		_ = call.JSON(setupJSONOf(call.Deps().Provider, report))
	} else {
		call.Deps().Out.Line(renderSetup(call.Deps().Provider, report))
	}
	if report.Ready {
		return ExitOK
	}
	return ExitNotReady
}

// setupBase is the checks that need no wiring: the runtime, the worker, the extra checks, the
// state and the limiter's cap.
func setupBase(ctx context.Context, call Invocation) setupReport {
	deps := call.Deps()
	version, versionErr := deps.Host.WorkerVersion(ctx)
	worker := setupWorkerCheck{Bin: deps.Host.WorkerBin}
	worker.OK = versionErr == nil
	worker.Value = version
	if versionErr != nil {
		worker.Error = versionErr.Error()
	}
	limit := deps.Limiter.Limit(ctx, deps.Clock.Now())
	return setupReport{
		Runtime: deps.Host.Runtime,
		Worker:  worker,
		Extra:   deps.Host.ExtraChecks(ctx),
		State:   deps.Host.StateRoot,
		Cap:     setupCap{Now: limit.Cap, Max: limit.Max},
	}
}

// setupExtraOK says whether every extra check passed.
func setupExtraOK(checks []app.SetupCheck) bool {
	for _, check := range checks {
		if !check.Result.OK {
			return false
		}
	}
	return true
}

// setupChangedLines says whether the settings merge changed anything of ours beyond a kept entry.
func setupChangedLines(settings LinesResult) bool {
	for _, line := range settings.Value {
		if !strings.HasPrefix(line, domain.KeptPrefix) {
			return true
		}
	}
	return false
}

// setupChangedAgents says whether any agent file was rewritten.
func setupChangedAgents(agents AgentsResult) bool {
	for _, agent := range agents.Value {
		if agent.Changed {
			return true
		}
	}
	return false
}

// setupAnySonnet says whether any agent still names Sonnet.
func setupAnySonnet(agents AgentsResult) bool {
	for _, agent := range agents.Value {
		if agent.Model == "sonnet" {
			return true
		}
	}
	return false
}

// setupJSONField is one member of a JSON document whose key order matters.
type setupJSONField struct {
	name  string
	value any
}

// setupJSONObject is a JSON object that marshals its members in order: setup's JSON report keeps
// a fixed key order.
type setupJSONObject []setupJSONField

// MarshalJSON writes each member in order through the domain encoder (no HTML escaping, raw
// U+2028/9), the way JSON.stringify does. The members are Go strings and values the reports already
// encode, so an encode cannot fail here.
func (o setupJSONObject) MarshalJSON() ([]byte, error) {
	var out strings.Builder
	out.WriteByte('{')
	for i, field := range o {
		if i > 0 {
			out.WriteByte(',')
		}
		encoded, _ := domain.MarshalCompactJSON(field.name)
		out.Write(encoded)
		out.WriteByte(':')
		encoded, _ = domain.MarshalCompactJSON(field.value)
		out.Write(encoded)
	}
	out.WriteByte('}')
	return []byte(out.String()), nil
}

// setupJSONOf is the worker under its label, then each extra check under its own, then the rest:
// the `setup --json` document.
func setupJSONOf(provider domain.Provider, report setupReport) setupJSONObject {
	document := setupJSONObject{
		{"ready", report.Ready},
	}
	if report.NotRouted != nil {
		document = append(document, setupJSONField{"routed", false}, setupJSONField{"baseUrl", report.NotRouted.BaseURL})
	}
	document = append(document,
		setupJSONField{"runtime", report.Runtime},
		setupJSONField{provider.WorkerLabel, report.Worker},
	)
	for _, check := range report.Extra {
		document = append(document, setupJSONField{check.Label, check.Result})
	}
	document = append(document,
		setupJSONField{"state", report.State},
		setupJSONField{"cap", report.Cap},
	)
	if report.Ping != nil {
		document = append(document, setupJSONField{"ping", *report.Ping})
	}
	if report.Router != nil {
		document = append(document, setupJSONField{"router", *report.Router})
	}
	if report.Models != nil {
		document = append(document, setupJSONField{"models", *report.Models})
	}
	if report.Settings != nil {
		document = append(document, setupJSONField{"settings", *report.Settings})
	}
	return document
}

// setupSettingsCheckOf is the settings line: what the merge did to the file.
func setupSettingsCheckOf(path string, settings LinesResult) setupSettingsCheck {
	if settings.OK {
		value := strings.Join(settings.Value, "; ")
		if value == "" {
			value = "no changes"
		}
		return setupSettingsCheck{OK: true, Path: path, Changed: len(settings.Value) > 0, Value: value}
	}
	return setupSettingsCheck{OK: false, Path: path, Error: settings.Error}
}

// setupPingCheck is one tiny real request that proves the key and the route work.
func setupPingCheck(ctx context.Context, call Invocation) app.StringResult {
	deps := call.Deps()
	result, err := app.Ping(ctx, deps)
	if err != nil {
		return app.StringResult{Error: app.DescribeWorkerError(deps.Provider, *asWorkerError(err))}
	}
	if result.Outcome.Kind != domain.WorkerOutcomeCompleted {
		return app.StringResult{Error: render.OutcomeText(result.Outcome)}
	}
	model := deps.Provider.Catalog[deps.Provider.PingTier].ID
	return app.StringResult{OK: true, Value: fmt.Sprintf("ok: %s answered (%s, %s)", model,
		render.Plural(result.Usage.Turns, "turn"),
		render.EstimateText(model, render.TokenCounts{
			InputTokens:      float64(result.Usage.InputTokens),
			OutputTokens:     float64(result.Usage.OutputTokens),
			CacheReadTokens:  float64(result.Usage.CacheReadTokens),
			CacheWriteTokens: float64(result.Usage.CacheWriteTokens),
		}))}
}

// setupLabels are the checklist labels besides the worker's and the extra checks'; with them they
// set the column width.
var setupLabels = []string{"runtime", "ping", "router", "models", "settings"}

// setupRemoveLabels are the remove report's labels.
var setupRemoveLabels = []string{"router", "models", "settings"}

// renderSetup is the outcome first, in one sentence with the next step, then a short checklist;
// state dir and cap are in --json.
func renderSetup(provider domain.Provider, report setupReport) string {
	labels := make([]string, 0, len(report.Extra)+len(setupLabels)+1)
	labels = append(labels, provider.WorkerLabel)
	for _, check := range report.Extra {
		labels = append(labels, check.Label)
	}
	labels = append(labels, setupLabels...)
	width := engineLabelWidth(labels, func(label string) string { return label })
	line := func(label, text string) string { return "  " + pad(label+":", width) + text }
	worker := report.Worker.Bin + " (" + report.Worker.Value + ")"
	if !report.Worker.OK {
		worker = report.Worker.Bin + ": FAILED: " + report.Worker.Error
	}
	optional := func(label string, check *app.StringResult) []string {
		if check == nil {
			return nil
		}
		if check.OK {
			return []string{line(label, check.Value)}
		}
		return []string{line(label, "FAILED: "+check.Error)}
	}
	var settings []string
	if report.Settings != nil {
		switch {
		case !report.Settings.OK:
			settings = []string{line("settings", "FAILED: "+report.Settings.Error)}
		case report.Settings.Changed:
			settings = []string{line("settings", report.Settings.Path+" (updated: "+report.Settings.Value+")")}
		default:
			settings = []string{line("settings", report.Settings.Path+" (already set)")}
		}
	}
	lines := []string{setupOutcomeLine(provider, report), line("runtime", report.Runtime), line(provider.WorkerLabel, worker)}
	for _, check := range report.Extra {
		lines = append(lines, line(check.Label, check.Text))
	}
	lines = append(lines, optional("ping", report.Ping)...)
	lines = append(lines, optional("router", report.Router)...)
	lines = append(lines, optional("models", report.Models)...)
	lines = append(lines, settings...)
	lines = append(lines, setupRestartLine(provider, report)...)
	return strings.Join(lines, "\n")
}

// setupOutcomeLine is the answer, before any detail: ready (and what that gives), set up but not
// routed (and the fix), or not ready.
func setupOutcomeLine(provider domain.Provider, report setupReport) string {
	name, catalog, agentPrefix, agents := provider.Name, provider.Catalog, provider.AgentPrefix, provider.Agents
	if report.Ready {
		return name + " setup: ready. " + catalog[domain.ModelTierMain].Label + " and " +
			catalog[domain.ModelTierFlash].Label + " are in /model; " +
			agentPrefix + agents[domain.ModelTierMain] + " and " +
			agentPrefix + agents[domain.ModelTierFlash] + " run on them."
	}
	if report.NotRouted != nil {
		return name + " setup: not routed. ANTHROPIC_BASE_URL in settings.json points at your own proxy (" +
			report.NotRouted.BaseURL + "), so " + provider.Display +
			" requests never reach the " + name + " router and its agents run on Sonnet. Point that proxy at " +
			report.NotRouted.RouterURL + ", or remove the entry and run " + provider.Slash + "setup again."
	}
	return name + " setup: not ready. The FAILED line below says why."
}

// setupRestartLine is Claude Code reading its settings when a session starts: this one keeps
// talking to Anthropic until it restarts.
func setupRestartLine(provider domain.Provider, report setupReport) []string {
	if !report.Ready || report.Changed == nil || !*report.Changed {
		return nil
	}
	return []string{"Restart Claude Code now. This session keeps talking to Anthropic until it restarts; " +
		provider.Catalog[domain.ModelTierMain].Label + " in /model and the " + provider.Name +
		" agents work from the next session."}
}

// renderRemove is the remove report.
func renderRemove(provider domain.Provider, settingsPath string, removed RoutingApplied) string {
	width := engineLabelWidth(setupRemoveLabels, func(label string) string { return label })
	line := func(label, text string) string { return "  " + pad(label+":", width) + text }
	settings := setupSettingsCheckOf(settingsPath, removed.Settings)
	clean := removed.Router.OK && removed.Agents.OK && settings.OK
	outcome := provider.Name + " removed, except for the FAILED line below."
	if clean {
		outcome = provider.Name + " removed: its agents are back on their models before setup, " +
			provider.Catalog[domain.ModelTierMain].Label + " and " + provider.Catalog[domain.ModelTierFlash].Label +
			" are out of /model, the router is retired and its stored key is removed. Open sessions keep working and new ones start without it; /plugin uninstall is safe now."
	}
	routerLine := removed.Router.Value
	if !removed.Router.OK {
		routerLine = "FAILED: " + removed.Router.Error
	}
	settingsLine := settings.Path + " (nothing to undo)"
	switch {
	case !settings.OK:
		settingsLine = "FAILED: " + settings.Error
	case settings.Changed:
		settingsLine = settings.Path + " (restored)"
	}
	return strings.Join([]string{
		outcome,
		line("router", routerLine),
		line("models", RestoredAgentText(removed)),
		line("settings", settingsLine),
	}, "\n")
}
