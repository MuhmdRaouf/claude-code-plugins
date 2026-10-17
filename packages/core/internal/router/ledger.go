// The ledger (`<state>/ledger.json`, 0600, atomic): every change setup made outside the plugin,
// with what was there before, so the router (which outlives the plugin) can undo exactly those when
// the plugin is uninstalled or disabled. A disabled plugin's ledger moves to
// `ledger.disabled.json`; the SessionStart hook of a re-enabled plugin finds it and re-applies
// setup.
package router

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// LedgerKeystore is whether setup created the provider's keystore item (only then does cleanup
// delete it).
type LedgerKeystore struct {
	Created bool `json:"created"`
}

// Ledger is every change setup made outside the plugin, in the order the file writes it.
type Ledger struct {
	Version   int64  `json:"version"`
	Plugin    string `json:"plugin"`
	RouterURL string `json:"routerUrl"`
	// SettingsPath is where Claude Code's settings live.
	SettingsPath string `json:"settingsPath"`
	// Settings is what setup changed in them, as the ledger recorded it.
	Settings      adapters.SettingsUndo `json:"settings"`
	Keystore      LedgerKeystore        `json:"keystore"`
	RouterFiles   []string              `json:"routerFiles"`
	LegacyRemoved *string               `json:"legacyRemoved,omitempty"`
	// Marker is `${CLAUDE_PLUGIN_DATA}/installed`, deleted by Claude Code on uninstall.
	Marker *string `json:"marker,omitempty"`
	// Agents is each agent's `model:` value before setup first changed it (nil: it had no `model:`
	// line), by agent name, in the order they were recorded.
	Agents *LedgerAgents `json:"agents,omitempty"`
	// AgentsDir is where the plugin's agent files are, as of the last setup run (the router restores
	// them on a disable).
	AgentsDir *string `json:"agentsDir,omitempty"`
	StateRoot string  `json:"stateRoot"`
	// fileOrder is the order the read file wrote its keys in. The read fronts the four keys the
	// ledger format checks and keeps every other key in the file's order, so a
	// read → modify → write (the agents records, the disabled copy) marshals in that order, not the
	// struct's. A ledger built in memory has none and takes the struct's order.
	fileOrder []string `json:"-"`
}

// UnmarshalJSON decodes the ledger and remembers the order the file wrote its keys in.
func (l *Ledger) UnmarshalJSON(data []byte) error {
	type ledgerFields Ledger
	var fields ledgerFields
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	*l = Ledger(fields)
	if node := parseBodyNode(data); node != nil && node.kind == jsonObject {
		l.fileOrder = append([]string(nil), node.keys...)
	}
	return nil
}

// ledgerKeys is the order a ledger built in memory marshals in: the recordLedger literal's own.
var ledgerKeys = []string{
	"version", "plugin", "routerUrl", "settingsPath", "settings", "keystore", "routerFiles",
	"legacyRemoved", "marker", "agents", "agentsDir", "stateRoot",
}

// checkedKeys is what readLedger's zod schema checks, in its order; a read ledger marshals with
// these keys first and every other key in the file's own order after them.
var checkedKeys = []string{"version", "plugin", "routerUrl", "settings"}

// marshalKeys is the order this ledger's present keys marshal in.
func (l Ledger) marshalKeys() []string {
	if l.fileOrder == nil {
		return ledgerKeys
	}
	seen := make(map[string]bool, len(ledgerKeys))
	order := make([]string, 0, len(ledgerKeys))
	for _, key := range checkedKeys {
		if slices.Contains(l.fileOrder, key) {
			order = append(order, key)
			seen[key] = true
		}
	}
	for _, key := range l.fileOrder {
		if !seen[key] {
			order = append(order, key)
			seen[key] = true
		}
	}
	for _, key := range ledgerKeys {
		if !seen[key] {
			order = append(order, key)
		}
	}
	return order
}

// fieldValue is the key's value and whether the key is written at all (the omitempty keys).
func (l Ledger) fieldValue(key string) (any, bool) {
	switch key {
	case "version":
		return l.Version, true
	case "plugin":
		return l.Plugin, true
	case "routerUrl":
		return l.RouterURL, true
	case "settingsPath":
		return l.SettingsPath, true
	case "settings":
		return l.Settings, true
	case "keystore":
		return l.Keystore, true
	case "routerFiles":
		return l.RouterFiles, true
	case "legacyRemoved":
		return l.LegacyRemoved, l.LegacyRemoved != nil
	case "marker":
		return l.Marker, l.Marker != nil
	case "agents":
		return l.Agents, l.Agents != nil
	case "agentsDir":
		return l.AgentsDir, l.AgentsDir != nil
	case "stateRoot":
		return l.StateRoot, true
	}
	return nil, false
}

// MarshalJSON writes a read ledger in the key order the file wrote, one built in memory in the
// construction order, both compact for the encoder to indent.
func (l Ledger) MarshalJSON() ([]byte, error) {
	var b strings.Builder
	b.WriteByte('{')
	wrote := false
	for _, key := range l.marshalKeys() {
		value, present := l.fieldValue(key)
		if !present {
			continue
		}
		if wrote {
			b.WriteByte(',')
		}
		wrote = true
		writeJSONString(&b, key)
		b.WriteByte(':')
		encoded, err := domain.MarshalCompactJSON(value)
		if err != nil {
			return nil, err
		}
		b.Write(encoded)
	}
	b.WriteByte('}')
	return []byte(b.String()), nil
}

// LedgerAgents is the ledger's `agents` object: each agent's `model:` value before setup first
// changed it (nil: it had no `model:` line), by name, in the order they were first recorded — the
// insertion order the file keeps and the restore walks.
type LedgerAgents struct {
	keys   []string
	values map[string]*string
}

// NewLedgerAgents returns an empty agents record.
func NewLedgerAgents() *LedgerAgents {
	return &LedgerAgents{values: make(map[string]*string)}
}

// Set stores the agent's value, appending its name when it is new; an existing key keeps its
// position, the insertion order the file keeps and the restore walks.
func (a *LedgerAgents) Set(name string, value *string) {
	if a.values == nil {
		a.values = make(map[string]*string)
	}
	if _, exists := a.values[name]; !exists {
		a.keys = append(a.keys, name)
	}
	a.values[name] = value
}

// Get returns the agent's recorded value; !ok when none was recorded.
func (a *LedgerAgents) Get(name string) (*string, bool) {
	if a == nil {
		return nil, false
	}
	value, ok := a.values[name]
	return value, ok
}

// Has is whether the agent has a record.
func (a *LedgerAgents) Has(name string) bool {
	_, ok := a.Get(name)
	return ok
}

// Names are the agents in the order they were recorded.
func (a *LedgerAgents) Names() []string {
	if a == nil {
		return nil
	}
	return a.keys
}

// MarshalJSON writes the object in the recorded order, each value a string or null.
func (a *LedgerAgents) MarshalJSON() ([]byte, error) {
	var b strings.Builder
	b.WriteByte('{')
	for i, name := range a.Names() {
		if i > 0 {
			b.WriteByte(',')
		}
		writeJSONString(&b, name)
		b.WriteByte(':')
		if value, _ := a.Get(name); value == nil {
			b.WriteString("null")
		} else {
			writeJSONString(&b, *value)
		}
	}
	b.WriteByte('}')
	return []byte(b.String()), nil
}

// UnmarshalJSON reads the object keeping the file's key order; a later duplicate key overwrites
// the earlier value in place, as JSON.parse does. A value that is not a string or null fails the
// read, the way decoding into the map did.
func (a *LedgerAgents) UnmarshalJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return fmt.Errorf("agents is not an object")
	}
	*a = LedgerAgents{values: make(map[string]*string)}
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
		if valueToken == nil {
			a.Set(key, nil)
			continue
		}
		value, ok := valueToken.(string)
		if !ok {
			return fmt.Errorf("value of %q is not a string or null", key)
		}
		a.Set(key, &value)
	}
	// More() is only false at the closing brace.
	_, _ = decoder.Token()
	return nil
}

// ledgerShape is only what reading the ledger back relies on: a ledger an older version wrote
// still counts, unknown keys and all.
type ledgerShape struct {
	Version   json.Number     `json:"version"`
	Plugin    *string         `json:"plugin"`
	RouterURL *string         `json:"routerUrl"`
	Settings  json.RawMessage `json:"settings"`
}

// ReadLedger is the ledger at path, or false when there is none or the shape it relies on is
// missing.
func ReadLedger(ctx context.Context, path string) (Ledger, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Ledger{}, false
	}
	var shape ledgerShape
	if err := json.Unmarshal(data, &shape); err != nil {
		return Ledger{}, false
	}
	version, err := shape.Version.Float64()
	if err != nil || version != 1 || shape.Plugin == nil || shape.RouterURL == nil {
		return Ledger{}, false
	}
	// settings is any object; everything else fails the read.
	if !bytes.HasPrefix(bytes.TrimSpace(shape.Settings), []byte("{")) {
		return Ledger{}, false
	}
	return fsutil.ReadJSONFile[Ledger](ctx, path)
}

// WriteLedger writes the ledger, 0600 and atomically, as `JSON.stringify(ledger, null, 2)` plus a
// newline. A Ledger's fields always marshal.
func WriteLedger(ctx context.Context, path string, ledger Ledger) error {
	data, _ := fsutil.MarshalJSON(ledger)
	_, err := fsutil.WriteFileAtomic(ctx, path, data, fsutil.WriteOptions{})
	return err
}

// RemoveLedger drops the ledger, there or not.
func RemoveLedger(path string) {
	_ = os.Remove(path)
}

// emptyUndo is the undo of a run that changed nothing.
func emptyUndo() adapters.SettingsUndo {
	return adapters.SettingsUndo{
		OptionsAdded:      []string{},
		AvailableAppended: []string{},
		EffortsAdded:      adapters.NewStringMap(),
	}
}

// union joins the two lists the way [...a, ...b] over a Set does: a's order, then b's new entries.
func union(a, b []string) []string {
	joined := make([]string, 0, len(a)+len(b))
	return append(append(joined, a...), b...)
}

// MergeSettingsUndo folds one setup run's delta into what earlier runs recorded: the first known
// "before" wins, additions add up.
func MergeSettingsUndo(previous *adapters.SettingsUndo, delta *adapters.SettingsDelta) adapters.SettingsUndo {
	base := emptyUndo()
	if previous != nil {
		base = *previous
	}
	if delta == nil {
		return base
	}
	merged := adapters.SettingsUndo{
		BaseURLBefore:      base.BaseURLBefore,
		ProxyBefore:        base.ProxyBefore,
		CABefore:           base.CABefore,
		NoProxyBefore:      base.NoProxyBefore,
		OptionsAdded:       dedupe(union(base.OptionsAdded, delta.OptionsAdded)),
		AvailableAppended:  dedupe(union(base.AvailableAppended, delta.AvailableAppended)),
		CreatedModelPicker: base.CreatedModelPicker || delta.CreatedModelPicker,
		CreatedOptions:     base.CreatedOptions || delta.CreatedOptions,
		CreatedEnv:         base.CreatedEnv || delta.CreatedEnv,
		CreatedProxy:       base.CreatedProxy || delta.CreatedProxy,
		CreatedToolSearch:  base.CreatedToolSearch || delta.CreatedToolSearch,
	}
	if merged.BaseURLBefore == nil {
		merged.BaseURLBefore = delta.BaseURLBefore
	}
	if merged.ProxyBefore == nil {
		merged.ProxyBefore = delta.ProxyBefore
	}
	if merged.CABefore == nil {
		merged.CABefore = delta.CABefore
	}
	if merged.NoProxyBefore == nil {
		merged.NoProxyBefore = delta.NoProxyBefore
	}
	// { ...delta.effortsAdded, ...base.effortsAdded }: the delta's keys first, the previous values
	// winning on the same key.
	merged.EffortsAdded = adapters.NewStringMap()
	if delta.EffortsAdded != nil {
		for _, key := range delta.EffortsAdded.Keys() {
			value, _ := delta.EffortsAdded.Get(key)
			merged.EffortsAdded.Set(key, value)
		}
	}
	if base.EffortsAdded != nil {
		for _, key := range base.EffortsAdded.Keys() {
			value, _ := base.EffortsAdded.Get(key)
			merged.EffortsAdded.Set(key, value)
		}
	}
	return merged
}

// dedupe keeps each entry once, at its first place.
func dedupe(list []string) []string {
	seen := make(map[string]bool, len(list))
	out := make([]string, 0, len(list))
	for _, value := range list {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}
