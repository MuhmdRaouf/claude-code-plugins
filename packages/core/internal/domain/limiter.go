package domain

import (
	"math"
	"strconv"
	"strings"
)

// AIMD concurrency limiting, as pure functions of an epoch-ms `now` (persisted by the limiter
// store).

// LimiterConfig configures the adaptive concurrency limiter.
type LimiterConfig struct {
	Min int
	// The ceiling when nothing has persisted one (see MaxFromEnv: `${PREFIX}_MAX_CONCURRENCY`).
	DefaultMax      int
	DecreaseFactor  float64
	WindowMs        int64
	CooldownMs      int64
	IncreaseAfterMs int64
}

// LimiterState is the adaptive concurrency limiter's shared state.
type LimiterState struct {
	Cap int `json:"cap"`
	// The ceiling this state grows back towards (written by run/batch from the environment).
	Max            int    `json:"max"`
	LastDecreaseAt *int64 `json:"lastDecreaseAt"`
	QuietSince     int64  `json:"quietSince"`
	// Recent rate-limit events (ms), oldest first; only the last windowMs are kept.
	RateLimitedAt []int64 `json:"rateLimitedAt"`
}

// eventsToLower: rate limits from any 3 attempts within one window — or one that ended an
// attempt — are pressure.
const eventsToLower = 3

// DEFAULT_LIMITER is the config every provider runs with.
var DEFAULT_LIMITER = LimiterConfig{
	Min:             1,
	DefaultMax:      16,
	DecreaseFactor:  0.75,
	WindowMs:        60_000,
	CooldownMs:      60_000,
	IncreaseAfterMs: 60_000,
}

// InitialLimiter starts at the ceiling with no decrease and quietSince = now. The optional max
// overrides the config's default ceiling.
func InitialLimiter(config LimiterConfig, now int64, max ...int) LimiterState {
	ceiling := config.DefaultMax
	if len(max) > 0 {
		ceiling = max[0]
	}
	return LimiterState{Cap: ceiling, Max: ceiling, LastDecreaseAt: nil, QuietSince: now, RateLimitedAt: []int64{}}
}

// WithMax applies a new ceiling, which keeps the current cap unless it sits above it.
func WithMax(state LimiterState, max int) LimiterState {
	state.Max = max
	state.Cap = min(state.Cap, max)
	return state
}

// MaxFromEnv reads `${PREFIX}_MAX_CONCURRENCY`: a positive integer, else the config's default
// ceiling. An unset variable reads as the empty string.
func MaxFromEnv(value string, config LimiterConfig) int {
	// Parsed as a float and trimmed, as JS Number() does; bounded by the JS safe-integer limit so
	// the conversion to int stays defined.
	number, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
	if err != nil || math.IsNaN(number) {
		return config.DefaultMax
	}
	if number != math.Trunc(number) || number < float64(config.Min) || number > jsMaxSafeInteger {
		return config.DefaultMax
	}
	return int(number)
}

// OnRateLimited records a rate limit at now, lowering the cap when the pressure rules and the
// cooldown allow. The optional endedAttempt records that the attempt already ended (default false).
func OnRateLimited(state LimiterState, config LimiterConfig, now int64, endedAttempt ...bool) LimiterState {
	ended := len(endedAttempt) > 0 && endedAttempt[0]
	rateLimitedAt := make([]int64, 0, len(state.RateLimitedAt)+1)
	for _, at := range state.RateLimitedAt {
		if now-at < config.WindowMs {
			rateLimitedAt = append(rateLimitedAt, at)
		}
	}
	rateLimitedAt = append(rateLimitedAt, now)
	base := state
	base.RateLimitedAt = rateLimitedAt
	base.QuietSince = now
	cooled := state.LastDecreaseAt == nil || now-*state.LastDecreaseAt >= config.CooldownMs
	if !(ended || len(rateLimitedAt) >= eventsToLower) || !cooled {
		return base
	}
	base.Cap = max(config.Min, int(math.Floor(float64(state.Cap)*config.DecreaseFactor)))
	decreasedAt := now
	base.LastDecreaseAt = &decreasedAt
	return base
}

// Tick grows the cap by one after increaseAfterMs of quiet.
func Tick(state LimiterState, config LimiterConfig, now int64) LimiterState {
	if state.Cap >= state.Max || now-state.QuietSince < config.IncreaseAfterMs {
		return state
	}
	state.Cap = state.Cap + 1
	state.QuietSince = now
	return state
}
