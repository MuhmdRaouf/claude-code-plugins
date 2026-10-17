package domain

import (
	"math"
	"reflect"
	"sort"
	"testing"
)

var limiterCONFIG = LimiterConfig{
	Min:             1,
	DefaultMax:      16,
	DecreaseFactor:  0.75,
	WindowMs:        60_000,
	CooldownMs:      60_000,
	IncreaseAfterMs: 60_000,
}

const limiterT0 int64 = 1_700_000_000_000

// limiterSeededRandom is mulberry32: a tiny seeded PRNG so property runs are reproducible from the
// seed in the failure message.
func limiterSeededRandom(seed uint32) func() float64 {
	state := seed
	return func() float64 {
		state += 0x6d2b79f5
		t := state
		t = (t ^ (t >> 15)) * (t | 1)
		t ^= t + (t^(t>>7))*(t|61)
		return float64(t^(t>>14)) / 4_296_729_296
	}
}

func limiterIntBetween(random func() float64, low, high int64) int64 {
	return low + int64(math.Floor(random()*float64(high-low+1)))
}

func limiterRandomConfig(random func() float64) LimiterConfig {
	minimum := int(limiterIntBetween(random, 1, 3))
	return LimiterConfig{
		Min:            minimum,
		DefaultMax:     int(limiterIntBetween(random, int64(minimum), int64(minimum+15))),
		DecreaseFactor: 0.1 + 0.85*random(),
		WindowMs:       limiterIntBetween(random, 1_000, 300_000),
		// Longer than the one-second burst, as any sane cooldown is.
		CooldownMs:      limiterIntBetween(random, 1_000, 300_000),
		IncreaseAfterMs: limiterIntBetween(random, 1_000, 600_000),
	}
}

var limiterSeeds = func() []uint32 {
	seeds := make([]uint32, 300)
	for index := range seeds {
		seeds[index] = 0x5eed + uint32(index)
	}
	return seeds
}()

type limiterStep struct {
	state       LimiterState
	now         int64
	rateLimited bool
}

// limiterRandomWalk runs 200 random steps of rate limits and ticks, each with the state it left
// and the time it happened.
func limiterRandomWalk(random func() float64, config LimiterConfig, ceiling int) []limiterStep {
	steps := make([]limiterStep, 0, 200)
	now := limiterT0
	state := InitialLimiter(config, now, ceiling)
	for step := 0; step < 200; step++ {
		now += limiterIntBetween(random, 0, 2*config.IncreaseAfterMs)
		rateLimited := random() < 0.3
		if rateLimited {
			state = OnRateLimited(state, config, now, random() < 0.2)
		} else {
			state = Tick(state, config, now)
		}
		steps = append(steps, limiterStep{state: state, now: now, rateLimited: rateLimited})
	}
	return steps
}

// limiterAt is a cooled state (a decrease is allowed) with no remembered events.
func limiterAt(cap int, ceiling ...int) LimiterState {
	max := limiterCONFIG.DefaultMax
	if len(ceiling) > 0 {
		max = ceiling[0]
	}
	return LimiterState{
		Cap:            cap,
		Max:            max,
		LastDecreaseAt: nil,
		QuietSince:     limiterT0,
		RateLimitedAt:  []int64{},
	}
}

func TestLimiter(t *testing.T) {
	t.Run("initialLimiter starts at the ceiling with no decrease and quietSince = now", func(t *testing.T) {
		want := LimiterState{Cap: 16, Max: 16, LastDecreaseAt: nil, QuietSince: limiterT0, RateLimitedAt: []int64{}}
		if got := InitialLimiter(limiterCONFIG, limiterT0); !reflect.DeepEqual(got, want) {
			t.Fatalf("initialLimiter(CONFIG, T0) = %#v, want %#v", got, want)
		}
		if got := InitialLimiter(limiterCONFIG, limiterT0, 4).Cap; got != 4 {
			t.Fatalf("initialLimiter(CONFIG, T0, 4).cap = %d, want 4", got)
		}
	})

	t.Run("DEFAULT_LIMITER lowers by a quarter at most once a minute and grows after one quiet minute, ceiling 16", func(t *testing.T) {
		want := LimiterConfig{
			Min:             1,
			DefaultMax:      16,
			DecreaseFactor:  0.75,
			WindowMs:        60_000,
			CooldownMs:      60_000,
			IncreaseAfterMs: 60_000,
		}
		if !reflect.DeepEqual(DEFAULT_LIMITER, want) {
			t.Fatalf("DEFAULT_LIMITER = %#v, want %#v", DEFAULT_LIMITER, want)
		}
	})

	t.Run("maxFromEnv takes a positive integer, anything else the default ceiling", func(t *testing.T) {
		cases := []struct {
			value string
			want  int
		}{
			{"4", 4},
			{"1", 1},
			// An unset env variable reads as "" in Go.
			{"", 16},
			{"0", 16},
			{"-2", 16},
			{"2.5", 16},
			{"eight", 16},
		}
		for _, tc := range cases {
			if got := MaxFromEnv(tc.value, limiterCONFIG); got != tc.want {
				t.Fatalf("maxFromEnv(%q) = %d, want %d", tc.value, got, tc.want)
			}
		}
	})

	t.Run("withMax keeps the cap unless it is above the new ceiling", func(t *testing.T) {
		if got := WithMax(limiterAt(3, 8), 16); !reflect.DeepEqual(got, limiterAt(3, 16)) {
			t.Fatalf("withMax(at(3, 8), 16) = %#v, want at(3, 16)", got)
		}
		want := limiterAt(6, 16)
		want.Cap = 4
		want.Max = 4
		if got := WithMax(limiterAt(6, 16), 4); !reflect.DeepEqual(got, want) {
			t.Fatalf("withMax(at(6, 16), 4) = %#v, want %#v", got, want)
		}
	})

	t.Run("one or two rate limits in the window never lower the cap; the third does, by a quarter (floor), min 1", func(t *testing.T) {
		now := limiterT0 + 5_000
		one := OnRateLimited(limiterAt(8), limiterCONFIG, now)
		two := OnRateLimited(one, limiterCONFIG, now+1_000)

		wantOne := limiterAt(8)
		wantOne.QuietSince = now
		wantOne.RateLimitedAt = []int64{now}
		if !reflect.DeepEqual(one, wantOne) {
			t.Fatalf("first rate limit = %#v, want %#v", one, wantOne)
		}
		wantTwo := limiterAt(8)
		wantTwo.QuietSince = now + 1_000
		wantTwo.RateLimitedAt = []int64{now, now + 1_000}
		if !reflect.DeepEqual(two, wantTwo) {
			t.Fatalf("second rate limit = %#v, want %#v", two, wantTwo)
		}

		wantThird := limiterAt(8)
		wantThird.QuietSince = now + 2_000
		wantThird.RateLimitedAt = []int64{now, now + 1_000, now + 2_000}
		wantThird.Cap = 6
		decreasedAt := now + 2_000
		wantThird.LastDecreaseAt = &decreasedAt
		if got := OnRateLimited(two, limiterCONFIG, now+2_000); !reflect.DeepEqual(got, wantThird) {
			t.Fatalf("third rate limit = %#v, want %#v", got, wantThird)
		}

		pair := OnRateLimited(OnRateLimited(limiterAt(3), limiterCONFIG, now), limiterCONFIG, now+1_000)
		if got := OnRateLimited(pair, limiterCONFIG, now+2_000).Cap; got != 2 {
			t.Fatalf("a third of three lowered the cap to %d, want 2", got)
		}
		floored := OnRateLimited(
			OnRateLimited(OnRateLimited(limiterAt(1), limiterCONFIG, now), limiterCONFIG, now+1_000),
			limiterCONFIG,
			now+2_000,
		)
		if floored.Cap != 1 {
			t.Fatalf("the floor lifted the cap to %d, want 1", floored.Cap)
		}
	})

	t.Run("a rate limit that ended an attempt lowers the cap on its own, the first event included", func(t *testing.T) {
		now := limiterT0 + 5_000
		want := limiterAt(6)
		want.QuietSince = now
		want.RateLimitedAt = []int64{now}
		want.LastDecreaseAt = &now
		if got := OnRateLimited(limiterAt(8), limiterCONFIG, now, true); !reflect.DeepEqual(got, want) {
			t.Fatalf("a rate limit that ended an attempt = %#v, want %#v", got, want)
		}
	})

	t.Run("events older than the window no longer count toward the three", func(t *testing.T) {
		old := OnRateLimited(limiterAt(8), limiterCONFIG, limiterT0)
		older := OnRateLimited(old, limiterCONFIG, limiterT0+1_000)
		later := limiterT0 + limiterCONFIG.WindowMs + 2_000

		want := limiterAt(8)
		want.QuietSince = later
		want.RateLimitedAt = []int64{later}
		if got := OnRateLimited(older, limiterCONFIG, later); !reflect.DeepEqual(got, want) {
			t.Fatalf("a rate limit after the window = %#v, want %#v", got, want)
		}
	})

	t.Run("a second decrease needs both the quorum and a full cooldown since the last one", func(t *testing.T) {
		decreased := limiterAt(6)
		lastDecrease := limiterT0
		decreased.LastDecreaseAt = &lastDecrease
		decreased.QuietSince = limiterT0
		decreased.RateLimitedAt = []int64{limiterT0 - 2_000, limiterT0 - 1_000, limiterT0}
		justBefore := limiterT0 + limiterCONFIG.CooldownMs - 1
		atCooldown := limiterT0 + limiterCONFIG.CooldownMs

		stillCooling := OnRateLimited(decreased, limiterCONFIG, justBefore, true)
		// Only limiterT0 itself is still inside the 60 s window at justBefore.
		want := decreased
		want.QuietSince = justBefore
		want.RateLimitedAt = []int64{limiterT0, justBefore}
		if !reflect.DeepEqual(stillCooling, want) {
			t.Fatalf("a decrease inside the cooldown = %#v, want %#v", stillCooling, want)
		}
		if got := OnRateLimited(decreased, limiterCONFIG, atCooldown, true).Cap; got != 4 {
			t.Fatalf("a decrease at the cooldown boundary lowered the cap to %d, want 4", got)
		}
	})

	t.Run("tick increases by one after increaseAfterMs of quiet, then needs another full quiet period", func(t *testing.T) {
		lowered := limiterAt(4)
		lastDecrease := limiterT0
		lowered.LastDecreaseAt = &lastDecrease
		firstAt := limiterT0 + limiterCONFIG.IncreaseAfterMs

		once := Tick(lowered, limiterCONFIG, firstAt)
		tooSoon := Tick(once, limiterCONFIG, firstAt+limiterCONFIG.IncreaseAfterMs-1)
		twice := Tick(tooSoon, limiterCONFIG, firstAt+limiterCONFIG.IncreaseAfterMs)

		wantOnce := lowered
		wantOnce.Cap = 5
		wantOnce.QuietSince = firstAt
		if !reflect.DeepEqual(once, wantOnce) {
			t.Fatalf("tick after one quiet minute = %#v, want %#v", once, wantOnce)
		}
		if !reflect.DeepEqual(tooSoon, once) {
			t.Fatalf("tick before another full quiet period = %#v, want the state unchanged", tooSoon)
		}
		wantTwice := lowered
		wantTwice.Cap = 6
		wantTwice.QuietSince = firstAt + limiterCONFIG.IncreaseAfterMs
		if !reflect.DeepEqual(twice, wantTwice) {
			t.Fatalf("a second tick after another full quiet minute = %#v, want %#v", twice, wantTwice)
		}
	})

	t.Run("tick never exceeds the persisted ceiling and never changes the cap before the quiet period", func(t *testing.T) {
		full := InitialLimiter(limiterCONFIG, limiterT0)
		lowered := limiterAt(2)
		lastDecrease := limiterT0
		lowered.LastDecreaseAt = &lastDecrease

		if got := Tick(full, limiterCONFIG, limiterT0+10*limiterCONFIG.IncreaseAfterMs); !reflect.DeepEqual(got, full) {
			t.Fatalf("tick at the ceiling = %#v, want the state unchanged", got)
		}
		if got := Tick(limiterAt(3, 3), limiterCONFIG, limiterT0+10*limiterCONFIG.IncreaseAfterMs).Cap; got != 3 {
			t.Fatalf("tick past a lowered ceiling gave cap %d, want 3", got)
		}
		if got := Tick(lowered, limiterCONFIG, limiterT0); !reflect.DeepEqual(got, lowered) {
			t.Fatalf("tick at the decrease = %#v, want the state unchanged", got)
		}
		if got := Tick(lowered, limiterCONFIG, limiterT0+limiterCONFIG.IncreaseAfterMs-1); !reflect.DeepEqual(got, lowered) {
			t.Fatalf("tick one millisecond early = %#v, want the state unchanged", got)
		}
	})

	t.Run("a burst of 20 rate limits in one second costs exactly one decrease (property over random bursts)", func(t *testing.T) {
		for _, seed := range limiterSeeds {
			random := limiterSeededRandom(seed)
			config := limiterRandomConfig(random)
			start := limiterT0 + limiterIntBetween(random, 0, 10_000_000)
			ceiling := int(limiterIntBetween(random, int64(config.Min), int64(config.Min+15)))
			before := LimiterState{
				Cap: int(limiterIntBetween(random, int64(config.Min), int64(ceiling))),
				Max: ceiling,
				LastDecreaseAt: func() *int64 {
					if random() < 0.5 {
						return nil
					}
					at := start - config.CooldownMs - limiterIntBetween(random, 0, 1_000_000)
					return &at
				}(),
				QuietSince:    start - limiterIntBetween(random, 0, 1_000_000),
				RateLimitedAt: []int64{},
			}
			burst := make([]int64, 20)
			for index := range burst {
				burst[index] = start + limiterIntBetween(random, 0, 999)
			}
			sort.Slice(burst, func(i, j int) bool { return burst[i] < burst[j] })

			after := before
			for _, now := range burst {
				after = OnRateLimited(after, config, now)
			}

			want := before
			want.Cap = max(config.Min, int(math.Floor(float64(before.Cap)*config.DecreaseFactor)))
			decreasedAt := burst[2]
			want.LastDecreaseAt = &decreasedAt
			want.QuietSince = burst[len(burst)-1]
			want.RateLimitedAt = burst
			if !reflect.DeepEqual(after, want) {
				t.Fatalf("seed %d: a one-second burst = %#v, want %#v", seed, after, want)
			}
		}
	})

	t.Run("the cap stays within [min, max] under any random interleaving of rate limits and ticks", func(t *testing.T) {
		for _, seed := range limiterSeeds {
			random := limiterSeededRandom(seed)
			config := limiterRandomConfig(random)
			ceiling := int(limiterIntBetween(random, int64(config.Min), int64(config.Min+15)))
			for step, s := range limiterRandomWalk(random, config, ceiling) {
				if s.state.Cap < config.Min || s.state.Cap > ceiling {
					t.Fatalf("seed %d step %d: cap %d outside [%d, %d]", seed, step, s.state.Cap, config.Min, ceiling)
				}
				// Pruning happens on the next event; only that step must leave a fully fresh window.
				if s.rateLimited {
					for _, at := range s.state.RateLimitedAt {
						if s.now-at >= config.WindowMs {
							t.Fatalf("seed %d: an event %d ms old survived a %d ms window", seed, s.now-at, config.WindowMs)
						}
					}
				}
			}
		}
	})

	t.Run("recovers from min to the ceiling in (ceiling - min) * increaseAfterMs of quiet", func(t *testing.T) {
		floored := limiterAt(limiterCONFIG.Min)
		lastDecrease := limiterT0
		floored.LastDecreaseAt = &lastDecrease
		recoveryMs := int64(limiterCONFIG.DefaultMax-limiterCONFIG.Min) * limiterCONFIG.IncreaseAfterMs
		everySecondUntil := func(end int64) LimiterState {
			state := floored
			for now := limiterT0; now <= end; now += 1_000 {
				state = Tick(state, limiterCONFIG, now)
			}
			return state
		}

		if got := everySecondUntil(limiterT0 + recoveryMs - 1_000).Cap; got != limiterCONFIG.DefaultMax-1 {
			t.Fatalf("one quiet second before full recovery the cap is %d, want %d", got, limiterCONFIG.DefaultMax-1)
		}
		if got := everySecondUntil(limiterT0 + recoveryMs).Cap; got != limiterCONFIG.DefaultMax {
			t.Fatalf("after (ceiling - min) * increaseAfterMs of quiet the cap is %d, want %d", got, limiterCONFIG.DefaultMax)
		}
	})
}
