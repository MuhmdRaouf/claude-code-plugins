// The ledger's own file handling and the undo fold: the read, write and remove arms' cases.
package router

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
)

func TestLedgerFile(t *testing.T) {
	t.Parallel()
	t.Run("writes it 0600 and atomically, and reads it back", func(t *testing.T) {
		// The write never creates the dir; the state root is there already.
		path := filepath.Join(t.TempDir(), "ledger.json")
		ledger := Ledger{
			Version:      1,
			Plugin:       "zai",
			RouterURL:    "http://127.0.0.1:18787",
			SettingsPath: "/home/.claude/settings.json",
			Settings: adapters.SettingsUndo{
				OptionsAdded:      []string{"glm-5.3", "glm-5.3-flash"},
				AvailableAppended: []string{},
				EffortsAdded:      adapters.NewStringMap(),
			},
			Keystore:    LedgerKeystore{Created: true},
			RouterFiles: []string{"/state/router/zai.js"},
			StateRoot:   "/state",
		}
		if err := WriteLedger(t.Context(), path, ledger); err != nil {
			t.Fatal(err)
		}
		text, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(string(text), "{\n  \"version\": 1,\n  \"plugin\": \"zai\",") {
			t.Fatalf("ledger = %s, want the ledger field order", text)
		}
		wantPrivateFile(t, path)
		read, ok := ReadLedger(t.Context(), path)
		if !ok || read.Plugin != ledger.Plugin || read.RouterURL != ledger.RouterURL ||
			read.SettingsPath != ledger.SettingsPath || !read.Keystore.Created ||
			strings.Join(read.RouterFiles, ",") != strings.Join(ledger.RouterFiles, ",") ||
			read.StateRoot != ledger.StateRoot || read.LegacyRemoved != nil {
			t.Fatalf("readLedger = %+v (%v)", read, ok)
		}
	})

	t.Run("a ledger an older version wrote still counts", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "ledger.json")
		if err := os.WriteFile(path, []byte(`{"version":1,"plugin":"zai","routerUrl":"u","settingsPath":"s",
"settings":{"optionsAdded":["glm-5.3"],"availableAppended":[],"createdModelPicker":true,"createdOptions":true,"createdEnv":true,"createdToolSearch":true,"effortsAdded":{"glm-5.3":"xhigh"},"extra":"kept"},
"keystore":{"created":false},"routerFiles":[],"unknown":"ignored","stateRoot":"/state"}`), 0o600); err != nil {
			t.Fatal(err)
		}
		read, ok := ReadLedger(t.Context(), path)
		if !ok {
			t.Fatal("a ledger with unknown keys was discarded")
		}
		if read.Settings.OptionsAdded[0] != "glm-5.3" || !read.Settings.CreatedToolSearch {
			t.Fatalf("settings = %+v", read.Settings)
		}
		if effort, ok := read.Settings.EffortsAdded.Get("glm-5.3"); !ok || effort != "xhigh" {
			t.Fatalf("effortsAdded = %v", read.Settings.EffortsAdded)
		}
	})

	t.Run("only what reading it back relies on is checked", func(t *testing.T) {
		for name, text := range map[string]string{
			"missing":          "",
			"garbage":          "{ not json",
			"no version":       `{"plugin":"z","routerUrl":"u","settings":{}}`,
			"wrong version":    `{"version":2,"plugin":"z","routerUrl":"u","settings":{}}`,
			"version a string": `{"version":"1","plugin":"z","routerUrl":"u","settings":{}}`,
			"no plugin":        `{"version":1,"routerUrl":"u","settings":{}}`,
			"plugin a number":  `{"version":1,"plugin":7,"routerUrl":"u","settings":{}}`,
			"no routerUrl":     `{"version":1,"plugin":"z","settings":{}}`,
			"no settings":      `{"version":1,"plugin":"z","routerUrl":"u"}`,
			"settings null":    `{"version":1,"plugin":"z","routerUrl":"u","settings":null}`,
			"settings array":   `{"version":1,"plugin":"z","routerUrl":"u","settings":[]}`,
		} {
			path := filepath.Join(t.TempDir(), "ledger.json")
			if text != "" {
				if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if _, ok := ReadLedger(t.Context(), path); ok {
				t.Fatalf("%s: readLedger accepted it", name)
			}
		}
	})

	t.Run("remove drops it, there or not", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "ledger.json")
		if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
		RemoveLedger(path)
		RemoveLedger(path)
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("the ledger survived: %v", err)
		}
	})

	t.Run("a dir that is not there fails the write", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "gone", "ledger.json")
		if err := WriteLedger(t.Context(), path, Ledger{Version: 1, Plugin: "zai"}); err == nil {
			t.Fatal("writeLedger into a missing dir succeeded")
		}
	})
}

func TestMergeSettingsUndo(t *testing.T) {
	t.Parallel()
	strPtr := func(s string) *string { return &s }
	efforts := func(pairs ...string) *adapters.StringMap {
		m := adapters.NewStringMap()
		for i := 0; i+1 < len(pairs); i += 2 {
			m.Set(pairs[i], pairs[i+1])
		}
		return m
	}
	delta := func(over func(*adapters.SettingsDelta)) adapters.SettingsDelta {
		d := adapters.SettingsDelta{
			OptionsAdded:      []string{"glm-5.3"},
			AvailableAppended: []string{"glm-5.3"},
			EffortsAdded:      efforts("glm-5.3", "xhigh"),
		}
		if over != nil {
			over(&d)
		}
		return d
	}

	t.Run("nothing previous: the delta stands on the empty base", func(t *testing.T) {
		d := delta(nil)
		merged := MergeSettingsUndo(nil, &d)
		if merged.BaseURLBefore != nil || merged.CreatedModelPicker {
			t.Fatal("the empty base contributed flags it does not have")
		}
		if strings.Join(merged.OptionsAdded, ",") != "glm-5.3" {
			t.Fatalf("optionsAdded = %v", merged.OptionsAdded)
		}
		if v, _ := merged.EffortsAdded.Get("glm-5.3"); v != "xhigh" {
			t.Fatalf("effortsAdded = %v", merged.EffortsAdded)
		}
	})

	t.Run("no delta: the previous undo stands as it is", func(t *testing.T) {
		previous := adapters.SettingsUndo{
			BaseURLBefore:     strPtr("https://before.example"),
			OptionsAdded:      []string{"glm-5.3"},
			AvailableAppended: []string{},
			CreatedToolSearch: true,
			EffortsAdded:      efforts("glm-5.3", "high"),
		}
		merged := MergeSettingsUndo(&previous, nil)
		if merged.BaseURLBefore != previous.BaseURLBefore ||
			strings.Join(merged.OptionsAdded, ",") != "glm-5.3" ||
			!merged.CreatedToolSearch || merged.EffortsAdded != previous.EffortsAdded {
			t.Fatalf("merged = %+v, want the previous untouched", merged)
		}
	})

	t.Run("the first known before wins, additions add up, creation flags or", func(t *testing.T) {
		previous := adapters.SettingsUndo{
			BaseURLBefore:      strPtr("https://before.example"),
			OptionsAdded:       []string{"kimi-k3"},
			AvailableAppended:  []string{"kimi-k3"},
			CreatedModelPicker: true,
			EffortsAdded:       efforts("kimi-k3", "high", "glm-5.3", "medium"),
		}
		d := delta(func(d *adapters.SettingsDelta) {
			d.BaseURLBefore = strPtr("https://later.example")
			// kimi-k3 rides along again: an id both runs recorded stays once, at its first place.
			d.OptionsAdded = []string{"glm-5.3", "kimi-k3", "glm-5.3-flash"}
			d.CreatedToolSearch = true
		})
		merged := MergeSettingsUndo(&previous, &d)
		if merged.BaseURLBefore == nil || *merged.BaseURLBefore != "https://before.example" {
			t.Fatalf("baseUrlBefore = %v, want the first known one", merged.BaseURLBefore)
		}
		if strings.Join(merged.OptionsAdded, ",") != "kimi-k3,glm-5.3,glm-5.3-flash" {
			t.Fatalf("optionsAdded = %v", merged.OptionsAdded)
		}
		if strings.Join(merged.AvailableAppended, ",") != "kimi-k3,glm-5.3" {
			t.Fatalf("availableAppended = %v", merged.AvailableAppended)
		}
		if !merged.CreatedModelPicker || !merged.CreatedToolSearch || merged.CreatedEnv {
			t.Fatalf("creation flags = %+v", merged)
		}
		// The spread is { ...delta.effortsAdded, ...base.effortsAdded }: the delta's key order
		// first, the previous values winning on the same key.
		if got := merged.EffortsAdded.Keys(); strings.Join(got, ",") != "glm-5.3,kimi-k3" {
			t.Fatalf("effortsAdded keys = %v", got)
		}
		if v, _ := merged.EffortsAdded.Get("glm-5.3"); v != "medium" {
			t.Fatalf("effortsAdded[glm-5.3] = %q, want the previous value", v)
		}
	})

	t.Run("a previous without a before takes the delta's", func(t *testing.T) {
		previous := adapters.SettingsUndo{OptionsAdded: []string{}, AvailableAppended: []string{}}
		d := delta(func(d *adapters.SettingsDelta) { d.BaseURLBefore = strPtr("https://later.example") })
		merged := MergeSettingsUndo(&previous, &d)
		if merged.BaseURLBefore == nil || *merged.BaseURLBefore != "https://later.example" {
			t.Fatalf("baseUrlBefore = %v, want the delta's", merged.BaseURLBefore)
		}
	})
}
