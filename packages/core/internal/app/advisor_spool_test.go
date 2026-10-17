// The router-health case that reads the spool from disk; package app_test because the spool
// reader lives in internal/adapters/spool.
package app_test

import (
	"reflect"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

func TestRouterHealth(t *testing.T) {
	t.Run("reads them from the spool on disk, today's and yesterday's file", func(t *testing.T) {
		deps, _, spoolDir := newActivityWorld(t)
		activityWriteSpool(t, spoolDir, "2026-10-07.jsonl", []domain.SpoolEvent{
			domain.HealthEvent("zai", domain.HealthRestart, "x", "", activityNoon),
		})
		activityWriteSpool(t, spoolDir, "2026-10-06.jsonl", []domain.SpoolEvent{
			domain.HealthEvent("zai", domain.HealthRateLimited, "HTTP 429", "glm-5.3", activityNoon-20*3_600_000),
		})

		// Two days of spool: today's and yesterday's file.
		events := deps.Spool.Events(deps.Clock.Now(), 2)
		got := app.RouterHealth(deps, events)

		want := app.RouterHealthCounts{RateLimited: 1, Restart: 1}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("RouterHealth() = %+v, want %+v", got, want)
		}
	})
}
