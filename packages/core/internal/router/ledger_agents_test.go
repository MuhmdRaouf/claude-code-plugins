// The agents record's order rules: the file lists the agents in the order they were recorded (the
// insertion order JSON.stringify writes), a read keeps that order for the agents and for the
// ledger's own keys (the read fronts the four keys the format checks), and a value that is not a
// string or null fails the read.
package router

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func strp(text string) *string { return &text }

// orderedAgents is the record the setup calls build: zealot, then alpha, then mid.
func orderedAgents() *LedgerAgents {
	agents := NewLedgerAgents()
	agents.Set("zealot", strp("opus"))
	agents.Set("alpha", nil)
	agents.Set("mid", strp("haiku"))
	return agents
}

// orderedLedger is a ledger carrying that record, built in memory the way recordLedger builds one.
func orderedLedger() Ledger {
	return Ledger{
		Version:      1,
		Plugin:       "zai",
		RouterURL:    "http://127.0.0.1:18787",
		SettingsPath: "/home/.claude/settings.json",
		Settings:     emptyUndo(),
		Keystore:     LedgerKeystore{Created: false},
		RouterFiles:  []string{"/state/router"},
		Agents:       orderedAgents(),
		AgentsDir:    strp("/plugin/agents"),
		StateRoot:    "/state",
	}
}

func TestLedgerAgentsOrder(t *testing.T) {
	t.Parallel()
	t.Run("writes the agents in the order they were recorded", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "ledger.json")
		if err := WriteLedger(t.Context(), path, orderedLedger()); err != nil {
			t.Fatal(err)
		}
		text, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		// JSON.stringify's rules: insertion order, two-space indent, trailing newline.
		want := `{
  "version": 1,
  "plugin": "zai",
  "routerUrl": "http://127.0.0.1:18787",
  "settingsPath": "/home/.claude/settings.json",
  "settings": {
    "optionsAdded": [],
    "availableAppended": [],
    "createdModelPicker": false,
    "createdOptions": false,
    "createdEnv": false,
    "createdProxy": false,
    "createdToolSearch": false,
    "effortsAdded": {}
  },
  "keystore": {
    "created": false
  },
  "routerFiles": [
    "/state/router"
  ],
  "agents": {
    "zealot": "opus",
    "alpha": null,
    "mid": "haiku"
  },
  "agentsDir": "/plugin/agents",
  "stateRoot": "/state"
}
`
		if string(text) != want {
			t.Fatalf("ledger =\n%s\nwant\n%s", text, want)
		}
	})

	t.Run("a read ledger writes the same bytes again, agents and keys in the file's order", func(t *testing.T) {
		dir := t.TempDir()
		// A ledger after its agents records: the read fronts the four checked keys, the agents
		// sit at the end, in the order they were recorded.
		written := orderedLedgerIn(t, dir)
		if err := os.WriteFile(filepath.Join(dir, "ledger.json"), []byte(written), 0o600); err != nil {
			t.Fatal(err)
		}
		ledger, ok := ReadLedger(t.Context(), filepath.Join(dir, "ledger.json"))
		if !ok {
			t.Fatal("the hand-written ledger did not read back")
		}
		if got := strings.Join(ledger.Agents.Names(), ","); got != "zealot,alpha,mid" {
			t.Fatalf("agents order = %q, want the file's", got)
		}
		// The disabled copy the uninstall watch writes goes through the same WriteLedger.
		disabled := filepath.Join(dir, "ledger.disabled.json")
		if err := WriteLedger(t.Context(), disabled, ledger); err != nil {
			t.Fatal(err)
		}
		again, err := os.ReadFile(disabled)
		if err != nil {
			t.Fatal(err)
		}
		if string(again) != written {
			t.Fatalf("the rewrite =\n%s\nwant the same bytes\n%s", again, written)
		}
	})

	t.Run("a value set again keeps its place and takes the new value", func(t *testing.T) {
		agents := orderedAgents()
		agents.Set("zealot", strp("sonnet"))
		if got := strings.Join(agents.Names(), ","); got != "zealot,alpha,mid" {
			t.Fatalf("names = %q, want the first places kept", got)
		}
		if got, _ := agents.Get("zealot"); got == nil || *got != "sonnet" {
			t.Fatalf("zealot = %v, want the new value", got)
		}
	})

	t.Run("a duplicate key keeps its first place with the last value", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "ledger.json")
		base := orderedLedgerIn(t, dir)
		if err := os.WriteFile(path, []byte(strings.Replace(base,
			`"zealot": "opus"`, `"zealot": "opus", "zealot": "sonnet"`, 1)), 0o600); err != nil {
			t.Fatal(err)
		}
		ledger, ok := ReadLedger(t.Context(), path)
		if !ok {
			t.Fatal("the ledger with a duplicate agent did not read back")
		}
		if got, _ := ledger.Agents.Get("zealot"); got == nil || *got != "sonnet" {
			t.Fatalf("zealot = %v, want the last value", got)
		}
		if got := strings.Join(ledger.Agents.Names(), ","); got != "zealot,alpha,mid" {
			t.Fatalf("names = %q, want the first places kept", got)
		}
	})

	t.Run("an agent value that is not a string or null fails the read", func(t *testing.T) {
		for name, value := range map[string]string{
			"a number":  `5`,
			"a boolean": `true`,
			"an object": `{"deep": "no"}`,
		} {
			dir := t.TempDir()
			base := orderedLedgerIn(t, dir)
			if err := os.WriteFile(filepath.Join(dir, "ledger.json"), []byte(strings.Replace(base,
				`"zealot": "opus"`, `"zealot": `+value, 1)), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, ok := ReadLedger(t.Context(), filepath.Join(dir, "ledger.json")); ok {
				t.Fatalf("%s: readLedger accepted it", name)
			}
		}
	})

	t.Run("agents that is not an object fails the read", func(t *testing.T) {
		dir := t.TempDir()
		base := orderedLedgerIn(t, dir)
		if err := os.WriteFile(filepath.Join(dir, "ledger.json"), []byte(strings.Replace(base,
			`"agents": {
    "zealot": "opus",
    "alpha": null,
    "mid": "haiku"
  }`, `"agents": []`, 1)), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, ok := ReadLedger(t.Context(), filepath.Join(dir, "ledger.json")); ok {
			t.Fatal("readLedger accepted an array agents")
		}
	})

	t.Run("a nil record reads as none, and its lookups say so", func(t *testing.T) {
		var agents *LedgerAgents
		if agents.Has("zealot") {
			t.Fatal("has on no record = true")
		}
		if got, ok := agents.Get("zealot"); ok || got != nil {
			t.Fatalf("get on no record = %v %v", got, ok)
		}
		if names := agents.Names(); names != nil {
			t.Fatalf("names on no record = %q", names)
		}
	})

	t.Run("an empty record writes an empty object", func(t *testing.T) {
		ledger := orderedLedger()
		ledger.Agents = NewLedgerAgents()
		data, err := ledger.MarshalJSON()
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), `"agents":{}`) {
			t.Fatalf("ledger = %s, want an empty agents object", data)
		}
	})

	t.Run("the zero value takes a Set", func(t *testing.T) {
		var agents LedgerAgents
		agents.Set("zealot", strp("opus"))
		if got, _ := agents.Get("zealot"); got == nil || *got != "opus" {
			t.Fatalf("zealot = %v, want opus", got)
		}
	})

	t.Run("an agents object that is not readable fails the decode", func(t *testing.T) {
		for name, text := range map[string]string{
			"empty":          ``,
			"an array":       `[]`,
			"a truncated":    `{"zealot"`,
			"a broken value": `{"zealot":`,
		} {
			var agents LedgerAgents
			if err := agents.UnmarshalJSON([]byte(text)); err == nil {
				t.Fatalf("%s: unmarshal accepted it", name)
			}
		}
	})
}

// orderedLedgerIn is orderedLedgerJSON written in dir: the dir's separators are slashed so the
// substituted value needs no JSON escaping (and reads back, then rewrites, as the same bytes).
func orderedLedgerIn(t *testing.T, dir string) string {
	t.Helper()
	return strings.Replace(orderedLedgerJSON(t), "REPLACED", filepath.ToSlash(dir), 1)
}

// orderedLedgerJSON is a ledger after its agents records: the four checked keys first, then the
// rest in the literal's order, the agents at the end. REPLACED stands for the dir the test writes
// it in.
func orderedLedgerJSON(t *testing.T) string {
	t.Helper()
	return `{
  "version": 1,
  "plugin": "zai",
  "routerUrl": "http://127.0.0.1:18787",
  "settings": {
    "optionsAdded": [],
    "availableAppended": [],
    "createdModelPicker": false,
    "createdOptions": false,
    "createdEnv": false,
    "createdProxy": false,
    "createdToolSearch": false,
    "effortsAdded": {}
  },
  "settingsPath": "/home/.claude/settings.json",
  "keystore": {
    "created": false
  },
  "routerFiles": [
    "REPLACED/router"
  ],
  "agentsDir": "/plugin/agents",
  "stateRoot": "REPLACED",
  "agents": {
    "zealot": "opus",
    "alpha": null,
    "mid": "haiku"
  }
}
`
}
