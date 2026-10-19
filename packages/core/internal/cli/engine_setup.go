package cli

// `/<p>:setup:<engine>`: `setup --engine-check <tool>` does everything plain `setup` does, then
// checks the tool as the user set it up (binary on PATH, its version, a one-word smoke run on the
// tool's own login, provider and default model — never this plugin's provider) and changes nothing
// about the engine; `setup --engine-enable <tool> --watcher provider|sonnet` records the engine and
// the watcher the user picked and points the tool's wrapper agent at that model; `setup --engines`
// reads, changing nothing, what plain `/<p>:setup` asks from: whether setup ran, and each tool's
// binary and recorded watcher. The CLI never asks: the command files ask (what to set up, who
// watches), every time, and pass the answers. The SessionStart hook re-applies the recorded
// watchers.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/engines/zcode"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/render"
)

// engineSmokeTimeoutMs covers a cold first start of a tool, plus one short answer from whatever
// model it defaults to.
const engineSmokeTimeoutMs int64 = 120_000

// engineSmokePrompt is the one-word check the tool must answer.
const engineSmokePrompt = `This is a check that you run. Use no tools. End at once with a notes report whose summary is the one word "ok", with no findings and no open items.`

// engineWatchers are the answers "Who should watch <engine> runs?" offers.
var engineWatchers = []domain.Watcher{domain.WatcherProvider, domain.WatcherSonnet}

// EngineOptions are setup's internal engine flags, for the command files and tests; never
// documented as user arguments.
func EngineOptions() map[string]OptionSpec {
	return map[string]OptionSpec{
		"engines":       {Type: OptionTypeBoolean},
		"engine-check":  {Type: OptionTypeString},
		"engine-enable": {Type: OptionTypeString},
		"watcher":       {Type: OptionTypeString},
	}
}

// BaseSetup is plain setup's own run, reused as the first half of the engine check.
type BaseSetup = func(ctx context.Context, call Invocation) ExitCode

// EngineSetup is setup's engine flags; false when the call has none, so plain setup runs.
func EngineSetup(ctx context.Context, call Invocation, base BaseSetup) (ExitCode, bool) {
	if call.Flag("engines") {
		return engineStatus(call), true
	}
	if check := call.Text("engine-check"); check != nil {
		return engineCheck(ctx, call, *check, base), true
	}
	if enable := call.Text("engine-enable"); enable != nil {
		var watcher *string
		if text := call.Text("watcher"); text != nil {
			watcher = text
		}
		return engineEnable(ctx, call, *enable, watcher), true
	}
	if call.Text("watcher") != nil {
		return call.Usage("--watcher goes with --engine-enable"), true
	}
	return ExitOK, false
}

// ── --engines ────────────────────────────────────────────────────────────────────────────────

// engineStatusEntry is one tool as plain setup's menu offers it: found or not, enabled or not.
type engineStatusEntry struct {
	Engine domain.EngineTool `json:"engine"`
	Binary app.StringResult  `json:"binary"`
	// The recorded watcher while the engine is enabled, null while it is not.
	Watcher *domain.Watcher `json:"watcher"`
}

// engineStatus is what `/<p>:setup` asks from, read-only: whether setup ran, and every tool's
// status.
func engineStatus(call Invocation) ExitCode {
	for _, flag := range []string{"engine-check", "engine-enable", "watcher"} {
		if call.Text(flag) != nil {
			return call.Usage("--engines takes no other setup flag")
		}
	}
	deps := call.Deps()
	setup := ReadSetupDone(deps.Host.StateRoot)
	recorded := deps.EngineConfig.Read().Engines
	engines := make([]engineStatusEntry, 0, len(domain.ENGINE_TOOLS))
	for _, tool := range domain.ENGINE_TOOLS {
		entry := engineStatusEntry{
			Engine: tool,
			Binary: findEngineBinary(deps, tool),
			// Watcher: null while the engine is not enabled.
			Watcher: nil,
		}
		if setting, ok := recorded[tool]; ok {
			watcher := setting.Watcher
			entry.Watcher = &watcher
		}
		engines = append(engines, entry)
	}
	if call.Flag("json") {
		_ = call.JSON(struct {
			Setup   bool                `json:"setup"`
			Engines []engineStatusEntry `json:"engines"`
		}{setup, engines})
	} else {
		deps.Out.Line(renderEngineStatus(deps.Provider, setup, engines))
	}
	return ExitOK
}

// renderEngineStatus is the read-only menu.
func renderEngineStatus(provider domain.Provider, setup bool, engines []engineStatusEntry) string {
	width := engineLabelWidth(domain.ENGINE_TOOLS, func(tool domain.EngineTool) string {
		return string(tool)
	})
	setupLine := provider.Name + " setup: not run yet"
	if setup {
		setupLine = provider.Name + " setup: done"
	}
	lines := []string{setupLine}
	for _, entry := range engines {
		found := "not found: " + entry.Binary.Error
		if entry.Binary.OK {
			found = "installed (" + entry.Binary.Value + ")"
		}
		state := "not enabled"
		if entry.Watcher != nil {
			state = "enabled, watched by " + engineWatcherLabels(provider)[*entry.Watcher]
		}
		lines = append(lines, "  "+pad(string(entry.Engine)+":", width)+found+"; "+state)
	}
	return strings.Join(lines, "\n")
}

// ── --engine-check ───────────────────────────────────────────────────────────────────────────

// engineReport is one engine's setup lines; ready only when plain setup passed too.
type engineReport struct {
	Engine  domain.EngineTool `json:"engine"`
	Ready   bool              `json:"ready"`
	Binary  app.StringResult  `json:"binary"`
	Version app.StringResult  `json:"version"`
	// A one-word run of the tool on its own setup: proves it is logged in and configured.
	Smoke app.StringResult `json:"smoke"`
	// The recorded watcher, or null before the engine was first enabled.
	Watcher *domain.Watcher `json:"watcher"`
	// What the command's question offers, by answer.
	Watchers map[domain.Watcher]string `json:"watchers"`
}

func engineCheck(ctx context.Context, call Invocation, name string, base BaseSetup) ExitCode {
	if !domain.IsEngineTool(name) {
		return call.Usage("--engine-check takes omp, opencode, pi or zcode")
	}
	captured := engineCapturing(call)
	baseReady := base(ctx, captured.call) == ExitOK
	report := engineReportOf(ctx, call.Deps(), domain.EngineTool(name), baseReady)
	if call.Flag("json") {
		fields, _ := captured.json()
		merged, ok := fields.(setupJSONObject)
		if !ok {
			merged = setupJSONObject{}
		}
		merged = append(merged,
			setupJSONField{name: "ready", value: report.Ready},
			setupJSONField{name: "engine", value: report})
		_ = call.JSON(merged)
	} else {
		for _, line := range captured.lines {
			call.Deps().Out.Line(line)
		}
		call.Deps().Out.Line(renderEngineReport(call.Deps().Provider, report))
	}
	if report.Ready {
		return ExitOK
	}
	return ExitNotReady
}

// engineCapturing is the invocation plain setup runs with: its lines and its JSON kept for the
// combined report. The capture is shared by pointer: the deps the base runs with write into the
// same record the combined report reads.
func engineCapturing(call Invocation) *engineCaptured {
	captured := &engineCaptured{lines: []string{}, out: call.Deps().Out}
	deps := call.Deps()
	deps.Out = captured
	captured.call = capturedCall{deps: deps, Invocation: call}
	return captured
}

// engineCaptured holds what plain setup printed under the capture.
type engineCaptured struct {
	call      Invocation
	lines     []string
	jsonValue any
	out       ports.Output
}

// json is what plain setup's --json wrote, if anything.
func (c *engineCaptured) json() (any, bool) {
	return c.jsonValue, c.jsonValue != nil
}

// Line records an output line for the combined report.
func (c *engineCaptured) Line(text string) { c.lines = append(c.lines, text) }

// Error passes error lines through untouched.
func (c *engineCaptured) Error(text string) { c.out.Error(text) }

// capturedCall is the invocation whose JSON lands in the capture.
type capturedCall struct {
	Invocation
	deps app.Deps
}

// Deps is the captured one: its output records.
func (c capturedCall) Deps() app.Deps { return c.deps }

// JSON keeps the value for the combined report.
func (c capturedCall) JSON(value any) error {
	capture, ok := c.deps.Out.(*engineCaptured)
	if ok {
		capture.jsonValue = value
	}
	return nil
}

// engineReportOf is the tool's lines: the smoke run needs only the tool, so it runs whether plain
// setup passed or not.
func engineReportOf(ctx context.Context, deps app.Deps, tool domain.EngineTool, baseReady bool) engineReport {
	binary := findEngineBinary(deps, tool)
	version := app.StringResult{Error: "not run: no binary"}
	if binary.OK {
		version = engineVersionResult(ctx, binary.Value, tool, deps.Env)
	}
	worker := engineWorkerOf(deps, tool)
	linesOK := binary.OK && version.OK && worker != nil
	smoke := app.StringResult{Error: "not run: fix the lines above first"}
	if linesOK {
		smoke = engineSmokeRun(ctx, deps, worker, tool)
	}
	watcher := (*domain.Watcher)(nil)
	if setting, ok := deps.EngineConfig.Read().Engines[tool]; ok {
		value := setting.Watcher
		watcher = &value
	}
	return engineReport{
		Engine:   tool,
		Ready:    baseReady && linesOK && smoke.OK,
		Binary:   binary,
		Version:  version,
		Smoke:    smoke,
		Watcher:  watcher,
		Watchers: engineWatcherLabels(deps.Provider),
	}
}

// FindBinary is the tool's binary: an explicit path as given, a bare name the first executable
// match on PATH.
func FindBinary(bin string, path string) app.StringResult {
	var candidates []string
	if strings.Contains(bin, "/") {
		candidates = []string{bin}
	} else {
		for _, dir := range strings.Split(path, string(os.PathListSeparator)) {
			if dir != "" {
				candidates = append(candidates, filepath.Join(dir, bin))
			}
		}
	}
	for _, candidate := range candidates {
		if isExecutableFile(candidate) {
			return app.StringResult{OK: true, Value: candidate}
		}
	}
	if strings.Contains(bin, "/") {
		return app.StringResult{Error: bin + " is not an executable file"}
	}
	return app.StringResult{Error: bin + " is not on PATH"}
}

// isExecutableFile says whether path runs.
func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir() && info.Mode().Perm()&0o111 != 0
}

// engineNotConfigured is what a failed smoke run tells the user: the plugin does not set the tool
// up, the user does, once.
func engineNotConfigured(tool domain.EngineTool, reason string) app.StringResult {
	return app.StringResult{
		Error: reason + "; run " + string(tool) + " once and log in / configure it; the plugin uses it as it is",
	}
}

// engineSmokeRun is one tiny real run of the tool through its bridge, on the tool's own login,
// provider and default model (readonly, in the state root, a notes report). The plugin's provider
// plays no part; the line reports the model the tool says it used, and its numbers as the tool
// reports them.
func engineSmokeRun(ctx context.Context, deps app.Deps, worker ports.Worker, tool domain.EngineTool) app.StringResult {
	root := deps.Host.StateRoot
	started, err := worker.Start(ctx, ports.WorkerSpec{
		Cwd: root,
		// The tool ignores this: it runs on its own default model.
		Model:     deps.Provider.Catalog[deps.Provider.PingTier],
		Access:    ports.AccessReadonly,
		Prompt:    engineSmokePrompt,
		Session:   ports.WorkerSession{Kind: ports.SessionKindNew, Key: deps.Ids.SessionID()},
		Report:    app.BuiltinContract(domain.BuiltinReportNotes),
		AddDirs:   []string{},
		PassEnv:   map[string]string{},
		TimeoutMs: engineSmokeTimeoutMs,
		LogPath:   filepath.Join(root, "setup-"+string(tool)+"-smoke.jsonl"),
	})
	if err != nil {
		return engineNotConfigured(tool, app.DescribeWorkerError(deps.Provider, *asWorkerError(err)))
	}
	var events []domain.WorkerEvent
	for event := range started.Events() {
		events = append(events, event)
	}
	exit := started.Wait()
	result := domain.FinalizeWorker(events, domain.WorkerExit{
		Code: exit.Code, Signal: exit.Signal, StderrTail: exit.StderrTail,
	}, exit.Forced)
	if result.Outcome.Kind != domain.WorkerOutcomeCompleted {
		return engineNotConfigured(tool, render.OutcomeText(result.Outcome))
	}
	on := ""
	if result.Usage.Model != nil {
		on = " on " + *result.Usage.Model
	}
	return app.StringResult{OK: true, Value: fmt.Sprintf(
		"ok: %s answered%s (%s's own numbers: %s, %s)",
		string(tool), on, string(tool),
		render.Plural(result.Usage.Turns, "turn"), render.Usd(result.Usage.CostUSD))}
}

// asWorkerError carries a worker failure through the error interface.
func asWorkerError(err error) *ports.WorkerError {
	var worker *ports.WorkerError
	if errors.As(err, &worker) {
		return worker
	}
	return &ports.WorkerError{Kind: ports.WorkerErrorSpawnFailed, Message: err.Error()}
}

// engineWatcherLabels is the two answers to "Who should watch <engine> runs?", as the command
// offers them.
func engineWatcherLabels(provider domain.Provider) map[domain.Watcher]string {
	return map[domain.Watcher]string{
		domain.WatcherProvider: provider.Catalog[domain.ModelTierMain].Label + " (" + provider.Display + ")",
		domain.WatcherSonnet:   "Claude Sonnet",
	}
}

// renderEngineReport is the engine check's checklist.
func renderEngineReport(provider domain.Provider, report engineReport) string {
	engineLabels := []string{"binary", "version", "smoke", "watcher"}
	width := engineLabelWidth(engineLabels, func(label string) string { return label })
	line := func(label string, check app.StringResult) string {
		text := check.Value
		if !check.OK {
			text = "FAILED: " + check.Error
		}
		return "  " + pad(label+":", width) + text
	}
	watcher := "not chosen yet"
	if report.Watcher != nil {
		watcher = report.Watchers[*report.Watcher] + " (current)"
	}
	ready := "not ready"
	if report.Ready {
		ready = "ready"
	}
	return strings.Join([]string{
		provider.Name + " setup: " + string(report.Engine) + " engine",
		line("binary", report.Binary),
		line("version", report.Version),
		line("smoke", report.Smoke),
		line("watcher", app.StringResult{OK: true, Value: watcher}),
		ready,
	}, "\n")
}

// engineLabelWidth is the checklist's column: the longest label plus two.
func engineLabelWidth[T any](items []T, label func(T) string) int {
	width := 0
	for _, item := range items {
		if length := len(label(item)); length > width {
			width = length
		}
	}
	return width + 2
}

// pad spaces a label out to the column's width, as JS's padEnd did.
func pad(label string, width int) string {
	for len(label) < width {
		label += " "
	}
	return label
}

// ── --engine-enable ──────────────────────────────────────────────────────────────────────────

func engineEnable(ctx context.Context, call Invocation, name string, watcher *string) ExitCode {
	if !domain.IsEngineTool(name) {
		return call.Usage("--engine-enable takes omp, opencode, pi or zcode")
	}
	if watcher == nil || !engineIsWatcher(*watcher) {
		return call.Usage("--engine-enable needs --watcher provider or --watcher sonnet")
	}
	deps := call.Deps()
	tool := domain.EngineTool(name)
	binary := findEngineBinary(deps, tool)
	version := binary
	if binary.OK {
		version = engineVersionResult(ctx, binary.Value, tool, deps.Env)
	}
	blocker := binary
	if blocker.OK && !version.OK {
		blocker = version
	}
	if !blocker.OK {
		deps.Out.Error(deps.Provider.Name + ": cannot enable " + name + ": " + blocker.Error)
		return ExitNotReady
	}
	model := engineWatcherModel(deps.Provider, domain.Watcher(*watcher))
	agentFile := filepath.Join(AgentsDir(deps.BundlePath), name+".md")
	before, found, _ := adapters.ReadModelLine(agentFile)
	var beforeValue *string
	if found {
		beforeValue = &before
	}
	agent := engineApplyAgent(ctx, deps.BundlePath, tool, model)
	if agent.Error != "" {
		deps.Out.Error(deps.Provider.Name + ": cannot enable " + name + ": " + agent.Error)
		return ExitNotReady
	}
	RecordEngineAgentBefore(ctx, deps.Host.StateRoot, tool, agent.Changed, beforeValue)
	config := domain.WithEngine(deps.EngineConfig.Read(), tool, domain.EngineSetting{
		Watcher: domain.Watcher(*watcher),
		Version: version.Value,
		Path:    binary.Value,
	})
	deps.EngineConfig.Write(config)
	return engineReportEnabled(call, tool, domain.Watcher(*watcher), model)
}

// engineReportEnabled says what the enable did.
func engineReportEnabled(call Invocation, tool domain.EngineTool, watcher domain.Watcher, model string) ExitCode {
	provider := call.Deps().Provider
	agent := provider.AgentPrefix + string(tool)
	if call.Flag("json") {
		_ = call.JSON(struct {
			Engine  domain.EngineTool `json:"engine"`
			Enabled bool              `json:"enabled"`
			Watcher domain.Watcher    `json:"watcher"`
			Agent   string            `json:"agent"`
			Model   string            `json:"model"`
		}{tool, true, watcher, agent, model})
	} else {
		call.Deps().Out.Line(provider.Name + ": " + string(tool) + " enabled; " + agent + " runs on " +
			model + " (watcher: " + engineWatcherLabels(provider)[watcher] + ")")
	}
	return ExitOK
}

// engineIsWatcher says whether the value names a watcher.
func engineIsWatcher(value string) bool {
	for _, watcher := range engineWatchers {
		if string(watcher) == value {
			return true
		}
	}
	return false
}

// engineWatcherModel is the model the wrapper agent's `model:` line names: the provider's main
// model, or Sonnet.
func engineWatcherModel(provider domain.Provider, watcher domain.Watcher) string {
	if watcher == domain.WatcherProvider {
		return provider.Catalog[domain.ModelTierMain].ID
	}
	return "sonnet"
}

// engineApplyAgent rewrites the engine wrapper agent's first `model:` line; Changed says whether
// the file was rewritten, Error why it could not be.
func engineApplyAgent(ctx context.Context, bundlePath string, tool domain.EngineTool, model string) engineAgentResult {
	changed, err := adapters.WriteModelLine(ctx, filepath.Join(AgentsDir(bundlePath), string(tool)+".md"), &model)
	if err != nil {
		return engineAgentResult{Error: err.Error()}
	}
	return engineAgentResult{Applied: true, Changed: changed}
}

// engineAgentResult is one engine-agent application's answer: whether it applied, whether it
// changed the file, and the error line when it failed.
type engineAgentResult struct {
	Applied bool
	Changed bool
	Error   string
}

// ── SessionStart ─────────────────────────────────────────────────────────────────────────────

// WithEngineHook runs the setup hook, then re-applies each enabled engine's watcher a plugin
// update may have reset. Never fails.
func WithEngineHook(ctx context.Context, deps app.Deps, hook func(context.Context) ExitCode) ExitCode {
	code := hook(ctx)
	func() {
		defer func() {
			// A hook must never disturb the session it starts.
			_ = recover()
		}()
		if repaired := engineReapplyWatchers(deps, deps.EngineConfig.Read()); len(repaired) > 0 {
			deps.Out.Line(deps.Provider.Name + ": repaired — " + strings.Join(repaired, ", "))
		}
	}()
	return code
}

// engineReapplyWatchers repoints each enabled engine's wrapper agent at its recorded watcher's
// model: a provider watcher follows the main agent — it runs on the provider's model exactly while
// the routing hook keeps the main agent there, and falls back to Sonnet with it when the router is
// down or the key is gone.
func engineReapplyWatchers(deps app.Deps, config domain.EngineConfig) []string {
	main := deps.Provider.Catalog[domain.ModelTierMain].ID
	routed := false
	if model, _, read := adapters.ReadModelLine(
		filepath.Join(AgentsDir(deps.BundlePath), deps.Provider.Agents[domain.ModelTierMain]+".md")); read && model == main {
		routed = true
	}
	var repaired []string
	// engines.json's own key order, then any engine this process enabled without a rewrite
	// behind it.
	for _, tool := range adapters.ConfiguredOrder(config,
		adapters.FileEngineOrder(domain.NewStateLayout(deps.Host.StateRoot).Engines)) {
		setting, ok := config.Engines[tool]
		if !ok {
			continue
		}
		model := "sonnet"
		if setting.Watcher == domain.WatcherProvider && routed {
			model = main
		}
		applied := engineApplyAgent(context.Background(), deps.BundlePath, tool, model)
		if applied.Applied && applied.Changed {
			repaired = append(repaired, deps.Provider.AgentPrefix+string(tool)+" → "+model)
		}
	}
	return repaired
}

// findEngineBinary is the tool's binary: a readable zcode script counts as found, whatever its
// mode, the way the desktop app installs it, and a GUI executable maps to the CLI script it
// stands for.
func findEngineBinary(deps app.Deps, tool domain.EngineTool) app.StringResult {
	result := findEngineBinaryResult(deps, tool)
	if tool == domain.EngineToolZcode && result.OK {
		// zcode on PATH can be a symlink to the desktop app's GUI executable; the engine wiring
		// maps it too — this covers a lookup with no wiring behind it.
		if script := zcode.CLIScriptFor(result.Value); script != "" {
			result.Value = script
		}
	}
	return result
}

// findEngineBinaryResult is the binary as found, before the GUI-executable mapping.
func findEngineBinaryResult(deps app.Deps, tool domain.EngineTool) app.StringResult {
	bin := string(tool)
	if deps.Engines != nil {
		bin = deps.Engines.Bin(tool)
	}
	if tool == domain.EngineToolZcode && zcode.ReadableZcodeScript(bin) {
		return app.StringResult{OK: true, Value: bin}
	}
	path := ""
	if deps.Env != nil {
		path = deps.Env["PATH"]
	}
	return FindBinary(bin, path)
}

// engineWorkerOf is the tool's worker, nil where this process wired no engines.
func engineWorkerOf(deps app.Deps, tool domain.EngineTool) ports.Worker {
	if deps.Engines == nil {
		return nil
	}
	return deps.Engines.Worker(tool)
}

// engineVersionResult is what `<bin> --version` printed, zcode through its runner.
func engineVersionResult(ctx context.Context, bin string, tool domain.EngineTool, env map[string]string) app.StringResult {
	command, prefixArgs := bin, []string(nil)
	childEnv := []string(nil)
	if tool == domain.EngineToolZcode {
		command, prefixArgs = zcode.ZcodeCommand(bin)
		if len(prefixArgs) == 1 && zcode.ElectronApp(prefixArgs[0]) != "" {
			// The app's own Electron runs the CLI script as plain node; without these it starts
			// the GUI and dies.
			childEnv = zcode.RunnerEnv(domain.EnvLookup(env), prefixArgs[0])
		}
	}
	version, err := process.ToolVersion(ctx, command, prefixArgs, childEnv)
	if err != nil {
		return app.StringResult{Error: err.Error()}
	}
	return app.StringResult{OK: true, Value: version}
}
