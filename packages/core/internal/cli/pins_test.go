package cli_test

import (
	"context"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

func TestPinsOf(t *testing.T) {
	t.Run("an empty environment pins nothing", func(t *testing.T) {
		pins := cli.PinsOf(domain.EnvLookup{})
		if pins.NowMS != 0 || pins.SequentialIDs || pins.Runtime != "" || pins.RouterLine != "" {
			t.Fatalf("pins = %+v, want the zero pins", pins)
		}
	})

	t.Run("reads every pin the parity session sets", func(t *testing.T) {
		pins := cli.PinsOf(domain.EnvLookup{
			"PLUGIN_CORE_NOW_MS":         "1791288000000",
			"PLUGIN_CORE_SEQUENTIAL_IDS": "1",
			"PLUGIN_CORE_RUNTIME":        "bun 1.3.14 (/usr/local/bin/bun)",
			"PLUGIN_CORE_ROUTER_LINE":    "running on http://127.0.0.1:18787 (already running)",
		})
		if pins.NowMS != 1791288000000 {
			t.Errorf("NowMS = %d, want 1791288000000", pins.NowMS)
		}
		if !pins.SequentialIDs {
			t.Error("SequentialIDs = false, want true")
		}
		if pins.Runtime != "bun 1.3.14 (/usr/local/bin/bun)" {
			t.Errorf("Runtime = %q", pins.Runtime)
		}
		if pins.RouterLine != "running on http://127.0.0.1:18787 (already running)" {
			t.Errorf("RouterLine = %q", pins.RouterLine)
		}
	})

	t.Run("a pin that is not a number is no pin at all, like an unset one", func(t *testing.T) {
		if pins := cli.PinsOf(domain.EnvLookup{"PLUGIN_CORE_NOW_MS": "soon"}); pins.NowMS != 0 {
			t.Errorf("NowMS = %d, want 0", pins.NowMS)
		}
	})
}

func TestWirePins(t *testing.T) {
	// The parity session's pins, as one wired environment.
	pinned := func(t *testing.T) map[string]string {
		t.Helper()
		env := wireSandbox(t, map[string]string{
			"PLUGIN_CORE_NOW_MS":         "1791288000000",
			"PLUGIN_CORE_SEQUENTIAL_IDS": "1",
			"PLUGIN_CORE_RUNTIME":        "bun 1.3.14 (/usr/local/bin/bun)",
			"PLUGIN_CORE_ROUTER_LINE":    "running on http://127.0.0.1:18787 (already running)",
		})
		return env
	}

	t.Run("the clock is the pinned instant, in both shapes Date.now() and toISOString() gave", func(t *testing.T) {
		deps := wired(t, testkit.ReferenceProvider, pinned(t), &fakes.RecordingOutput{}, "/zai.js")
		if got := deps.Clock.Now(); got != 1791288000000 {
			t.Errorf("now = %d, want the pinned 1791288000000", got)
		}
		if got := deps.Clock.Iso(); got != "2026-10-06T12:00:00.000Z" {
			t.Errorf("iso = %q, want 2026-10-06T12:00:00.000Z", got)
		}
	})

	t.Run("ids count across wirings, the session's every command one file", func(t *testing.T) {
		env := pinned(t)
		first := wired(t, testkit.ReferenceProvider, env, &fakes.RecordingOutput{}, "/zai.js")
		second := wired(t, testkit.ReferenceProvider, env, &fakes.RecordingOutput{}, "/zai.js")

		if got := first.Ids.JobID(); got != "261006-000001" {
			t.Errorf("first job id = %q, want 261006-000001", got)
		}
		if got := second.Ids.JobID(); got != "261006-000002" {
			t.Errorf("second job id = %q, want 261006-000002", got)
		}
		if got := first.Ids.SessionID(); got != "00000000-0000-4000-8000-000000000001" {
			t.Errorf("first session id = %q", got)
		}
	})

	t.Run("unpinned wirings stay on the wall clock and random ids", func(t *testing.T) {
		deps := wired(t, testkit.ReferenceProvider, wireSandbox(t, nil), &fakes.RecordingOutput{}, "/zai.js")
		if deps.Clock.Now() < 1791288000000 {
			t.Errorf("now = %d, want the wall clock after the pinned instant", deps.Clock.Now())
		}
		if deps.Ids.JobID() == deps.Ids.JobID() {
			t.Error("two job ids are the same, want random base32 ids")
		}
	})

	t.Run("the runtime line and the router answer are the pinned ones", func(t *testing.T) {
		deps := wired(t, testkit.ReferenceProvider, pinned(t), &fakes.RecordingOutput{}, "/zai.js")
		if deps.Host.Runtime != "bun 1.3.14 (/usr/local/bin/bun)" {
			t.Errorf("runtime = %q, want the pinned line", deps.Host.Runtime)
		}
		line, err := deps.Host.EnsureRouter(context.Background())
		if err != nil || line != "running on http://127.0.0.1:18787 (already running)" {
			t.Fatalf("ensureRouter = (%q, %v), want the pinned line and no error", line, err)
		}
	})

	t.Run("without the router pin the start still runs", func(t *testing.T) {
		env := wireSandbox(t, map[string]string{"ZAI_ROUTER_PORT": "18999"})
		deps := wired(t, testkit.ReferenceProvider, env, &fakes.RecordingOutput{}, "/zai.js")
		if _, err := deps.Host.EnsureRouter(context.Background()); err == nil {
			t.Fatal("ensureRouter with no pin and no router binary = nil error")
		}
		if deps.Host.Runtime != adapters.Runtime() {
			t.Errorf("runtime = %q, want the real %q", deps.Host.Runtime, adapters.Runtime())
		}
	})
}
