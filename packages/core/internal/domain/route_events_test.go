package domain

import (
	"encoding/json"
	"testing"
)

func TestHealthEvent(t *testing.T) {
	t.Run("records no model as null", func(t *testing.T) {
		got := HealthEvent("zai", HealthRefusal, "no key", "", 123)
		want := RouterHealthEvent{
			Kind:   HealthEventKind,
			Plugin: "zai",
			Event:  HealthRefusal,
			Reason: "no key",
			Model:  nil,
			Ts:     123,
		}
		if got != want {
			t.Fatalf("HealthEvent() = %+v, want %+v", got, want)
		}
	})
	t.Run("records the named model", func(t *testing.T) {
		got := HealthEvent("zai", HealthFallback, "passthrough served", "glm-4.7", 1)
		if got.Model == nil || *got.Model != "glm-4.7" {
			t.Fatalf("HealthEvent().Model = %v, want glm-4.7", got.Model)
		}
	})
}

func TestRouterHealthEvents(t *testing.T) {
	want := []RouterHealth{HealthFallback, HealthRefusal, HealthRateLimited, HealthBudgetStop, HealthRestart}
	if len(RouterHealthEvents) != len(want) {
		t.Fatalf("RouterHealthEvents has %d entries, want %d", len(RouterHealthEvents), len(want))
	}
	for i, health := range want {
		if RouterHealthEvents[i] != health {
			t.Fatalf("RouterHealthEvents[%d] = %q, want %q", i, RouterHealthEvents[i], health)
		}
	}
}

func TestSpoolEventJSON(t *testing.T) {
	cases := []struct {
		name  string
		event SpoolEvent
		want  string
	}{
		{
			"a route event without optionals",
			RouteEvent{
				Ts: "2026-10-13T00:00:00.000Z", Event: EventRoute, Plugin: "zai", Model: "glm-4.7",
				Upstream: "https://api.z.ai", Route: "provider", Status: 200, LatencyMs: 42,
			},
			`{"ts":"2026-10-13T00:00:00.000Z","event":"route","plugin":"zai","model":"glm-4.7",` +
				`"upstream":"https://api.z.ai","route":"provider","status":200,"latency_ms":42}`,
		},
		{
			"a route event with every optional, in the spool line's key order",
			routeEventFull(),
			`{"ts":"t","event":"route","plugin":"zai","model":"m","upstream":"u","route":"provider",` +
				`"status":429,"error":"boom","latency_ms":5,"session_id":"s1","agent_id":"a1",` +
				`"parent_agent_id":"p1","usage":{"input_tokens":10},"headers":{"request-id":"r"},"prompt_hash":"h"}`,
		},
		{
			"a capture event",
			CaptureEvent{Ts: "t", Event: EventCapture, Plugin: "zai", PromptHash: "h", Gz: "g"},
			`{"ts":"t","event":"capture","plugin":"zai","prompt_hash":"h","gz":"g"}`,
		},
		{
			"a router start event",
			RouterEvent{Ts: "t", Event: EventRouter, Plugin: "zai", Port: 18787, State: RouterStateStart, Version: 1},
			`{"ts":"t","event":"router","plugin":"zai","port":18787,"state":"start","version":1}`,
		},
		{
			"a router stop event",
			RouterEvent{Ts: "t", Event: EventRouter, Plugin: "zai", Port: 18787, State: RouterStateStop, Version: 1},
			`{"ts":"t","event":"router","plugin":"zai","port":18787,"state":"stop","version":1}`,
		},
		{
			"a health event with no model",
			HealthEvent("zai", HealthBudgetStop, "budget stopped", "", 7),
			`{"kind":"router.event","plugin":"zai","event":"budget_stop","reason":"budget stopped","model":null,"ts":7}`,
		},
		{
			"a health event with a model",
			HealthEvent("zai", HealthRestart, "worker replaced", "glm-4.7", 7),
			`{"kind":"router.event","plugin":"zai","event":"restart","reason":"worker replaced","model":"glm-4.7","ts":7}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := json.Marshal(tc.event)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(got) != tc.want {
				t.Fatalf("JSON = %s\n     want %s", got, tc.want)
			}
		})
	}
}

func routeEventFull() RouteEvent {
	text := "boom"
	session := "s1"
	agent := "a1"
	parent := "p1"
	usage := RouteUsage{"input_tokens": 10}
	headers := map[string]string{"request-id": "r"}
	hash := "h"
	return RouteEvent{
		Ts: "t", Event: EventRoute, Plugin: "zai", Model: "m", Upstream: "u", Route: "provider", Status: 429,
		Error: &text, LatencyMs: 5, SessionID: &session, AgentID: &agent, ParentAgentID: &parent,
		Usage: &usage, Headers: &headers, PromptHash: &hash,
	}
}

// The markers keep the SpoolEvent union closed to exactly these four variants.
func TestSpoolEventUnionIsClosed(t *testing.T) {
	RouteEvent{Event: EventRoute}.spoolEvent()
	CaptureEvent{Event: EventCapture}.spoolEvent()
	RouterEvent{Event: EventRouter}.spoolEvent()
	RouterHealthEvent{Kind: HealthEventKind}.spoolEvent()
}

func TestIsHealthEvent(t *testing.T) {
	cases := []struct {
		name  string
		event SpoolEvent
		want  bool
	}{
		{"a health event", HealthEvent("zai", HealthFallback, "r", "m", 1), true},
		{"a health event by pointer", &RouterHealthEvent{Kind: HealthEventKind}, true},
		{"a route event", RouteEvent{Event: EventRoute}, false},
		{"a router event", RouterEvent{Event: EventRouter}, false},
		{"a capture event", CaptureEvent{Event: EventCapture}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsHealthEvent(tc.event); got != tc.want {
				t.Fatalf("IsHealthEvent(%T) = %v, want %v", tc.event, got, tc.want)
			}
		})
	}
}
