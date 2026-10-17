// The settings adapter's external cases, through the exported API only. The cases the internal
// claude_settings_test.go already carries are not repeated. Every path sits under t.TempDir();
// the real ~/.claude is never touched.
package adapters_test

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/router"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

const (
	extRouter     = "http://127.0.0.1:18787"
	extKimiRouter = "http://127.0.0.1:18788"
	extAcmeRouter = "http://127.0.0.1:18800"
)

// The two catalog rows setup writes, and the modelSettings it sets, as they land in the file.
const extReferenceOptions = `  "modelPicker": {
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
  }`

const extReferenceEfforts = `  "modelSettings": {
    "glm-5.3": {
      "effortLevel": "xhigh"
    },
    "glm-5.3-flash": {
      "effortLevel": "xhigh"
    }
  }`

func extSettingsPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "home", ".claude", "settings.json")
}

// extWriteJSON writes the file's dir first, then the JSON as its pretty text.
func extWriteJSON(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func extRead(t *testing.T, path string) string {
	t.Helper()
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(text)
}

func extAssertFile(t *testing.T, path, want string) {
	t.Helper()
	if got := extRead(t, path); got != want {
		t.Fatalf("%s =\n%s; want\n%s", path, got, want)
	}
}

func extAssertLines(t *testing.T, got []string, want ...string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Fatalf("lines = %#v; want %#v", got, want)
	}
}

// extAppliedLines is an apply that must have succeeded.
func extAppliedLines(t *testing.T, path string) []string {
	t.Helper()
	lines, err := adapters.ApplyProviderSettings(t.Context(), path, testkit.ReferenceProvider, extRouter, adapters.ApplyProviderOptions{})
	if err != nil {
		t.Fatalf("applyProviderSettings(%s): %v", path, err)
	}
	return lines
}

// extApply is an apply with its delta captured.
func extApply(t *testing.T, path string, ownOptions []string) ([]string, adapters.SettingsDelta) {
	t.Helper()
	var recorded adapters.SettingsDelta
	lines, err := adapters.ApplyProviderSettings(t.Context(), path, testkit.ReferenceProvider, extRouter, adapters.ApplyProviderOptions{
		OwnOptions: ownOptions,
		Record:     func(delta adapters.SettingsDelta) { recorded = delta },
	})
	if err != nil {
		t.Fatalf("applyProviderSettings(%s): %v", path, err)
	}
	return lines, recorded
}

func extStrPtr(text string) *string { return &text }

// extDeltaAsUndo hands a delta straight to the undo: its shape carries every undo field, and the
// two types stay apart, so the copy is said once.
func extDeltaAsUndo(delta adapters.SettingsDelta) adapters.SettingsUndo {
	return adapters.SettingsUndo{
		BaseURLBefore:      delta.BaseURLBefore,
		OptionsAdded:       delta.OptionsAdded,
		AvailableAppended:  delta.AvailableAppended,
		CreatedModelPicker: delta.CreatedModelPicker,
		CreatedOptions:     delta.CreatedOptions,
		CreatedEnv:         delta.CreatedEnv,
		CreatedToolSearch:  delta.CreatedToolSearch,
		EffortsAdded:       delta.EffortsAdded,
	}
}

func TestTheBaseURLPlan(t *testing.T) {
	t.Run("sets when unset, keeps when already ours, moves from another plugin router", func(t *testing.T) {
		set := domain.PlanBaseUrl(nil, extRouter, nil)
		if set.Kind != domain.BaseUrlPlanSet || set.URL != extRouter {
			t.Fatalf("planBaseUrl(unset) = %+v, want a set at the router", set)
		}
		if got := domain.PlanBaseUrl(extStrPtr(extRouter), extRouter, nil); got.Kind != domain.BaseUrlPlanKeep {
			t.Fatalf("planBaseUrl(ours) = %+v, want a keep", got)
		}
		moved := domain.PlanBaseUrl(extStrPtr(extKimiRouter), extRouter, nil)
		if moved.Kind != domain.BaseUrlPlanSet || moved.URL != extRouter {
			t.Fatalf("planBaseUrl(kimi's) = %+v, want a set at the router", moved)
		}
		if moved.Report == nil || !strings.Contains(*moved.Report, "kimi") {
			t.Fatalf("the move's report = %v, want it to name kimi", moved.Report)
		}
	})

	t.Run("keeps and reports anything else as the user's own proxy", func(t *testing.T) {
		plan := domain.PlanBaseUrl(extStrPtr("https://proxy.example"), extRouter, nil)
		if plan.Kind != domain.BaseUrlPlanKeep {
			t.Fatalf("plan = %+v, want a keep", plan)
		}
		if plan.Report == nil || !strings.Contains(*plan.Report, "your own proxy") {
			t.Fatalf("the keep's report = %v, want it to name the user's own proxy", plan.Report)
		}
	})

	t.Run("clears only what is ours, repointing at another live router when there is one", func(t *testing.T) {
		if got := domain.PlanBaseUrlRemoval(extStrPtr(extRouter), extRouter, nil); got.Kind != domain.BaseUrlPlanRemove {
			t.Fatalf("planBaseUrlRemoval(ours, no others) = %+v, want a remove", got)
		}
		got := domain.PlanBaseUrlRemoval(extStrPtr(extRouter), extRouter, []string{extKimiRouter})
		if got.Kind != domain.BaseUrlPlanSet || got.URL != extKimiRouter {
			t.Fatalf("planBaseUrlRemoval(ours, kimi live) = %+v, want a set at kimi's", got)
		}
		if got := domain.PlanBaseUrlRemoval(extStrPtr("https://proxy.example"), extRouter, nil); got.Kind != domain.BaseUrlPlanKeep {
			t.Fatalf("planBaseUrlRemoval(foreign) = %+v, want a keep", got)
		}
	})

	t.Run("does not move the base URL from a live plugin router, and says a dead one was not running", func(t *testing.T) {
		if got := domain.PlanBaseUrl(extStrPtr(extKimiRouter), extRouter, []string{extKimiRouter}); got.Kind != domain.BaseUrlPlanKeep || got.Report != nil {
			t.Fatalf("planBaseUrl(kimi live) = %+v, want a silent keep", got)
		}
		dead := domain.PlanBaseUrl(extStrPtr(extKimiRouter), extRouter, nil)
		if dead.Kind != domain.BaseUrlPlanSet || dead.Report == nil || !strings.Contains(*dead.Report, "not running") {
			t.Fatalf("planBaseUrl(kimi dead) = %+v, want a set that says the old one was not running", dead)
		}
	})
}

func TestApplyProviderSettingsTS(t *testing.T) {
	t.Run("creates the file (and its directory) when missing, with the two models (behaving as their Claude models) and the base URL", func(t *testing.T) {
		path := extSettingsPath(t)

		extAssertLines(t, extAppliedLines(t, path),
			"added GLM 5.3 (glm-5.3) to /model",
			"added GLM 5.3 Flash (glm-5.3-flash) to /model",
			"set GLM 5.3 default effort to xhigh",
			"set GLM 5.3 Flash default effort to xhigh",
			"pointed ANTHROPIC_BASE_URL at "+extRouter,
			"turned on MCP tool search",
		)
		extAssertFile(t, path, "{\n"+extReferenceOptions+",\n"+extReferenceEfforts+",\n"+
			"  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+extRouter+"\",\n    \"ENABLE_TOOL_SEARCH\": \"true\"\n  }\n}\n")
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("mode = %o, want 600", info.Mode().Perm())
		}
	})

	t.Run("keeps every other key and its order, and only appends to an existing availableModels", func(t *testing.T) {
		path := extSettingsPath(t)
		extWriteJSON(t, path, `{
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
    "ANTHROPIC_BASE_URL": "`+extRouter+`"
  },
  "after": [
    1,
    2
  ]
}
`)

		if _, err := adapters.ApplyProviderSettings(t.Context(), path, testkit.ReferenceProvider, extRouter, adapters.ApplyProviderOptions{}); err != nil {
			t.Fatal(err)
		}

		extAssertFile(t, path, `{
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
    "ANTHROPIC_BASE_URL": "`+extRouter+`",
    "ENABLE_TOOL_SEARCH": "true"
  },
  "after": [
    1,
    2
  ],
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

	t.Run("is idempotent: a second apply is byte-identical and reports no changes", func(t *testing.T) {
		path := extSettingsPath(t)
		extAppliedLines(t, path)
		first := extRead(t, path)

		extAssertLines(t, extAppliedLines(t, path))
		if second := extRead(t, path); second != first {
			t.Fatalf("a second apply rewrote the file:\n%s", second)
		}
	})

	t.Run("errors without writing when the file is not valid JSON or not an object", func(t *testing.T) {
		broken := extSettingsPath(t)
		extWriteJSON(t, broken, "{ not json")
		_, err := adapters.ApplyProviderSettings(t.Context(), broken, testkit.ReferenceProvider, extRouter, adapters.ApplyProviderOptions{})
		if err == nil || !strings.Contains(err.Error(), "not valid JSON") {
			t.Fatalf("error = %v; want it to say not valid JSON", err)
		}
		if got := extRead(t, broken); got != "{ not json" {
			t.Fatalf("the broken file was rewritten: %s", got)
		}

		array := extSettingsPath(t)
		extWriteJSON(t, array, "[]")
		_, err = adapters.ApplyProviderSettings(t.Context(), array, testkit.ReferenceProvider, extRouter, adapters.ApplyProviderOptions{})
		if err == nil || !strings.Contains(err.Error(), "not a settings object") {
			t.Fatalf("error = %v; want it to say not a settings object", err)
		}
		if got := extRead(t, array); got != "[]" {
			t.Fatalf("the array file was rewritten: %s", got)
		}
	})

	t.Run("brings a row shaped like setup's own up to the catalog's behavesAs, and leaves a row the user made their own untouched", func(t *testing.T) {
		path := extSettingsPath(t)
		extWriteJSON(t, path, `{
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
    "ANTHROPIC_BASE_URL": "`+extRouter+`"
  }
}
`)

		if _, err := adapters.ApplyProviderSettings(t.Context(), path, testkit.ReferenceProvider, extRouter, adapters.ApplyProviderOptions{}); err != nil {
			t.Fatal(err)
		}

		extAssertFile(t, path, `{
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
    "ANTHROPIC_BASE_URL": "`+extRouter+`",
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

		plain := extSettingsPath(t)
		if _, err := adapters.ApplyProviderSettings(t.Context(), plain, testkit.AcmeProvider, extAcmeRouter, adapters.ApplyProviderOptions{}); err != nil {
			t.Fatal(err)
		}
		extAssertFile(t, plain, `{
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
    "ANTHROPIC_BASE_URL": "`+extAcmeRouter+`",
    "ENABLE_TOOL_SEARCH": "true"
  }
}
`)
	})

	t.Run("sets ENABLE_TOOL_SEARCH when it points the base URL at the router, but never over a value the user set", func(t *testing.T) {
		path := extSettingsPath(t)
		extWriteJSON(t, path, `{
  "env": {
    "ANTHROPIC_BASE_URL": "`+extKimiRouter+`",
    "ENABLE_TOOL_SEARCH": "false"
  }
}
`)
		_, delta := extApply(t, path, nil)
		extAssertFile(t, path, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+extRouter+"\",\n    \"ENABLE_TOOL_SEARCH\": \"false\"\n  },\n"+
			extReferenceOptions+",\n"+extReferenceEfforts+"\n}\n")
		if delta.CreatedToolSearch {
			t.Fatal("the delta claims setup created the tool-search value the user had set")
		}
	})
}

func TestRemoveProviderSettingsTS(t *testing.T) {
	t.Run("leaves a foreign proxy and an empty file alone", func(t *testing.T) {
		foreign := extSettingsPath(t)
		extWriteJSON(t, foreign, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \"https://proxy.example\"\n  }\n}\n")
		if _, err := adapters.RemoveProviderSettings(t.Context(), foreign, testkit.ReferenceProvider, extRouter, nil); err != nil {
			t.Fatal(err)
		}
		extAssertFile(t, foreign, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \"https://proxy.example\"\n  }\n}\n")

		empty := extSettingsPath(t)
		lines, err := adapters.RemoveProviderSettings(t.Context(), empty, testkit.ReferenceProvider, extRouter, nil)
		if err != nil || len(lines) != 0 {
			t.Fatalf("removeProviderSettings(missing) = %v, %v; want no change", lines, err)
		}
		// Nothing changed, so nothing is written: a missing file stays missing.
		if _, err := os.Stat(empty); !os.IsNotExist(err) {
			t.Fatalf("the missing file stayed missing: %v", err)
		}
	})
}

func TestTheCarefulWrite(t *testing.T) {
	t.Run("writes nothing when nothing changed", func(t *testing.T) {
		path := extSettingsPath(t)
		extAppliedLines(t, path)
		// Every write goes through a temp file renamed over the target, so a rewrite would give the
		// file a new inode; the same file and bytes mean nothing was written (an mtime check misses
		// rewrites on coarse-clock filesystems).
		before, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		first := extRead(t, path)
		extAssertLines(t, extAppliedLines(t, path))
		after, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if !os.SameFile(before, after) || extRead(t, path) != first {
			t.Fatal("a nothing-changed apply rewrote the file")
		}
	})

	t.Run("waits for another plugin's edit to finish (a shared lock), and gives up when it never does", func(t *testing.T) {
		path := extSettingsPath(t)
		extWriteJSON(t, path, "{}\n")
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
			lines, err := adapters.ApplyProviderSettings(t.Context(), path, testkit.ReferenceProvider, extRouter, adapters.ApplyProviderOptions{})
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
				t.Fatalf("the waiting apply failed: %v (%v)", result.err, result.lines)
			}
		case <-time.After(6 * time.Second):
			t.Fatal("the waiting apply never finished")
		}
	})

	t.Run("refuses an env that is not an object, and a base URL that is not a string", func(t *testing.T) {
		path := extSettingsPath(t)
		extWriteJSON(t, path, "{\n  \"env\": \"nope\"\n}\n")
		_, err := adapters.ApplyProviderSettings(t.Context(), path, testkit.ReferenceProvider, extRouter, adapters.ApplyProviderOptions{})
		if err == nil || !strings.Contains(err.Error(), "env must be an object") {
			t.Fatalf("error = %v; want it to say env must be an object", err)
		}
		extWriteJSON(t, path, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": 7\n  }\n}\n")
		_, err = adapters.ApplyProviderSettings(t.Context(), path, testkit.ReferenceProvider, extRouter, adapters.ApplyProviderOptions{})
		if err == nil || !strings.Contains(err.Error(), "must be a string") {
			t.Fatalf("error = %v; want it to say must be a string", err)
		}
	})
}

func TestTheUninstallUndoOfSettings(t *testing.T) {
	t.Run("takes out exactly what setup added, the containers it created, and leaves what the user added", func(t *testing.T) {
		path := extSettingsPath(t)
		_, delta := extApply(t, path, nil)
		if delta.BaseURLBefore != nil ||
			strings.Join(delta.OptionsAdded, ",") != "glm-5.3,glm-5.3-flash" ||
			len(delta.AvailableAppended) != 0 ||
			!delta.CreatedModelPicker || !delta.CreatedOptions || !delta.CreatedEnv || !delta.CreatedToolSearch {
			t.Fatalf("delta = %+v", delta)
		}
		if got := delta.EffortsAdded.Keys(); strings.Join(got, ",") != "glm-5.3,glm-5.3-flash" {
			t.Fatalf("delta efforts = %v", got)
		}
		if v, _ := delta.EffortsAdded.Get("glm-5.3"); v != "xhigh" {
			t.Fatalf("delta efforts[glm-5.3] = %q", v)
		}
		// The user hangs their own row off setup's.
		extWriteJSON(t, path, "{\n"+
			"  \"modelPicker\": {\n    \"options\": [\n      {\n        \"model\": \"glm-5.3\",\n        \"label\": \"GLM 5.3\",\n        \"behavesAs\": \"claude-opus-5-5\"\n      },\n"+
			"      {\n        \"model\": \"glm-5.3-flash\",\n        \"label\": \"GLM 5.3 Flash\",\n        \"behavesAs\": \"claude-opus-5-5\"\n      },\n"+
			"      {\n        \"model\": \"mine\",\n        \"label\": \"Mine\"\n      }\n    ]\n  },\n"+
			extReferenceEfforts+",\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+extRouter+"\",\n    \"ENABLE_TOOL_SEARCH\": \"true\"\n  }\n}\n")
		lines, err := adapters.UndoProviderSettings(t.Context(), path, "zai", extDeltaAsUndo(delta), extRouter, nil)
		if err != nil {
			t.Fatal(err)
		}
		if len(lines) == 0 {
			t.Fatal("the undo reported nothing")
		}
		extAssertFile(t, path, "{\n  \"modelPicker\": {\n    \"options\": [\n      {\n        \"model\": \"mine\",\n        \"label\": \"Mine\"\n      }\n    ]\n  }\n}\n")
	})

	t.Run("removes appended availableModels ids and leaves an availableModels setup did not touch", func(t *testing.T) {
		path := extSettingsPath(t)
		untouched := "{\n  \"availableModels\": [\n    \"sonnet\"\n  ],\n  \"modelPicker\": \"odd\"\n}\n"
		extWriteJSON(t, path, untouched)
		if _, err := adapters.UndoProviderSettings(t.Context(), path, "zai", adapters.SettingsUndo{
			OptionsAdded:      []string{},
			AvailableAppended: []string{"glm-5.3"},
			EffortsAdded:      adapters.NewStringMap(),
		}, extRouter, nil); err != nil {
			t.Fatal(err)
		}
		extAssertFile(t, path, untouched)

		extWriteJSON(t, path, "{\n  \"availableModels\": [\n    \"sonnet\",\n    \"glm-5.3\"\n  ],\n  \"modelPicker\": {\n    \"options\": \"odd\"\n  }\n}\n")
		if _, err := adapters.UndoProviderSettings(t.Context(), path, "zai", adapters.SettingsUndo{
			OptionsAdded:       []string{},
			AvailableAppended:  []string{"glm-5.3"},
			CreatedModelPicker: true,
			EffortsAdded:       adapters.NewStringMap(),
		}, extRouter, nil); err != nil {
			t.Fatal(err)
		}
		extAssertFile(t, path, "{\n  \"availableModels\": [\n    \"sonnet\"\n  ],\n  \"modelPicker\": {\n    \"options\": \"odd\"\n  }\n}\n")
	})

	t.Run("takes ENABLE_TOOL_SEARCH and the behaving-as rows back out when setup added them, and keeps a value the user set", func(t *testing.T) {
		path := extSettingsPath(t)
		_, delta := extApply(t, path, nil)
		lines, err := adapters.UndoProviderSettings(t.Context(), path, "zai", extDeltaAsUndo(delta), extRouter, nil)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Contains(lines, "removed ENABLE_TOOL_SEARCH") {
			t.Fatalf("lines = %#v; want removed ENABLE_TOOL_SEARCH", lines)
		}
		extAssertFile(t, path, "{}\n")

		user := extSettingsPath(t)
		extWriteJSON(t, user, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+extKimiRouter+"\",\n    \"ENABLE_TOOL_SEARCH\": \"false\"\n  }\n}\n")
		_, userDelta := extApply(t, user, nil)
		extAssertFile(t, user, "{\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+extRouter+"\",\n    \"ENABLE_TOOL_SEARCH\": \"false\"\n  },\n"+
			extReferenceOptions+",\n"+extReferenceEfforts+"\n}\n")
		if _, err := adapters.UndoProviderSettings(t.Context(), user, "zai", extDeltaAsUndo(userDelta), extRouter, nil); err != nil {
			t.Fatal(err)
		}
		extAssertFile(t, user, "{\n  \"env\": {\n    \"ENABLE_TOOL_SEARCH\": \"false\"\n  }\n}\n")
	})
}

func TestTheModelSettingsEffortLevels(t *testing.T) {
	t.Run("never overwrites an effort level the user set, on apply or undo", func(t *testing.T) {
		path := extSettingsPath(t)
		extWriteJSON(t, path, "{\n  \"modelSettings\": {\n    \"glm-5.3\": {\n      \"effortLevel\": \"low\"\n    },\n    \"glm-5.3-flash\": {\n      \"effortLevel\": \"medium\"\n    }\n  }\n}\n")

		lines, delta := extApply(t, path, nil)

		if slices.Contains(lines, "set GLM 5.3 default effort to xhigh") ||
			slices.Contains(lines, "set GLM 5.3 Flash default effort to xhigh") {
			t.Fatalf("lines = %#v; want no effort set over the user's", lines)
		}
		if delta.EffortsAdded.Len() != 0 {
			t.Fatalf("delta efforts = %v, want none", delta.EffortsAdded.Keys())
		}
		if _, err := adapters.UndoProviderSettings(t.Context(), path, "zai", extDeltaAsUndo(delta), extRouter, nil); err != nil {
			t.Fatal(err)
		}
		extAssertFile(t, path, "{\n  \"modelSettings\": {\n    \"glm-5.3\": {\n      \"effortLevel\": \"low\"\n    },\n    \"glm-5.3-flash\": {\n      \"effortLevel\": \"medium\"\n    }\n  }\n}\n")
	})

	t.Run("undo takes setup's levels out, an emptied entry with them, and leaves what the user added to the same entries", func(t *testing.T) {
		path := extSettingsPath(t)
		_, delta := extApply(t, path, nil)
		// The user hangs their own keys off setup's entries and adds an entry of their own.
		extWriteJSON(t, path, "{\n"+
			extReferenceOptions+",\n"+
			"  \"modelSettings\": {\n    \"glm-5.3\": {\n      \"effortLevel\": \"xhigh\",\n      \"note\": \"mine\"\n    },\n"+
			"    \"glm-5.3-flash\": {\n      \"effortLevel\": \"xhigh\"\n    },\n    \"mine\": {\n      \"effortLevel\": \"high\"\n    }\n  },\n"+
			"  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+extRouter+"\",\n    \"ENABLE_TOOL_SEARCH\": \"true\"\n  }\n}\n")

		lines, err := adapters.UndoProviderSettings(t.Context(), path, "zai", extDeltaAsUndo(delta), extRouter, nil)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Contains(lines, "took glm-5.3 and glm-5.3-flash out of modelSettings") {
			t.Fatalf("lines = %#v; want the modelSettings takeout", lines)
		}
		extAssertFile(t, path, "{\n  \"modelSettings\": {\n    \"glm-5.3\": {\n      \"note\": \"mine\"\n    },\n    \"mine\": {\n      \"effortLevel\": \"high\"\n    }\n  }\n}\n")
	})

	t.Run("is idempotent: a rerun reports no effort changes and rewrites nothing", func(t *testing.T) {
		path := extSettingsPath(t)
		extApply(t, path, nil)
		after := extRead(t, path)

		lines, _ := extApply(t, path, nil)
		extAssertLines(t, lines)
		if got := extRead(t, path); got != after {
			t.Fatalf("the rerun rewrote the file:\n%s", got)
		}
	})
}

// The settings an older setup leaves: its rows without `behavesAs`, its base URL without tool
// search. That setup's undo owns the rows and the containers, and never recorded tool search.
func extOldSettings() string {
	return "{\n  \"modelPicker\": {\n    \"options\": [\n      {\n        \"model\": \"glm-5.3\",\n        \"label\": \"GLM 5.3\"\n      },\n      {\n        \"model\": \"glm-5.3-flash\",\n        \"label\": \"GLM 5.3 Flash\"\n      }\n    ]\n  },\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \"" + extRouter + "\"\n  }\n}\n"
}

func extOldUndo() adapters.SettingsUndo {
	return adapters.SettingsUndo{
		BaseURLBefore:      nil,
		OptionsAdded:       []string{"glm-5.3", "glm-5.3-flash"},
		AvailableAppended:  []string{},
		CreatedModelPicker: true,
		CreatedOptions:     true,
		CreatedEnv:         true,
		CreatedToolSearch:  false,
		EffortsAdded:       adapters.NewStringMap(),
	}
}

// extUpgrade is the apply as the setup flow runs it, with the old ledger's ids and its delta
// captured.
func extUpgrade(t *testing.T, path string) ([]string, adapters.SettingsDelta) {
	t.Helper()
	return extApply(t, path, extOldUndo().OptionsAdded)
}

func TestTheUpgradeOfAnOlderSettings(t *testing.T) {
	t.Run("adds behavesAs to the rows it added before and tool search on the already-set base URL, and records both", func(t *testing.T) {
		path := extSettingsPath(t)
		extWriteJSON(t, path, extOldSettings())

		lines, delta := extUpgrade(t, path)

		extAssertLines(t, lines,
			"set behavesAs on the GLM 5.3 (glm-5.3) row in /model",
			"set behavesAs on the GLM 5.3 Flash (glm-5.3-flash) row in /model",
			"set GLM 5.3 default effort to xhigh",
			"set GLM 5.3 Flash default effort to xhigh",
			"turned on MCP tool search",
		)
		extAssertFile(t, path, "{\n"+extReferenceOptions+",\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+extRouter+"\",\n    \"ENABLE_TOOL_SEARCH\": \"true\"\n  },\n"+extReferenceEfforts+"\n}\n")
		if len(delta.OptionsAdded) != 0 || !delta.CreatedToolSearch {
			t.Fatalf("delta = %+v; want no new rows and tool search recorded", delta)
		}
		if v, _ := delta.EffortsAdded.Get("glm-5.3"); v != "xhigh" {
			t.Fatalf("delta efforts = %v", delta.EffortsAdded.Keys())
		}
		if v, _ := delta.EffortsAdded.Get("glm-5.3-flash"); v != "xhigh" {
			t.Fatalf("delta efforts = %v", delta.EffortsAdded.Keys())
		}
	})

	t.Run("leaves a row the user wrote themselves, and the user's own tool-search value", func(t *testing.T) {
		path := extSettingsPath(t)
		extWriteJSON(t, path, "{\n  \"modelPicker\": {\n    \"options\": [\n      {\n        \"model\": \"glm-5.3\",\n        \"label\": \"GLM 5.3\",\n        \"note\": \"mine\"\n      },\n      {\n        \"model\": \"glm-5.3-flash\",\n        \"label\": \"Flash, mine\"\n      }\n    ]\n  },\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+extRouter+"\",\n    \"ENABLE_TOOL_SEARCH\": \"false\"\n  },\n  \"modelSettings\": {\n    \"glm-5.3\": {\n      \"effortLevel\": \"low\"\n    },\n    \"glm-5.3-flash\": {\n      \"effortLevel\": \"medium\"\n    }\n  }\n}\n")

		lines, delta := extApply(t, path, nil)

		extAssertLines(t, lines, "updated the GLM 5.3 Flash (glm-5.3-flash) label in /model")
		extAssertFile(t, path, "{\n  \"modelPicker\": {\n    \"options\": [\n      {\n        \"model\": \"glm-5.3\",\n        \"label\": \"GLM 5.3\",\n        \"note\": \"mine\"\n      },\n      {\n        \"model\": \"glm-5.3-flash\",\n        \"label\": \"GLM 5.3 Flash\"\n      }\n    ]\n  },\n  \"env\": {\n    \"ANTHROPIC_BASE_URL\": \""+extRouter+"\",\n    \"ENABLE_TOOL_SEARCH\": \"false\"\n  },\n  \"modelSettings\": {\n    \"glm-5.3\": {\n      \"effortLevel\": \"low\"\n    },\n    \"glm-5.3-flash\": {\n      \"effortLevel\": \"medium\"\n    }\n  }\n}\n")
		if len(delta.OptionsAdded) != 0 || delta.CreatedToolSearch || delta.EffortsAdded.Len() != 0 {
			t.Fatalf("delta = %+v; want nothing recorded", delta)
		}
	})

	t.Run("is idempotent: the run after the upgrade reports no changes and rewrites nothing", func(t *testing.T) {
		path := extSettingsPath(t)
		extWriteJSON(t, path, extOldSettings())
		extUpgrade(t, path)
		upgraded := extRead(t, path)

		lines, _ := extUpgrade(t, path)
		extAssertLines(t, lines)
		if got := extRead(t, path); got != upgraded {
			t.Fatalf("the run after the upgrade rewrote the file:\n%s", got)
		}
	})

	t.Run("undoes the upgrade through the merged ledger, back to an empty file", func(t *testing.T) {
		path := extSettingsPath(t)
		extWriteJSON(t, path, extOldSettings())
		_, delta := extUpgrade(t, path)
		previous := extOldUndo()
		undo := router.MergeSettingsUndo(&previous, &delta)

		lines, err := adapters.UndoProviderSettings(t.Context(), path, "zai", undo, extRouter, nil)
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Contains(lines, "removed ENABLE_TOOL_SEARCH") {
			t.Fatalf("lines = %#v; want removed ENABLE_TOOL_SEARCH", lines)
		}
		extAssertFile(t, path, "{}\n")
	})
}
