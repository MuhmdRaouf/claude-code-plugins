package spool

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// The contract with the dashboards that read a router's spool: the lines the writer appends and
// the shape Radar's budget-status.json takes. The fixtures live in packages/core/testdata/contract
// and the huddle repository keeps an identical copy, so every byte of a change is reviewed twice.

// contractFixtureDir is the fixtures' directory, relative to this package.
const contractFixtureDir = "../../../testdata/contract"

// contractNoon pins the writer's clock: 2026-10-07 12:00 local, so the day file's name is the
// same whatever timezone the test runs in.
func contractNoon() int64 {
	return time.Date(2026, time.October, 7, 12, 0, 0, 0, time.Local).UnixMilli()
}

// The one session, agent and prompt the fixture lines name: fixed ids, so the bytes only change
// when the schema does.
const (
	contractTs         = "2026-10-07T09:00:00.000Z"
	contractTsMs       = int64(1791363600000)
	contractSessionID  = "b1c0ffee-0000-4000-8000-000000000001"
	contractAgentID    = "b1c0ffee-0000-4000-8000-000000000002"
	contractParentID   = "b1c0ffee-0000-4000-8000-000000000003"
	contractPromptHash = "5f1b1c4d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d"
)

// contractPromptBody is the request top the capture event gzips: the system prompt and the tool
// list, nothing else.
const contractPromptBody = `{"system":[{"type":"text","text":"You are Claude Code, the agent doing the work."}],"tools":[]}`

// contractRouteEvents is one line per non-health event kind, in the order a day writes them: the
// router coming up, a forwarded request, its prompt's capture, the router shutting down.
func contractRouteEvents() []domain.SpoolEvent {
	session, agent, parent := contractSessionID, contractAgentID, contractParentID
	hash := contractPromptHash
	headers := map[string]string{
		"anthropic-ratelimit-requests-limit": "2000",
		"anthropic-ratelimit-tokens-limit":   "450000",
		"request-id":                         "req_01ja9c2x7qe4bfv5smr3nd08pa",
	}
	usage := domain.RouteUsage{"input_tokens": 4.0, "output_tokens": 212.0, "cache_read_input_tokens": 13598.0}
	return []domain.SpoolEvent{
		domain.RouterEvent{
			Ts: contractTs, Event: domain.EventRouter, Plugin: "zai",
			Port: 18787, State: domain.RouterStateStart, Version: SpoolVersion,
		},
		domain.RouteEvent{
			Ts: contractTs, Event: domain.EventRoute, Plugin: "zai",
			Model: "glm-5.3", Upstream: "https://api.z.ai/api/anthropic", Route: "provider",
			Status: 200, LatencyMs: 4123,
			SessionID: &session, AgentID: &agent, ParentAgentID: &parent,
			Usage: &usage, Headers: &headers, PromptHash: &hash,
		},
		domain.CaptureEvent{
			Ts: contractTs, Event: domain.EventCapture, Plugin: "zai",
			PromptHash: contractPromptHash, Gz: contractGz(),
		},
		domain.RouterEvent{
			Ts: contractTs, Event: domain.EventRouter, Plugin: "zai",
			Port: 18787, State: domain.RouterStateStop, Version: SpoolVersion,
		},
	}
}

// contractHealthEvents is one line per health event kind, in RouterHealthEvents' order.
func contractHealthEvents() []domain.SpoolEvent {
	return []domain.SpoolEvent{
		domain.HealthEvent("zai", domain.HealthFallback,
			"dial tcp 1.2.3.4:443: i/o timeout: served by the passthrough", "", contractTsMs),
		domain.HealthEvent("zai", domain.HealthRefusal,
			"upstream 401: invalid api key", "glm-5.3", contractTsMs),
		domain.HealthEvent("zai", domain.HealthRateLimited,
			"upstream 429: rate limit reached", "glm-5.3", contractTsMs),
		domain.HealthEvent("zai", domain.HealthBudgetStop,
			"budget stop for provider:zai", "glm-5.3", contractTsMs),
		domain.HealthEvent("zai", domain.HealthRestart,
			"front silent for 5s: replaced", "", contractTsMs),
	}
}

// contractGz gzips the prompt body the way the router's capture does, base64.
func contractGz() string {
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, _ = writer.Write([]byte(contractPromptBody))
	_ = writer.Close()
	return base64.StdEncoding.EncodeToString(compressed.Bytes())
}

// TestContractFixturesMatchTheWriters regenerates the spool fixtures with the real writer, pinned
// to one clock and one set of ids, and requires byte-for-byte equality with the committed files:
// a formatting change must land in both repositories' copies at once.
func TestContractFixturesMatchTheWriters(t *testing.T) {
	dir := t.TempDir()
	routeEnv := domain.EnvLookup{
		"HOME":       filepath.Join(dir, "home"),
		"RADAR_HOME": filepath.Join(dir, "radar-route"),
	}
	healthEnv := domain.EnvLookup{
		"HOME":       filepath.Join(dir, "home"),
		"RADAR_HOME": filepath.Join(dir, "radar-health"),
	}
	write := CreateSpoolWriter(routeEnv, nil, contractNoon)
	for _, event := range contractRouteEvents() {
		write(event)
	}
	write = CreateSpoolWriter(healthEnv, nil, contractNoon)
	for _, event := range contractHealthEvents() {
		write(event)
	}
	compareContractFixture(t, routeEnv, "spool-route.jsonl")
	compareContractFixture(t, healthEnv, "spool-health.jsonl")
}

// compareContractFixture fails unless the spool the writer produced under env equals the named
// fixture, byte for byte.
func compareContractFixture(t *testing.T, env domain.EnvLookup, name string) {
	t.Helper()
	produced, err := os.ReadFile(SpoolFile(env, contractNoon()))
	if err != nil {
		t.Fatalf("the writer produced no spool file: %v", err)
	}
	fixture, err := os.ReadFile(filepath.Join(contractFixtureDir, name))
	if err != nil {
		t.Fatalf("reading the fixture failed and the spool lines produced were:\n%s", produced)
	}
	if !bytes.Equal(produced, fixture) {
		t.Fatalf("the writer's lines differ from testdata/contract/%s\nproduced:\n%s\nfixture:\n%s",
			name, produced, fixture)
	}
}
