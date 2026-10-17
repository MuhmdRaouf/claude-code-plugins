package domain

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The goldens are fixed fixtures: parseBrief's answer for every case, written next to it.
func TestParseBriefGoldens(t *testing.T) {
	casesDir := filepath.Join("..", "..", "testdata", "brief", "cases")
	entries, err := os.ReadDir(casesDir)
	if err != nil {
		t.Fatalf("read cases: %v", err)
	}
	count := 0
	for _, entry := range entries {
		path := filepath.Join(casesDir, entry.Name())
		if entry.IsDir() {
			t.Run(entry.Name(), func(t *testing.T) {
				runGoldenDir(t, path)
			})
			count++
			continue
		}
		if !strings.HasSuffix(entry.Name(), ".md") {
			continue
		}
		name := strings.TrimSuffix(entry.Name(), ".md")
		t.Run(name, func(t *testing.T) {
			runGoldenCase(t, path)
		})
		count++
	}
	if count < 40 {
		t.Fatalf("only %d golden cases ran, the generator's set has shrunk", count)
	}
}

// runGoldenDir runs every case in a subfolder (no-budget parses with a worker without a cap).
func runGoldenDir(t *testing.T, dir string) {
	t.Helper()
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".md") {
			return nil
		}
		t.Run(strings.TrimSuffix(entry.Name(), ".md"), func(t *testing.T) {
			runGoldenCase(t, path)
		})
		return nil
	})
	if err != nil {
		t.Fatalf("walk %s: %v", dir, err)
	}
}

func runGoldenCase(t *testing.T, path string) {
	t.Helper()
	text, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read case: %v", err)
	}
	golden, err := os.ReadFile(strings.TrimSuffix(path, ".md") + ".json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var want any
	if err := json.Unmarshal(golden, &want); err != nil {
		t.Fatalf("parse golden: %v", err)
	}
	// The no-budget folder parses with the worker that has no spending cap, as the generator does.
	worker := referenceCaps
	if strings.Contains(filepath.ToSlash(path), "/no-budget/") {
		worker = acmeWorker
	}
	ctx := BriefContext{DefaultCwd: "/work/repo", Provider: referenceProvider, Worker: worker}
	brief, errors := ParseBrief(string(text), ctx)
	var got any
	if errors != nil {
		got = map[string]any{"ok": false, "error": toJSONValue(errors)}
	} else {
		got = map[string]any{"ok": true, "value": toJSONValue(brief)}
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseBrief(%s) =\n%s\nwant\n%s", filepath.Base(path), mustJSON(got), string(golden))
	}
}

// slashEveryString canonicalises every string in a decoded JSON tree the way path.resolve's
// answers differ across platforms: a leading drive goes, backslashes become slashes.
func slashEveryString(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		for name, item := range typed {
			typed[name] = slashEveryString(item)
		}
		return typed
	case []any:
		for index, item := range typed {
			typed[index] = slashEveryString(item)
		}
		return typed
	case string:
		text := typed
		if len(text) >= 2 && text[1] == ':' {
			text = text[2:]
		}
		return strings.ReplaceAll(text, `\`, "/")
	default:
		return value
	}
}

// toJSONValue round-trips through JSON so pointers, empty slices and omitted fields compare the
// way the golden's JSON sees them.
func toJSONValue(value any) any {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err.Error()
	}
	var decoded any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		return err.Error()
	}
	return decoded
}
