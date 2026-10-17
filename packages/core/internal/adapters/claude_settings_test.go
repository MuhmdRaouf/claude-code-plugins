package adapters

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/providers"
)

// The focused tests for the settings adapter's exports: every exported function directly — merges
// into an empty file and one with other keys, files that are not JSON, idempotent re-runs, the
// careful write, and the undo that restores exactly what setup changed. Every path sits under
// t.TempDir(); the real ~/.claude is never touched.

const (
	routerURL  = "http://127.0.0.1:18787"
	kimiRouter = "http://127.0.0.1:18788"
)

func settingsFilePath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "home", ".claude", "settings.json")
}

func writeSettingsFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// appliedLines is an apply that must have succeeded.
func appliedLines(t *testing.T, path string) []string {
	t.Helper()
	lines, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{})
	if err != nil {
		t.Fatalf("applyProviderSettings(%s): %v", path, err)
	}
	return lines
}

func assertLines(t *testing.T, got []string, want ...string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Fatalf("lines = %#v; want %#v", got, want)
	}
}

func assertFile(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if string(got) != want {
		t.Fatalf("%s =\n%s; want\n%s", path, got, want)
	}
}

// assertMode checks the permission bits a file was created with.
func assertMode(t *testing.T, path string, want fs.FileMode) {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != want {
		t.Fatalf("%s mode = %o; want %o", path, got, want)
	}
}

func TestClaudeSettingsPath(t *testing.T) {
	t.Run("takes $CLAUDE_CONFIG_DIR over ~/.claude", func(t *testing.T) {
		if got := ClaudeSettingsPath(domain.EnvLookup{"CLAUDE_CONFIG_DIR": "/cfg", "HOME": "/home"}); got != filepath.Join("/cfg", "settings.json") {
			t.Fatalf("claudeSettingsPath = %q; want %q", got, filepath.Join("/cfg", "settings.json"))
		}
		if got := ClaudeSettingsPath(domain.EnvLookup{"HOME": "/home"}); got != filepath.Join("/home", ".claude", "settings.json") {
			t.Fatalf("claudeSettingsPath = %q; want %q", got, filepath.Join("/home", ".claude", "settings.json"))
		}
		if got := ClaudeSettingsPath(domain.EnvLookup{"CLAUDE_CONFIG_DIR": "", "HOME": "/home"}); got != filepath.Join("/home", ".claude", "settings.json") {
			t.Fatalf("claudeSettingsPath = %q; want %q (an empty config dir counts as unset)", got, filepath.Join("/home", ".claude", "settings.json"))
		}
	})

	t.Run("falls back to the OS home when HOME is unset", func(t *testing.T) {
		home := t.TempDir()
		t.Setenv("HOME", home)
		if got := ClaudeConfigDir(domain.EnvLookup{}); got != filepath.Join(home, ".claude") {
			t.Fatalf("claudeConfigDir = %q; want %q", got, filepath.Join(home, ".claude"))
		}
	})
}

func TestApplyProviderSettings(t *testing.T) {
	t.Run("creates the file and its directory when missing", func(t *testing.T) {
		path := settingsFilePath(t)

		assertLines(t, appliedLines(t, path),
			"added GLM 5.3 (glm-5.3) to /model",
			"added GLM 5.3 Flash (glm-5.3-flash) to /model",
			"set GLM 5.3 default effort to xhigh",
			"set GLM 5.3 Flash default effort to xhigh",
			"pointed ANTHROPIC_BASE_URL at "+routerURL,
			"turned on MCP tool search",
		)
		assertFile(t, path, `{
  "modelPicker": {
    "options": [
      {
        "model": "glm-5.3",
        "label": "GLM 5.3",
        "behavesAs": "claude-opus-5-5"
      },
      {
        "model": "glm-5.3-flash",
        "label": "GLM 5.3 Flash",
        "behavesAs": "claude-opus-5-5"
      }
    ]
  },
  "modelSettings": {
    "glm-5.3": {
      "effortLevel": "xhigh"
    },
    "glm-5.3-flash": {
      "effortLevel": "xhigh"
    }
  },
  "env": {
    "ANTHROPIC_BASE_URL": "`+routerURL+`",
    "ENABLE_TOOL_SEARCH": "true"
  }
}
`)
		assertMode(t, path, 0o600)
	})

	t.Run("keeps every other key and its order, appending to an existing availableModels", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, `{
  "before": 1,
  "modelPicker": {
    "options": [
      {
        "model": "claude-opus-4",
        "label": "Opus"
      }
    ],
    "other": true
  },
  "availableModels": [
    "claude-sonnet-4"
  ],
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "redacted",
    "ANTHROPIC_BASE_URL": "`+routerURL+`"
  },
  "after": [
    1,
    2
  ],
  "flag": true,
  "none": null,
  "off": false
}
`)

		if _, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{}); err != nil {
			t.Fatal(err)
		}

		assertFile(t, path, `{
  "before": 1,
  "modelPicker": {
    "options": [
      {
        "model": "claude-opus-4",
        "label": "Opus"
      },
      {
        "model": "glm-5.3",
        "label": "GLM 5.3",
        "behavesAs": "claude-opus-5-5"
      },
      {
        "model": "glm-5.3-flash",
        "label": "GLM 5.3 Flash",
        "behavesAs": "claude-opus-5-5"
      }
    ],
    "other": true
  },
  "availableModels": [
    "claude-sonnet-4",
    "glm-5.3",
    "glm-5.3-flash"
  ],
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "redacted",
    "ANTHROPIC_BASE_URL": "`+routerURL+`",
    "ENABLE_TOOL_SEARCH": "true"
  },
  "after": [
    1,
    2
  ],
  "flag": true,
  "none": null,
  "off": false,
  "modelSettings": {
    "glm-5.3": {
      "effortLevel": "xhigh"
    },
    "glm-5.3-flash": {
      "effortLevel": "xhigh"
    }
  }
}
`)
		assertMode(t, path, 0o644)
	})

	t.Run("leaves availableModels absent when it was absent", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+routerURL+"\"\n  }\n}\n")

		if _, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{}); err != nil {
			t.Fatal(err)
		}

		assertFile(t, path, `{
  "env": {
    "ANTHROPIC_BASE_URL": "`+routerURL+`",
    "ENABLE_TOOL_SEARCH": "true"
  },
  "modelPicker": {
    "options": [
      {
        "model": "glm-5.3",
        "label": "GLM 5.3",
        "behavesAs": "claude-opus-5-5"
      },
      {
        "model": "glm-5.3-flash",
        "label": "GLM 5.3 Flash",
        "behavesAs": "claude-opus-5-5"
      }
    ]
  },
  "modelSettings": {
    "glm-5.3": {
      "effortLevel": "xhigh"
    },
    "glm-5.3-flash": {
      "effortLevel": "xhigh"
    }
  }
}
`)
	})

	t.Run("is idempotent: a second apply reports nothing and writes nothing", func(t *testing.T) {
		path := settingsFilePath(t)
		appliedLines(t, path)
		before, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		first, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}

		assertLines(t, appliedLines(t, path))
		after, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		second, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		// Every write goes through a temp file renamed over the target, so a rewrite would give
		// the file a new inode; the same inode and bytes mean nothing was written.
		if !os.SameFile(before, after) || !slices.Equal(first, second) {
			t.Fatal("a second apply rewrote the file")
		}
	})

	t.Run("replaces another plugin's router, and keeps a foreign proxy while reporting it", func(t *testing.T) {
		moved := settingsFilePath(t)
		writeSettingsFile(t, moved, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+kimiRouter+"\"\n  }\n}\n")
		lines := appliedLines(t, moved)
		if !strings.Contains(lines[len(lines)-2], "kimi") {
			t.Fatalf("lines = %#v; want the move to name the kimi router", lines)
		}
		assertFile(t, moved, `{
  "env": {
    "ANTHROPIC_BASE_URL": "`+routerURL+`",
    "ENABLE_TOOL_SEARCH": "true"
  },
  "modelPicker": {
    "options": [
      {
        "model": "glm-5.3",
        "label": "GLM 5.3",
        "behavesAs": "claude-opus-5-5"
      },
      {
        "model": "glm-5.3-flash",
        "label": "GLM 5.3 Flash",
        "behavesAs": "claude-opus-5-5"
      }
    ]
  },
  "modelSettings": {
    "glm-5.3": {
      "effortLevel": "xhigh"
    },
    "glm-5.3-flash": {
      "effortLevel": "xhigh"
    }
  }
}
`)

		kept := settingsFilePath(t)
		writeSettingsFile(t, kept, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \"https://proxy.example\"\n  }\n}\n")
		lines = appliedLines(t, kept)
		if !strings.Contains(lines[len(lines)-1], "your own proxy") {
			t.Fatalf("lines = %#v; want the keep to be reported", lines)
		}
		assertFile(t, kept, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \"https://proxy.example\"\n  },\n"+
			"  \"modelPicker\": {\n    \"options\": [\n      {\n        \"model\": \"glm-5.3\",\n        \"label\": \"GLM 5.3\",\n"+
			"        \"behavesAs\": \"claude-opus-5-5\"\n      },\n      {\n        \"model\": \"glm-5.3-flash\",\n"+
			"        \"label\": \"GLM 5.3 Flash\",\n        \"behavesAs\": \"claude-opus-5-5\"\n      }\n    ]\n  },\n"+
			"  \"modelSettings\": {\n    \"glm-5.3\": {\n      \"effortLevel\": \"xhigh\"\n    },\n"+
			"    \"glm-5.3-flash\": {\n      \"effortLevel\": \"xhigh\"\n    }\n  }\n}\n")
	})

	t.Run("errors without writing when the file is not valid JSON", func(t *testing.T) {
		for name, content := range map[string]string{
			"broken":           "{ not json",
			"with comments":    "{\n  // a comment\n}\n",
			"trailing garbage": "{} {}",
			"empty":            "",
		} {
			path := settingsFilePath(t)
			writeSettingsFile(t, path, content)
			if _, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{}); err == nil || !strings.Contains(err.Error(), "not valid JSON") {
				t.Fatalf("%s: error = %v; want it to say not valid JSON", name, err)
			}
			assertFile(t, path, content)
		}
	})

	t.Run("errors without writing when the top level is not an object", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "[]\n")
		if _, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{}); err == nil || !strings.Contains(err.Error(), "not a settings object") {
			t.Fatalf("error = %v; want it to say not a settings object", err)
		}
		assertFile(t, path, "[]\n")
	})

	t.Run("errors without writing when a touched key has the wrong type", func(t *testing.T) {
		for _, row := range []struct{ name, content, message string }{
			{"modelPicker", "{\"modelPicker\":\"odd\"}", "modelPicker must be an object"},
			{"options", "{\"modelPicker\":{\"options\":\"nope\"}}", "options must be an array"},
			{"availableModels", "{\"availableModels\":\"nope\"}", "availableModels must be an array"},
			{"env", "{\"env\":\"nope\"}", "env must be an object"},
			{"base url", "{\"env\":{\"ANTHROPIC_BASE_URL\":7}}", "env.ANTHROPIC_BASE_URL must be a string"},
			{"tool search", "{\"env\":{\"ENABLE_TOOL_SEARCH\":7}}", "env.ENABLE_TOOL_SEARCH must be a string"},
			{"modelSettings", "{\"modelSettings\":\"odd\"}", "modelSettings must be an object"},
			{"effort entry", "{\"modelSettings\":{\"glm-5.3\":\"odd\"}}", "modelSettings.glm-5.3 must be an object"},
		} {
			path := settingsFilePath(t)
			writeSettingsFile(t, path, row.content+"\n")
			if _, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{}); err == nil || !strings.Contains(err.Error(), row.message) {
				t.Fatalf("%s: error = %v; want it to say %q", row.name, err, row.message)
			}
			assertFile(t, path, row.content+"\n")
		}
	})

	t.Run("appends only the missing ids to availableModels, over junk it cannot read", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{\n  \"availableModels\": [\n    \"claude-sonnet-4\",\n    5,\n    \"glm-5.3\"\n  ],\n  \"modelPicker\": {\n    \"options\": [\n      \"junk\",\n      {\n        \"model\": \"glm-5.3\",\n        \"label\": \"GLM 5.3\"\n      }\n    ]\n  }\n}\n")

		lines, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if slices.Contains(lines, "added glm-5.3 to availableModels") || !slices.Contains(lines, "added glm-5.3-flash to availableModels") {
			t.Fatalf("lines = %#v; want only the flash id appended", lines)
		}
		assertFile(t, path, `{
  "availableModels": [
    "claude-sonnet-4",
    5,
    "glm-5.3",
    "glm-5.3-flash"
  ],
  "modelPicker": {
    "options": [
      "junk",
      {
        "model": "glm-5.3",
        "label": "GLM 5.3",
        "behavesAs": "claude-opus-5-5"
      },
      {
        "model": "glm-5.3-flash",
        "label": "GLM 5.3 Flash",
        "behavesAs": "claude-opus-5-5"
      }
    ]
  },
  "modelSettings": {
    "glm-5.3": {
      "effortLevel": "xhigh"
    },
    "glm-5.3-flash": {
      "effortLevel": "xhigh"
    }
  },
  "env": {
    "ANTHROPIC_BASE_URL": "`+routerURL+`",
    "ENABLE_TOOL_SEARCH": "true"
  }
}
`)
	})

	t.Run("round-trips the values JSON.stringify escapes, byte for byte", func(t *testing.T) {
		path := settingsFilePath(t)
		fixture := "{\n  \"esc\": \"a\\\"b\\\\c\\b\\f\\n\\r\\t<>&\",\n  \"ctl\": \"\\u0001\"\n}\n"
		writeSettingsFile(t, path, fixture)

		if _, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{}); err != nil {
			t.Fatal(err)
		}
		got, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		// The rewritten file spells the value exactly as JSON.stringify does: the two-character
		// escapes, the lowercase \u00xx for other controls, and no HTML escaping.
		for _, want := range []string{
			"\"esc\": \"a\\\"b\\\\c\\b\\f\\n\\r\\t<>&\"",
			"\"ctl\": \"\\u0001\"",
		} {
			if !strings.Contains(string(got), want) {
				t.Fatalf("%s does not contain %q:\n%s", path, want, got)
			}
		}
	})

	t.Run("brings a setup-shaped row up to the catalog's behavesAs and leaves a user-owned row alone", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, `{
  "modelPicker": {
    "options": [
      {
        "model": "glm-5.3",
        "label": "GLM 5.3"
      },
      {
        "model": "glm-5.3-flash",
        "label": "GLM 5.3 Flash",
        "note": "mine"
      }
    ]
  },
  "env": {
    "ANTHROPIC_BASE_URL": "`+routerURL+`"
  }
}
`)

		assertLines(t, appliedLines(t, path),
			"set behavesAs on the GLM 5.3 (glm-5.3) row in /model",
			"set GLM 5.3 default effort to xhigh",
			"set GLM 5.3 Flash default effort to xhigh",
			"turned on MCP tool search",
		)
		assertFile(t, path, `{
  "modelPicker": {
    "options": [
      {
        "model": "glm-5.3",
        "label": "GLM 5.3",
        "behavesAs": "claude-opus-5-5"
      },
      {
        "model": "glm-5.3-flash",
        "label": "GLM 5.3 Flash",
        "note": "mine"
      }
    ]
  },
  "env": {
    "ANTHROPIC_BASE_URL": "`+routerURL+`",
    "ENABLE_TOOL_SEARCH": "true"
  },
  "modelSettings": {
    "glm-5.3": {
      "effortLevel": "xhigh"
    },
    "glm-5.3-flash": {
      "effortLevel": "xhigh"
    }
  }
}
`)
	})

	t.Run("writes no behavesAs and no efforts for a provider that declares neither", func(t *testing.T) {
		plain := providers.Zai
		plain.Name = "acme"
		plain.Catalog = map[domain.ModelTier]domain.ModelRef{
			domain.ModelTierMain:  {Tier: domain.ModelTierMain, ID: "big-model-9", Label: "Big Model 9"},
			domain.ModelTierFlash: {Tier: domain.ModelTierFlash, ID: "small-model-9", Label: "Small Model 9"},
		}
		path := settingsFilePath(t)
		assertLines(t, mustApply(t, path, plain),
			"added Big Model 9 (big-model-9) to /model",
			"added Small Model 9 (small-model-9) to /model",
			"pointed ANTHROPIC_BASE_URL at "+routerURL,
			"turned on MCP tool search",
		)
		assertFile(t, path, `{
  "modelPicker": {
    "options": [
      {
        "model": "big-model-9",
        "label": "Big Model 9"
      },
      {
        "model": "small-model-9",
        "label": "Small Model 9"
      }
    ]
  },
  "env": {
    "ANTHROPIC_BASE_URL": "`+routerURL+`",
    "ENABLE_TOOL_SEARCH": "true"
  }
}
`)
	})

	t.Run("sets ENABLE_TOOL_SEARCH only when there is no value yet", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+kimiRouter+"\",\n    \"ENABLE_TOOL_SEARCH\": \"false\"\n  }\n}\n")
		var delta SettingsDelta
		if _, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{
			Record: func(recorded SettingsDelta) { delta = recorded },
		}); err != nil {
			t.Fatal(err)
		}

		assertFile(t, path, `{
  "env": {
    "ANTHROPIC_BASE_URL": "`+routerURL+`",
    "ENABLE_TOOL_SEARCH": "false"
  },
  "modelPicker": {
    "options": [
      {
        "model": "glm-5.3",
        "label": "GLM 5.3",
        "behavesAs": "claude-opus-5-5"
      },
      {
        "model": "glm-5.3-flash",
        "label": "GLM 5.3 Flash",
        "behavesAs": "claude-opus-5-5"
      }
    ]
  },
  "modelSettings": {
    "glm-5.3": {
      "effortLevel": "xhigh"
    },
    "glm-5.3-flash": {
      "effortLevel": "xhigh"
    }
  }
}
`)
		if delta.CreatedToolSearch {
			t.Fatal("delta.createdToolSearch = true; want false (the user set a value)")
		}
	})

	t.Run("never overwrites an effort level the user set", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, `{
  "modelSettings": {
    "glm-5.3": {
      "effortLevel": "low"
    },
    "glm-5.3-flash": {
      "effortLevel": "medium"
    }
  }
}
`)
		var delta SettingsDelta
		lines, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{
			Record: func(recorded SettingsDelta) { delta = recorded },
		})
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines,
			"added GLM 5.3 (glm-5.3) to /model",
			"added GLM 5.3 Flash (glm-5.3-flash) to /model",
			"pointed ANTHROPIC_BASE_URL at "+routerURL,
			"turned on MCP tool search",
		)
		if delta.EffortsAdded.Len() != 0 {
			t.Fatalf("delta.effortsAdded = %v; want empty", delta.EffortsAdded.Keys())
		}
		assertFile(t, path, `{
  "modelSettings": {
    "glm-5.3": {
      "effortLevel": "low"
    },
    "glm-5.3-flash": {
      "effortLevel": "medium"
    }
  },
  "modelPicker": {
    "options": [
      {
        "model": "glm-5.3",
        "label": "GLM 5.3",
        "behavesAs": "claude-opus-5-5"
      },
      {
        "model": "glm-5.3-flash",
        "label": "GLM 5.3 Flash",
        "behavesAs": "claude-opus-5-5"
      }
    ]
  },
  "env": {
    "ANTHROPIC_BASE_URL": "`+routerURL+`",
    "ENABLE_TOOL_SEARCH": "true"
  }
}
`)
	})

	t.Run("records what changed in the delta", func(t *testing.T) {
		path := settingsFilePath(t)
		var delta SettingsDelta
		lines, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{
			Record: func(recorded SettingsDelta) { delta = recorded },
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(lines) == 0 {
			t.Fatal("expected report lines")
		}
		if delta.BaseURLBefore != nil {
			t.Fatalf("delta.baseUrlBefore = %q; want nil (there was none)", *delta.BaseURLBefore)
		}
		if !slices.Equal(delta.OptionsAdded, []string{"glm-5.3", "glm-5.3-flash"}) {
			t.Fatalf("delta.optionsAdded = %#v", delta.OptionsAdded)
		}
		if len(delta.AvailableAppended) != 0 {
			t.Fatalf("delta.availableAppended = %#v; want empty", delta.AvailableAppended)
		}
		if !delta.CreatedModelPicker || !delta.CreatedOptions || !delta.CreatedEnv || !delta.CreatedToolSearch {
			t.Fatalf("delta.created* = %t %t %t %t; want all true",
				delta.CreatedModelPicker, delta.CreatedOptions, delta.CreatedEnv, delta.CreatedToolSearch)
		}
		efforts, err := json.Marshal(delta.EffortsAdded)
		if err != nil {
			t.Fatal(err)
		}
		if string(efforts) != `{"glm-5.3":"xhigh","glm-5.3-flash":"xhigh"}` {
			t.Fatalf("delta.effortsAdded = %s; want both ids in catalog order", efforts)
		}
	})

	t.Run("upgrades an older setup's rows and records it", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, `{
  "modelPicker": {
    "options": [
      {
        "model": "glm-5.3",
        "label": "GLM 5.3"
      },
      {
        "model": "glm-5.3-flash",
        "label": "GLM 5.3 Flash"
      }
    ]
  },
  "env": {
    "ANTHROPIC_BASE_URL": "`+routerURL+`"
  }
}
`)
		var delta SettingsDelta
		lines, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{
			OwnOptions: []string{"glm-5.3", "glm-5.3-flash"},
			Record:     func(recorded SettingsDelta) { delta = recorded },
		})
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines,
			"set behavesAs on the GLM 5.3 (glm-5.3) row in /model",
			"set behavesAs on the GLM 5.3 Flash (glm-5.3-flash) row in /model",
			"set GLM 5.3 default effort to xhigh",
			"set GLM 5.3 Flash default effort to xhigh",
			"turned on MCP tool search",
		)
		assertFile(t, path, `{
  "modelPicker": {
    "options": [
      {
        "model": "glm-5.3",
        "label": "GLM 5.3",
        "behavesAs": "claude-opus-5-5"
      },
      {
        "model": "glm-5.3-flash",
        "label": "GLM 5.3 Flash",
        "behavesAs": "claude-opus-5-5"
      }
    ]
  },
  "env": {
    "ANTHROPIC_BASE_URL": "`+routerURL+`",
    "ENABLE_TOOL_SEARCH": "true"
  },
  "modelSettings": {
    "glm-5.3": {
      "effortLevel": "xhigh"
    },
    "glm-5.3-flash": {
      "effortLevel": "xhigh"
    }
  }
}
`)
		if len(delta.OptionsAdded) != 0 || !delta.CreatedToolSearch {
			t.Fatalf("delta optionsAdded = %#v, createdToolSearch = %t; want none and true", delta.OptionsAdded, delta.CreatedToolSearch)
		}

		// The run after the upgrade reports no changes and rewrites nothing.
		upgraded, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, appliedLines(t, path))
		assertFile(t, path, string(upgraded))
	})

	t.Run("leaves a row the user wrote themselves, and their own tool-search value", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, `{
  "modelPicker": {
    "options": [
      {
        "model": "glm-5.3",
        "label": "GLM 5.3",
        "note": "mine"
      },
      {
        "model": "glm-5.3-flash",
        "label": "Flash, mine"
      }
    ]
  },
  "env": {
    "ANTHROPIC_BASE_URL": "`+routerURL+`",
    "ENABLE_TOOL_SEARCH": "false"
  },
  "modelSettings": {
    "glm-5.3": {
      "effortLevel": "low"
    },
    "glm-5.3-flash": {
      "effortLevel": "medium"
    }
  }
}
`)
		var delta SettingsDelta
		lines, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{
			Record: func(recorded SettingsDelta) { delta = recorded },
		})
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines, "updated the GLM 5.3 Flash (glm-5.3-flash) label in /model")
		assertFile(t, path, `{
  "modelPicker": {
    "options": [
      {
        "model": "glm-5.3",
        "label": "GLM 5.3",
        "note": "mine"
      },
      {
        "model": "glm-5.3-flash",
        "label": "GLM 5.3 Flash"
      }
    ]
  },
  "env": {
    "ANTHROPIC_BASE_URL": "`+routerURL+`",
    "ENABLE_TOOL_SEARCH": "false"
  },
  "modelSettings": {
    "glm-5.3": {
      "effortLevel": "low"
    },
    "glm-5.3-flash": {
      "effortLevel": "medium"
    }
  }
}
`)
		if len(delta.OptionsAdded) != 0 || delta.CreatedToolSearch || delta.EffortsAdded.Len() != 0 {
			t.Fatalf("delta recorded changes it did not make: %#v", delta)
		}
	})
}

// mustApply is appliedLines for a provider the caller names.
func mustApply(t *testing.T, path string, provider domain.Provider) []string {
	t.Helper()
	lines, err := ApplyProviderSettings(t.Context(), path, provider, routerURL, ApplyProviderOptions{})
	if err != nil {
		t.Fatalf("applyProviderSettings(%s): %v", path, err)
	}
	return lines
}

func TestRemoveProviderSettings(t *testing.T) {
	t.Run("takes exactly this provider's entries out; an emptied list stays an empty array", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, `{
  "modelPicker": {
    "options": [
      {
        "model": "kimi-k3",
        "label": "Kimi K3"
      },
      {
        "model": "glm-5.3",
        "label": "GLM 5.3",
        "behavesAs": "claude-opus-5-5"
      },
      {
        "model": "glm-5.3-flash",
        "label": "GLM 5.3 Flash",
        "behavesAs": "claude-opus-5-5"
      }
    ]
  },
  "availableModels": [
    "kimi-k3",
    "glm-5.3"
  ],
  "env": {
    "ANTHROPIC_BASE_URL": "`+routerURL+`"
  }
}
`)

		lines, err := RemoveProviderSettings(t.Context(), path, providers.Zai, routerURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines,
			"took glm-5.3 and glm-5.3-flash out of /model",
			"took glm-5.3 and glm-5.3-flash out of availableModels",
			"removed ANTHROPIC_BASE_URL ("+routerURL+")",
		)
		assertFile(t, path, `{
  "modelPicker": {
    "options": [
      {
        "model": "kimi-k3",
        "label": "Kimi K3"
      }
    ]
  },
  "availableModels": [
    "kimi-k3"
  ]
}
`)
	})

	t.Run("removes the base URL when it is ours and nobody else is registered", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+routerURL+"\"\n  }\n}\n")

		lines, err := RemoveProviderSettings(t.Context(), path, providers.Zai, routerURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines, "removed ANTHROPIC_BASE_URL ("+routerURL+")")
		assertFile(t, path, "{}\n")
	})

	t.Run("an emptied availableModels stays an empty array", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{\n  \"availableModels\": [\n    \"glm-5.3\"\n  ]\n}\n")

		lines, err := RemoveProviderSettings(t.Context(), path, providers.Zai, routerURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines, "took glm-5.3 and glm-5.3-flash out of availableModels")
		assertFile(t, path, "{\n  \"availableModels\": []\n}\n")
	})

	t.Run("repoints the base URL at the first other registered router", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+routerURL+"\"\n  }\n}\n")

		lines, err := RemoveProviderSettings(t.Context(), path, providers.Zai, routerURL, []string{kimiRouter})
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines, "pointed ANTHROPIC_BASE_URL at another plugin's router ("+kimiRouter+")")
		assertFile(t, path, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+kimiRouter+"\"\n  }\n}\n")
	})

	t.Run("leaves a foreign proxy and a missing file alone", func(t *testing.T) {
		foreign := settingsFilePath(t)
		content := "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \"https://proxy.example\"\n  }\n}\n"
		writeSettingsFile(t, foreign, content)
		lines, err := RemoveProviderSettings(t.Context(), foreign, providers.Zai, routerURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines)
		assertFile(t, foreign, content)

		missing := settingsFilePath(t)
		assertLines(t, mustRemove(t, missing))
		if _, err := os.Stat(missing); !os.IsNotExist(err) {
			t.Fatal("a missing settings file was created by a remove that changed nothing")
		}
	})

	t.Run("keeps entries it cannot read and containers it does not own", func(t *testing.T) {
		path := settingsFilePath(t)
		content := "{\n  \"modelPicker\": {\n    \"options\": [\n      \"junk\",\n      {\n        \"model\": \"kimi-k3\",\n        \"label\": \"Kimi K3\"\n      }\n    ]\n  },\n  \"availableModels\": [\n    7,\n    \"kimi-k3\"\n  ]\n}\n"
		writeSettingsFile(t, path, content)

		assertLines(t, mustRemove(t, path))
		assertFile(t, path, content)

		bare := settingsFilePath(t)
		writeSettingsFile(t, bare, "{\n  \"modelPicker\": {}\n}\n")
		assertLines(t, mustRemove(t, bare))
		assertFile(t, bare, "{\n  \"modelPicker\": {}\n}\n")
	})

	t.Run("errors on malformed containers", func(t *testing.T) {
		for _, row := range []struct{ name, content, message string }{
			{"modelPicker", "{\"modelPicker\":\"odd\"}", "modelPicker must be an object"},
			{"options", "{\"modelPicker\":{\"options\":\"odd\"}}", "options must be an array"},
			{"availableModels", "{\"availableModels\":\"nope\"}", "availableModels must be an array"},
			{"env", "{\"env\":\"nope\"}", "env must be an object"},
		} {
			path := settingsFilePath(t)
			writeSettingsFile(t, path, row.content+"\n")
			if _, err := RemoveProviderSettings(t.Context(), path, providers.Zai, routerURL, nil); err == nil || !strings.Contains(err.Error(), row.message) {
				t.Fatalf("%s: error = %v; want it to say %q", row.name, err, row.message)
			}
			assertFile(t, path, row.content+"\n")
		}
	})
}

func mustRemove(t *testing.T, path string) []string {
	t.Helper()
	lines, err := RemoveProviderSettings(t.Context(), path, providers.Zai, routerURL, nil)
	if err != nil {
		t.Fatalf("removeProviderSettings(%s): %v", path, err)
	}
	return lines
}

func TestClearBaseUrl(t *testing.T) {
	t.Run("clears only the base URL, leaving every model entry", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, `{
  "modelPicker": {
    "options": [
      {
        "model": "glm-5.3",
        "label": "GLM 5.3"
      }
    ]
  },
  "env": {
    "ANTHROPIC_BASE_URL": "`+routerURL+`"
  }
}
`)

		lines, err := ClearBaseUrl(t.Context(), path, routerURL, nil, "provider-router")
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines, "removed ANTHROPIC_BASE_URL ("+routerURL+")")
		assertFile(t, path, `{
  "modelPicker": {
    "options": [
      {
        "model": "glm-5.3",
        "label": "GLM 5.3"
      }
    ]
  }
}
`)
	})

	t.Run("refuses an env that is not an object", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{\"env\":\"nope\"}\n")
		if _, err := ClearBaseUrl(t.Context(), path, routerURL, nil, "provider-router"); err == nil || !strings.Contains(err.Error(), "env must be an object") {
			t.Fatalf("error = %v; want it to say env must be an object", err)
		}
		assertFile(t, path, "{\"env\":\"nope\"}\n")
	})
}

func TestReadBaseUrl(t *testing.T) {
	t.Run("reads the current base URL, and nothing from a file that is missing or malformed", func(t *testing.T) {
		path := settingsFilePath(t)
		if _, ok := ReadBaseUrl(path); ok {
			t.Fatal("readBaseUrl(missing) says ok")
		}
		writeSettingsFile(t, path, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+routerURL+"\"\n  }\n}\n")
		if got, ok := ReadBaseUrl(path); !ok || got != routerURL {
			t.Fatalf("readBaseUrl() = %q, %t; want %q, true", got, ok, routerURL)
		}
		writeSettingsFile(t, path, "{\n  \"env\": null\n}\n")
		if _, ok := ReadBaseUrl(path); ok {
			t.Fatal("readBaseUrl(env: null) says ok")
		}
		writeSettingsFile(t, path, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": 1\n  }\n}\n")
		if _, ok := ReadBaseUrl(path); ok {
			t.Fatal("readBaseUrl(base url: 1) says ok")
		}
		writeSettingsFile(t, path, "{ not json")
		if _, ok := ReadBaseUrl(path); ok {
			t.Fatal("readBaseUrl(not json) says ok")
		}
	})
}

func TestUndoProviderSettings(t *testing.T) {
	// appliedWithDelta is an apply on a fresh path with its delta captured.
	appliedWithDelta := func(t *testing.T, path string) SettingsDelta {
		t.Helper()
		var delta SettingsDelta
		if _, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{
			Record: func(recorded SettingsDelta) { delta = recorded },
		}); err != nil {
			t.Fatalf("applyProviderSettings(%s): %v", path, err)
		}
		return delta
	}

	t.Run("takes out exactly what setup added and leaves what the user added", func(t *testing.T) {
		path := settingsFilePath(t)
		delta := appliedWithDelta(t, path)
		// The user adds a row of their own to the merged file.
		writeSettingsFile(t, path, `{
  "modelPicker": {
    "options": [
      {
        "model": "glm-5.3",
        "label": "GLM 5.3",
        "behavesAs": "claude-opus-5-5"
      },
      {
        "model": "glm-5.3-flash",
        "label": "GLM 5.3 Flash",
        "behavesAs": "claude-opus-5-5"
      },
      {
        "model": "mine",
        "label": "Mine"
      }
    ]
  },
  "modelSettings": {
    "glm-5.3": {
      "effortLevel": "xhigh"
    },
    "glm-5.3-flash": {
      "effortLevel": "xhigh"
    }
  },
  "env": {
    "ANTHROPIC_BASE_URL": "`+routerURL+`",
    "ENABLE_TOOL_SEARCH": "true"
  }
}
`)

		lines, err := UndoProviderSettings(t.Context(), path, "zai", SettingsUndo(delta), routerURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines,
			"took glm-5.3 and glm-5.3-flash out of /model",
			"removed ANTHROPIC_BASE_URL ("+routerURL+")",
			"removed ENABLE_TOOL_SEARCH",
			"took glm-5.3 and glm-5.3-flash out of modelSettings",
		)
		assertFile(t, path, `{
  "modelPicker": {
    "options": [
      {
        "model": "mine",
        "label": "Mine"
      }
    ]
  }
}
`)
	})

	t.Run("restores the backup's exact bytes when the undo equals it", func(t *testing.T) {
		path := settingsFilePath(t)
		original := "{\"theme\": \"dark\"}\n"
		writeSettingsFile(t, path, original)
		delta := appliedWithDelta(t, path)
		if content, err := os.ReadFile(path); err != nil || string(content) == original {
			t.Fatalf("the apply did not rewrite the file: %v", err)
		}

		if _, err := UndoProviderSettings(t.Context(), path, "zai", SettingsUndo(delta), routerURL, nil); err != nil {
			t.Fatal(err)
		}
		// The undo equals the backup's JSON, so the backup's own bytes come back — odd spacing
		// and all, not a re-serialization.
		assertFile(t, path, original)
	})

	t.Run("removes appended availableModels ids and leaves others", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{\n  \"availableModels\": [\n    \"sonnet\"\n  ],\n  \"modelPicker\": \"odd\"\n}\n")
		lines, err := UndoProviderSettings(t.Context(), path, "zai", SettingsUndo{
			AvailableAppended: []string{"glm-5.3"},
		}, routerURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines)
		assertFile(t, path, "{\n  \"availableModels\": [\n    \"sonnet\"\n  ],\n  \"modelPicker\": \"odd\"\n}\n")

		writeSettingsFile(t, path, "{\n  \"availableModels\": [\n    \"sonnet\",\n    \"glm-5.3\"\n  ],\n  \"modelPicker\": {\n    \"options\": \"odd\"\n  }\n}\n")
		lines, err = UndoProviderSettings(t.Context(), path, "zai", SettingsUndo{
			AvailableAppended:  []string{"glm-5.3"},
			CreatedModelPicker: true,
		}, routerURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines, "took the appended ids out of availableModels")
		assertFile(t, path, "{\n  \"availableModels\": [\n    \"sonnet\"\n  ],\n  \"modelPicker\": {\n    \"options\": \"odd\"\n  }\n}\n")
	})

	t.Run("puts the base URL back at the live plugin router it came from", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+kimiRouter+"\"\n  }\n}\n")
		var delta SettingsDelta
		if _, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{
			LivePluginURLs: nil, // kimi's router is down, so the apply moves the base URL
			Record:         func(recorded SettingsDelta) { delta = recorded },
		}); err != nil {
			t.Fatal(err)
		}
		if delta.BaseURLBefore == nil || *delta.BaseURLBefore != kimiRouter {
			t.Fatalf("delta.baseUrlBefore = %v; want %q", delta.BaseURLBefore, kimiRouter)
		}

		lines, err := UndoProviderSettings(t.Context(), path, "zai", SettingsUndo(delta), routerURL, []string{kimiRouter})
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines,
			"took glm-5.3 and glm-5.3-flash out of /model",
			"set ANTHROPIC_BASE_URL back to "+kimiRouter,
			"removed ENABLE_TOOL_SEARCH",
			"took glm-5.3 and glm-5.3-flash out of modelSettings",
		)
		assertFile(t, path, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+kimiRouter+"\"\n  }\n}\n")
	})

	t.Run("keeps a tool-search value the user set", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+kimiRouter+"\",\n    \"ENABLE_TOOL_SEARCH\": \"false\"\n  }\n}\n")
		var delta SettingsDelta
		if _, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{
			Record: func(recorded SettingsDelta) { delta = recorded },
		}); err != nil {
			t.Fatal(err)
		}
		if delta.CreatedToolSearch {
			t.Fatal("delta.createdToolSearch = true; want false")
		}

		if _, err := UndoProviderSettings(t.Context(), path, "zai", SettingsUndo(delta), routerURL, nil); err != nil {
			t.Fatal(err)
		}
		assertFile(t, path, "{\n  \"env\": {\n    \"ENABLE_TOOL_SEARCH\": \"false\"\n  }\n}\n")
	})

	t.Run("takes the effort levels out, an emptied entry with them", func(t *testing.T) {
		path := settingsFilePath(t)
		delta := appliedWithDelta(t, path)
		writeSettingsFile(t, path, `{
  "modelPicker": {
    "options": [
      {
        "model": "glm-5.3",
        "label": "GLM 5.3",
        "behavesAs": "claude-opus-5-5"
      },
      {
        "model": "glm-5.3-flash",
        "label": "GLM 5.3 Flash",
        "behavesAs": "claude-opus-5-5"
      }
    ]
  },
  "modelSettings": {
    "glm-5.3": {
      "effortLevel": "xhigh",
      "note": "mine"
    },
    "glm-5.3-flash": {
      "effortLevel": "xhigh"
    },
    "mine": {
      "effortLevel": "high"
    }
  },
  "env": {
    "ANTHROPIC_BASE_URL": "`+routerURL+`",
    "ENABLE_TOOL_SEARCH": "true"
  }
}
`)

		lines, err := UndoProviderSettings(t.Context(), path, "zai", SettingsUndo(delta), routerURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines,
			"took glm-5.3 and glm-5.3-flash out of /model",
			"removed ANTHROPIC_BASE_URL ("+routerURL+")",
			"removed ENABLE_TOOL_SEARCH",
			"took glm-5.3 and glm-5.3-flash out of modelSettings",
		)
		assertFile(t, path, `{
  "modelSettings": {
    "glm-5.3": {
      "note": "mine"
    },
    "mine": {
      "effortLevel": "high"
    }
  }
}
`)
	})

	t.Run("skips containers the undo does not own", func(t *testing.T) {
		path := settingsFilePath(t)
		content := "{\n  \"modelPicker\": {\n    \"options\": \"odd\"\n  },\n  \"availableModels\": \"odd\",\n  \"modelSettings\": \"odd\"\n}\n"
		writeSettingsFile(t, path, content)
		lines, err := UndoProviderSettings(t.Context(), path, "zai", SettingsUndo{
			OptionsAdded:      []string{"glm-5.3"},
			AvailableAppended: []string{"glm-5.3"},
			CreatedToolSearch: true,
			EffortsAdded:      stringEfforts("glm-5.3", "xhigh"),
		}, routerURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines)
		assertFile(t, path, content)

		entries := settingsFilePath(t)
		writeSettingsFile(t, entries, "{\n  \"modelSettings\": {\n    \"glm-5.3\": \"odd\"\n  }\n}\n")
		lines, err = UndoProviderSettings(t.Context(), entries, "zai", SettingsUndo{
			EffortsAdded: stringEfforts("glm-5.3", "xhigh"),
		}, routerURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines)
		assertFile(t, entries, "{\n  \"modelSettings\": {\n    \"glm-5.3\": \"odd\"\n  }\n}\n")
	})

	t.Run("refuses an env that is not an object", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{\"env\":\"nope\"}\n")
		if _, err := UndoProviderSettings(t.Context(), path, "zai", SettingsUndo{}, routerURL, nil); err == nil || !strings.Contains(err.Error(), "env must be an object") {
			t.Fatalf("error = %v; want it to say env must be an object", err)
		}
		assertFile(t, path, "{\"env\":\"nope\"}\n")
	})

	t.Run("leaves an effort level the user changed meanwhile", func(t *testing.T) {
		path := settingsFilePath(t)
		content := "{\n  \"modelSettings\": {\n    \"glm-5.3\": {\n      \"effortLevel\": \"low\"\n    }\n  }\n}\n"
		writeSettingsFile(t, path, content)
		lines, err := UndoProviderSettings(t.Context(), path, "zai", SettingsUndo{
			EffortsAdded: stringEfforts("glm-5.3", "xhigh"),
		}, routerURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines)
		assertFile(t, path, content)
	})

	t.Run("repoints a base URL with no ledger at another live router, and drops an env it created", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+routerURL+"\"\n  }\n}\n")
		lines, err := UndoProviderSettings(t.Context(), path, "zai", SettingsUndo{
			CreatedEnv: true,
		}, routerURL, []string{routerURL, kimiRouter})
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, lines, "set ANTHROPIC_BASE_URL back to "+kimiRouter)
		assertFile(t, path, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+kimiRouter+"\"\n  }\n}\n")

		created := settingsFilePath(t)
		writeSettingsFile(t, created, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+routerURL+"\"\n  }\n}\n")
		assertLines(t, mustUndo(t, created, SettingsUndo{CreatedEnv: true}, routerURL, nil), "removed ANTHROPIC_BASE_URL ("+routerURL+")")
		assertFile(t, created, "{}\n")

		// A tool search the ledger claims but whose value moved on is not setup's to take.
		moved := settingsFilePath(t)
		writeSettingsFile(t, moved, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+routerURL+"\",\n    \"ENABLE_TOOL_SEARCH\": \"off\"\n  }\n}\n")
		assertLines(t, mustUndo(t, moved, SettingsUndo{CreatedToolSearch: true}, routerURL, nil), "removed ANTHROPIC_BASE_URL ("+routerURL+")")
		assertFile(t, moved, "{\n  \"env\": {\n    \"ENABLE_TOOL_SEARCH\": \"off\"\n  }\n}\n")
	})
}

func mustUndo(t *testing.T, path string, undo SettingsUndo, routerURL string, live []string) []string {
	t.Helper()
	lines, err := UndoProviderSettings(t.Context(), path, "zai", undo, routerURL, live)
	if err != nil {
		t.Fatalf("undoProviderSettings(%s): %v", path, err)
	}
	return lines
}

// stringEfforts builds an ordered efforts map the way applyEfforts records one.
func stringEfforts(pairs ...string) *StringMap {
	efforts := NewStringMap()
	for i := 0; i+1 < len(pairs); i += 2 {
		efforts.Set(pairs[i], pairs[i+1])
	}
	return efforts
}

func TestClaudeSettingsCarefulWrite(t *testing.T) {
	t.Run("never overwrites a settings.json it cannot read: only a missing file counts as empty", func(t *testing.T) {
		path := settingsFilePath(t)
		content := "{\n  \"permissions\": {\n    \"allow\": [\n      \"Bash\"\n    ]\n  },\n  \"env\": {\n    \"MY_TOKEN\": \"t\"\n  }\n}\n"
		writeSettingsFile(t, path, content)
		if err := os.Chmod(path, 0o000); err != nil {
			t.Fatal(err)
		}
		_, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{})
		if err == nil || !strings.Contains(err.Error(), "cannot read") {
			t.Fatalf("error = %v; want it to say cannot read", err)
		}
		if err := os.Chmod(path, 0o600); err != nil {
			t.Fatal(err)
		}
		assertFile(t, path, content)

		dir := settingsFilePath(t)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if _, err := ApplyProviderSettings(t.Context(), dir, providers.Zai, routerURL, ApplyProviderOptions{}); err == nil || !strings.Contains(err.Error(), "cannot read") {
			t.Fatalf("error = %v; want it to say cannot read for a directory", err)
		}

		underFile := filepath.Join(t.TempDir(), "afile")
		if err := os.WriteFile(underFile, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		// The mkdir of the settings dir fails first (ENOTDIR).
		if _, err := ApplyProviderSettings(t.Context(), filepath.Join(underFile, "settings.json"), providers.Zai, routerURL, ApplyProviderOptions{}); err == nil || !strings.Contains(err.Error(), "nothing changed") {
			t.Fatalf("error = %v; want it to change nothing", err)
		}
		if _, err := snapshotSettings(filepath.Join(underFile, "settings.json")); err == nil || !strings.Contains(err.Error(), "cannot read") {
			t.Fatalf("snapshot = %v; want it to say cannot read for a path under a file", err)
		}
	})

	t.Run("keeps the file's mode and writes through a symlink, keeping the link", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{\n  \"theme\": \"dark\"\n}\n")
		if err := os.Chmod(path, 0o600); err != nil {
			t.Fatal(err)
		}
		appliedLines(t, path)
		assertMode(t, path, 0o600)

		real := filepath.Join(t.TempDir(), "dotfiles-settings.json")
		if err := os.WriteFile(real, []byte("{}\n"), 0o640); err != nil {
			t.Fatal(err)
		}
		link := settingsFilePath(t)
		if err := os.MkdirAll(filepath.Dir(link), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(real, link); err != nil {
			t.Fatal(err)
		}
		appliedLines(t, link)
		info, err := os.Lstat(link)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode()&fs.ModeSymlink == 0 {
			t.Fatal("the symlink was replaced by a regular file")
		}
		assertMode(t, real, 0o640)
		content, err := os.ReadFile(real)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(content), `"ANTHROPIC_BASE_URL": "`+routerURL+`"`) {
			t.Fatalf("the symlink's target was not merged: %s", content)
		}
	})

	t.Run("backs the file up once, before the first write ever, mode 0600", func(t *testing.T) {
		path := settingsFilePath(t)
		original := "{\n  \"theme\": \"dark\"\n}\n"
		writeSettingsFile(t, path, original)
		appliedLines(t, path)
		backup := SettingsBackupPath(path, "zai")
		assertFile(t, backup, original)
		assertMode(t, backup, 0o600)
		if _, err := ClearBaseUrl(t.Context(), path, routerURL, nil, "zai"); err != nil {
			t.Fatal(err)
		}
		assertFile(t, backup, original)
	})

	t.Run("waits for another plugin's edit to finish (a shared lock)", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{}\n")
		lock := path + ".provider-routers.lock"
		if err := os.WriteFile(lock, []byte(fmt.Sprintf("%d\n", os.Getpid())), 0o666); err != nil {
			t.Fatal(err)
		}
		type outcome struct {
			lines []string
			err   error
		}
		done := make(chan outcome, 1)
		go func() {
			lines, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{})
			done <- outcome{lines, err}
		}()
		// The edit holds off while the lock is there.
		time.Sleep(100 * time.Millisecond)
		if err := os.Remove(lock); err != nil {
			t.Fatal(err)
		}
		select {
		case result := <-done:
			if result.err != nil || len(result.lines) == 0 {
				t.Fatalf("the waiting apply failed: %v", result.err)
			}
		case <-time.After(6 * time.Second):
			t.Fatal("the waiting apply never finished")
		}
	})

	t.Run("gives up when the other plugin never releases the lock", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{}\n")
		lock := path + ".provider-routers.lock"
		if err := os.WriteFile(lock, []byte(fmt.Sprintf("%d\n", os.Getpid())), 0o666); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Remove(lock) })
		start := time.Now()
		_, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{})
		if err == nil || !strings.Contains(err.Error(), "another plugin is editing it") {
			t.Fatalf("error = %v; want it to say another plugin is editing it", err)
		}
		if elapsed := time.Since(start); elapsed < 4*time.Second {
			t.Fatalf("gave up after %v; want it to wait out the lock", elapsed)
		}
		assertFile(t, path, "{}\n")
	})

	t.Run("redoes the edit once when the file changed under it", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{}\n")
		raced := 0
		lines, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{
			// The edit's own record hook stands in for another writer striking between the read
			// and the rename: it changes the file's size once, so the first commit is refused.
			Record: func(SettingsDelta) {
				raced++
				if raced == 1 {
					if err := os.WriteFile(path, []byte("{\"racing\": 1}\n"), 0o644); err != nil {
						t.Error(err)
					}
				}
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		if raced != 2 {
			t.Fatalf("the edit ran %d times; want 2 (one refused, one redone)", raced)
		}
		if len(lines) == 0 {
			t.Fatal("the redone edit reported nothing")
		}
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(content), "\"racing\"") || !strings.Contains(string(content), "\"modelPicker\"") {
			t.Fatalf("the file holds neither racer's nor edit's keys: %s", content)
		}
	})

	t.Run("reports the change and writes nothing when the file keeps changing", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{}\n")
		raced := 0
		_, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{
			Record: func(SettingsDelta) {
				raced++
				if err := os.WriteFile(path, []byte(fmt.Sprintf("{\"racing\": %d}\n", raced)), 0o644); err != nil {
					t.Error(err)
				}
			},
		})
		if err == nil || !strings.Contains(err.Error(), "changed on disk while being edited") {
			t.Fatalf("error = %v; want it to say the file changed while being edited", err)
		}
		assertFile(t, path, fmt.Sprintf("{\"racing\": %d}\n", raced))
	})

	t.Run("fails when the parent directory cannot be created", func(t *testing.T) {
		// A file where the settings directory should be: the mkdir fails under it (ENOTDIR).
		notADir := filepath.Join(t.TempDir(), "afile")
		if err := os.WriteFile(notADir, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		path := filepath.Join(notADir, "sub", "settings.json")
		if _, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{}); err == nil || !strings.Contains(err.Error(), "nothing changed") {
			t.Fatalf("error = %v; want it to change nothing", err)
		}
	})

	t.Run("fails when the backup cannot be written", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "settings.json")
		writeSettingsFile(t, path, "{\n  \"theme\": \"dark\"\n}\n")
		t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
		if _, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{
			Record: func(SettingsDelta) { _ = os.Chmod(dir, 0o500) },
		}); err == nil || !strings.Contains(err.Error(), "nothing changed") {
			t.Fatalf("error = %v; want it to change nothing", err)
		}
	})

	t.Run("fails when the write itself fails", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "settings.json")
		writeSettingsFile(t, path, "{\n  \"theme\": \"dark\"\n}\n")
		// The backup already exists, so the failure lands on the atomic write.
		if err := os.WriteFile(SettingsBackupPath(path, "zai"), []byte("old\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Chmod(dir, 0o700); _ = os.Chmod(path, 0o600) })
		if _, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{
			// The directory goes read-only, so the temp file cannot be written.
			Record: func(SettingsDelta) {
				_ = os.Chmod(dir, 0o500)
			},
		}); err == nil || !strings.Contains(err.Error(), "nothing changed") {
			t.Fatalf("error = %v; want it to change nothing", err)
		}
	})

	t.Run("fails when the backup's source cannot be read", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "settings.json")
		writeSettingsFile(t, path, "{\n  \"theme\": \"dark\"\n}\n")
		t.Cleanup(func() { _ = os.Chmod(path, 0o600) })
		if _, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{
			Record: func(SettingsDelta) { _ = os.Chmod(path, 0o000) },
		}); err == nil || !strings.Contains(err.Error(), "nothing changed") {
			t.Fatalf("error = %v; want it to change nothing", err)
		}
	})

	t.Run("reports a lock release failure after a successful edit", func(t *testing.T) {
		path := settingsFilePath(t)
		writeSettingsFile(t, path, "{}\n")
		lock := path + ".provider-routers.lock"
		// 0000 makes the release's read fail.
		t.Cleanup(func() {
			_ = os.Chmod(lock, 0o600)
			_ = os.Remove(lock)
		})
		if _, err := ApplyProviderSettings(t.Context(), path, providers.Zai, routerURL, ApplyProviderOptions{
			Record: func(SettingsDelta) {
				_ = os.Chmod(lock, 0o000)
			},
		}); err == nil {
			t.Fatal("the failed release was swallowed; want it to surface")
		}
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(content), "\"modelPicker\"") {
			t.Fatalf("the edit itself did not land: %s", content)
		}
	})
}

func TestClaudeSettingsInternals(t *testing.T) {
	t.Run("applyBaseUrl leaves a malformed env alone and still reports", func(t *testing.T) {
		root, err := parseJSON("{\"env\": \"nope\"}")
		if err != nil {
			t.Fatal(err)
		}
		report := "pointed ANTHROPIC_BASE_URL somewhere"
		lines := applyBaseUrl(root, domain.BaseUrlPlan{Kind: domain.BaseUrlPlanSet, URL: routerURL, Report: &report}, "p")
		assertLines(t, lines, report)
		if got := marshalSettings(root); got != "{\n  \"env\": \"nope\"\n}" {
			t.Fatalf("root = %s; want untouched", got)
		}
	})

	t.Run("applyToolSearch skips a file with no env", func(t *testing.T) {
		root := emptyObject()
		assertLines(t, applyToolSearch(root, true, nil, "p"))
		if root.get("env") != nil {
			t.Fatal("applyToolSearch created an env")
		}
	})

	t.Run("undoToolSearch skips an env that is not an object", func(t *testing.T) {
		root, err := parseJSON("{\"env\": \"nope\"}")
		if err != nil {
			t.Fatal(err)
		}
		assertLines(t, undoToolSearch(root, SettingsUndo{CreatedToolSearch: true}))
	})

	t.Run("serialized rejects a value that does not survive the round trip", func(t *testing.T) {
		root := emptyObject()
		root.set("broken", &jsonNode{kind: jsonNumber, num: "1.2.3"})
		if _, err := serializedSettings("p", root); err == nil || !strings.Contains(err.Error(), "did not survive a JSON round trip") {
			t.Fatalf("error = %v; want the round-trip guard", err)
		}
	})

	t.Run("serialized rejects keys a round trip would reorder", func(t *testing.T) {
		root := &jsonNode{kind: jsonObject, keys: []string{"a", "a"}, fields: map[string]*jsonNode{"a": newText("x")}}
		if _, err := serializedSettings("p", root); err == nil || !strings.Contains(err.Error(), "did not survive a JSON round trip") {
			t.Fatalf("error = %v; want the round-trip guard", err)
		}
	})

	t.Run("backupBytesIfEqual is false when the backup is missing", func(t *testing.T) {
		if _, ok := backupBytesIfEqual(filepath.Join(t.TempDir(), "missing"), emptyObject()); ok {
			t.Fatal("backupBytesIfEqual(missing) says ok")
		}
	})

	t.Run("node accessors guard values that are not objects", func(t *testing.T) {
		if got := newText("x").get("k"); got != nil {
			t.Fatalf("get on a string = %v; want nil", got)
		}
		if size := newText("x").size(); size != 0 {
			t.Fatalf("size of a string = %d; want 0", size)
		}
		node := &jsonNode{kind: jsonObject}
		node.set("a", newText("v"))
		if got := marshalSettings(node); got != "{\n  \"a\": \"v\"\n}" {
			t.Fatalf("marshal = %q", got)
		}
		emptyObject().del("missing") // a missing key is a no-op, not a panic
		if nodesEqual(newText("a"), newText("b")) || !nodesEqual(newText("a"), newText("a")) {
			t.Fatal("nodesEqual compares scalars wrongly")
		}
		if nodesEqual(&jsonNode{kind: jsonBool, boolean: true}, &jsonNode{kind: jsonNull}) {
			t.Fatal("nodesEqual says true and null are equal")
		}
		if nodesEqual(nil, newText("a")) || !nodesEqual(nil, nil) {
			t.Fatal("nodesEqual compares a missing value wrongly")
		}
		two := newArray(newText("a"), newText("b"))
		other := newArray(newText("a"), newText("c"))
		if nodesEqual(two, other) || !nodesEqual(two, newArray(newText("a"), newText("b"))) {
			t.Fatal("nodesEqual compares arrays wrongly")
		}
	})

	t.Run("parseJSON rejects malformed shapes", func(t *testing.T) {
		for _, text := range []string{"]", "{5:1}", "[1", "{\"a\"", "[,]", "{\"a\":}"} {
			if _, err := parseJSON(text); err == nil {
				t.Fatalf("parseJSON(%q) succeeded; want an error", text)
			}
		}
	})

	t.Run("StringMap grows from its zero value and rejects malformed JSON", func(t *testing.T) {
		var zero StringMap
		zero.Set("k", "v")
		data, err := json.Marshal(&zero)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != `{"k":"v"}` {
			t.Fatalf("marshal = %s", data)
		}

		var none *StringMap
		if _, ok := none.Get("k"); ok {
			t.Fatal("get on a nil map says ok")
		}
		for _, text := range []string{`x`, `[1]`, `{"x":1}`, `{"x"`, `{"x":"y"`} {
			var m StringMap
			if err := json.Unmarshal([]byte(text), &m); err == nil {
				t.Fatalf("unmarshal(%s) succeeded; want an error", text)
			}
		}
		// json.Unmarshal validates before it calls in, so the truncated shapes go straight in.
		for _, text := range []string{"x", "{\"x\"", "{\"x\":\"y\"", "{\"x\":1}"} {
			var m StringMap
			if err := m.UnmarshalJSON([]byte(text)); err == nil {
				t.Fatalf("UnmarshalJSON(%s) succeeded; want an error", text)
			}
		}
	})

	t.Run("StringMap keeps insertion order and JSON shape", func(t *testing.T) {
		efforts := NewStringMap()
		efforts.Set("glm-5.3", "xhigh")
		efforts.Set("glm-5.3-flash", "xhigh")
		efforts.Set("glm-5.3", "high")
		data, err := json.Marshal(efforts)
		if err != nil {
			t.Fatal(err)
		}
		if string(data) != `{"glm-5.3":"high","glm-5.3-flash":"xhigh"}` {
			t.Fatalf("marshal = %s; want insertion order kept", data)
		}

		var round StringMap
		if err := json.Unmarshal(data, &round); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(round.Keys(), []string{"glm-5.3", "glm-5.3-flash"}) {
			t.Fatalf("keys = %#v; want the file order back", round.Keys())
		}
		if value, ok := round.Get("glm-5.3"); !ok || value != "high" {
			t.Fatalf("get(glm-5.3) = %q, %t; want high, true", value, ok)
		}
		if _, ok := round.Get("missing"); ok {
			t.Fatal("get(missing) says ok")
		}

		var duplicates StringMap
		if err := json.Unmarshal([]byte(`{"x":"1","x":"2","y":"3"}`), &duplicates); err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(duplicates.Keys(), []string{"x", "y"}) || duplicates.Len() != 2 {
			t.Fatalf("keys = %#v; want the last duplicate to win in place", duplicates.Keys())
		}
		if value, _ := duplicates.Get("x"); value != "2" {
			t.Fatalf("x = %q; want 2", value)
		}

		var none *StringMap
		if none.Len() != 0 || none.Keys() != nil {
			t.Fatal("a nil map is not empty")
		}
	})
}
