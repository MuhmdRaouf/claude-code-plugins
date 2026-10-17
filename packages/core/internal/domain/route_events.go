// What a plugin's router writes to Radar's spool: one event per forwarded request, one per router start or
// stop, a health event when something went other than plainly, and one capture event per distinct prompt —
// the request's own system prompt and tool definitions, gzipped. A route event stays metadata (model, route,
// status, latency, usage, the three ids Claude Code sends, the hash its prompt capture sits under and the
// allow-listed response headers); no other header value and no message body ever lands here.
package domain

// RouteUsage is the usage counters an answer carries, as the provider or Anthropic reports them.
type RouteUsage map[string]any

// The `event` field each spool line carries.
const (
	EventRoute   = "route"
	EventCapture = "capture"
	EventRouter  = "router"
)

// RouteEvent is one forwarded request, appended after it completes.
type RouteEvent struct {
	Ts       string `json:"ts"`
	Event    string `json:"event"`
	Plugin   string `json:"plugin"`
	Model    string `json:"model"`
	Upstream string `json:"upstream"`
	Route    string `json:"route"`
	Status   int64  `json:"status"`

	// Error is why the upstream answered an error, when it did and the router read it (provider routes only): one
	// line, the provider's own `type: message` (or `code: msg`) or the first 300 characters of its text, credentials
	// redacted. Never a header value, a request byte, or a success answer's anything.
	Error     *string `json:"error,omitempty"`
	LatencyMs int64   `json:"latency_ms"`
	// SessionID, AgentID and ParentAgentID are the ids Claude Code sends with the request.
	SessionID     *string            `json:"session_id,omitempty"`
	AgentID       *string            `json:"agent_id,omitempty"`
	ParentAgentID *string            `json:"parent_agent_id,omitempty"`
	Usage         *RouteUsage        `json:"usage,omitempty"`
	Headers       *map[string]string `json:"headers,omitempty"`
	PromptHash    *string            `json:"prompt_hash,omitempty"`
}

// CaptureEvent is one distinct prompt's content, appended once per hash per router process: gzip of the JSON the
// request carried at its top level — its `system` and `tools` and nothing else — base64. Written off the request's
// turn of the event loop, so the answer never waits on it.
type CaptureEvent struct {
	Ts         string `json:"ts"`
	Event      string `json:"event"`
	Plugin     string `json:"plugin"`
	PromptHash string `json:"prompt_hash"`
	Gz         string `json:"gz"`
}

// RouterState is the state a router event reports: coming up, or shutting down cleanly.
type RouterState string

const (
	RouterStateStart RouterState = "start"
	RouterStateStop  RouterState = "stop"
)

// RouterEvent is a router coming up or shutting down cleanly.
type RouterEvent struct {
	Ts      string      `json:"ts"`
	Event   string      `json:"event"`
	Plugin  string      `json:"plugin"`
	Port    int64       `json:"port"`
	State   RouterState `json:"state"`
	Version int64       `json:"version"`
}

// RouterHealth is what a router's health event reports: a request the passthrough served instead of the router, a
// provider request the router refused (no key, a refused key, no balance, a stopped budget), a provider rate limit, a
// budget turning a route off, or a worker the front had to replace (and the router retiring: the last line a retired
// router writes).
type RouterHealth string

const (
	HealthFallback    RouterHealth = "fallback"
	HealthRefusal     RouterHealth = "refusal"
	HealthRateLimited RouterHealth = "rate_limited"
	HealthBudgetStop  RouterHealth = "budget_stop"
	HealthRestart     RouterHealth = "restart"
)

// RouterHealthEvents lists the health events a router reports.
var RouterHealthEvents = []RouterHealth{
	HealthFallback,
	HealthRefusal,
	HealthRateLimited,
	HealthBudgetStop,
	HealthRestart,
}

// HealthEventKind marks a router health line (Radar's `router.event`).
const HealthEventKind = "router.event"

// RouterHealthEvent is one router health event: what happened and why, the model the request named when there was
// one, epoch milliseconds. Never a key, a header value or a byte of any body.
type RouterHealthEvent struct {
	Kind   string       `json:"kind"`
	Plugin string       `json:"plugin"`
	Event  RouterHealth `json:"event"`
	Reason string       `json:"reason"`
	Model  *string      `json:"model"`
	Ts     int64        `json:"ts"`
}

// HealthEvent builds a health event, a model of "" (none named) recorded as null.
func HealthEvent(plugin string, event RouterHealth, reason string, model string, ts int64) RouterHealthEvent {
	health := RouterHealthEvent{
		Kind:   HealthEventKind,
		Plugin: plugin,
		Event:  event,
		Reason: reason,
		Ts:     ts,
	}
	if model != "" {
		health.Model = &model
	}
	return health
}

// SpoolEvent is any event a plugin's router appends to Radar's spool.
type SpoolEvent interface {
	spoolEvent()
}

func (RouteEvent) spoolEvent() {}

func (CaptureEvent) spoolEvent() {}

func (RouterEvent) spoolEvent() {}

func (RouterHealthEvent) spoolEvent() {}

// IsHealthEvent reports whether the event is a router health event; route and router events are told apart by their
// `event` field.
func IsHealthEvent(event SpoolEvent) bool {
	switch event.(type) {
	case RouterHealthEvent, *RouterHealthEvent:
		return true
	}
	return false
}
