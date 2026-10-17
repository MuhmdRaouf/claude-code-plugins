package adapters

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

func TestFsEngineConfig(t *testing.T) {
	omp := domain.EngineSetting{
		Watcher: domain.WatcherProvider, Version: "omp/18.6.3", Path: "/usr/bin/omp",
	}

	t.Run("a plugin set up before engines existed has no file: claude only", func(t *testing.T) {
		root := t.TempDir()

		if got := CreateFsEngineConfig(root).Read(); !reflect.DeepEqual(got,
			domain.EngineConfig{Engines: map[domain.EngineTool]domain.EngineSetting{}}) {
			t.Fatalf("read = %+v, want claude only", got)
		}
		if !domain.EngineEnabled(CreateFsEngineConfig(root).Read(), domain.EngineClaude) {
			t.Fatal("claude is not enabled")
		}
		if domain.EngineEnabled(CreateFsEngineConfig(root).Read(), domain.EngineOmp) {
			t.Fatal("omp is enabled before its setup ran")
		}
	})

	t.Run("round-trips, additive per engine, with the default engine kept", func(t *testing.T) {
		root := t.TempDir()
		store := CreateFsEngineConfig(root)
		pi := omp
		pi.Watcher = domain.WatcherSonnet
		defaultEngine := domain.EnginePi
		store.Write(domain.EngineConfig{
			Engines:       map[domain.EngineTool]domain.EngineSetting{domain.EngineToolPi: pi},
			DefaultEngine: &defaultEngine,
		})
		store.Write(domain.WithEngine(store.Read(), domain.EngineToolOmp, omp))

		want := domain.EngineConfig{
			Engines: map[domain.EngineTool]domain.EngineSetting{
				domain.EngineToolPi:  pi,
				domain.EngineToolOmp: omp,
			},
			DefaultEngine: &defaultEngine,
		}
		if got := CreateFsEngineConfig(root).Read(); !reflect.DeepEqual(got, want) {
			t.Fatalf("read = %+v, want %+v", got, want)
		}
		if !domain.EngineEnabled(CreateFsEngineConfig(root).Read(), domain.EngineOmp) {
			t.Fatal("omp is not enabled after its setup ran")
		}
	})

	t.Run("an unreadable or foreign file reads as claude only", func(t *testing.T) {
		root := t.TempDir()
		file := domain.NewStateLayout(root).Engines
		if err := os.WriteFile(file, []byte(`{"engines":{"omp":{"watcher":"opus"}}}`), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}

		if got := CreateFsEngineConfig(root).Read(); !reflect.DeepEqual(got,
			domain.EngineConfig{Engines: map[domain.EngineTool]domain.EngineSetting{}}) {
			t.Fatalf("read of a foreign file = %+v, want claude only", got)
		}
		if err := os.WriteFile(file, []byte("["), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		if got := CreateFsEngineConfig(root).Read(); !reflect.DeepEqual(got,
			domain.EngineConfig{Engines: map[domain.EngineTool]domain.EngineSetting{}}) {
			t.Fatalf("read of a torn file = %+v, want claude only", got)
		}
		if _, err := os.Stat(filepath.Join(root, "engines.json")); err != nil {
			t.Fatalf("the reads left the file behind: %v", err)
		}
	})
}

func TestFsEngineConfigUnwritableRoot(t *testing.T) {
	file := filepath.Join(t.TempDir(), "engines-root")
	if err := os.WriteFile(file, []byte("a file"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	store := CreateFsEngineConfig(file)
	store.Write(domain.EngineConfig{Engines: map[domain.EngineTool]domain.EngineSetting{}})
	if got := store.Read(); !reflect.DeepEqual(got,
		domain.EngineConfig{Engines: map[domain.EngineTool]domain.EngineSetting{}}) {
		t.Fatalf("read = %+v, want claude only", got)
	}
}

// The file keeps the insertion order: the order the engines were enabled in, and the file's own
// order on a rewrite. The expected bytes are the format's two-space JSON for the same sequence.
func TestFsEngineConfigKeepsInsertionOrder(t *testing.T) {
	zcode := domain.EngineSetting{
		Watcher: domain.WatcherProvider, Version: "zcode/0.14.2", Path: "/usr/local/bin/zcode",
	}
	omp := domain.EngineSetting{
		Watcher: domain.WatcherSonnet, Version: "omp/18.6.3", Path: "/usr/bin/omp",
	}
	zcodeDefault := domain.EngineZcode

	t.Run("engines enabled in turn are listed in that order, byte for byte", func(t *testing.T) {
		root := t.TempDir()
		file := domain.NewStateLayout(root).Engines
		store := CreateFsEngineConfig(root)

		store.Write(domain.EngineConfig{
			Engines:       map[domain.EngineTool]domain.EngineSetting{domain.EngineToolZcode: zcode},
			DefaultEngine: &zcodeDefault,
		})
		first := readEngineFile(t, file)
		wantFirst := `{
  "engines": {
    "zcode": {
      "watcher": "provider",
      "version": "zcode/0.14.2",
      "path": "/usr/local/bin/zcode"
    }
  },
  "defaultEngine": "zcode"
}
`
		if first != wantFirst {
			t.Fatalf("the first write =\n%s\nwant\n%s", first, wantFirst)
		}

		store.Write(domain.WithEngine(store.Read(), domain.EngineToolOmp, omp))
		second := readEngineFile(t, file)
		wantSecond := `{
  "engines": {
    "zcode": {
      "watcher": "provider",
      "version": "zcode/0.14.2",
      "path": "/usr/local/bin/zcode"
    },
    "omp": {
      "watcher": "sonnet",
      "version": "omp/18.6.3",
      "path": "/usr/bin/omp"
    }
  },
  "defaultEngine": "zcode"
}
`
		if second != wantSecond {
			t.Fatalf("the second write =\n%s\nwant\n%s", second, wantSecond)
		}
	})

	t.Run("a rewrite keeps the file's own order and appends the newly enabled engine", func(t *testing.T) {
		root := t.TempDir()
		file := domain.NewStateLayout(root).Engines
		seed := `{
  "engines": {
    "pi": {
      "watcher": "provider",
      "version": "pi/1.2.0",
      "path": "/usr/bin/pi"
    },
    "omp": {
      "watcher": "provider",
      "version": "omp/18.6.3",
      "path": "/usr/bin/omp"
    }
  }
}
`
		if err := os.WriteFile(file, []byte(seed), 0o600); err != nil {
			t.Fatalf("seed: %v", err)
		}

		store := CreateFsEngineConfig(root)
		store.Write(domain.WithEngine(store.Read(), domain.EngineToolZcode, zcode))

		got := readEngineFile(t, file)
		if pi, omp := strings.Index(got, `"pi"`), strings.Index(got, `"omp"`); pi > omp {
			t.Fatalf("the rewrite reordered the file:\n%s", got)
		}
		if ompAt, zcodeAt := strings.Index(got, `"omp"`), strings.Index(got, `"zcode"`); zcodeAt < ompAt {
			t.Fatalf("the newly enabled engine was not appended:\n%s", got)
		}
		readBack := CreateFsEngineConfig(root).Read()
		if len(readBack.Engines) != 3 || readBack.Engines[domain.EngineToolPi].Version != "pi/1.2.0" {
			t.Fatalf("read = %+v, want all three engines", readBack)
		}
	})

	t.Run("an empty config writes the empty-engines shape byte for byte", func(t *testing.T) {
		root := t.TempDir()
		file := domain.NewStateLayout(root).Engines
		piDefault := domain.EnginePi
		store := CreateFsEngineConfig(root)

		store.Write(domain.EngineConfig{
			Engines:       map[domain.EngineTool]domain.EngineSetting{},
			DefaultEngine: &piDefault,
		})
		if got := readEngineFile(t, file); got != "{\n  \"engines\": {},\n  \"defaultEngine\": \"pi\"\n}\n" {
			t.Fatalf("the empty write = %q", got)
		}

		store.Write(domain.EngineConfig{Engines: map[domain.EngineTool]domain.EngineSetting{}})
		if got := readEngineFile(t, file); got != "{\n  \"engines\": {}\n}\n" {
			t.Fatalf("the empty write without a default = %q", got)
		}
	})

	t.Run("a rewrite ignores foreign members and keeps the file's engine order", func(t *testing.T) {
		root := t.TempDir()
		file := domain.NewStateLayout(root).Engines
		seed := `{"junk": [1, {"a": 2}], "engines": {"pi": {"watcher": "provider", "version": "pi/1.2.0", "path": "/usr/bin/pi"}}, "defaultEngine": "pi"}`
		if err := os.WriteFile(file, []byte(seed), 0o600); err != nil {
			t.Fatalf("seed: %v", err)
		}

		store := CreateFsEngineConfig(root)
		read := store.Read()
		if read.DefaultEngine == nil || *read.DefaultEngine != domain.EnginePi || len(read.Engines) != 1 {
			t.Fatalf("read = %+v, want pi alone with pi as the default", read)
		}
		store.Write(domain.WithEngine(read, domain.EngineToolOmp, omp))
		got := readEngineFile(t, file)
		if pi, ompAt := strings.Index(got, `"pi"`), strings.Index(got, `"omp"`); pi > ompAt {
			t.Fatalf("the rewrite reordered the file:\n%s", got)
		}
		if strings.Contains(got, `"junk"`) {
			t.Fatalf("the rewrite kept the foreign member:\n%s", got)
		}
	})

	t.Run("a file whose engines object cannot be walked has no order", func(t *testing.T) {
		for name, body := range map[string]string{
			"torn":             "[",
			"engines-a-number": `{"engines": 42}`,
			"engines-torn":     `{"engines": {"pi":`,
			"engines-a-list":   `{"engines": ["pi"]}`,
			"root-torn":        `{"pi"`,
			"engines-unclosed": `{"engines": {}`,
		} {
			file := filepath.Join(t.TempDir(), "engines.json")
			if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
				t.Fatalf("write %s: %v", name, err)
			}
			if got := fileEngineOrder(file); got != nil {
				t.Fatalf("order of the %s file = %v, want none", name, got)
			}
		}
		if got := fileEngineOrder(filepath.Join(t.TempDir(), "absent.json")); got != nil {
			t.Fatalf("order of a missing file = %v, want none", got)
		}
	})
}

func readEngineFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(raw)
}
