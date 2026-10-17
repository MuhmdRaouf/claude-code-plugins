package adapters

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// The engine config file (`engines.json` in the state root, beside the `setup-done` mark, so
// plugin updates cannot lose it). A missing or unreadable file is the config of a plugin set up
// before engines existed: claude only.

// enginesFileShape is engines.json as written: every setting field and the optional default
// engine as pointers, so a missing key reads as foreign the way the zod schema rejected it.
type enginesFileShape struct {
	Engines       *map[string]engineSettingShape `json:"engines"`
	DefaultEngine *string                        `json:"defaultEngine"`
}

type engineSettingShape struct {
	Watcher *string `json:"watcher"`
	Version *string `json:"version"`
	Path    *string `json:"path"`
}

type fsEngineConfig struct {
	file string
}

// CreateFsEngineConfig is which engines are enabled, over <stateRoot>/engines.json.
func CreateFsEngineConfig(stateRoot string) ports.EngineConfigStore {
	return &fsEngineConfig{file: domain.NewStateLayout(stateRoot).Engines}
}

func (c *fsEngineConfig) Read() domain.EngineConfig {
	parsed, ok := fsutil.ReadJSONFile[enginesFileShape](context.Background(), c.file)
	if !ok || parsed.DefaultEngine != nil && !slices.Contains(domain.ENGINES, domain.Engine(*parsed.DefaultEngine)) {
		return domain.EngineConfig{Engines: map[domain.EngineTool]domain.EngineSetting{}}
	}
	engines := map[domain.EngineTool]domain.EngineSetting{}
	if parsed.Engines != nil {
		for name, setting := range *parsed.Engines {
			// A key outside the four tools is stripped the way partialRecord kept only its enum.
			if !slices.Contains(domain.ENGINE_TOOLS, domain.EngineTool(name)) {
				continue
			}
			if setting.Watcher == nil || setting.Version == nil || setting.Path == nil ||
				(*setting.Watcher != string(domain.WatcherProvider) && *setting.Watcher != string(domain.WatcherSonnet)) {
				return domain.EngineConfig{Engines: map[domain.EngineTool]domain.EngineSetting{}}
			}
			engines[domain.EngineTool(name)] = domain.EngineSetting{
				Watcher: domain.Watcher(*setting.Watcher), Version: *setting.Version, Path: *setting.Path,
			}
		}
	}
	config := domain.EngineConfig{Engines: engines}
	if parsed.DefaultEngine != nil {
		defaultEngine := domain.Engine(*parsed.DefaultEngine)
		config.DefaultEngine = &defaultEngine
	}
	return config
}

// Write lays the engines out the way the file's format pins: the file's own key order for the
// engines that stay, the newly enabled ones after those, every byte two-space indented with a
// trailing newline. The port's write cannot report failures.
func (c *fsEngineConfig) Write(config domain.EngineConfig) {
	order := writeOrder(config, fileEngineOrder(c.file))
	_, _ = fsutil.WriteFileAtomic(context.Background(), c.file,
		marshalEnginesJSON(config, order), fsutil.WriteOptions{Mkdir: true})
}

// FileEngineOrder reads the file's engines keys in document order, however valid their values
// are: that order is what a rewrite keeps and what the setup hook's repairs walk.
func FileEngineOrder(path string) []string {
	return fileEngineOrder(path)
}

// writeOrder is the engines' insertion order: the file's own order for the engines the config
// keeps, then the ones newly enabled (sorted, for one deterministic answer when a single write
// enables several).
func writeOrder(config domain.EngineConfig, fileOrder []string) []domain.EngineTool {
	return ConfiguredOrder(config, fileOrder)
}

// ConfiguredOrder is the config's engines in the file's own order, then the ones the file does
// not name yet (sorted, for one deterministic answer when a single write enables several).
func ConfiguredOrder(config domain.EngineConfig, fileOrder []string) []domain.EngineTool {
	order := make([]domain.EngineTool, 0, len(config.Engines))
	for _, name := range fileOrder {
		if tool := domain.EngineTool(name); toolIn(config, tool) {
			order = append(order, tool)
		}
	}
	var fresh []domain.EngineTool
	for tool := range config.Engines {
		if !slices.Contains(order, tool) {
			fresh = append(fresh, tool)
		}
	}
	slices.Sort(fresh)
	return append(order, fresh...)
}

func toolIn(config domain.EngineConfig, tool domain.EngineTool) bool {
	_, ok := config.Engines[tool]
	return ok
}

// fileEngineOrder reads the file's engines keys in document order, however valid their values
// are: that order is what a rewrite keeps.
func fileEngineOrder(path string) []string {
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	if tok, err := decoder.Token(); err != nil || tok != json.Delim('{') {
		return nil
	}
	var order []string
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return nil
		}
		name, _ := key.(string)
		if name != "engines" {
			if err := skipJSONValue(decoder); err != nil {
				return nil
			}
			continue
		}
		if tok, err := decoder.Token(); err != nil || tok != json.Delim('{') {
			return nil
		}
		for decoder.More() {
			engineKey, err := decoder.Token()
			if err != nil {
				return nil
			}
			if name, ok := engineKey.(string); ok {
				order = append(order, name)
			}
			if err := skipJSONValue(decoder); err != nil {
				return nil
			}
		}
		if _, err := decoder.Token(); err != nil {
			return nil
		}
	}
	return order
}

// skipJSONValue consumes one JSON value, an object or an array by depth, a scalar at once.
func skipJSONValue(decoder *json.Decoder) error {
	depth := 0
	for {
		tok, err := decoder.Token()
		if err != nil {
			return err
		}
		if delim, ok := tok.(json.Delim); ok {
			if delim == '{' || delim == '[' {
				depth++
			} else {
				depth--
			}
			if depth == 0 {
				return nil
			}
			continue
		}
		if depth == 0 {
			return nil
		}
	}
}

// marshalEnginesJSON builds the file the way JSON.stringify(config, null, 2) built it: the
// engines in order, each setting's fields in the interface's order, two spaces per level.
func marshalEnginesJSON(config domain.EngineConfig, order []domain.EngineTool) []byte {
	var buf bytes.Buffer
	buf.WriteString("{\n  \"engines\": {")
	for i, tool := range order {
		if i > 0 {
			buf.WriteByte(',')
		}
		setting := config.Engines[tool]
		fmt.Fprintf(&buf, "\n    %s: {\n      %s: %s,\n      %s: %s,\n      %s: %s\n    }",
			quoteJSON(string(tool)),
			quoteJSON("watcher"), quoteJSON(string(setting.Watcher)),
			quoteJSON("version"), quoteJSON(setting.Version),
			quoteJSON("path"), quoteJSON(setting.Path))
	}
	if len(order) > 0 {
		buf.WriteString("\n  }")
	} else {
		buf.WriteString("}")
	}
	if config.DefaultEngine != nil {
		fmt.Fprintf(&buf, ",\n  \"defaultEngine\": %s", quoteJSON(string(*config.DefaultEngine)))
	}
	buf.WriteString("\n}\n")
	return buf.Bytes()
}

// quoteJSON is one JSON string without HTML escaping: the config file carries none of the
// escapes encoding/json would add.
func quoteJSON(text string) string {
	quoted, _ := fsutil.MarshalJSON(text)
	return strings.TrimSuffix(string(quoted), "\n")
}
