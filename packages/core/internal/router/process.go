// Starting, updating and stopping the router as one plain background process the plugin owns: the
// same code on macOS and Linux, no service manager. StartRouter is what setup, the
// SessionStart hook and the per-prompt ensure run. In order: retire a legacy OS service (only once
// the new router answers on the same port); probe the port, and never touch what someone else
// owns; take an atomic lock so concurrent hooks start exactly one router; copy this binary into
// the state root (always named plugin-core, mode from the source) so a plugin update or uninstall
// never deletes the running code; spawn it detached and wait for its health; fall back to the
// emergency passthrough when it will not start. A running router of an older version gets a hot
// update (its worker is re-pointed, the port never closes); one with another front protocol, the
// emergency passthrough, or a retired router, is handed over to a fresh front. When nothing of
// ours can hold the port, the base URL guard takes this router out of Claude Code's settings so
// the next session talks to Anthropic directly. RetireRouter is what setup --remove runs: the
// router keeps serving the sessions already open.
package router

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// ── where the router lives ──────────────────────────────────────────────────────────────────────────────────────────

// RegistryEntryFor is this plugin's registry entry: its resolved catalog ids (env overrides
// included) and the pid when it is known.
func RegistryEntryFor(provider domain.Provider, env domain.EnvLookup, pid *int64) RegisteredRouter {
	claim := domain.ResolveProvider(provider, env).ModelClaim()
	return RegisteredRouter{
		Name:          provider.Name,
		Port:          int64(domain.RouterPort(provider, env)),
		ModelPrefixes: claim.Prefixes,
		CatalogIds:    claim.IDs,
		Pid:           pid,
		UpdatedAt:     isoNow(),
	}
}

// BundleVersion is the binary's version: the first 12 hex digits of its SHA-256, so any change to
// the code is a new version.
func BundleVersion(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])[:12]
}

// routerBinaryName is the copied router binary's file name.
const routerBinaryName = "plugin-core"

// RouterFiles are the stable copies under `<state>/router`: the binary itself, always named
// plugin-core.
type RouterFiles struct {
	Dir     string
	Binary  string
	Version string
}

// routerSource is the binary the router's code is copied from: an explicit source (a test's
// fake), else the running executable with its symlinks resolved. After the release the plugin's
// only plugin-core lives under AGENTS_CORE_HOME/<version>, never beside the bundles, so the
// running binary is the one to copy.
func routerSource(source string) string {
	if source == "" {
		source, _ = os.Executable()
	}
	if resolved, err := filepath.EvalSymlinks(source); err == nil {
		return resolved
	}
	return source
}

// CopyRouterFiles copies the running binary into `<state>/router` (0700) when it differs, by temp
// file and rename, so a plugin update or uninstall that deletes the plugin cache never deletes the
// running router's code and a running process never reads a half-written file. The source is the
// binary at source — the running executable when empty — so a plugin with no binary beside its
// bundles still starts its router.
func CopyRouterFiles(ctx context.Context, source, stateRoot string) (RouterFiles, error) {
	dir := domain.NewStateLayout(stateRoot).RouterDir
	from := routerSource(source)
	to := filepath.Join(dir, routerBinaryName)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return RouterFiles{}, copyError(dir, err)
	}
	fresh, err := os.ReadFile(from)
	if err != nil {
		return RouterFiles{}, copyError(dir, errors.New(fsutil.NodeMessage(err, "open", from)))
	}
	same := false
	if current, err := os.ReadFile(to); err == nil {
		same = bytes.Equal(current, fresh)
	}
	if !same {
		// The source binary's own mode, which is 0755; anything odd still copies runnable.
		mode := fs.FileMode(0o755)
		if info, err := os.Stat(from); err == nil {
			mode = info.Mode().Perm()
		}
		if _, err := fsutil.WriteFileAtomic(ctx, to, fresh, fsutil.WriteOptions{Mode: fsutil.Perm(mode)}); err != nil {
			return RouterFiles{}, copyError(dir, err)
		}
	}
	return RouterFiles{Dir: dir, Binary: to, Version: BundleVersion(fresh)}, nil
}

// copyError is CopyRouterFiles's one failure shape, the underlying error's message included
// whole.
func copyError(dir string, err error) error {
	return fmt.Errorf("copying the router into %s failed: %s", dir, err.Error())
}

// ── probing the port ────────────────────────────────────────────────────────────────────────────────────────────────

// RouterHealth is what a health answer of ours carries; a nil field is one the answer left out.
type RouterHealth struct {
	OK           bool
	Name         string
	Provider     string
	Mode         *string
	Version      *string
	FrontVersion *int64
	Pid          *int64
}

// ProbeState is what the router port probes as: none (nothing listens), ours (our health
// answered), foreign (something else holds the port) or silent (something accepts connections but
// its health never answered).
type ProbeState string

const (
	ProbeNone    ProbeState = "none"
	ProbeOurs    ProbeState = "ours"
	ProbeForeign ProbeState = "foreign"
	ProbeSilent  ProbeState = "silent"
)

// Probe is one probe of the router port.
type Probe struct {
	State  ProbeState
	Health RouterHealth
}

// healthBodyShape is a health answer's optional fields as raw values, so a missing one and a
// mistyped one stay apart.
type healthBodyShape struct {
	OK           *bool           `json:"ok"`
	Name         *string         `json:"name"`
	Provider     *string         `json:"provider"`
	Mode         json.RawMessage `json:"mode"`
	Version      json.RawMessage `json:"version"`
	FrontVersion json.RawMessage `json:"frontVersion"`
	Pid          json.RawMessage `json:"pid"`
}

// OurHealth parses a health body; ours only when it carries our name and provider.
func OurHealth(body, name, display string) (RouterHealth, bool) {
	var shape healthBodyShape
	if err := json.Unmarshal([]byte(body), &shape); err != nil {
		return RouterHealth{}, false
	}
	if shape.OK == nil || !*shape.OK || shape.Name == nil || *shape.Name != name ||
		shape.Provider == nil || *shape.Provider != display {
		return RouterHealth{}, false
	}
	health := RouterHealth{OK: true, Name: *shape.Name, Provider: *shape.Provider}
	health.Mode = rawJSONString(shape.Mode)
	health.Version = rawJSONString(shape.Version)
	if raw := shape.FrontVersion; len(raw) > 0 {
		if value, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64); err == nil {
			health.FrontVersion = &value
		}
	}
	if raw := shape.Pid; len(raw) > 0 {
		if value, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64); err == nil {
			health.Pid = &value
		}
	}
	return health, true
}

// rawJSONString is a raw JSON value as a string, when it is one.
func rawJSONString(raw json.RawMessage) *string {
	text := ""
	if json.Unmarshal(raw, &text) == nil {
		return &text
	}
	return nil
}

// probeClient asks a router port, pooling its connections as any client does: a probe whose
// budget runs out has its context canceled, and a canceled request's connection is closed rather
// than reused, so a silent port still cannot leak a connection into the next probe.
var probeClient = &http.Client{Transport: &http.Transport{MaxIdleConnsPerHost: 4, IdleConnTimeout: 30 * time.Second}}

// fetchBody makes one loopback call and reads its whole body; every failure is one error.
func fetchBody(ctx context.Context, method, target, token string, body []byte) (int, []byte, error) {
	request, err := http.NewRequestWithContext(ctx, method, target, strings.NewReader(string(body)))
	if err != nil {
		return 0, nil, err
	}
	if token != "" {
		request.Header.Set(TokenHeader, token)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	answer, err := probeClient.Do(request)
	if err != nil {
		return 0, nil, err
	}
	text, readErr := io.ReadAll(answer.Body)
	closeErr := answer.Body.Close()
	return answer.StatusCode, text, errors.Join(readErr, closeErr)
}

// ProbeRouter probes the router port: a connect within connectMs (200 when 0), then the health
// path (1 s), whose body must name us.
func ProbeRouter(ctx context.Context, port int, provider domain.Provider, connectMs int64) Probe {
	if connectMs == 0 {
		connectMs = 200
	}
	if !process.PortAnswers(ctx, port, connectMs) {
		return Probe{State: ProbeNone}
	}
	checkCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	state, health := probeHealth(checkCtx, port, provider)
	return Probe{State: state, Health: health}
}

// probeHealth reads the health path once: ours, foreign, or silent when the probe times out (the
// budget ran out while something kept accepting).
func probeHealth(ctx context.Context, port int, provider domain.Provider) (ProbeState, RouterHealth) {
	status, body, err := fetchBody(ctx, http.MethodGet,
		fmt.Sprintf("http://127.0.0.1:%d%s", port, provider.Router.HealthPath), "", nil)
	if err != nil {
		// The connect worked, so the deadline running out means something accepts but never
		// answers; any other failure is a foreign holder.
		state := ProbeForeign
		if ctx.Err() == context.DeadlineExceeded {
			state = ProbeSilent
		}
		return state, RouterHealth{}
	}
	if status >= 200 && status < 300 {
		if health, ok := OurHealth(string(body), provider.Name, provider.Display); ok {
			return ProbeOurs, health
		}
	}
	return ProbeForeign, RouterHealth{}
}

// ── spawning ────────────────────────────────────────────────────────────────────────────────────────────────────────

// DetachedChild is a spawned router process as the starter sees it: its pid, whether it exited,
// and how to end it.
type DetachedChild interface {
	Pid() int64
	Exited() bool
	Kill()
}

// SpawnDetached spawns the binary with args, detached from the caller, its output in the log file.
type SpawnDetached func(binary string, args []string, env map[string]string, logFile string) DetachedChild

// spawnRouterDetached is the production spawn: the binary in its own session and group, no longer
// the caller's child, its output appended to the router log.
func spawnRouterDetached(binary string, args []string, env map[string]string, logFile string) DetachedChild {
	return detachedChild{process.StartDetached(binary, args, process.DetachedOptions{Env: environOf(env), LogFile: logFile})}
}

// detachedChild is the adapters' Detached as the starter's interface.
type detachedChild struct {
	inner process.Detached
}

func (c detachedChild) Pid() int64   { return c.inner.Pid }
func (c detachedChild) Exited() bool { return c.inner.Exited() }
func (c detachedChild) Kill()        { c.inner.Kill() }

// childExactSet is the environment the router child keeps as-is: its home and path, its locale,
// its temp dirs, its certificates, the state dirs the router reads (Claude's, Radar's, the peers')
// and the provider's key.
func childExactSet(provider domain.Provider) map[string]bool {
	exact := map[string]bool{
		"HOME": true, "PATH": true, "TMPDIR": true, "TEMP": true, "TMP": true,
		"LANG": true, "LC_ALL": true,
		"NODE_EXTRA_CA_CERTS": true, "SSL_CERT_FILE": true, "SSL_CERT_DIR": true,
		"NODE_USE_ENV_PROXY": true, "CLAUDE_CONFIG_DIR": true, "XDG_STATE_HOME": true,
		"XDG_CONFIG_HOME": true, "RADAR_HOME": true, "PROVIDER_ROUTERS_HOME": true,
	}
	for _, name := range provider.KeyEnv {
		exact[name] = true
	}
	return exact
}

// ChildEnv is the environment the router runs with: what it needs to find its state, its key and
// the network (the caller's proxy and certificate settings, in any case), and nothing else. A
// proxy naming a plugin router never passes: proxy mode puts the router in HTTPS_PROXY, and a
// child sending its own upstream requests through the router loops back into itself — the CA
// variable goes with it, since it was set for that proxy's certificate.
func ChildEnv(provider domain.Provider, env domain.EnvLookup, stateRoot string, extra map[string]string) map[string]string {
	exact := childExactSet(provider)
	out := map[string]string{}
	routerProxy := false
	for name, value := range env {
		if exact[name] || strings.EqualFold(name, "no_proxy") ||
			strings.HasPrefix(name, provider.EnvPrefix+"_") {
			out[name] = value
			continue
		}
		if strings.EqualFold(name, "http_proxy") || strings.EqualFold(name, "https_proxy") {
			if domain.IsPluginRouterProxy(value) {
				routerProxy = true
				continue
			}
			out[name] = value
		}
	}
	if routerProxy {
		delete(out, "NODE_EXTRA_CA_CERTS")
	}
	out[domain.RouterEnvName(provider, domain.RouterEnvKnobPort)] = strconv.Itoa(domain.RouterPort(provider, env))
	out[provider.EnvPrefix+"_STATE_DIR"] = stateRoot
	for name, value := range extra {
		out[name] = value
	}
	return ExemptLoopback(out)
}

// ── the starter ─────────────────────────────────────────────────────────────────────────────────────────────────────

// StartOptions is what one router start needs.
type StartOptions struct {
	Provider  domain.Provider
	Env       domain.EnvLookup
	StateRoot string
	// Source is the binary the router's code is copied from: the running executable when empty
	// (see routerSource). Tests inject a fake binary's path.
	Source string
	// Node names the engine the pid record carries; "" is this binary.
	Node         string
	Spawn        SpawnDetached
	Run          CommandRunner
	UID          int64
	BudgetMs     int64
	HealthWaitMs int64
	// Answers says whether a port accepts connections (the guard's check on another plugin's
	// router); nil is the connect check itself.
	Answers func(ctx context.Context, port int) bool
	// Say receives one line each for what the base URL guard did.
	Say func(line string)
}

// lockStaleMs is how old a router lock may be before a start takes it over without asking who
// holds it: no start lasts this long, and a holder whose pid cannot be read (an unreadable or
// empty lock) or whose command line cannot be read is judged by age alone.
const lockStaleMs = 10_000

// lockForeignMs is how old a router lock held by a live pid may be before a start asks who holds
// it: a holder the command line proves is no process of this plugin's is a pid the OS reused
// after a crash, and waiting lockStaleMs for it would spend a hook's whole budget three times
// over. A holder of ours may hold the lock for a whole start (its health wait alone is seconds),
// so it keeps the fresh-wait until the lock is older than any start.
const lockForeignMs = 3_000

// startCtx carries one start's decisions.
type startCtx struct {
	o        StartOptions
	port     int
	url      string
	deadline int64
	spawn    SpawnDetached
	node     string
}

// orDefault fills a zero option with its default.
func orDefault(value, fallback int64) int64 {
	if value == 0 {
		return fallback
	}
	return value
}

// nowMs is the wall clock, epoch milliseconds.
func nowMs() int64 { return time.Now().UnixMilli() }

// startNow is one start's context, its spawn and defaults resolved.
func startNow(o StartOptions) *startCtx {
	spawn := o.Spawn
	if spawn == nil {
		spawn = spawnRouterDetached
	}
	node := o.Node
	if node == "" {
		if self, err := os.Executable(); err == nil {
			node = self
		}
	}
	return &startCtx{
		o:        o,
		port:     domain.RouterPort(o.Provider, o.Env),
		url:      domain.RouterBaseURL(o.Provider, o.Env),
		deadline: nowMs() + orDefault(o.BudgetMs, 8000),
		spawn:    spawn,
		node:     node,
	}
}

// waitOurs waits for our health on the port until the deadline, giving up early when the child
// exits.
func waitOurs(ctx context.Context, c *startCtx, port int, child DetachedChild, until int64) (RouterHealth, bool) {
	for {
		probe := ProbeRouter(ctx, port, c.o.Provider, 100)
		if probe.State == ProbeOurs {
			return probe.Health, true
		}
		if (child != nil && child.Exited()) || nowMs() >= until {
			return RouterHealth{}, false
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// StartRouter brings the router up on this plugin's port, one way or another; the string says how,
// the error why not.
func StartRouter(ctx context.Context, o StartOptions) (string, error) {
	c := startNow(o)
	line, err := bringUp(ctx, c)
	GuardSettings(ctx, o, err == nil)
	return line, err
}

func bringUp(ctx context.Context, c *startCtx) (string, error) {
	o := c.o
	home := o.Env["HOME"]
	if home == "" {
		if userHome, err := os.UserHomeDir(); err == nil {
			home = userHome
		}
	}
	if legacy, found := FindLegacyService(o.Provider.Router.Label, home); found {
		started := "not started"
		var startErr error
		migrated := MigrateLegacyService(ctx, legacy, legacyRunner(ctx, o), func(ctx context.Context) bool {
			started, startErr = startFresh(ctx, c)
			return startErr == nil
		}, startUid(o))
		if startErr == nil {
			return fmt.Sprintf("%s; %s", started, migrated.Line), nil
		}
		return "", errors.New(migrated.Line)
	}
	probe := ProbeRouter(ctx, c.port, o.Provider, 0)
	switch probe.State {
	case ProbeForeign:
		return "", fmt.Errorf("port %d is held by another program; it was left alone and Claude Code no longer uses it", c.port)
	case ProbeSilent:
		return replaceSilent(ctx, c)
	case ProbeNone:
		return startFresh(ctx, c)
	default:
		return update(ctx, c, probe.Health)
	}
}

// legacyRunner is the start's command runner for the legacy migration: the injected one, else a
// real tool run under a 10 s timeout.
func legacyRunner(ctx context.Context, o StartOptions) CommandRunner {
	if o.Run != nil {
		return o.Run
	}
	return func(bin string, args []string) bool {
		timeoutMs := int64(10_000)
		return process.Succeeded(process.RunToolSync(ctx, bin, args, process.ToolOptions{TimeoutMs: &timeoutMs}))
	}
}

// startUid is the legacy migration's gui domain: the injected uid, else this process's.
func startUid(o StartOptions) int64 {
	uid := o.UID
	if uid == 0 {
		uid = max64(int64(os.Getuid()), 0)
	}
	return uid
}

// replaceSilent handles something that accepts on the port but never answers health: when the pid
// file says it is our router, it is hung and is replaced; anything else is left alone.
func replaceSilent(ctx context.Context, c *startCtx) (string, error) {
	o := c.o
	record, ok := ReadPidFile(ctx, o.StateRoot)
	if !ok || record.Port != int64(c.port) || !IsOurProcess(record.Pid, o.Provider.Name, nil) {
		return "", fmt.Errorf("port %d accepts connections but does not answer; it was left alone", c.port)
	}
	signalPid(record.Pid, "SIGKILL")
	time.Sleep(100 * time.Millisecond)
	return startFresh(ctx, c)
}

// signalPid (in the front_signal halves) sends the signal to one pid and reports whether a
// process is there to receive it.

// update handles a router of ours that already runs: nothing to do, a hot update (same front
// protocol, another version), or a handover (another front protocol, the emergency passthrough, or
// a retired router).
func update(ctx context.Context, c *startCtx, health RouterHealth) (string, error) {
	o := c.o
	if health.Mode != nil && *health.Mode == "retired" {
		return takeOverRetired(ctx, c, health)
	}
	files, err := CopyRouterFiles(ctx, o.Source, o.StateRoot)
	if err != nil {
		return fmt.Sprintf("running on %s (already running; %s)", c.url, err.Error()), nil
	}
	notEmergency := health.Mode == nil || *health.Mode != "emergency"
	if notEmergency && health.FrontVersion != nil && *health.FrontVersion == FrontVersion {
		if health.Version != nil && *health.Version == files.Version {
			return fmt.Sprintf("running on %s (already running)", c.url), nil
		}
		record, ok := ReadPidFile(ctx, o.StateRoot)
		if !ok {
			return fmt.Sprintf("running on %s (already running; no pid file to update it with)", c.url), nil
		}
		reloaded, reached := control(ctx, c.port, o.Provider.Router.HealthPath, record.Token, "reload", []byte(marshalCompact(struct {
			Exec    string `json:"exec"`
			Version string `json:"version"`
		}{Exec: files.Binary, Version: files.Version})), 2000)
		if !reached || reloaded.OK == nil || !*reloaded.OK {
			return fmt.Sprintf("running on %s (already running; the update was refused)", c.url), nil
		}
		record.Version = files.Version
		if err := WritePidFile(ctx, o.StateRoot, record); err != nil {
			return "", err
		}
		return fmt.Sprintf("running on %s (updated to %s without closing the port)", c.url, files.Version), nil
	}
	what := "an older front"
	if !notEmergency {
		what = "the emergency passthrough"
	}
	return handover(ctx, c, files, what)
}

// takeOverRetired handles a retired router holding the port (the plugin was removed, then set up
// again): a fresh front takes the port over by the handover, so the sessions it still serves never
// see the port close. Without a record to hand over with, the retired router is stopped and a
// fresh one started.
func takeOverRetired(ctx context.Context, c *startCtx, health RouterHealth) (string, error) {
	o := c.o
	files, err := CopyRouterFiles(ctx, o.Source, o.StateRoot)
	if err != nil {
		return "", fmt.Errorf("a retired router holds %s, and %s", c.url, err.Error())
	}
	if old, ok := ReadRetiredFile(ctx, o.StateRoot); ok {
		return handOverRetiredRecord(ctx, c, files, old)
	} else if old, ok := ReadPidFile(ctx, o.StateRoot); ok {
		return handOverRetiredRecord(ctx, c, files, old)
	}
	if health.Pid == nil || !IsOurProcess(*health.Pid, o.Provider.Name, nil) {
		return "", fmt.Errorf("a retired router holds %s and cannot be identified; it was left alone", c.url)
	}
	signalPid(*health.Pid, "SIGTERM")
	until := max64(c.deadline, nowMs()+3000)
	for ProbeRouter(ctx, c.port, o.Provider, 100).State != ProbeNone {
		if nowMs() >= until {
			return "", fmt.Errorf("the retired router on %s did not stop", c.url)
		}
		time.Sleep(50 * time.Millisecond)
	}
	return startFresh(ctx, c)
}

// handOverRetiredRecord hands the port over with the record the retired router left (the retired
// one, or a pid record it never moved aside) and drops the retired record once replaced.
func handOverRetiredRecord(ctx context.Context, c *startCtx, files RouterFiles, old PidRecord) (string, error) {
	handed, err := handoverWith(ctx, c, files, "a retired router", old)
	if err == nil && handed.replaced {
		RemoveRetiredFile(c.o.StateRoot)
		return handed.line, nil
	}
	if err == nil {
		err = fmt.Errorf("a retired router holds the port: %s", handed.line)
	}
	return "", err
}

// controlCall is one control call in flight or done: its answer, and whether it reached the
// router at all.
type controlCall struct {
	answer  controlAnswer
	reached bool
}

// controlAnswer is one control call's answer: ok when the call reached the router and its body
// parsed.
type controlAnswer struct {
	OK      *bool
	reached bool
}

// control makes one control call to a router; reached is false when it cannot be reached.
func control(ctx context.Context, port int, healthPath, token, action string, body []byte, ms int64) (controlAnswer, bool) {
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(ms)*time.Millisecond)
	defer cancel()
	_, text, err := fetchBody(callCtx, http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d%s/%s", port, healthPath, action), token, body)
	if err != nil {
		return controlAnswer{}, false
	}
	var parsed struct {
		OK *bool `json:"ok"`
	}
	if json.Unmarshal(text, &parsed) != nil {
		return controlAnswer{}, false
	}
	return controlAnswer{OK: parsed.OK, reached: true}, true
}

// FreePort is a free loopback port for the new front to prove itself on before it takes the real
// one. A listen that cannot be made is port 0 with the error, never a silently random port.
func FreePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	port := 0
	if err == nil {
		port = listener.Addr().(*net.TCPAddr).Port
		_ = listener.Close()
	}
	return port, err
}

// handover restarts the front without the port ever being free for long. Without the running
// router's record there is no token to tell it to let go, so it stays.
func handover(ctx context.Context, c *startCtx, files RouterFiles, what string) (string, error) {
	old, ok := ReadPidFile(ctx, c.o.StateRoot)
	if !ok {
		return fmt.Sprintf("running on %s (%s; no pid file to hand it over with)", c.url, what), nil
	}
	handed, err := handoverWith(ctx, c, files, what, old)
	if err == nil && (handed.replaced || handed.kept) {
		return handed.line, nil
	}
	if err == nil {
		err = errors.New(handed.line)
	}
	return "", err
}

// handedOver is a handover's outcome: replaced (the new front holds the port), kept (the old one
// stays), or neither (failed).
type handedOver struct {
	replaced bool
	kept     bool
	line     string
}

// handoverWith is the handover itself: the new front starts on a temporary port and must answer
// health there; then it is told to take the real port (retrying the bind for up to 2 s) while the
// old one stops accepting and finishes its streams. If the new front never comes up, the old one
// is left running.
func handoverWith(ctx context.Context, c *startCtx, files RouterFiles, what string, old PidRecord) (handedOver, error) {
	o := c.o
	temporary, err := FreePort()
	if err != nil {
		return handedOver{}, err
	}
	token := randomToken()
	child := c.spawn(files.Binary, []string{o.Provider.Name, "router", "run"},
		ChildEnv(o.Provider, o.Env, o.StateRoot, map[string]string{
			o.Provider.EnvPrefix + "_ROUTER_LISTEN_PORT": strconv.Itoa(temporary),
			o.Provider.EnvPrefix + "_ROUTER_TOKEN":       token,
		}), domain.NewStateLayout(o.StateRoot).RouterLog)
	if _, ok := waitOurs(ctx, c, temporary, child, max64(c.deadline, nowMs()+3000)); !ok || child.Pid() == 0 {
		child.Kill()
		return handedOver{
			kept: true,
			line: fmt.Sprintf("running on %s (%s; the new router did not start, so the running one stays)", c.url, what),
		}, nil
	}
	// The adopt runs while the old front is told to hand over: it retries the bind until the old
	// one lets go.
	adopting := make(chan controlCall, 1)
	go func() {
		answer, reached := control(ctx, temporary, o.Provider.Router.HealthPath, token, "adopt", []byte("{}"), 4000)
		adopting <- controlCall{answer: answer, reached: reached}
	}()
	_, _ = control(ctx, c.port, o.Provider.Router.HealthPath, old.Token, "handover", []byte("{}"), 2000)
	adopted := <-adopting
	if !adopted.reached || adopted.answer.OK == nil || !*adopted.answer.OK {
		child.Kill()
		return handedOver{line: "handing " + c.url + " over to a new router failed"}, nil
	}
	if err := WritePidFile(ctx, o.StateRoot, newPidRecord(child.Pid(), int64(c.port), files.Version, c.node, PidModeRouter, token)); err != nil {
		return handedOver{}, err
	}
	return handedOver{
		replaced: true,
		line:     fmt.Sprintf("running on %s (replaced %s, pid %d)", c.url, what, child.Pid()),
	}, nil
}

// randomToken is a control token: 16 random bytes as hex.
func randomToken() string {
	raw := make([]byte, 16)
	rand.Read(raw)
	return hex.EncodeToString(raw)
}

// newPidRecord is the pid file's record for a router the starter just brought up.
func newPidRecord(pid, port int64, version, node string, mode PidMode, token string) PidRecord {
	return PidRecord{
		Pid:          pid,
		Port:         port,
		StartedAt:    isoNow(),
		Node:         node,
		Version:      version,
		FrontVersion: FrontVersion,
		Mode:         mode,
		Token:        token,
	}
}

// takeLock takes `<state>/router.lock` (atomic create). A lock whose holder is gone — the pid
// inside names no live process; a power loss or a crash left it behind — is taken over at once.
// A lock whose live holder the command line proves is no process of this plugin's (the OS reused
// a dead holder's pid) is taken over once older than lockForeignMs. Every other lock is waited
// for while fresh and taken over once older than lockStaleMs: a live holder is never signalled,
// and its pid alone never identifies it, because the setup path holds this lock in-process from
// a command line that names no router (`read` nil is the real command line).
func takeLock(ctx context.Context, path, name string, read func(int64) (string, bool)) bool {
	for attempt := 0; attempt < 2; attempt++ {
		created, err := adapters.CreateExclusive(ctx, path, fmt.Sprintf("%d\n", os.Getpid()))
		if err != nil {
			return false
		}
		if created {
			return true
		}
		holder, hasHolder := pidNamedBy(path)
		if hasHolder && !process.IsAlive(holder) {
			_ = os.Remove(path)
			continue
		}
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		age := nowMs() - info.ModTime().UnixMilli()
		if age > lockForeignMs && hasHolder {
			if ours, identified := lockHolderIsOurs(holder, name, read); identified && !ours {
				_ = os.Remove(path)
				continue
			}
		}
		if age <= lockStaleMs {
			return false
		}
		_ = os.Remove(path)
	}
	return false
}

// lockHolderIsOurs is whether the pid a start lock names is a process of this plugin: one of its
// router processes (IsOurProcess), or its setup, which holds the lock in-process from the
// launcher's command line `plugin-core <name> cli setup`, naming no router. identified is false
// when the command line cannot be read: the holder is then never taken for a stranger on missing
// evidence — only the lock's age may end the wait.
func lockHolderIsOurs(pid int64, name string, read func(int64) (string, bool)) (ours, identified bool) {
	if read == nil {
		read = func(pid int64) (string, bool) { return CommandLineOf(context.Background(), pid) }
	}
	command, ok := read(pid)
	if !ok {
		return false, false
	}
	asRead := func(int64) (string, bool) { return command, true }
	return IsOurProcess(pid, name, asRead) || strings.Contains(command, name+" cli setup"), true
}

// pidNamedBy is the pid a state file names, when it names one: the start lock, a session's watch
// guard, the exit marker.
func pidNamedBy(path string) (int64, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	pid, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
	if err != nil || pid <= 0 {
		return 0, false
	}
	return pid, true
}

// startFresh starts the router on a port nothing holds (or waits for the starter that holds the
// lock), else the emergency passthrough.
func startFresh(ctx context.Context, c *startCtx) (string, error) {
	o := c.o
	if err := os.MkdirAll(o.StateRoot, 0o700); err != nil {
		return "", err
	}
	layout := domain.NewStateLayout(o.StateRoot)
	lock := layout.RouterLock
	if !takeLock(ctx, lock, o.Provider.Name, nil) {
		if _, ok := waitOurs(ctx, c, c.port, nil, max64(c.deadline, nowMs()+3000)); !ok {
			return "", errors.New("another start of the router holds the lock and did not bring it up")
		}
		return fmt.Sprintf("running on %s (started by another session)", c.url), nil
	}
	defer func() { _ = os.Remove(lock) }()
	sweepStaleTemps(o.StateRoot)
	sweepStaleTemps(layout.RouterDir)
	// Re-probe under the lock: a starter that just finished may already have it up.
	again := ProbeRouter(ctx, c.port, o.Provider, 0)
	if again.State == ProbeOurs {
		return fmt.Sprintf("running on %s (started by another session)", c.url), nil
	}
	if again.State != ProbeNone {
		return "", fmt.Errorf("port %d is held by another program; it was left alone and Claude Code no longer uses it", c.port)
	}
	files, err := CopyRouterFiles(ctx, o.Source, o.StateRoot)
	if err != nil {
		return startEmergencyFrom(ctx, c, nil, err.Error())
	}
	token := randomToken()
	child := c.spawn(files.Binary, []string{o.Provider.Name, "router", "run"},
		ChildEnv(o.Provider, o.Env, o.StateRoot, map[string]string{
			o.Provider.EnvPrefix + "_ROUTER_TOKEN": token,
		}), layout.RouterLog)
	until := min64(nowMs()+orDefault(o.HealthWaitMs, 3000), c.deadline-1500)
	health, ok := waitOurs(ctx, c, c.port, child, until)
	if ok && health.Pid != nil && *health.Pid == child.Pid() && child.Pid() != 0 {
		if err := WritePidFile(ctx, o.StateRoot, newPidRecord(child.Pid(), int64(c.port), files.Version, c.node, PidModeRouter, token)); err != nil {
			return "", err
		}
		return fmt.Sprintf("running on %s (pid %d)", c.url, child.Pid()), nil
	}
	if ok {
		return fmt.Sprintf("running on %s (started by another session)", c.url), nil
	}
	child.Kill()
	return startEmergencyFrom(ctx, c, &files, "the router did not start")
}

// startEmergencyFrom is the emergency passthrough: Claude traffic keeps flowing even when the main
// router cannot start.
func startEmergencyFrom(ctx context.Context, c *startCtx, files *RouterFiles, why string) (string, error) {
	o := c.o
	script := routerSource(o.Source)
	version := "emergency"
	if files != nil {
		script = files.Binary
		version = files.Version
	}
	token := randomToken()
	child := c.spawn(script, []string{o.Provider.Name, "passthrough"},
		ChildEnv(o.Provider, o.Env, o.StateRoot, map[string]string{
			o.Provider.EnvPrefix + "_ROUTER_TOKEN": token,
		}), domain.NewStateLayout(o.StateRoot).RouterLog)
	health, ok := waitOurs(ctx, c, c.port, child, max64(c.deadline, nowMs()+1500))
	if !ok || child.Pid() == 0 || health.Mode == nil || *health.Mode != "emergency" {
		child.Kill()
		return "", fmt.Errorf("%s, and neither did the emergency passthrough (see %s)", why, domain.NewStateLayout(o.StateRoot).RouterLog)
	}
	if err := WritePidFile(ctx, o.StateRoot, newPidRecord(child.Pid(), int64(c.port), version, c.node, PidModeEmergency, token)); err != nil {
		return "", err
	}
	return fmt.Sprintf("running on %s as the emergency passthrough (%s): Claude models work, %s models do not until the next start",
		c.url, why, o.Provider.Display), nil
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// ── the settings guard ───────────────────────────────────────────────────────────────────────────────────────────────

// GuardSettings keeps Claude Code's settings on something that answers: a proxy or base URL naming
// this router when the router could not be brought up, or naming another plugin's router that is
// dead and no longer registered (that plugin was uninstalled), is repointed at a live plugin
// router or removed. Anything that is not one of the plugin routers is never touched. Says one
// line when it changed something: the running session keeps its settings until restarted.
func GuardSettings(ctx context.Context, o StartOptions, up bool) {
	path := adapters.ClaudeSettingsPath(o.Env)
	settings, ok := adapters.ReadProxySettings(path)
	if !ok {
		return
	}
	ours := domain.RouterBaseURL(o.Provider, o.Env)
	// The proxy keys first: proxy mode is the default. A proxy that is not a plugin router's is
	// the user's own, and base-URL mode is what they run on — its base URL is guarded below.
	if settings.HTTPSProxy != nil && domain.IsPluginRouterProxy(*settings.HTTPSProxy) {
		guardOne(ctx, o, path, *settings.HTTPSProxy, ours, up, adapters.ClearProxy)
		return
	}
	if settings.BaseURL != nil {
		guardOne(ctx, o, path, *settings.BaseURL, ours, up, adapters.ClearBaseUrl)
	}
}

// guardOne clears one routing entry (ClearProxy or ClearBaseUrl) when its value names a plugin
// router that is dead — this one that could not be brought up, or another plugin's that is no
// longer registered and answers nothing — and says one line when it did.
func guardOne(ctx context.Context, o StartOptions, path, value, ours string, up bool,
	clear func(ctx context.Context, path, routerURL string, others []string, name string) ([]string, error)) {
	dead := false
	if value == ours {
		dead = !up
	} else if domain.IsPluginRouterURL(value) {
		port := domain.PortOf(value)
		registered := false
		for _, entry := range ReadRegistry(o.Env) {
			if entry.Port == port {
				registered = true
				break
			}
		}
		answers := o.Answers
		if answers == nil {
			answers = func(ctx context.Context, port int) bool { return process.PortAnswers(ctx, port, 200) }
		}
		dead = !registered && !answers(ctx, int(port))
	}
	if !dead {
		return
	}
	var others []string
	for _, entry := range LiveRouters(ctx, o.Env, o.Provider.Name, nil) {
		url := fmt.Sprintf("http://127.0.0.1:%d", entry.Port)
		if url != value {
			others = append(others, url)
		}
	}
	lines, err := clear(ctx, path, value, others, o.Provider.Name)
	if err != nil || len(lines) == 0 || o.Say == nil {
		return
	}
	why := fmt.Sprintf("the router at %s is gone", value)
	if value == ours {
		why = "the router could not start"
	}
	o.Say(fmt.Sprintf("%s: %s; %s. Restart Claude Code sessions that still fail to connect.",
		o.Provider.Name, why, strings.Join(lines, "; ")))
}

// ── stop and status ─────────────────────────────────────────────────────────────────────────────────────────────────

// CommandLineOf is a pid's command line (/proc, else `ps`), or false when neither can say.
func CommandLineOf(ctx context.Context, pid int64) (string, bool) {
	line, ok := procCmdline(fmt.Sprintf("/proc/%d/cmdline", pid))
	if !ok {
		line, ok = psCmdline(ctx, pid)
	}
	return line, ok
}

// procCmdline is one /proc cmdline file: NUL-separated argv as one line (the trailing NUL becomes
// a trailing space).
func procCmdline(path string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return strings.Join(strings.Split(string(data), "\x00"), " "), true
}

// psCmdline is the ps fallback: the pid's command as `ps -p <pid> -o command=` reports it.
func psCmdline(ctx context.Context, pid int64) (string, bool) {
	timeoutMs := int64(2000)
	answer := process.RunToolSync(ctx, "ps", []string{"-p", strconv.FormatInt(pid, 10), "-o", "command="}, process.ToolOptions{TimeoutMs: &timeoutMs})
	if !process.Succeeded(answer) {
		return "", false
	}
	return strings.TrimSpace(string(answer.Stdout)), true
}

// parentPidOf is a pid's parent, from `ps -p <pid> -o ppid=`; false when ps cannot say (the
// process is gone).
func parentPidOf(ctx context.Context, pid int64) (int64, bool) {
	timeoutMs := int64(2000)
	answer := process.RunToolSync(ctx, "ps", []string{"-p", strconv.FormatInt(pid, 10), "-o", "ppid="}, process.ToolOptions{TimeoutMs: &timeoutMs})
	if !process.Succeeded(answer) {
		return 0, false
	}
	parent, err := strconv.ParseInt(strings.TrimSpace(string(answer.Stdout)), 10, 64)
	if err != nil || parent <= 0 {
		return 0, false
	}
	return parent, true
}

// IsOurProcess is true when the pid runs one of this plugin's router processes: this binary as
// plugin-core (`<name> router run`, `<name> passthrough`), or the node bundle an earlier release
// still runs (kept so a migration can stop it). A nil read is the real command line.
func IsOurProcess(pid int64, name string, read func(int64) (string, bool)) bool {
	if read == nil {
		read = func(pid int64) (string, bool) { return CommandLineOf(context.Background(), pid) }
	}
	command, ok := read(pid)
	if !ok {
		return false
	}
	return strings.Contains(command, name+" router") ||
		strings.Contains(command, name+" passthrough") ||
		strings.Contains(command, name+"-router.js") ||
		strings.Contains(command, name+"-passthrough.js")
}

// StopOptions is what one router stop needs.
type StopOptions struct {
	Provider    domain.Provider
	Env         domain.EnvLookup
	StateRoot   string
	CommandLine func(pid int64) (string, bool)
}

// isOurPid is IsOurProcess with the options' command line reader (nil is the real one).
func isOurPid(ctx context.Context, o StopOptions, pid int64) bool {
	read := o.CommandLine
	if read == nil {
		read = func(pid int64) (string, bool) { return CommandLineOf(ctx, pid) }
	}
	return IsOurProcess(pid, o.Provider.Name, read)
}

// StopRouter stops the router (a retired one included): SIGTERM only a pid whose command line is
// one of ours; a stale pid file just goes.
func StopRouter(ctx context.Context, o StopOptions) string {
	record, hasRunning := ReadPidFile(ctx, o.StateRoot)
	if !hasRunning {
		record, hasRunning = ReadRetiredFile(ctx, o.StateRoot)
	}
	line := "stopped (was not running)"
	if hasRunning {
		if isOurPid(ctx, o, record.Pid) {
			if signalPid(record.Pid, "SIGTERM") {
				line = fmt.Sprintf("stopped (pid %d)", record.Pid)
			}
		} else {
			line = fmt.Sprintf("stopped (pid %d is not our router; removed the stale record)", record.Pid)
		}
	}
	RemovePidFile(o.StateRoot)
	RemoveRetiredFile(o.StateRoot)
	_ = os.Remove(domain.NewStateLayout(o.StateRoot).RouterExit)
	_ = os.Remove(domain.NewStateLayout(o.StateRoot).RouterLock)
	RemoveRegistryEntry(o.Env, o.Provider.Name)
	return line
}

// RetireOptions is the stop's own options under the retire step.
type RetireOptions struct {
	StopOptions
}

// retiredLineFor is the remove report's router line for a retired router.
func retiredLineFor(pid int64) string {
	return fmt.Sprintf("retired (pid %d): keeps Claude working in open sessions, exits when they close", pid)
}

// RetireRouter is setup --remove's router step. Claude Code sessions keep the base URL they
// started with, so stopping the router would cut every open session off: the router is told to
// retire instead (see front.go), and its record moves to `router.retired` so the hooks stop
// bringing it back while a later setup can still take the port over. A router that is already
// retired is left as it is. For the emergency passthrough, or when the retire call fails, the
// router is stopped instead.
func RetireRouter(ctx context.Context, o RetireOptions) string {
	record, ok := ReadPidFile(ctx, o.StateRoot)
	if !ok {
		if retired, hasRetired := ReadRetiredFile(ctx, o.StateRoot); hasRetired && isOurPid(ctx, o.StopOptions, retired.Pid) {
			return retiredLineFor(retired.Pid)
		}
		return StopRouter(ctx, o.StopOptions)
	}
	if record.Mode == PidModeEmergency || !isOurPid(ctx, o.StopOptions, record.Pid) {
		return StopRouter(ctx, o.StopOptions)
	}
	answer, reached := control(ctx, int(record.Port), o.Provider.Router.HealthPath, record.Token, "retire", []byte("{}"), 2000)
	if !reached || answer.OK == nil || !*answer.OK {
		return StopRouter(ctx, o.StopOptions)
	}
	if err := RetirePidFile(ctx, o.StateRoot, record); err != nil {
		return StopRouter(ctx, o.StopOptions)
	}
	_ = os.Remove(domain.NewStateLayout(o.StateRoot).RouterLock)
	RemoveRegistryEntry(o.Env, o.Provider.Name)
	return retiredLineFor(record.Pid)
}

// ClearRetiredRecord drops the retired router's record, unless it already names another process.
func ClearRetiredRecord(ctx context.Context, stateRoot string, pid int64) {
	if retired, ok := ReadRetiredFile(ctx, stateRoot); ok && retired.Pid == pid {
		RemoveRetiredFile(stateRoot)
	}
}

// keyCheckPollMs is how often RouterKeyCheck re-asks a router whose worker is still starting.
const keyCheckPollMs = 100

// RouterKeyCheck asks the running router whether its worker can read the provider key (the source,
// never the key), waiting up to waitMs (8 s when 0) for a worker that is still starting.
func RouterKeyCheck(ctx context.Context, provider domain.Provider, env domain.EnvLookup, stateRoot string, waitMs int64) (string, error) {
	record, ok := ReadPidFile(ctx, stateRoot)
	if !ok {
		return "", errors.New("no router is running")
	}
	// A router setup has just started answers before its worker is up: that is a wait, not a
	// failure.
	deadline := nowMs() + orDefault(waitMs, 8000)
	for {
		answer, err := askKey(ctx, provider, env, record.Token)
		if err == nil || err.Error() != NoWorker || nowMs() >= deadline {
			return answer, err
		}
		time.Sleep(keyCheckPollMs * time.Millisecond)
	}
}

// askKey makes one key check call; any failure is the same honest error.
func askKey(ctx context.Context, provider domain.Provider, env domain.EnvLookup, token string) (string, error) {
	callCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	_, text, err := fetchBody(callCtx, http.MethodGet,
		domain.RouterBaseURL(provider, env)+provider.Router.HealthPath+"/key", token, nil)
	if err != nil {
		return "", errors.New("the router did not answer the key check")
	}
	var parsed struct {
		OK     *bool           `json:"ok"`
		Source json.RawMessage `json:"source"`
		Error  json.RawMessage `json:"error"`
	}
	if json.Unmarshal(text, &parsed) != nil {
		return "", errors.New("the router did not answer the key check")
	}
	if parsed.OK != nil && *parsed.OK {
		if source := rawJSONString(parsed.Source); source != nil {
			return *source, nil
		}
	}
	if reason := rawJSONString(parsed.Error); reason != nil {
		return "", errors.New(*reason)
	}
	return "", errors.New("the router cannot read the key")
}

// RouterStatus is the status line: what runs on the port, and whether this session uses it.
func RouterStatus(ctx context.Context, provider domain.Provider, env domain.EnvLookup) (bool, string) {
	url := domain.RouterBaseURL(provider, env)
	probe := ProbeRouter(ctx, domain.RouterPort(provider, env), provider, 0)
	uses := "does not use"
	if env["ANTHROPIC_BASE_URL"] == url {
		uses = "uses"
	}
	what := "port held by another program"
	switch probe.State {
	case ProbeOurs:
		what = "running"
		if probe.Health.Mode != nil {
			what = fmt.Sprintf("running (%s)", *probe.Health.Mode)
		}
	case ProbeNone:
		what = "not running"
	}
	return probe.State == ProbeOurs, fmt.Sprintf("%s-router %s on %s; this session %s it", provider.Name, what, url, uses)
}
