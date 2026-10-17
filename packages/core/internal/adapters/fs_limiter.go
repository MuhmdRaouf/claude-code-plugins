package adapters

import (
	"context"
	"encoding/json"
	"os"
	"slices"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// <root>/limiter.json, read-modify-write under a lock file; applies the pure rules of
// domain/limiter.go.

// The lock is held only for one read-modify-write; waiting longer means its holder is stuck.
const limiterLockTimeoutMs = 10_000

// storedLimiter is limiter.json as written; the pointer fields tell a missing key (the zod
// schema's required ones) from a present null, and max and rateLimitedAt are optional: a state
// file without them keeps its cap.
type storedLimiter struct {
	Cap *int64 `json:"cap"`
	Max *int64 `json:"max"`
	// A value RawMessage, not a pointer: JSON null decodes a pointer to nil, which would read
	// a present null as a missing key.
	LastDecreaseAt json.RawMessage `json:"lastDecreaseAt"`
	QuietSince     *int64          `json:"quietSince"`
	RateLimitedAt  *[]int64        `json:"rateLimitedAt"`
}

type fsLimiter struct {
	root   string
	file   string
	config domain.LimiterConfig
}

// CreateFsLimiter is the shared AIMD state under <root>/limiter.json.
func CreateFsLimiter(root string, config domain.LimiterConfig) ports.LimiterStore {
	return &fsLimiter{root: root, file: domain.NewStateLayout(root).Limiter, config: config}
}

// read is the stored state; a missing or unreadable file starts over at full capacity, and a cap
// from an older or higher ceiling is clamped.
func (s *fsLimiter) read(ctx context.Context, now int64) domain.LimiterState {
	stored, ok := fsutil.ReadJSONFile[storedLimiter](ctx, s.file)
	if !ok || stored.Cap == nil || len(stored.LastDecreaseAt) == 0 || stored.QuietSince == nil {
		return domain.InitialLimiter(s.config, now)
	}
	lastDecreaseAt, ok := nullableNumber(stored.LastDecreaseAt)
	if !ok {
		return domain.InitialLimiter(s.config, now)
	}
	ceiling := s.config.DefaultMax
	if stored.Max != nil {
		ceiling = int(*stored.Max)
	}
	rateLimitedAt := []int64{}
	if stored.RateLimitedAt != nil {
		rateLimitedAt = *stored.RateLimitedAt
	}
	return domain.LimiterState{
		Cap:            min(ceiling, max(s.config.Min, int(*stored.Cap))),
		Max:            ceiling,
		LastDecreaseAt: lastDecreaseAt,
		QuietSince:     *stored.QuietSince,
		RateLimitedAt:  rateLimitedAt,
	}
}

// nullableNumber reads lastDecreaseAt: present-null stays nil, a number is its value, and
// anything else makes the state file unreadable.
func nullableNumber(raw json.RawMessage) (*int64, bool) {
	var value *int64
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, false
	}
	return value, true
}

// update applies step under the lock and persists a changed state. Without the lock (a stuck
// holder) the shared state is left alone and the caller sees the step applied to what was read.
func (s *fsLimiter) update(ctx context.Context, now int64, step func(domain.LimiterState) domain.LimiterState) (domain.LimiterState, error) {
	if err := os.MkdirAll(s.root, 0o755); err != nil {
		return domain.LimiterState{}, err
	}
	lock, lockErr := WaitLock(ctx, s.file+".lock", int64(os.Getpid()), process.IsAlive, limiterLockTimeoutMs)
	if lockErr == nil {
		defer func() { _ = lock(ctx) }()
	}
	before := s.read(ctx, now)
	after := step(before)
	if lockErr == nil && !sameState(before, after) {
		data, err := json.Marshal(after)
		if err != nil {
			return after, err
		}
		if _, err := fsutil.WriteFileAtomic(ctx, s.file, append(data, '\n'), fsutil.WriteOptions{}); err != nil {
			return after, err
		}
	}
	return after, nil
}

func (s *fsLimiter) Capacity(ctx context.Context, now int64) int {
	// The port's capacity cannot carry the persist error, so the ticked cap is returned either
	// way; the next write persists what it can.
	state, _ := s.update(ctx, now, func(state domain.LimiterState) domain.LimiterState {
		return domain.Tick(state, s.config, now)
	})
	return state.Cap
}

func (s *fsLimiter) Limit(ctx context.Context, now int64) ports.LimiterLevels {
	state := s.read(ctx, now)
	return ports.LimiterLevels{Cap: state.Cap, Max: state.Max}
}

func (s *fsLimiter) RateLimited(ctx context.Context, now int64, options ports.RateLimitOptions) error {
	_, err := s.update(ctx, now, func(state domain.LimiterState) domain.LimiterState {
		return domain.OnRateLimited(state, s.config, now, options.EndedAttempt)
	})
	return err
}

func (s *fsLimiter) SaveMax(ctx context.Context, ceiling int, now int64) error {
	_, err := s.update(ctx, now, func(state domain.LimiterState) domain.LimiterState {
		return domain.WithMax(state, max(s.config.Min, ceiling))
	})
	return err
}

func sameState(a, b domain.LimiterState) bool {
	return a.Cap == b.Cap && a.Max == b.Max &&
		equalNullable(a.LastDecreaseAt, b.LastDecreaseAt) &&
		a.QuietSince == b.QuietSince &&
		slices.Equal(a.RateLimitedAt, b.RateLimitedAt)
}

func equalNullable(a, b *int64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
