// Radar's budgets on a provider route through the router: a stopped scope answers the provider's
// models with the refusal's non-retryable 400 and never touches claude-*. The gate's own cases
// are budget_gate_test.go's.
package router

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// budgetKey is the key the rig reads; its name must never reach a spool event.
const budgetKey = "sk-budget-test-key"

// budgetBox is the rig's shared mutable state: the stop in force and how often the key was read.
type budgetBox struct {
	mu       sync.Mutex
	stop     domain.BudgetStop
	stopped  bool
	keyReads int
}

func (b *budgetBox) setStop(stop domain.BudgetStop) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.stop, b.stopped = stop, true
}

func (b *budgetBox) lift() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.stop, b.stopped = domain.BudgetStop{}, false
}

func (b *budgetBox) reads() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.keyReads
}

// budgetRig is the budget suite's rig: a router over two answering upstreams, its budget and key
// behind the box.
type budgetRig struct {
	provider  *answeringState
	anthropic *answeringState
	events    *eventLog
	box       *budgetBox
	port      int
}

// newBudgetRig builds the rig; a nil key answers none.
func newBudgetRig(t *testing.T, key *string) *budgetRig {
	t.Helper()
	provider, providerURL := answeringUpstream(t)
	anthropic, anthropicURL := answeringUpstream(t)
	events := &eventLog{}
	box := &budgetBox{}
	port := reservePort(t)
	server := CreateRouter(RouterOptions{
		Provider:    routerProvider,
		Port:        port,
		Anthropic:   anthropicURL,
		ProviderURL: providerURL,
		Key: func(context.Context) (string, error) {
			box.mu.Lock()
			box.keyReads++
			box.mu.Unlock()
			if key == nil {
				return "", nil
			}
			return *key, nil
		},
		Log:    func(string) {},
		Events: events.record,
		Budget: func() (domain.BudgetStop, bool) {
			box.mu.Lock()
			defer box.mu.Unlock()
			return box.stop, box.stopped
		},
	})
	serveRouter(t, server, port)
	return &budgetRig{provider: provider, anthropic: anthropic, events: events, box: box, port: port}
}

// post sends a request whose messages carry the rig's secret prompt text.
func (r *budgetRig) post(t *testing.T, model string) (int, string, string) {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"model":    model,
		"messages": []any{map[string]any{"role": "user", "content": "secret prompt text"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := postRawBody(r.port, "/v1/messages", string(body), map[string]string{"Content-Type": "application/json"})
	if err != nil {
		t.Fatal(err)
	}
	return got.status, got.header.Get("X-Should-Retry"), got.body
}

func TestStoppedBudgetOnRouter(t *testing.T) {
	t.Parallel()
	t.Run("answers the provider's models with a non-retryable 400 naming the dashboard, before reading the key", func(t *testing.T) {
		month := domain.BudgetMonth
		r := newBudgetRig(t, strPtrLocal(budgetKey))
		r.box.setStop(domain.BudgetStop{Scope: "provider:zai", Period: &month})
		code, retry, body := r.post(t, "glm-5.3")
		if code != 400 {
			t.Fatalf("status = %d, want 400", code)
		}
		if retry != "false" {
			t.Errorf("x-should-retry = %q", retry)
		}
		want := `{"type":"error","error":{"type":"invalid_request_error","message":` +
			`"Z.ai GLM budget reached for this month: raise or lift it in the Radar dashboard (/radar:open)"}}`
		if body != want {
			t.Errorf("body = %s", body)
		}
		if r.provider.count() != 0 {
			t.Error("the provider saw a stopped request")
		}
		if r.box.reads() != 0 {
			t.Error("the key was read for a stopped request")
		}
	})

	t.Run("never touches claude-*: a stopped total still sends Anthropic's models through", func(t *testing.T) {
		r := newBudgetRig(t, strPtrLocal(budgetKey))
		r.box.setStop(domain.BudgetStop{Scope: "total"})
		code, retry, body := r.post(t, "claude-sonnet-5-5")
		if code != 200 || retry != "" || body != `{"ok":true}` {
			t.Fatalf("answer = %d %q %q", code, retry, body)
		}
		if r.anthropic.count() != 1 {
			t.Errorf("Anthropic saw %d requests", r.anthropic.count())
		}
		if healths := r.events.healths(); len(healths) != 0 {
			t.Errorf("health events = %+v", healths)
		}
	})

	t.Run("records one budget_stop when a scope turns the models off, a refusal per request, and again after a lift", func(t *testing.T) {
		day, week := domain.BudgetDay, domain.BudgetWeek
		r := newBudgetRig(t, strPtrLocal(budgetKey))
		r.box.setStop(domain.BudgetStop{Scope: "provider:zai", Period: &day})
		_, _, _ = r.post(t, "glm-5.3")
		_, _, _ = r.post(t, "glm-5.3-flash")
		r.box.lift()
		if code, _, _ := r.post(t, "glm-5.3"); code != 200 {
			t.Fatalf("a lifted budget still answers %d", code)
		}
		r.box.setStop(domain.BudgetStop{Scope: "total", Period: &week})
		_, _, _ = r.post(t, "glm-5.3")
		type note struct {
			event  domain.RouterHealth
			reason string
			model  string
		}
		var seen []note
		for _, health := range r.events.healths() {
			seen = append(seen, note{health.Event, health.Reason, deref(health.Model)})
		}
		want := []note{
			{domain.HealthBudgetStop, "provider:zai budget reached for this day", "glm-5.3"},
			{domain.HealthRefusal, "budget: provider:zai", "glm-5.3"},
			{domain.HealthRefusal, "budget: provider:zai", "glm-5.3-flash"},
			{domain.HealthBudgetStop, "total budget reached for this week", "glm-5.3"},
			{domain.HealthRefusal, "budget: total", "glm-5.3"},
		}
		if len(seen) != len(want) {
			t.Fatalf("health events = %+v", seen)
		}
		for i := range want {
			if seen[i] != want[i] {
				t.Errorf("event %d = %+v, want %+v", i, seen[i], want[i])
			}
		}
	})
}

// deref reads a optional string pointer ("" for nil).
func deref(text *string) string {
	if text == nil {
		return ""
	}
	return *text
}

func TestRouterHealthEvents(t *testing.T) {
	t.Parallel()
	t.Run("records a refused key, an empty balance, a plain rate limit and a missing key; never the key or a body", func(t *testing.T) {
		r := newBudgetRig(t, strPtrLocal(budgetKey))
		r.provider.set(401, fmt.Sprintf(`{"error":{"message":"bad key %s"}}`, budgetKey))
		_, _, _ = r.post(t, "glm-5.3")
		r.provider.set(429, fmt.Sprintf(`{"error":{"code":"1113","message":"Insufficient balance %s"}}`, budgetKey))
		_, _, _ = r.post(t, "glm-5.3")
		r.provider.set(429, fmt.Sprintf(`{"error":{"code":"1302","message":"rate limit %s"}}`, budgetKey))
		_, _, _ = r.post(t, "glm-5.3-flash")
		r.provider.set(500, `{"ok":true}`)
		_, _, _ = r.post(t, "glm-5.3")
		none := newBudgetRig(t, nil)
		_, _, _ = none.post(t, "glm-5.3")

		seen := append(append([]domain.RouterHealthEvent(nil), r.events.healths()...), none.events.healths()...)
		type note struct {
			event  domain.RouterHealth
			reason string
			model  string
		}
		var got []note
		for _, health := range seen {
			got = append(got, note{health.Event, health.Reason, deref(health.Model)})
		}
		want := []note{
			{domain.HealthRefusal, "key: HTTP 401", "glm-5.3"},
			{domain.HealthRefusal, "balance: HTTP 429", "glm-5.3"},
			{domain.HealthRateLimited, "HTTP 429", "glm-5.3-flash"},
			{domain.HealthRefusal, "key: no key is set", "glm-5.3"},
		}
		if len(got) != len(want) {
			t.Fatalf("health events = %+v", got)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("event %d = %+v, want %+v", i, got[i], want[i])
			}
		}
		for _, health := range seen {
			var fields map[string]any
			if err := json.Unmarshal(mustJSON(t, health), &fields); err != nil {
				t.Fatal(err)
			}
			if len(fields) != 6 {
				t.Errorf("event fields = %v", fields)
			}
			if health.Kind != domain.HealthEventKind || health.Plugin != "zai" {
				t.Errorf("event = %+v", health)
			}
			if delta := time.Now().UnixMilli() - health.Ts; delta < 0 || delta > 60_000 {
				t.Errorf("ts = %d", health.Ts)
			}
		}
		text := string(mustJSON(t, append(append([]domain.SpoolEvent(nil), r.events.all()...), none.events.all()...)))
		if strings.Contains(text, budgetKey) || strings.Contains(text, "secret prompt text") || strings.Contains(text, "Insufficient") {
			t.Error("the spool carries a key or a body")
		}
	})

	t.Run("writes nothing for claude-* errors: Anthropic's 429 is not this router's rate limit", func(t *testing.T) {
		r := newBudgetRig(t, strPtrLocal(budgetKey))
		r.anthropic.set(429, `{"error":{"code":"1113","message":"Insufficient balance"}}`)
		code, _, _ := r.post(t, "claude-haiku-4-5")
		if code != 429 {
			t.Fatalf("status = %d, want 429", code)
		}
		if healths := r.events.healths(); len(healths) != 0 {
			t.Errorf("health events = %+v", healths)
		}
	})
}
