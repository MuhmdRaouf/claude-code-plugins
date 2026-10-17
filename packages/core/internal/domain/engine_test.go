package domain

import (
	"reflect"
	"testing"
)

func TestEngines(t *testing.T) {
	t.Run("claude plus the four delegation tools", func(t *testing.T) {
		if !reflect.DeepEqual(ENGINES, []Engine{"claude", "omp", "opencode", "pi", "zcode"}) {
			t.Fatalf("ENGINES = %v, want [claude omp opencode pi zcode]", ENGINES)
		}
		if !reflect.DeepEqual(ENGINE_TOOLS, []EngineTool{"omp", "opencode", "pi", "zcode"}) {
			t.Fatalf("ENGINE_TOOLS = %v, want [omp opencode pi zcode]", ENGINE_TOOLS)
		}
		if !IsEngine("claude") {
			t.Fatal("isEngine(claude) = false, want true")
		}
		if IsEngine("cursor") {
			t.Fatal("isEngine(cursor) = true, want false")
		}
		if IsEngine(3) {
			t.Fatal("isEngine(3) = true, want false")
		}
		if IsEngineTool("claude") {
			t.Fatal("isEngineTool(claude) = true, want false")
		}
		if !IsEngineTool("pi") {
			t.Fatal("isEngineTool(pi) = false, want true")
		}
	})
}

func TestWithEngine(t *testing.T) {
	ompSetting := EngineSetting{Watcher: WatcherSonnet, Version: "1.0.0", Path: "/usr/bin/omp"}
	piSetting := EngineSetting{Watcher: WatcherProvider, Version: "2.1.0", Path: "/opt/homebrew/bin/pi"}

	t.Run("enables one engine and keeps every other engine and the default", func(t *testing.T) {
		defaultEngine := EngineOpencode
		base := EngineConfig{Engines: map[EngineTool]EngineSetting{EngineToolOmp: ompSetting}, DefaultEngine: &defaultEngine}
		got := WithEngine(base, EngineToolPi, piSetting)
		want := EngineConfig{
			Engines:       map[EngineTool]EngineSetting{EngineToolOmp: ompSetting, EngineToolPi: piSetting},
			DefaultEngine: &defaultEngine,
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("withEngine = %#v, want %#v", got, want)
		}
		// withEngine leaves the config it was given untouched.
		if _, ok := base.Engines[EngineToolPi]; ok {
			t.Fatal("withEngine mutated the config it was given")
		}
	})

	t.Run("enables the first engine of an empty config", func(t *testing.T) {
		got := WithEngine(EngineConfig{}, EngineToolPi, piSetting)
		want := EngineConfig{Engines: map[EngineTool]EngineSetting{EngineToolPi: piSetting}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("withEngine = %#v, want %#v", got, want)
		}
	})
}

func TestEngineEnabled(t *testing.T) {
	setting := EngineSetting{Watcher: WatcherProvider, Version: "1.2.3", Path: "/usr/bin/zcode"}
	config := WithEngine(EngineConfig{}, EngineToolZcode, setting)

	if !EngineEnabled(config, EngineClaude) {
		t.Fatal("claude is always enabled, even with no engines set up")
	}
	if !EngineEnabled(EngineConfig{}, EngineClaude) {
		t.Fatal("claude is always enabled, even for a plugin set up before engines existed")
	}
	if !EngineEnabled(config, EngineZcode) {
		t.Fatal("an engine whose setup ran is enabled")
	}
	if EngineEnabled(config, EngineOmp) {
		t.Fatal("an engine whose setup never ran is not enabled")
	}
	if EngineEnabled(config, "cursor") {
		t.Fatal("an unknown engine is not enabled")
	}
}
