package adapters

// The claude -p headless worker: the exact argv, the layered environment (allowlist, CLAUDE_*
// minus the denylist, brief env, provider values), and the stream-json reading, against the fake
// claude.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakeclaude"
)

const headlessSessionID = "11111111-2222-4333-8444-555555555555"

const headlessKey = "zai-test-key-0123456789abcdef"

const headlessConfigDir = "/state/claude-home"

// headlessLoadedKey is the loader's result for headlessKey: the value plus where it came from.
func headlessLoadedKey(context.Context) (ports.ProviderKey, *ports.WorkerError) {
	return ports.ProviderKey{Value: headlessKey, Source: "ZAI_API_KEY"}, nil
}

// headlessSpec is the reference spec; each override mutates its own copy.
func headlessSpec(overrides ...func(*ports.WorkerSpec)) ports.WorkerSpec {
	spec := ports.WorkerSpec{
		Cwd:       "/work/repo",
		Model:     testkit.ReferenceProvider.Catalog[domain.ModelTierMain],
		Access:    ports.AccessWrite,
		Prompt:    "Rename foo to bar everywhere.",
		Session:   ports.WorkerSession{Kind: ports.SessionKindNew, Key: headlessSessionID},
		Report:    headlessReport(`{"type":"object","properties":{"summary":{"type":"string"}}}`),
		AddDirs:   []string{},
		PassEnv:   map[string]string{},
		TimeoutMs: 60_000,
		LogPath:   "/tmp/zai-test/attempt-1.jsonl",
	}
	for _, override := range overrides {
		override(&spec)
	}
	return spec
}

func headlessReport(schema string) ports.ReportContract {
	return ports.ReportContract{
		Name:       "custom.json",
		JSONSchema: json.RawMessage(schema),
		Validate: func(report json.RawMessage) domain.ReportCheck {
			return domain.CheckReport(report, domain.ReportContract{Kind: domain.ReportContractFile})
		},
	}
}

// headlessParentEnv is a realistic orchestrator environment: allowlisted basics plus everything
// that must never reach a worker. A fresh map per call, so tests mutate their copy.
func headlessParentEnv() domain.EnvLookup {
	return domain.EnvLookup{
		"PATH":                   "/usr/bin:/bin",
		"HOME":                   "/home/dev",
		"LANG":                   "en_US.UTF-8",
		"LC_ALL":                 "en_US.UTF-8",
		"TERM":                   "xterm-256color",
		"SHELL":                  "/bin/zsh",
		"TMPDIR":                 "/tmp/dev",
		"USER":                   "dev",
		"LOGNAME":                "dev",
		"ANTHROPIC_API_KEY":      "sk-ant-orchestrator-secret",
		"ANTHROPIC_AUTH_TOKEN":   "orchestrator-oauth-token",
		"ANTHROPIC_BASE_URL":     "https://api.anthropic.com",
		"ANTHROPIC_MODEL":        "claude-opus",
		"CLAUDECODE":             "1",
		"CLAUDE_CODE_ENTRYPOINT": "cli",
		"CLAUDE_CONFIG_DIR":      "/home/dev/.claude",
		"CLAUDE_PLUGIN_ROOT":     "/home/dev/.claude/plugins/zai",
		"ZAI_API_KEY":            headlessKey,
		"ZAI_MAX_CONCURRENCY":    "3",
		"AWS_SECRET_ACCESS_KEY":  "aws-secret",
		"GITHUB_TOKEN":           "gh-secret",
	}
}

// headlessFlagValue is the value following flag in argv, when flag is there.
func headlessFlagValue(args []string, flag string) (string, bool) {
	for i, arg := range args {
		if arg == flag && i+1 < len(args) {
			return args[i+1], true
		}
	}
	return "", false
}

func headlessWantFlag(t *testing.T, args []string, flag, want string) {
	t.Helper()
	got, ok := headlessFlagValue(args, flag)
	if !ok || got != want {
		t.Fatalf("%s = %q (present %v), want %q", flag, got, ok, want)
	}
}

func headlessWantNoFlag(t *testing.T, args []string, flag string) {
	t.Helper()
	if _, ok := headlessFlagValue(args, flag); ok {
		t.Fatalf("argv carries %s: %q", flag, args)
	}
}

func TestBuildClaudeArgs(t *testing.T) {
	t.Run("always: -p, --output-format stream-json, --verbose, --include-partial-messages, --model per tier", func(t *testing.T) {
		glm := BuildClaudeArgs(headlessSpec())
		wantHead := []string{"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"}
		if len(glm) < 5 || !slices.Equal(glm[:5], wantHead) {
			t.Fatalf("argv head = %q, want %q", glm, wantHead)
		}
		headlessWantFlag(t, glm, "--model", "sonnet")
		// flash passes its full id, not the haiku alias: plan mode (readonly) resolves that alias to
		// sonnet, i.e. the main model.
		for _, access := range []ports.Access{ports.AccessWrite, ports.AccessExec, ports.AccessReadonly} {
			flash := testkit.ReferenceProvider.Catalog[domain.ModelTierFlash]
			args := BuildClaudeArgs(headlessSpec(func(s *ports.WorkerSpec) {
				s.Model = flash
				s.Access = access
			}))
			headlessWantFlag(t, args, "--model", flash.ID)
		}
	})
	t.Run("new session → --session-id <id>; resume → --resume <id> (never both)", func(t *testing.T) {
		fresh := BuildClaudeArgs(headlessSpec(func(s *ports.WorkerSpec) {
			s.Session = ports.WorkerSession{Kind: ports.SessionKindNew, Key: headlessSessionID}
		}))
		resumed := BuildClaudeArgs(headlessSpec(func(s *ports.WorkerSpec) {
			s.Session = ports.WorkerSession{Kind: ports.SessionKindResume, Key: headlessSessionID}
		}))

		headlessWantFlag(t, fresh, "--session-id", headlessSessionID)
		headlessWantNoFlag(t, fresh, "--resume")
		headlessWantFlag(t, resumed, "--resume", headlessSessionID)
		headlessWantNoFlag(t, resumed, "--session-id")
	})
	t.Run("--permission-mode from spec; --json-schema as compact JSON", func(t *testing.T) {
		schema := `{"type":"object","required":["summary"],"properties":{"summary":{"type":"string"}}}`
		bypass := BuildClaudeArgs(headlessSpec(func(s *ports.WorkerSpec) { s.Report = headlessReport(schema) }))
		plan := BuildClaudeArgs(headlessSpec(func(s *ports.WorkerSpec) { s.Access = ports.AccessReadonly }))

		headlessWantFlag(t, bypass, "--permission-mode", "bypassPermissions")
		headlessWantFlag(t, plan, "--permission-mode", "plan")
		headlessWantFlag(t, bypass, "--json-schema", `{"type":"object","required":["summary"],"properties":{"summary":{"type":"string"}}}`)
	})
	t.Run("--effort only when set; --max-budget-usd only when set; one --add-dir per dir", func(t *testing.T) {
		bare := BuildClaudeArgs(headlessSpec())
		high := "high"
		maxEffort := "max"
		budget := 2.5
		full := BuildClaudeArgs(headlessSpec(func(s *ports.WorkerSpec) {
			s.Effort = &high
			s.BudgetUSD = &budget
			s.AddDirs = []string{"/docs/a", "/docs/b"}
		}))

		headlessWantNoFlag(t, bare, "--effort")
		headlessWantNoFlag(t, bare, "--max-budget-usd")
		headlessWantNoFlag(t, bare, "--add-dir")
		headlessWantFlag(t, full, "--effort", "high")
		headlessWantFlag(t, BuildClaudeArgs(headlessSpec(func(s *ports.WorkerSpec) { s.Effort = &maxEffort })), "--effort", "max")
		headlessWantFlag(t, full, "--max-budget-usd", "2.5")
		wantTail := []string{"--add-dir", "/docs/a", "--add-dir", "/docs/b"}
		if len(full) < 4 || !slices.Equal(full[len(full)-4:], wantTail) {
			t.Fatalf("argv tail = %q, want %q", full, wantTail)
		}
	})
	t.Run("never contains the prompt or any env value", func(t *testing.T) {
		prompt := "PROMPT-MARKER do the work"
		one := 1.0
		low := "low"
		args := BuildClaudeArgs(headlessSpec(func(s *ports.WorkerSpec) {
			s.Prompt = prompt
			s.PassEnv = map[string]string{"NPM_TOKEN": "env-value-marker"}
			s.Effort = &low
			s.AddDirs = []string{"/x"}
			s.BudgetUSD = &one
		}))

		joined := strings.Join(args, "\n")
		if strings.Contains(joined, "PROMPT-MARKER") {
			t.Fatalf("argv carries the prompt: %q", joined)
		}
		if strings.Contains(joined, "env-value-marker") {
			t.Fatalf("argv carries an env value: %q", joined)
		}
	})
}

func TestClaudeWorkerPort(t *testing.T) {
	t.Run("each access maps to a permission mode: write and exec bypass permissions, readonly plans", func(t *testing.T) {
		var modes []string
		for _, access := range []ports.Access{ports.AccessWrite, ports.AccessExec, ports.AccessReadonly} {
			mode, _ := headlessFlagValue(BuildClaudeArgs(headlessSpec(func(s *ports.WorkerSpec) {
				s.Access = access
			})), "--permission-mode")
			modes = append(modes, mode)
		}
		want := []string{"bypassPermissions", "bypassPermissions", "plan"}
		if !slices.Equal(modes, want) {
			t.Fatalf("permission modes = %q, want %q", modes, want)
		}
	})
	t.Run("a session is missing only when a resume is answered with Claude Code's no-conversation line", func(t *testing.T) {
		tail := "No conversation found with session ID: " + headlessSessionID + "\n"
		resume := ports.WorkerSession{Kind: ports.SessionKindResume, Key: headlessSessionID}
		fresh := ports.WorkerSession{Kind: ports.SessionKindNew, Key: headlessSessionID}

		if !ClaudeSessionMissing(resume, tail) {
			t.Fatal("a resume answered with the no-conversation line must be session-missing")
		}
		if ClaudeSessionMissing(fresh, tail) {
			t.Fatal("a new session is never session-missing")
		}
		if ClaudeSessionMissing(resume, "fake claude: simulated crash\n") {
			t.Fatal("a crash is not a missing session")
		}
	})
	t.Run("caps: native schema, a budget, three efforts; the brief template names the claude flags", func(t *testing.T) {
		worker := NewClaudeHeadlessWorker(ClaudeHeadlessOptions{
			Provider:    testkit.ReferenceProvider,
			Bin:         "claude",
			ConfigDir:   headlessConfigDir,
			LoadKey:     headlessLoadedKey,
			ParentEnv:   domain.EnvLookup{},
			StopGraceMs: 5_000,
		})

		if !reflect.DeepEqual(worker.Caps(), ClaudeCaps) {
			t.Fatalf("caps = %+v, want %+v", worker.Caps(), ClaudeCaps)
		}
		caps := worker.Caps()
		if caps.Name != ports.WorkerNameClaudeHeadless || !caps.NativeSchema || !caps.Budget {
			t.Fatalf("caps flags = %+v", caps)
		}
		if !slices.Equal(caps.Efforts, []string{"low", "high", "max"}) {
			t.Fatalf("efforts = %q", caps.Efforts)
		}
		wantNotes := domain.BriefNotes{
			Effort:    "passed to claude --effort",
			AddDirs:   "passed as --add-dir",
			BudgetUSD: "passed as --max-budget-usd",
			Readonly:  "plan mode, read tools only",
		}
		if caps.BriefNotes != wantNotes {
			t.Fatalf("brief notes = %+v, want %+v", caps.BriefNotes, wantNotes)
		}
	})
	t.Run("preflight checks only the key: ok when it loads, the loader's error otherwise", func(t *testing.T) {
		options := ClaudeHeadlessOptions{
			Provider:    testkit.ReferenceProvider,
			Bin:         "/no/such/claude",
			ConfigDir:   headlessConfigDir,
			ParentEnv:   domain.EnvLookup{},
			StopGraceMs: 5_000,
		}
		keyed := NewClaudeHeadlessWorker(options)
		keyed.options.LoadKey = headlessLoadedKey
		noKey := func(context.Context) (ports.ProviderKey, *ports.WorkerError) {
			return ports.ProviderKey{}, &ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "no key"}
		}
		keyless := NewClaudeHeadlessWorker(options)
		keyless.options.LoadKey = noKey

		if err := keyed.Preflight(context.Background()); err != nil {
			t.Fatalf("preflight with a key = %v, want nil", err)
		}
		err := keyless.Preflight(context.Background())
		var workerErr *ports.WorkerError
		if !errors.As(err, &workerErr) || workerErr.Kind != ports.WorkerErrorNoKey || workerErr.Message != "no key" {
			t.Fatalf("preflight without a key = %v, want no_key", err)
		}
	})
	t.Run("parseLine reads stream-json lines; one it cannot read yields no events; dispose has nothing to release", func(t *testing.T) {
		worker := NewClaudeHeadlessWorker(ClaudeHeadlessOptions{
			Provider:    testkit.ReferenceProvider,
			Bin:         "claude",
			ConfigDir:   headlessConfigDir,
			LoadKey:     headlessLoadedKey,
			ParentEnv:   domain.EnvLookup{},
			StopGraceMs: 5_000,
		})
		model := "glm-5.3"
		want := []domain.WorkerEvent{{Kind: domain.WorkerEventInit, SessionID: "s1", Model: &model}}
		if got := worker.ParseLine(`{"type":"system","subtype":"init","session_id":"s1","model":"glm-5.3"}`); !reflect.DeepEqual(got, want) {
			t.Fatalf("parseLine = %+v, want %+v", got, want)
		}
		if got := worker.ParseLine("{not json"); len(got) != 0 {
			t.Fatalf("parseLine of a bad line = %+v, want none", got)
		}
		if err := worker.Dispose(context.Background()); err != nil {
			t.Fatalf("dispose = %v, want nil", err)
		}
	})
}

func TestBuildWorkerEnv(t *testing.T) {
	t.Run("copies only ENV_ALLOWLIST names from the parent", func(t *testing.T) {
		env := BuildWorkerEnv(testkit.ReferenceProvider, headlessSpec(), headlessKey, headlessParentEnv(), headlessConfigDir)

		parent := headlessParentEnv()
		delete(parent, "LC_ALL")
		withoutLcAll := BuildWorkerEnv(testkit.ReferenceProvider, headlessSpec(), headlessKey, parent, headlessConfigDir)

		for _, name := range ENV_ALLOWLIST {
			if env[name] != headlessParentEnv()[name] {
				t.Fatalf("%s = %q, want the parent's %q", name, env[name], headlessParentEnv()[name])
			}
		}
		if _, ok := withoutLcAll["LC_ALL"]; ok {
			t.Fatal("an unset LC_ALL must stay unset")
		}
		for _, name := range []string{"AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "ZAI_MAX_CONCURRENCY"} {
			if _, ok := env[name]; ok {
				t.Fatalf("%s leaked into the worker env", name)
			}
		}
	})
	t.Run("ENV_ALLOWLIST — all a gate process inherits from the parent — still contains no CLAUDE_* name", func(t *testing.T) {
		for _, name := range ENV_ALLOWLIST {
			if strings.HasPrefix(name, "CLAUDE") {
				t.Fatalf("ENV_ALLOWLIST carries %q", name)
			}
		}
	})
	t.Run("drops ANTHROPIC_API_KEY, the orchestrator's ANTHROPIC_AUTH_TOKEN, denied CLAUDE_* and plugin variables", func(t *testing.T) {
		env := BuildWorkerEnv(testkit.ReferenceProvider, headlessSpec(), headlessKey, headlessParentEnv(), headlessConfigDir)

		for _, name := range []string{
			"ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT",
			"CLAUDE_PLUGIN_ROOT", "ZAI_API_KEY", "ZAI_MAX_CONCURRENCY",
		} {
			if _, ok := env[name]; ok {
				t.Fatalf("%s leaked into the worker env", name)
			}
		}
		for _, leaked := range []string{"sk-ant-orchestrator-secret", "orchestrator-oauth-token", "https://api.anthropic.com", "/home/dev/.claude"} {
			for name, value := range env {
				if value == leaked {
					t.Fatalf("%s leaked into the worker env as %s", leaked, name)
				}
			}
		}
	})
	t.Run("sets ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN=<key>, the alias mapping, API_TIMEOUT_MS, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", func(t *testing.T) {
		env := BuildWorkerEnv(testkit.ReferenceProvider, headlessSpec(), headlessKey, headlessParentEnv(), headlessConfigDir)

		want := map[string]string{
			"ANTHROPIC_BASE_URL":                       "https://api.z.ai/api/anthropic",
			"ANTHROPIC_AUTH_TOKEN":                     headlessKey,
			"ANTHROPIC_DEFAULT_OPUS_MODEL":             "glm-5.3",
			"ANTHROPIC_DEFAULT_SONNET_MODEL":           "glm-5.3",
			"ANTHROPIC_DEFAULT_HAIKU_MODEL":            "glm-5.3-flash",
			"API_TIMEOUT_MS":                           "3000000",
			"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
		}
		for name, value := range want {
			if env[name] != value {
				t.Fatalf("%s = %q, want %q", name, env[name], value)
			}
		}
	})
	t.Run("sets CLAUDE_CONFIG_DIR to the isolated dir", func(t *testing.T) {
		env := BuildWorkerEnv(testkit.ReferenceProvider, headlessSpec(), headlessKey, headlessParentEnv(), headlessConfigDir)

		if env["CLAUDE_CONFIG_DIR"] != headlessConfigDir {
			t.Fatalf("CLAUDE_CONFIG_DIR = %q, want %q", env["CLAUDE_CONFIG_DIR"], headlessConfigDir)
		}
	})
	t.Run("passes the parent's CLAUDE_* settings through; an unset one stays unset (nothing is defaulted)", func(t *testing.T) {
		parent := headlessParentEnv()
		parent["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] = "40"
		parent["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = "32000"

		env := BuildWorkerEnv(testkit.ReferenceProvider, headlessSpec(), headlessKey, parent, headlessConfigDir)
		delete(parent, "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE")
		unset := BuildWorkerEnv(testkit.ReferenceProvider, headlessSpec(), headlessKey, parent, headlessConfigDir)

		if env["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] != "40" {
			t.Fatalf("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = %q, want 40", env["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"])
		}
		// TOKENS is a size setting, not a credential: the credential rule matches TOKEN as a whole segment only.
		if env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] != "32000" {
			t.Fatalf("CLAUDE_CODE_MAX_OUTPUT_TOKENS = %q, want 32000", env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"])
		}
		if _, ok := unset["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"]; ok {
			t.Fatal("a CLAUDE_* setting the parent did not set must stay unset")
		}
	})
	t.Run("drops credential-shaped CLAUDE_* names: TOKEN, KEY or SECRET as a whole _ segment", func(t *testing.T) {
		credentials := map[string]string{
			"CLAUDE_CODE_API_TOKEN":     "cred-token-marker",
			"CLAUDE_CODE_TOKEN_FILE":    "cred-token-marker",
			"CLAUDE_CODE_API_KEY":       "cred-key-marker",
			"CLAUDE_CODE_KEY_FILE":      "cred-key-marker",
			"CLAUDE_CODE_CLIENT_SECRET": "cred-secret-marker",
			"CLAUDE_CODE_SECRET_FILE":   "cred-secret-marker",
		}

		parent := headlessParentEnv()
		for name, value := range credentials {
			parent[name] = value
		}
		env := BuildWorkerEnv(testkit.ReferenceProvider, headlessSpec(), headlessKey, parent, headlessConfigDir)

		for name, value := range credentials {
			if _, ok := env[name]; ok {
				t.Fatalf("%s leaked into the worker env", name)
			}
			for envName, envValue := range env {
				if envValue == value {
					t.Fatalf("%s leaked into the worker env as %s", value, envName)
				}
			}
		}
	})
	t.Run("drops every CLAUDE_ENV_DENYLIST name from the parent; the plugin's own values still win", func(t *testing.T) {
		// A trailing * entry denies its prefix, so plant a name under it. CLAUDE_CONFIG_DIR and
		// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC are denied yet present, with zai's values.
		var planted []string
		for _, entry := range ClaudeEnvDenylist {
			if strings.HasSuffix(entry, "*") {
				planted = append(planted, strings.TrimSuffix(entry, "*")+"RESUMED")
			} else {
				planted = append(planted, entry)
			}
		}
		parent := headlessParentEnv()
		for _, name := range planted {
			parent[name] = "parent-" + name
		}

		env := BuildWorkerEnv(testkit.ReferenceProvider, headlessSpec(), headlessKey, parent, headlessConfigDir)

		pluginOwned := map[string]bool{"CLAUDE_CONFIG_DIR": true, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": true}
		for _, name := range planted {
			for envName, value := range env {
				if value == "parent-"+name {
					t.Fatalf("the parent's %s survived as %s", name, envName)
				}
			}
			if !pluginOwned[name] {
				if _, ok := env[name]; ok {
					t.Fatalf("denied %s reached the worker env", name)
				}
			}
		}
		if env["CLAUDE_CONFIG_DIR"] != headlessConfigDir {
			t.Fatalf("CLAUDE_CONFIG_DIR = %q, want %q", env["CLAUDE_CONFIG_DIR"], headlessConfigDir)
		}
		if env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] != "1" {
			t.Fatalf("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = %q, want 1", env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"])
		}
	})
	t.Run("brief env may name CLAUDE_* settings (overriding the parent); denied ones and the reserved names are dropped", func(t *testing.T) {
		passEnv := map[string]string{
			"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "25",
			"CLAUDE_CODE_USE_BEDROCK":         "1",
			"CLAUDE_CODE_SESSION_RESUMED":     "orchestrator-session",
			"CLAUDECODE":                      "1",
			"ANTHROPIC_API_KEY":               "sk-ant-orchestrator-secret",
			"API_TIMEOUT_MS":                  "1",
			"ZAI_API_KEY":                     headlessKey,
		}
		parent := headlessParentEnv()
		parent["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] = "40"

		env := BuildWorkerEnv(testkit.ReferenceProvider, headlessSpec(func(s *ports.WorkerSpec) {
			s.PassEnv = passEnv
		}), headlessKey, parent, headlessConfigDir)

		if env["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] != "25" {
			t.Fatalf("brief env CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = %q, want 25", env["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"])
		}
		for _, name := range []string{"CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_SESSION_RESUMED", "CLAUDECODE", "ANTHROPIC_API_KEY", "ZAI_API_KEY"} {
			if _, ok := env[name]; ok {
				t.Fatalf("brief env named the reserved %s", name)
			}
		}
		if env["API_TIMEOUT_MS"] != "3000000" {
			t.Fatalf("API_TIMEOUT_MS = %q, want the plugin's 3000000", env["API_TIMEOUT_MS"])
		}
	})
	t.Run("layers parent CLAUDE_* settings over the allowlist and passEnv over those (zai's own values come last)", func(t *testing.T) {
		passEnv := map[string]string{
			"NPM_TOKEN":                      "npm-value",
			"PATH":                           "/opt/tools/bin:/usr/bin",
			"ANTHROPIC_BASE_URL":             "https://evil.example",
			"ANTHROPIC_AUTH_TOKEN":           "other-token",
			"ANTHROPIC_API_KEY":              "sk-ant-orchestrator-secret",
			"ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet",
			"API_TIMEOUT_MS":                 "1",
			"CLAUDE_CONFIG_DIR":              "/home/dev/.claude",
			"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "0",
			"CLAUDECODE":    "1",
			"ZAI_API_KEY":   headlessKey,
			"ZAI_ARTIFACTS": "/state/jobs/x/artifacts",
		}
		parent := headlessParentEnv()
		parent["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] = "40"

		env := BuildWorkerEnv(testkit.ReferenceProvider, headlessSpec(func(s *ports.WorkerSpec) {
			s.PassEnv = passEnv
		}), headlessKey, parent, headlessConfigDir)

		want := map[string]string{
			"PATH":                            "/opt/tools/bin:/usr/bin",
			"HOME":                            "/home/dev",
			"LANG":                            "en_US.UTF-8",
			"LC_ALL":                          "en_US.UTF-8",
			"TERM":                            "xterm-256color",
			"SHELL":                           "/bin/zsh",
			"TMPDIR":                          "/tmp/dev",
			"USER":                            "dev",
			"LOGNAME":                         "dev",
			"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "40",
			"NPM_TOKEN":                       "npm-value",
			"ZAI_ARTIFACTS":                   "/state/jobs/x/artifacts",
			"ANTHROPIC_BASE_URL":              "https://api.z.ai/api/anthropic",
			"ANTHROPIC_AUTH_TOKEN":            headlessKey,
			"ANTHROPIC_DEFAULT_OPUS_MODEL":    "glm-5.3",
			"ANTHROPIC_DEFAULT_SONNET_MODEL":  "glm-5.3",
			"ANTHROPIC_DEFAULT_HAIKU_MODEL":   "glm-5.3-flash",
			"API_TIMEOUT_MS":                  "3000000",
			"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
			"CLAUDE_CONFIG_DIR":                        headlessConfigDir,
		}
		if !reflect.DeepEqual(env, want) {
			t.Fatalf("worker env drifted:\n%+v\nwant\n%+v", env, want)
		}
	})
}

// headlessStubParse is a stand-in for domain.ParseStreamLine: just enough to observe the worker's
// plumbing on its own. Everything it does not know becomes `other`, like the real parser; a
// {"type":"pair"} line yields two events.
func headlessStubParse(line string) ([]domain.WorkerEvent, error) {
	if strings.TrimSpace(line) == "" {
		return nil, nil
	}
	var event any
	if err := json.Unmarshal([]byte(line), &event); err != nil {
		return nil, errors.New("malformed JSON")
	}
	record, isRecord := event.(map[string]any)
	if !isRecord {
		return []domain.WorkerEvent{{Kind: domain.WorkerEventOther, Raw: line}}, nil
	}
	if record["type"] == "pair" {
		return []domain.WorkerEvent{
			{Kind: domain.WorkerEventAssistantText, Text: "first"},
			{Kind: domain.WorkerEventToolUse, Name: "Bash", Summary: "second"},
		}, nil
	}
	if record["type"] == "system" && record["subtype"] == "init" {
		sessionID := headlessJSString(record["session_id"])
		model := headlessJSString(record["model"])
		return []domain.WorkerEvent{{Kind: domain.WorkerEventInit, SessionID: sessionID, Model: &model}}, nil
	}
	if record["type"] == "assistant" {
		if message, ok := record["message"].(map[string]any); ok {
			if blocks, ok := message["content"].([]any); ok {
				var text strings.Builder
				for _, block := range blocks {
					if blockRecord, ok := block.(map[string]any); ok {
						if blockText, ok := blockRecord["text"].(string); ok {
							text.WriteString(blockText)
						}
					}
				}
				return []domain.WorkerEvent{{Kind: domain.WorkerEventAssistantText, Text: text.String()}}, nil
			}
		}
	}
	return []domain.WorkerEvent{{Kind: domain.WorkerEventOther, Raw: line}}, nil
}

// headlessJSString is JS String(value) for the JSON values the stub meets.
func headlessJSString(value any) string {
	if value == nil {
		return "undefined"
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

func headlessCollect(run ports.WorkerRun) []domain.WorkerEvent {
	var events []domain.WorkerEvent
	for event := range run.Events() {
		events = append(events, event)
	}
	return events
}

func TestClaudeHeadlessWorkerIntegration(t *testing.T) {
	// Groups whose pids a test learned, so a failing test cannot leak processes. The pid came from
	// the fake's pidfile: the kill lands only while the pid still runs the fake this test built —
	// a pid the kernel has handed to another process is never signalled.
	headlessKillGroup := func(pid int64) {
		bin := fakeclaude.Build(t)
		t.Cleanup(func() {
			if testkit.PidMatches(pid, bin, 0) {
				process.SignalGroup(pid, syscall.SIGKILL)
			}
		})
	}

	// headlessGroupPids waits for the fake to report "<its pid> <grandchild pid>".
	headlessGroupPids := func(pidFile string) []int64 {
		var pids []int64
		err := testkit.Until(t, func() bool {
			content, err := os.ReadFile(pidFile)
			if err != nil || len(content) == 0 {
				return false
			}
			pids = nil
			for _, field := range strings.Fields(string(content)) {
				pid, err := strconv.ParseInt(field, 10, 64)
				if err != nil {
					return false
				}
				pids = append(pids, pid)
			}
			return len(pids) > 0
		}, testkit.UntilOptions{Message: "the fake never wrote its pidfile"})
		if err != nil {
			t.Fatal(err)
		}
		headlessKillGroup(pids[0])
		return pids
	}

	newWorker := func(dir string, overrides ...func(*ClaudeHeadlessOptions)) *ClaudeHeadlessWorker {
		parent := headlessParentEnv()
		parent["PATH"] = os.Getenv("PATH")
		options := ClaudeHeadlessOptions{
			Provider:    testkit.ReferenceProvider,
			Bin:         fakeclaude.Build(t),
			ConfigDir:   filepath.Join(dir, "claude-home"),
			LoadKey:     headlessLoadedKey,
			ParentEnv:   parent,
			StopGraceMs: 5_000,
			Parse:       headlessStubParse,
		}
		for _, override := range overrides {
			override(&options)
		}
		return NewClaudeHeadlessWorker(options)
	}

	fakeSpec := func(dir string, passEnv map[string]string, overrides ...func(*ports.WorkerSpec)) ports.WorkerSpec {
		fixed := append([]func(*ports.WorkerSpec){
			func(s *ports.WorkerSpec) {
				s.Cwd = dir
				s.LogPath = filepath.Join(dir, "logs", "attempt-1.jsonl")
				s.PassEnv = passEnv
			},
		}, overrides...)
		return headlessSpec(fixed...)
	}

	started := func(run ports.WorkerRun, err error) ports.WorkerRun {
		t.Helper()
		if err != nil {
			t.Fatalf("worker did not start: %v", err)
		}
		return run
	}

	wantExit := func(got ports.WorkerExit, want ports.WorkerExit) {
		t.Helper()
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("exit = %+v, want %+v", got, want)
		}
	}

	i64 := func(v int64) *int64 { return &v }
	signal := func(v string) *string { return &v }
	forced := func(v domain.ForcedEnd) *domain.ForcedEnd { return &v }

	t.Run("streams parsed events from the fake and resolves exit with code 0", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		run := started(newWorker(dir).Start(context.Background(), fakeSpec(dir, map[string]string{"FAKE_CLAUDE_SCENARIO": "ok"})))

		events := headlessCollect(run)
		exit := run.Wait()

		pid, ok := run.(interface{ Pid() int64 })
		if !ok || pid.Pid() <= 0 {
			t.Fatalf("run pid = %+v, want a positive one", run)
		}
		model := "glm-5.3"
		wantHead := []domain.WorkerEvent{
			{Kind: domain.WorkerEventInit, SessionID: headlessSessionID, Model: &model},
			{Kind: domain.WorkerEventAssistantText, Text: "done"},
		}
		if len(events) < 2 || !reflect.DeepEqual(events[:2], wantHead) {
			t.Fatalf("events head = %+v, want %+v", events, wantHead)
		}
		if len(events) != 3 || events[2].Kind != domain.WorkerEventOther || !strings.Contains(events[2].Raw, `"type":"result"`) {
			t.Fatalf("events = %+v, want a result line as the last other", events)
		}
		wantExit(exit, ports.WorkerExit{Code: i64(0), StderrTail: ""})
	})
	t.Run("writes the prompt to the child's stdin (fake echoes it into an assistant event)", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		prompt := "Rename `foo` → `bar`.\n\n- keep \"quotes\" and $VARS literal\n- ünïcødé ✓\n"

		run := started(newWorker(dir).Start(context.Background(), fakeSpec(dir,
			map[string]string{"FAKE_CLAUDE_SCENARIO": "echo-prompt"},
			func(s *ports.WorkerSpec) { s.Prompt = prompt },
		)))
		events := headlessCollect(run)

		want := domain.WorkerEvent{Kind: domain.WorkerEventAssistantText, Text: prompt}
		if !slices.ContainsFunc(events, func(event domain.WorkerEvent) bool { return reflect.DeepEqual(event, want) }) {
			t.Fatalf("events = %+v, want the prompt echoed back", events)
		}
	})
	t.Run("tees raw stdout to logPath", func(t *testing.T) {
		// Also: the log and its directory are created (0600), and a later attempt appends.
		dir := testkit.TempDir(t, "core-worker-")
		fixturePath := filepath.Join(testkit.ModuleRoot(t), "testdata", "stream", "rate-limited-429.jsonl")
		fixture, err := os.ReadFile(fixturePath)
		if err != nil {
			t.Fatal(err)
		}
		replay := fakeSpec(dir, map[string]string{"FAKE_CLAUDE_FIXTURE": fixturePath})

		for range 2 {
			run, err := newWorker(dir).Start(context.Background(), replay)
			started(run, err).Wait()
		}

		log, err := os.ReadFile(replay.LogPath)
		if err != nil {
			t.Fatal(err)
		}
		if string(log) != string(fixture)+string(fixture) {
			t.Fatalf("log = %d bytes, want the fixture twice (%d)", len(log), 2*len(fixture))
		}
		info, err := os.Stat(replay.LogPath)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("log mode = %v, want 0600", info.Mode().Perm())
		}
	})
	t.Run("kills the whole process group on timeout and reports forced timeout", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		pidFile := filepath.Join(dir, "pids")
		sleeper := fakeSpec(dir,
			map[string]string{"FAKE_CLAUDE_SCENARIO": "sleep", "FAKE_CLAUDE_PIDFILE": pidFile},
			func(s *ports.WorkerSpec) { s.TimeoutMs = 3_000 },
		)

		run := started(newWorker(dir).Start(context.Background(), sleeper))
		pids := headlessGroupPids(pidFile)
		events := headlessCollect(run)
		exit := run.Wait()

		wantExit(exit, ports.WorkerExit{Signal: signal("SIGTERM"), Forced: forced(domain.ForcedTimeout)})
		if len(events) == 0 || events[0].Kind != domain.WorkerEventInit {
			t.Fatalf("events = %+v, want an init first", events)
		}
		if len(pids) != 2 {
			t.Fatalf("pids = %v, want the leader and its grandchild", pids)
		}
		for _, pid := range pids {
			if process.IsAlive(pid) {
				t.Fatalf("pid %d survived the timeout", pid)
			}
		}
	})
	t.Run("a resume of a session Claude Code does not have exits with sessionMissing", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		resume := fakeSpec(dir,
			map[string]string{"FAKE_CLAUDE_SCENARIO": "no-session"},
			func(s *ports.WorkerSpec) {
				s.Session = ports.WorkerSession{Kind: ports.SessionKindResume, Key: headlessSessionID}
			},
		)

		run := started(newWorker(dir).Start(context.Background(), resume))
		headlessCollect(run)

		wantExit(run.Wait(), ports.WorkerExit{
			Code:           i64(1),
			StderrTail:     "No conversation found with session ID: " + headlessSessionID + "\n",
			SessionMissing: true,
		})
	})
	t.Run("interrupt stops the run: the whole group is gone and the exit reports forced stopped", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		pidFile := filepath.Join(dir, "pids")
		sleeper := fakeSpec(dir, map[string]string{"FAKE_CLAUDE_SCENARIO": "sleep", "FAKE_CLAUDE_PIDFILE": pidFile})

		run := started(newWorker(dir).Start(context.Background(), sleeper))
		pids := headlessGroupPids(pidFile)
		if err := run.Interrupt(context.Background(), ports.InterruptStopped); err != nil {
			t.Fatalf("interrupt = %v", err)
		}
		headlessCollect(run)

		wantExit(run.Wait(), ports.WorkerExit{Signal: signal("SIGTERM"), Forced: forced(domain.ForcedStopped)})
		for _, pid := range pids {
			if process.IsAlive(pid) {
				t.Fatalf("pid %d survived the interrupt", pid)
			}
		}
	})
	t.Run("returns no_key / insecure_key_file from loadKey without spawning", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		noKey := &ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "no key"}
		insecure := &ports.WorkerError{
			Kind:  ports.WorkerErrorInsecureKeyFile,
			Label: "key file",
			Path:  "/home/dev/.config/zai-plugin-cc/env",
			Mode:  "0644",
		}
		target := fakeSpec(dir, map[string]string{"FAKE_CLAUDE_SCENARIO": "ok"})

		for _, wantErr := range []*ports.WorkerError{noKey, insecure} {
			failing := func(context.Context) (ports.ProviderKey, *ports.WorkerError) {
				return ports.ProviderKey{}, wantErr
			}
			_, err := newWorker(dir, func(o *ClaudeHeadlessOptions) { o.LoadKey = failing }).Start(context.Background(), target)
			var got *ports.WorkerError
			if !errors.As(err, &got) || !reflect.DeepEqual(got, wantErr) {
				t.Fatalf("start error = %v, want %+v", err, wantErr)
			}
		}
		// The log is opened right before the spawn, so its absence proves nothing was started.
		if _, err := os.Stat(target.LogPath); !os.IsNotExist(err) {
			t.Fatalf("stat log = %v, want ENOENT", err)
		}
	})
	t.Run("returns spawn_failed when the binary does not exist", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		missing := filepath.Join(dir, "no-such-claude")

		_, err := newWorker(dir, func(o *ClaudeHeadlessOptions) { o.Bin = missing }).Start(
			context.Background(), fakeSpec(dir, map[string]string{}))

		var got *ports.WorkerError
		if !errors.As(err, &got) || got.Kind != ports.WorkerErrorSpawnFailed || got.Message != "spawn "+missing+" ENOENT" {
			t.Fatalf("start error = %v, want spawn_failed spawn %s ENOENT", err, missing)
		}
	})
	t.Run("returns spawn_failed without spawning when the log cannot be opened", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		notADirectory := filepath.Join(dir, "file")
		if err := os.WriteFile(notADirectory, nil, 0o644); err != nil {
			t.Fatal(err)
		}
		target := fakeSpec(dir, map[string]string{"FAKE_CLAUDE_SCENARIO": "ok"},
			func(s *ports.WorkerSpec) { s.LogPath = filepath.Join(notADirectory, "attempt-1.jsonl") })

		_, err := newWorker(dir).Start(context.Background(), target)

		var got *ports.WorkerError
		// mkdir over a file: EEXIST on macOS, ENOTDIR on Linux, both Node spells "Error: E…".
		if !errors.As(err, &got) || got.Kind != ports.WorkerErrorSpawnFailed ||
			!strings.Contains(got.Message, "cannot open log "+target.LogPath) {
			t.Fatalf("start error = %v, want spawn_failed naming the log", err)
		}
	})
	t.Run("the key never appears in argv, in logPath or in the fake's dumped argv (fake writes its argv/env names to a file)", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		// The real environment of this test run (which may itself be inside Claude Code) plus planted leaks.
		parentEnv := domain.EnvLookup{}
		for _, entry := range os.Environ() {
			name, value, _ := strings.Cut(entry, "=")
			parentEnv[name] = value
		}
		for name, value := range headlessParentEnv() {
			parentEnv[name] = value
		}
		parentEnv["PATH"] = os.Getenv("PATH")
		parentEnv["HOME"] = os.Getenv("HOME")
		dumpPath := filepath.Join(dir, "dump.json")
		passEnv := map[string]string{"FAKE_CLAUDE_SCENARIO": "echo-prompt", "FAKE_CLAUDE_DUMP": dumpPath}
		target := fakeSpec(dir, passEnv)

		run := started(newWorker(dir, func(o *ClaudeHeadlessOptions) { o.ParentEnv = parentEnv }).Start(context.Background(), target))
		headlessCollect(run)
		run.Wait()
		dumpText, err := os.ReadFile(dumpPath)
		if err != nil {
			t.Fatal(err)
		}
		var dump struct {
			Argv            []string `json:"argv"`
			EnvNames        []string `json:"envNames"`
			AuthTokenSha256 string   `json:"authTokenSha256"`
		}
		if err := json.Unmarshal(dumpText, &dump); err != nil {
			t.Fatal(err)
		}

		if !slices.Equal(dump.Argv, BuildClaudeArgs(target)) {
			t.Fatalf("dumped argv = %q, want the built argv", dump.Argv)
		}
		if strings.Contains(string(dumpText), headlessKey) {
			t.Fatal("the key leaked into the dump")
		}
		log, err := os.ReadFile(target.LogPath)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(log), headlessKey) {
			t.Fatal("the key leaked into the log")
		}
		sum := sha256.Sum256([]byte(headlessKey))
		if dump.AuthTokenSha256 != hex.EncodeToString(sum[:]) {
			t.Fatalf("dumped token hash = %s, want the key's", dump.AuthTokenSha256)
		}
		var inherited []string
		for _, name := range ENV_ALLOWLIST {
			if _, ok := parentEnv[name]; ok {
				inherited = append(inherited, name)
			}
		}
		// This test may itself run inside Claude Code, so the parent's CLAUDE_* settings vary;
		// whatever passes the denylist is exactly what the worker must receive.
		var claudeSettings []string
		for name := range PickClaudeSettings(parentEnv) {
			claudeSettings = append(claudeSettings, name)
		}
		managed := []string{
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_BASE_URL",
			"ANTHROPIC_DEFAULT_HAIKU_MODEL",
			"ANTHROPIC_DEFAULT_OPUS_MODEL",
			"ANTHROPIC_DEFAULT_SONNET_MODEL",
			"API_TIMEOUT_MS",
			"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
			"CLAUDE_CONFIG_DIR",
		}
		// macOS adds __CF_USER_TEXT_ENCODING to every process it starts; it never comes from
		// the parent.
		injected := "__CF_USER_TEXT_ENCODING"
		var received []string
		for _, name := range dump.EnvNames {
			if name != injected {
				received = append(received, name)
			}
		}
		want := slices.Concat(inherited, claudeSettings, slices.Collect(maps.Keys(passEnv)), managed)
		slices.Sort(want)
		if !slices.Equal(received, want) {
			t.Fatalf("env names = %q, want %q", received, want)
		}
	})
	t.Run("terminates processes the worker left running in its group once it exits", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		pidFile := filepath.Join(dir, "pids")
		leaver := fakeSpec(dir, map[string]string{"FAKE_CLAUDE_SCENARIO": "ok", "FAKE_CLAUDE_PIDFILE": pidFile})

		run := started(newWorker(dir).Start(context.Background(), leaver))
		pids := headlessGroupPids(pidFile)
		headlessCollect(run)
		exit := run.Wait()

		wantExit(exit, ports.WorkerExit{Code: i64(0), StderrTail: ""})
		for _, pid := range pids {
			if process.IsAlive(pid) {
				t.Fatalf("pid %d outlived the run", pid)
			}
		}
	})
	t.Run("a crashing worker resolves exit with its exit code and stderr", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		run := started(newWorker(dir).Start(context.Background(), fakeSpec(dir, map[string]string{"FAKE_CLAUDE_SCENARIO": "crash"})))

		headlessCollect(run)

		wantExit(run.Wait(), ports.WorkerExit{Code: i64(3), StderrTail: "fake claude: simulated crash\n"})
	})
	t.Run("keeps only the last 4000 characters of stderr", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		// A #!-script floods stderr.
		bin := filepath.Join(dir, "noisy-claude")
		passEnv := map[string]string{}
		script := "#!/bin/sh\nhead -c 10000 /dev/zero | tr '\\0' x >&2\nprintf END >&2\nexit 1\n"
		if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}

		run := started(newWorker(dir, func(o *ClaudeHeadlessOptions) { o.Bin = bin }).Start(
			context.Background(), fakeSpec(dir, passEnv)))
		exit := run.Wait()

		tail := []rune(exit.StderrTail)
		if len(tail) != 4000 {
			t.Fatalf("stderr tail = %d characters, want 4000", len(tail))
		}
		if !strings.HasSuffix(exit.StderrTail, "xxxEND") {
			t.Fatalf("stderr tail ends with %q", exit.StderrTail[len(exit.StderrTail)-100:])
		}
	})
	t.Run("a timeout beyond setTimeout's range (about 24.8 days) does not fire at once", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		run := started(newWorker(dir).Start(context.Background(), fakeSpec(dir,
			map[string]string{"FAKE_CLAUDE_SCENARIO": "ok"},
			func(s *ports.WorkerSpec) { s.TimeoutMs = 1 << 32 },
		)))

		headlessCollect(run)

		exit := run.Wait()
		if exit.Code == nil || *exit.Code != 0 || exit.Forced != nil {
			t.Fatalf("exit = %+v, want code 0 with no forced end", exit)
		}
	})
	t.Run("skips lines the parser rejects (they stay in the log) and keeps streaming", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		fixture := filepath.Join(dir, "malformed.jsonl")
		init := `{"type":"system","subtype":"init","session_id":"s-1","model":"glm-5.3"}`
		said := `{"type":"assistant","message":{"content":[{"type":"text","text":"still here"}]}}`
		if err := os.WriteFile(fixture, []byte(init+"\n"+`{"type": "assist`+"\n\n"+said+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		replay := fakeSpec(dir, map[string]string{"FAKE_CLAUDE_FIXTURE": fixture})

		run := started(newWorker(dir).Start(context.Background(), replay))
		events := headlessCollect(run)
		run.Wait()

		model := "glm-5.3"
		want := []domain.WorkerEvent{
			{Kind: domain.WorkerEventInit, SessionID: "s-1", Model: &model},
			{Kind: domain.WorkerEventAssistantText, Text: "still here"},
		}
		if !reflect.DeepEqual(events, want) {
			t.Fatalf("events = %+v, want %+v", events, want)
		}
		log, err := os.ReadFile(replay.LogPath)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(log), "{\"type\": \"assist\n") {
			t.Fatalf("the rejected line is not in the log: %q", log)
		}
	})
	t.Run("delivers every event of a line that parses to several, in order", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		fixture := filepath.Join(dir, "pair.jsonl")
		content := "{\"type\":\"pair\"}\n{\"type\":\"assistant\",\"message\":{\"content\":[{\"text\":\"after\"}]}}\n"
		if err := os.WriteFile(fixture, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}

		run := started(newWorker(dir).Start(context.Background(), fakeSpec(dir, map[string]string{"FAKE_CLAUDE_FIXTURE": fixture})))
		events := headlessCollect(run)
		run.Wait()

		want := []domain.WorkerEvent{
			{Kind: domain.WorkerEventAssistantText, Text: "first"},
			{Kind: domain.WorkerEventToolUse, Name: "Bash", Summary: "second"},
			{Kind: domain.WorkerEventAssistantText, Text: "after"},
		}
		if !reflect.DeepEqual(events, want) {
			t.Fatalf("events = %+v, want %+v", events, want)
		}
	})
	t.Run("parses a final line that has no trailing newline", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		fixture := filepath.Join(dir, "unterminated.jsonl")
		line := `{"type":"assistant","message":{"content":[{"type":"text","text":"last"}]}}`
		if err := os.WriteFile(fixture, []byte(line), 0o644); err != nil {
			t.Fatal(err)
		}

		run := started(newWorker(dir).Start(context.Background(), fakeSpec(dir, map[string]string{"FAKE_CLAUDE_FIXTURE": fixture})))
		events := headlessCollect(run)
		run.Wait()

		want := []domain.WorkerEvent{{Kind: domain.WorkerEventAssistantText, Text: "last"}}
		if !reflect.DeepEqual(events, want) {
			t.Fatalf("events = %+v, want %+v", events, want)
		}
	})
	t.Run("runs the worker in spec.cwd (the fake's edit-file scenario writes there)", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		workspace := filepath.Join(dir, "workspace")
		if err := os.Mkdir(workspace, 0o755); err != nil {
			t.Fatal(err)
		}
		edit := fakeSpec(dir,
			map[string]string{"FAKE_CLAUDE_SCENARIO": "edit-file", "FAKE_CLAUDE_EDIT": "src/out.txt:hello from glm"},
			func(s *ports.WorkerSpec) { s.Cwd = workspace },
		)

		run := started(newWorker(dir).Start(context.Background(), edit))
		events := headlessCollect(run)
		run.Wait()

		edited, err := os.ReadFile(filepath.Join(workspace, "src", "out.txt"))
		if err != nil {
			t.Fatal(err)
		}
		if string(edited) != "hello from glm" {
			t.Fatalf("edited file = %q, want the fake's write", edited)
		}
		want := domain.WorkerEvent{Kind: domain.WorkerEventAssistantText, Text: "edited src/out.txt"}
		if !slices.ContainsFunc(events, func(event domain.WorkerEvent) bool { return reflect.DeepEqual(event, want) }) {
			t.Fatalf("events = %+v, want the edit announced", events)
		}
	})
	t.Run("by default parses with domain parseStreamLine", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		defaultParser := NewClaudeHeadlessWorker(ClaudeHeadlessOptions{
			Provider:    testkit.ReferenceProvider,
			Bin:         fakeclaude.Build(t),
			ConfigDir:   filepath.Join(dir, "claude-home"),
			LoadKey:     headlessLoadedKey,
			ParentEnv:   domain.EnvLookup{"PATH": os.Getenv("PATH")},
			StopGraceMs: 5_000,
		})

		run := started(defaultParser.Start(context.Background(), fakeSpec(dir, map[string]string{"FAKE_CLAUDE_SCENARIO": "ok"})))
		events := headlessCollect(run)
		run.Wait()

		model := "glm-5.3"
		wantHead := []domain.WorkerEvent{
			{Kind: domain.WorkerEventInit, SessionID: headlessSessionID, Model: &model},
			{Kind: domain.WorkerEventAssistantText, Text: "done"},
		}
		if len(events) < 2 || !reflect.DeepEqual(events[:2], wantHead) {
			t.Fatalf("events head = %+v, want %+v", events, wantHead)
		}
		want := domain.WorkerEvent{
			Kind:             domain.WorkerEventResult,
			IsError:          false,
			Text:             "done",
			StructuredOutput: json.RawMessage(`{"summary":"fake run"}`),
			Turns:            1,
			DurationMs:       12,
			CostUSD:          0.0012,
			Usage: domain.ResultUsage{
				InputTokens:      100,
				OutputTokens:     20,
				CacheReadTokens:  50,
				CacheWriteTokens: 10,
			},
		}
		if !reflect.DeepEqual(events[len(events)-1], want) {
			t.Fatalf("last event = %+v, want %+v", events[len(events)-1], want)
		}
	})
	t.Run("delivers every line of a long stream, in order", func(t *testing.T) {
		dir := testkit.TempDir(t, "core-worker-")
		fixture := filepath.Join(dir, "long.jsonl")
		var stream strings.Builder
		var want []domain.WorkerEvent
		for i := range 5000 {
			text := "line " + strconv.Itoa(i)
			line, err := json.Marshal(map[string]any{
				"type":    "assistant",
				"message": map[string]any{"content": []map[string]string{{"type": "text", "text": text}}},
			})
			if err != nil {
				t.Fatal(err)
			}
			stream.Write(line)
			stream.WriteByte('\n')
			want = append(want, domain.WorkerEvent{Kind: domain.WorkerEventAssistantText, Text: text})
		}
		if err := os.WriteFile(fixture, []byte(stream.String()), 0o644); err != nil {
			t.Fatal(err)
		}

		run := started(newWorker(dir).Start(context.Background(), fakeSpec(dir, map[string]string{"FAKE_CLAUDE_FIXTURE": fixture})))
		events := headlessCollect(run)
		run.Wait()

		if !reflect.DeepEqual(events, want) {
			t.Fatalf("events = %d delivered, want %d in order", len(events), len(want))
		}
	})
}

// Direct tests for the two helpers whole runs reach only through their happy paths: the compact
// schema (a parsed schema never fails it) and the number string (budgets stay in plain notation).

func TestHeadlessNumberString(t *testing.T) {
	for _, tc := range []struct {
		value float64
		want  string
	}{
		{0, "0"},
		{1, "1"},
		{2.5, "2.5"},
		{100, "100"},
		{123.456, "123.456"},
		// JS switches to exponent notation outside [1e-6, 1e21), without a leading zero in the
		// exponent.
		{0.000001, "0.000001"},
		{1e-7, "1e-7"},
		{1e21, "1e+21"},
	} {
		if got := headlessNumberString(tc.value); got != tc.want {
			t.Fatalf("headlessNumberString(%v) = %q, want %q", tc.value, got, tc.want)
		}
	}
}

func TestHeadlessCompactJSON(t *testing.T) {
	if got := headlessCompactJSON(json.RawMessage("{ \"type\": \"object\" }")); got != `{"type":"object"}` {
		t.Fatalf("headlessCompactJSON = %q, want the compact form", got)
	}
	already := `{"type":"object","required":["summary"]}`
	if got := headlessCompactJSON(json.RawMessage(already)); got != already {
		t.Fatalf("headlessCompactJSON = %q, want %q unchanged", got, already)
	}
	// Schema bytes that are not JSON reach the argv as they are; the caller owns them.
	broken := "{oops"
	if got := headlessCompactJSON(json.RawMessage(broken)); got != broken {
		t.Fatalf("headlessCompactJSON of broken JSON = %q, want it unchanged", got)
	}
}
