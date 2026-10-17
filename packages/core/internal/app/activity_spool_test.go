// The activity board's two halves that read the spool from disk, as the usage report reads it:
// the merged board over today's and yesterday's files beside the job store, and the three usage
// windows over thirty days, both over real spool lines, run here (package app_test) because the
// spool reader lives in internal/adapters/spool.
package app_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/spool"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakes"
)

// activityNoon is local noon of a fixed day, so file names and midnight windows hold in any
// timezone.
var activityNoon = time.Date(2026, time.October, 7, 12, 0, 0, 0, time.Local).UnixMilli()

// activityAt is a moment on the fixed day as the ISO timestamp the spool carries.
func activityAt(dayOffset, hour, minute, second int) string {
	return time.Date(2026, time.October, 7+dayOffset, hour, minute, second, 0, time.Local).UTC().
		Format("2006-01-02T15:04:05.000Z")
}

// activityRoute is a route event with only what the aggregations read.
func activityRoute(ts string, overrides ...func(*domain.RouteEvent)) domain.RouteEvent {
	event := domain.RouteEvent{
		Ts:        ts,
		Event:     domain.EventRoute,
		Plugin:    "zai",
		Model:     "glm-5.3",
		Upstream:  "api.z.ai",
		Route:     "provider",
		Status:    200,
		LatencyMs: 40,
	}
	for _, override := range overrides {
		override(&event)
	}
	return event
}

// activityRouteUsage is the answer usage every fixture shares.
func activityRouteUsage() *domain.RouteUsage {
	usage := domain.RouteUsage{
		"input_tokens":                float64(100),
		"output_tokens":               float64(10),
		"cache_read_input_tokens":     float64(5),
		"cache_creation_input_tokens": float64(7),
	}
	return &usage
}

// newActivityWorld wires the fakes into Deps with the spool as the real reader under a temp radar
// home.
func newActivityWorld(t *testing.T) (app.Deps, *fakes.MemoryStore, string) {
	t.Helper()
	root := testkit.TempDir(t, "core-activity-")
	process := fakes.NewFakeProcess()
	store := fakes.NewMemoryStore(root)
	clock := fakes.NewManualClock()
	clock.Advance(activityNoon - fakes.T0)
	env := domain.EnvLookup{
		"HOME":       filepath.Join(root, "home"),
		"RADAR_HOME": filepath.Join(root, "radar"),
	}
	deps := app.Deps{
		Worker:   fakes.NewScriptedWorker(t, process, fakes.Completes()),
		Store:    store,
		Files:    adapters.CreateFsJobFiles(root),
		Spool:    spool.CreateSpoolReader(env),
		Clock:    clock,
		Ids:      fakes.NewFakeIds(),
		Out:      &fakes.RecordingOutput{},
		Host:     app.HostInfo{StateRoot: root},
		Provider: testkit.ReferenceProvider,
		Env:      env,
		Config:   app.Config{Limiter: domain.DEFAULT_LIMITER, Prompt: domain.DefaultLimits, StopGraceMs: 100},
	}
	return deps, store, filepath.Join(root, "radar", "spool")
}

// activityWriteSpool writes one dated file of JSON lines into the spool.
func activityWriteSpool(t *testing.T, dir, name string, events []domain.SpoolEvent) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	lines := make([]string, len(events))
	for i, event := range events {
		line, err := json.Marshal(event)
		if err != nil {
			t.Fatal(err)
		}
		lines[i] = string(line)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestActivityBoard(t *testing.T) {
	t.Run("reads today's and yesterday's spool beside the job store, one merged board", func(t *testing.T) {
		ctx := context.Background()
		deps, store, spoolDir := newActivityWorld(t)
		activityWriteSpool(t, spoolDir, "2026-10-07.jsonl", []domain.SpoolEvent{
			activityRoute(activityAt(0, 11, 59, 30), func(e *domain.RouteEvent) {
				session, agent := "s-now", "a-now"
				e.SessionID, e.AgentID = &session, &agent
			}),
		})
		activityWriteSpool(t, spoolDir, "2026-10-06.jsonl", []domain.SpoolEvent{
			activityRoute(activityAt(-1, 11, 0, 0), func(e *domain.RouteEvent) {
				session := "s-yesterday"
				e.SessionID = &session
			}),
		})
		activityWriteSpool(t, spoolDir, "2026-10-05.jsonl", []domain.SpoolEvent{
			activityRoute(activityAt(-2, 11, 0, 0), func(e *domain.RouteEvent) {
				session := "s-too-old"
				e.SessionID = &session
			}),
		})
		store.Put(testkit.AJob(func(j *domain.Job) {
			j.ID = "261007-job001"
			j.State = domain.JobStateAwaitingReview
			j.UpdatedAt = activityAt(-1, 23, 0, 0)
		}))

		repo := "/repo"
		rows := app.ActivityBoard(ctx, deps, app.Scope{RepoRoot: &repo, All: false})

		got := make([]string, len(rows))
		for i, row := range rows {
			got[i] = fmt.Sprintf("%s %s %s", row.Kind, row.ID, row.State)
		}
		want := []string{
			"subagent a-now active",
			"job 261007-job001 awaiting_review",
			"session s-yester idle",
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("ActivityBoard() = %v, want %v", got, want)
		}
	})
}

func TestUsageWindows(t *testing.T) {
	t.Run("the three windows read thirty days of spool with the injected clock", func(t *testing.T) {
		deps, _, spoolDir := newActivityWorld(t)
		usage := activityRouteUsage()
		for name, ts := range map[string]string{
			"2026-10-07.jsonl": activityAt(0, 8, 0, 0),
			"2026-10-02.jsonl": activityAt(-5, 8, 0, 0),
			"2026-09-15.jsonl": activityAt(-22, 8, 0, 0),
			"2026-09-01.jsonl": activityAt(-36, 8, 0, 0),
		} {
			activityWriteSpool(t, spoolDir, name, []domain.SpoolEvent{
				activityRoute(ts, func(e *domain.RouteEvent) { e.Usage = usage }),
			})
		}

		windows := app.UsageWindows(deps, app.UsageEvents(deps))

		got := make([][2]any, len(windows))
		for i, window := range windows {
			requests := any(nil)
			if len(window.Rows) > 0 {
				requests = window.Rows[0].Requests
			}
			got[i] = [2]any{window.Label, requests}
		}
		want := [][2]any{
			{"Today", int64(1)},
			{"Last 7 days", int64(2)},
			{"Last 30 days", int64(3)},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("UsageWindows() = %v, want %v", got, want)
		}
	})
}
