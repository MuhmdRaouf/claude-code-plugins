package app

import (
	"encoding/json"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// The pure halves of the activity board, the cases that need no disk: the spool's subagent and
// session rows, the job rows and the board's order.

// activityNoon is local noon of a fixed day, so file names and midnight windows hold in any
// timezone.
var activityNoon = time.Date(2026, time.October, 7, 12, 0, 0, 0, time.Local).UnixMilli()

// activityAt is a moment on the fixed day as the ISO timestamp the spool and job.json carry.
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

// firstOrNil is the rows' first row, or the zero row for an empty board.
func firstOrNil(rows []ActivityRow) ActivityRow {
	if len(rows) == 0 {
		return ActivityRow{}
	}
	return rows[0]
}

func TestSpoolRows(t *testing.T) {
	t.Run("one row per subagent and per main session: requests and tokens summed, short id, last request's model", func(t *testing.T) {
		withSession := func(id string) func(*domain.RouteEvent) {
			return func(e *domain.RouteEvent) { e.SessionID = &id }
		}
		withAgent := func(id string) func(*domain.RouteEvent) {
			return func(e *domain.RouteEvent) { e.AgentID = &id }
		}
		events := []domain.SpoolEvent{
			activityRoute(activityAt(0, 11, 50, 10), withSession("session-one-aaaa"), withAgent("agent-aaa-111"),
				func(e *domain.RouteEvent) { e.Usage = activityRouteUsage() }),
			activityRoute(activityAt(0, 11, 50, 20), withSession("session-one-aaaa"), withAgent("agent-aaa-111"),
				func(e *domain.RouteEvent) {
					flash := "glm-5.3-flash"
					e.Model = flash
					e.Usage = activityRouteUsage()
				}),
			activityRoute(activityAt(0, 11, 50, 30), withSession("session-one-aaaa"), withAgent("agent-bbb-222"),
				func(e *domain.RouteEvent) {
					parent := "agent-aaa-111"
					e.ParentAgentID = &parent
					e.Usage = activityRouteUsage()
				}),
			activityRoute(activityAt(0, 11, 50, 40), withSession("session-two-bbbb"),
				func(e *domain.RouteEvent) { e.Usage = activityRouteUsage() }),
			// Another plugin's router shares the file; a router event is not a request; an event
			// with no id belongs to no row.
			activityRoute(activityAt(0, 11, 50, 45), withSession("session-kimi"),
				func(e *domain.RouteEvent) { e.Plugin = "kimi" }),
			domain.RouterEvent{
				Ts: activityAt(0, 11, 50, 45), Event: domain.EventRouter, Plugin: "zai",
				Port: 18787, State: domain.RouterStateStart, Version: 1,
			},
			activityRoute(activityAt(0, 11, 50, 45), func(e *domain.RouteEvent) { e.Route = "anthropic" }),
		}

		now := time.Date(2026, time.October, 7, 11, 50, 59, 0, time.Local).UnixMilli()
		rows := SpoolRows("zai", events, now)

		want := []ActivityRow{
			{
				Kind: ActivityKindSubagent, ID: "agent-aa", Model: strPtr("glm-5.3-flash"),
				State: "active", Requests: strPtr(int64(2)), InputTokens: strPtr(int64(200)),
				OutputTokens: strPtr(int64(20)), At: activityAt(0, 11, 50, 20),
			},
			{
				Kind: ActivityKindSubagent, ID: "agent-bb", Model: strPtr("glm-5.3"),
				State: "active", Requests: strPtr(int64(1)), InputTokens: strPtr(int64(100)),
				OutputTokens: strPtr(int64(10)), At: activityAt(0, 11, 50, 30),
			},
			{
				Kind: ActivityKindSession, ID: "session-", Model: strPtr("glm-5.3"),
				State: "active", Requests: strPtr(int64(1)), InputTokens: strPtr(int64(100)),
				OutputTokens: strPtr(int64(10)), At: activityAt(0, 11, 50, 40),
			},
		}
		if !reflect.DeepEqual(rows, want) {
			t.Errorf("SpoolRows() = %+v, want %+v", rows, want)
		}
	})

	t.Run("active only within the minute, idle after; usage counters that are not numbers count as nothing", func(t *testing.T) {
		events := []domain.SpoolEvent{
			activityRoute(activityAt(0, 11, 59, 30), func(e *domain.RouteEvent) {
				id := "s-fresh"
				e.SessionID = &id
				usage := domain.RouteUsage{"input_tokens": "90", "output_tokens": nil}
				e.Usage = &usage
			}),
			activityRoute(activityAt(0, 10, 0, 0), func(e *domain.RouteEvent) {
				id := "s-old"
				e.SessionID = &id
				e.Usage = activityRouteUsage()
			}),
		}

		rows := SpoolRows("zai", events, activityNoon)

		got := make([][2]string, len(rows))
		for i, row := range rows {
			got[i] = [2]string{row.ID, row.State}
		}
		want := [][2]string{{"s-fresh", "active"}, {"s-old", "idle"}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("rows = %v, want %v", got, want)
		}
		// A missing row fails the check, not the run.
		if len(rows) < 1 || rows[0].InputTokens == nil || *rows[0].InputTokens != 90 {
			t.Errorf("inputTokens = %v, want 90 (a numeric string counts)", firstOrNil(rows).InputTokens)
		}
		if len(rows) < 1 || rows[0].OutputTokens == nil || *rows[0].OutputTokens != 0 {
			t.Errorf("outputTokens = %v, want 0 (null counts as nothing)", firstOrNil(rows).OutputTokens)
		}
	})
}

func TestJobRowsBoard(t *testing.T) {
	t.Run("jobs map to rows, a dead driver marking a mid-flight job stale", func(t *testing.T) {
		running := testkit.AJob(func(j *domain.Job) {
			j.ID = "261007-run001"
			j.State = domain.JobStateRunning
		})
		verifying := testkit.AJob(func(j *domain.Job) {
			j.ID = "261007-ver001"
			j.State = domain.JobStateVerifying
		})
		settled := testkit.AJob(func(j *domain.Job) {
			j.ID = "261007-rev001"
			j.State = domain.JobStateAwaitingReview
			pass := domain.VerdictPass
			j.Attempts = []domain.Attempt{testkit.AnAttempt(func(a *domain.Attempt) { a.Verdict = &pass })}
		})

		got := JobRows(testkit.ReferenceProvider, []BoardRow{
			{Job: running, Live: true},
			{Job: verifying, Live: false},
			{Job: settled, Live: false},
		})

		want := []ActivityRow{
			{
				Kind: ActivityKindJob, ID: "261007-run001", Model: strPtr("glm-5.3"),
				State: "running", Verdict: strPtr("no verdict"), Stale: strPtr(false),
				At: running.UpdatedAt, Title: strPtr("Rename the helper"),
			},
			{
				Kind: ActivityKindJob, ID: "261007-ver001", Model: strPtr("glm-5.3"),
				State: "verifying", Verdict: strPtr("no verdict"), Stale: strPtr(true),
				At: verifying.UpdatedAt, Title: strPtr("Rename the helper"),
			},
			{
				Kind: ActivityKindJob, ID: "261007-rev001", Model: strPtr("glm-5.3"),
				State: "awaiting_review", Verdict: strPtr("pass"), Stale: strPtr(false),
				At: settled.UpdatedAt, Title: strPtr("Rename the helper"),
			},
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("JobRows() = %+v, want %+v", got, want)
		}
	})
}

func TestOrderRows(t *testing.T) {
	t.Run("active rows first, then newest first — an active subagent outranks a newer idle session", func(t *testing.T) {
		rows := []ActivityRow{
			{Kind: ActivityKindSession, ID: "idle-new", State: "idle", At: activityAt(0, 10, 0, 0)},
			{Kind: ActivityKindSession, ID: "idle-old", State: "idle", At: activityAt(-1, 10, 0, 0)},
			{Kind: ActivityKindSubagent, ID: "active-b", State: "active", At: activityAt(0, 11, 20, 0)},
			{Kind: ActivityKindSubagent, ID: "active-a", State: "active", At: activityAt(0, 11, 30, 0)},
			{Kind: ActivityKindJob, ID: "queued", State: "queued", At: activityAt(0, 9, 0, 0)},
		}

		ordered := OrderRows(rows)

		got := make([]string, len(ordered))
		for i, row := range ordered {
			got[i] = row.ID
		}
		want := []string{"active-a", "active-b", "queued", "idle-new", "idle-old"}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("OrderRows() ids = %v, want %v", got, want)
		}
	})
}

func TestWindowStart(t *testing.T) {
	t.Run("windowStart is local midnight, today included", func(t *testing.T) {
		localMidnight := func(day int) int64 {
			return time.Date(2026, time.October, day, 0, 0, 0, 0, time.Local).UnixMilli()
		}
		if got := WindowStart(activityNoon, 1); got != localMidnight(7) {
			t.Errorf("WindowStart(noon, 1) = %d, want %d", got, localMidnight(7))
		}
		if got := WindowStart(activityNoon, 7); got != localMidnight(1) {
			t.Errorf("WindowStart(noon, 7) = %d, want %d", got, localMidnight(1))
		}
		september := time.Date(2026, time.September, 8, 0, 0, 0, 0, time.Local).UnixMilli()
		if got := WindowStart(activityNoon, 30); got != september {
			t.Errorf("WindowStart(noon, 30) = %d, want %d", got, september)
		}
	})
}

func TestModelUsageOf(t *testing.T) {
	t.Run("sums per model over the provider-bound requests only, in the window only", func(t *testing.T) {
		millionUsage := func(input, output float64) *domain.RouteUsage {
			usage := domain.RouteUsage{"input_tokens": input, "output_tokens": output}
			return &usage
		}
		events := []domain.SpoolEvent{
			activityRoute(activityAt(0, 8, 0, 0), func(e *domain.RouteEvent) {
				e.Model = "glm-5.3-flash"
				e.Usage = activityRouteUsage()
			}),
			activityRoute(activityAt(-2, 8, 0, 0), func(e *domain.RouteEvent) {
				e.Usage = millionUsage(1_000_000, 0)
			}),
			activityRoute(activityAt(-2, 8, 0, 0), func(e *domain.RouteEvent) {
				e.Usage = millionUsage(500_000, 250_000)
			}),
			activityRoute(activityAt(-2, 8, 0, 0), func(e *domain.RouteEvent) {
				e.Model = "claude-sonnet-5-5"
				e.Route = "anthropic"
				e.Usage = activityRouteUsage()
			}),
			activityRoute(activityAt(-2, 8, 0, 0), func(e *domain.RouteEvent) {
				e.Model = "kimi-k3"
				e.Route = "peer:kimi"
				e.Usage = activityRouteUsage()
			}),
			activityRoute(activityAt(-2, 8, 0, 0), func(e *domain.RouteEvent) {
				e.Plugin = "kimi"
				e.Usage = activityRouteUsage()
			}),
			activityRoute(activityAt(-40, 8, 0, 0), func(e *domain.RouteEvent) {
				e.Usage = activityRouteUsage()
			}),
		}

		week := ModelUsageOf("zai", events, WindowStart(activityNoon, 7))
		wantWeek := []ModelUsage{
			{
				Model: "glm-5.3", Requests: 2, InputTokens: 1_500_000, OutputTokens: 250_000,
				CacheReadTokens: 0, CacheWriteTokens: 0,
			},
			{
				Model: "glm-5.3-flash", Requests: 1, InputTokens: 100, OutputTokens: 10,
				CacheReadTokens: 5, CacheWriteTokens: 7,
			},
		}
		if !reflect.DeepEqual(week, wantWeek) {
			t.Errorf("ModelUsageOf(week) = %+v, want %+v", week, wantWeek)
		}
		today := ModelUsageOf("zai", events, WindowStart(activityNoon, 1))
		wantToday := []ModelUsage{{
			Model: "glm-5.3-flash", Requests: 1, InputTokens: 100, OutputTokens: 10,
			CacheReadTokens: 5, CacheWriteTokens: 7,
		}}
		if !reflect.DeepEqual(today, wantToday) {
			t.Errorf("ModelUsageOf(today) = %+v, want %+v", today, wantToday)
		}
	})
}

// Direct coverage of activity.go's own branches (the engine and health halves have their own
// files): the number shapes Go's `any` carries, the id cut in UTF-16 units, the timestamp that
// does not parse, and a job's summed attempt usages.

func TestTokenCountDirect(t *testing.T) {
	usage := domain.RouteUsage{
		"float":    float64(12),
		"int":      3,
		"int64":    int64(4),
		"string":   " 90 ",
		"null":     nil,
		"bool":     true,
		"words":    "not a number",
		"infinity": "Infinity",
		"jsonnum":  json.Number("7"),
		"nan":      math.NaN(),
		"inf":      math.Inf(1),
	}
	tests := []struct {
		key  string
		want int64
	}{
		{"float", 12},
		{"int", 3},
		{"int64", 4},
		{"string", 90},
		{"null", 0},
		{"bool", 0},
		{"words", 0},
		{"infinity", 0},
		{"jsonnum", 7},
		{"nan", 0},
		{"inf", 0},
		{"missing", 0},
	}
	for _, test := range tests {
		if got := TokenCount(&usage, test.key); got != test.want {
			t.Errorf("TokenCount(%q) = %d, want %d", test.key, got, test.want)
		}
	}
	if got := TokenCount(nil, "input_tokens"); got != 0 {
		t.Errorf("TokenCount(nil) = %d, want 0", got)
	}
}

func TestActivityShortIDDirect(t *testing.T) {
	// The cut counts UTF-16 code units, as JS slice does: the emoji is two units, so 8 units end
	// right after it, never inside its surrogate pair.
	if got := activityShortID("agent-😀-tail"); got != "agent-😀" {
		t.Errorf("activityShortID(emoji) = %q, want agent-😀", got)
	}
	if got := activityShortID("short"); got != "short" {
		t.Errorf("activityShortID(short) = %q, want it whole", got)
	}
}

func TestActivityParseTsDirect(t *testing.T) {
	if ts, ok := activityParseTs("2026-10-07T11:50:10.123Z"); !ok || ts != 1791373810123 {
		t.Errorf("activityParseTs(iso) = (%d, %v), want the epoch ms", ts, ok)
	}
	if _, ok := activityParseTs("not a timestamp"); ok {
		t.Error("activityParseTs(garbage) parsed, want not ok")
	}
	// A row whose at does not parse compares equal to everything, as NaN does: the board
	// keeps its source order instead of panicking.
	rows := []ActivityRow{
		{Kind: ActivityKindSession, ID: "first", State: "idle", At: "not a timestamp"},
		{Kind: ActivityKindSession, ID: "second", State: "idle", At: "also not one"},
	}
	if got := OrderRows(rows); !reflect.DeepEqual(got, rows) {
		t.Errorf("OrderRows(unparsable) = %+v, want the source order", got)
	}
}

func TestRoutesOfDirect(t *testing.T) {
	routed := activityRoute("2026-10-07T11:00:00.000Z")
	events := []domain.SpoolEvent{
		routed,
		domain.CaptureEvent{
			Ts: "2026-10-07T11:00:01.000Z", Event: domain.EventCapture, Plugin: "zai",
			PromptHash: "h", Gz: "data",
		},
		domain.HealthEvent("zai", domain.HealthFallback, "no worker was ready", "", 1),
		activityRoute("2026-10-07T11:00:02.000Z", func(e *domain.RouteEvent) { e.Plugin = "kimi" }),
	}

	got := RoutesOf("zai", events)

	if len(got) != 1 || got[0].Ts != routed.Ts {
		t.Errorf("RoutesOf() = %+v, want only this plugin's route event", got)
	}
}

func TestJobRowsSumUsagesDirect(t *testing.T) {
	job := testkit.AJob(func(j *domain.Job) {
		j.Attempts = []domain.Attempt{
			testkit.AnAttempt(func(a *domain.Attempt) {
				usage := domain.Usage{Turns: 2, InputTokens: 100, OutputTokens: 20}
				a.Usage = &usage
			}),
			testkit.AnAttempt(func(a *domain.Attempt) {}),
			testkit.AnAttempt(func(a *domain.Attempt) {
				usage := domain.Usage{Turns: 3, InputTokens: 50, OutputTokens: 10}
				a.Usage = &usage
			}),
		}
	})

	rows := JobRows(testkit.ReferenceProvider, []BoardRow{{Job: job}})

	if len(rows) != 1 {
		t.Fatalf("rows = %d, want one", len(rows))
	}
	row := rows[0]
	if row.Requests == nil || *row.Requests != 5 {
		t.Errorf("requests = %v, want the summed turns 5", row.Requests)
	}
	if row.InputTokens == nil || *row.InputTokens != 150 {
		t.Errorf("inputTokens = %v, want 150", row.InputTokens)
	}
	if row.OutputTokens == nil || *row.OutputTokens != 30 {
		t.Errorf("outputTokens = %v, want 30", row.OutputTokens)
	}
}
