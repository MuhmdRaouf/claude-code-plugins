package shared

import (
	"reflect"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

func TestToolEnv(t *testing.T) {
	withheld := func(name string) bool { return name == "ACME_API_KEY" || strings.HasPrefix(name, "ACME_") }
	reserved := func(name string) bool {
		return strings.HasPrefix(name, "TOOL_") || strings.HasSuffix(name, "_API_KEY")
	}

	t.Run("passes the user's own environment, minus the plugin's provider and the Claude Code session", func(t *testing.T) {
		parent := domain.EnvLookup{
			"HOME":                           "/home/user",
			"OPENAI_API_KEY":                 "users-own",
			"TOOL_CONFIG":                    "/home/user/.tool",
			"ACME_API_KEY":                   "plugin-key",
			"ACME_BASE_URL":                  "https://acme.test",
			"ANTHROPIC_BASE_URL":             "http://127.0.0.1:18800",
			"ANTHROPIC_DEFAULT_SONNET_MODEL": "big-9",
			"CLAUDE_PLUGIN_ROOT":             "/plugins/acme",
			"CLAUDECODE":                     "1",
		}
		passEnv := map[string]string{
			"GREETING":      "hi",
			"TOOL_CONFIG":   "/elsewhere",
			"OTHER_API_KEY": "k",
			"ACME_FLAGS":    "--verbose",
			"CLAUDECODE":    "0",
		}

		env := ToolEnv(parent, passEnv, withheld, reserved)

		want := map[string]string{
			"HOME":           "/home/user",
			"OPENAI_API_KEY": "users-own",
			"TOOL_CONFIG":    "/home/user/.tool",
			"GREETING":       "hi",
		}
		if !reflect.DeepEqual(env, want) {
			t.Errorf("ToolEnv() = %v, want %v", env, want)
		}
	})

	t.Run("withholds a proxy that names a plugin router and the CA set for it, keeps a corporate proxy and its CA", func(t *testing.T) {
		cases := []domain.EnvLookup{
			{"HTTPS_PROXY": "http://127.0.0.1:18787"},
			{"https_proxy": "http://127.0.0.1:18787"},
			{"HTTP_PROXY": "http://localhost:18790"},
			{"HTTPS_PROXY": "localhost:18790"},
		}
		for _, parent := range cases {
			parent["NODE_EXTRA_CA_CERTS"] = "/ca.pem"
			env := ToolEnv(parent, nil, withheld, reserved)
			for _, name := range []string{
				"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NODE_EXTRA_CA_CERTS",
			} {
				if _, ok := env[name]; ok {
					t.Errorf("ToolEnv(%v) kept %s", parent, name)
				}
			}
		}
		env := ToolEnv(domain.EnvLookup{
			"HTTPS_PROXY":         "http://proxy.corp:3128",
			"NODE_EXTRA_CA_CERTS": "/ca.pem",
		}, nil, withheld, reserved)
		if env["HTTPS_PROXY"] != "http://proxy.corp:3128" || env["NODE_EXTRA_CA_CERTS"] != "/ca.pem" {
			t.Errorf("ToolEnv dropped a corporate proxy or its CA: %v", env)
		}
	})

	t.Run("knows Claude Code's routing and session variables from the user's own", func(t *testing.T) {
		for _, name := range []string{
			"ANTHROPIC_BASE_URL",
			"ANTHROPIC_AUTH_TOKEN",
			"ANTHROPIC_MODEL",
			"CLAUDE_CODE_ENTRYPOINT",
		} {
			if !IsClaudeSessionVar(name) {
				t.Errorf("IsClaudeSessionVar(%q) = false, want true", name)
			}
		}
		for _, name := range []string{"ANTHROPIC_API_KEY", "HOME", "CLAUDIA"} {
			if IsClaudeSessionVar(name) {
				t.Errorf("IsClaudeSessionVar(%q) = true, want false", name)
			}
		}
	})
}

func TestReportedModel(t *testing.T) {
	t.Run("is the tool's own provider and model, as the tool names them", func(t *testing.T) {
		cases := []struct {
			message map[string]any
			want    string
			wantOK  bool
		}{
			{message: map[string]any{"provider": "zai", "model": "glm-5.3"}, want: "zai/glm-5.3", wantOK: true},
			{message: map[string]any{"provider": "openrouter", "model": "openrouter/qwen"}, want: "openrouter/qwen", wantOK: true},
			{message: map[string]any{"model": "glm-5.3"}, want: "glm-5.3", wantOK: true},
			{message: map[string]any{"provider": "", "model": "glm-5.3"}, want: "glm-5.3", wantOK: true},
			{message: map[string]any{"provider": "zai"}, wantOK: false},
			{message: map[string]any{"provider": "zai", "model": ""}, wantOK: false},
		}
		for _, c := range cases {
			got, ok := ReportedModel(c.message)
			if got != c.want || ok != c.wantOK {
				t.Errorf("ReportedModel(%v) = (%q, %v), want (%q, %v)", c.message, got, ok, c.want, c.wantOK)
			}
		}
	})
}
