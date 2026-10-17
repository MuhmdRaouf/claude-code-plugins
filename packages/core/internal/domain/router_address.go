package domain

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// RouterPort is the port the router takes: `${envPrefix}_ROUTER_PORT`, else the provider's
// router port. The override parses the way JS Number does, and Number(x) || port drops NaN and
// 0 on the floor.
func RouterPort(provider Provider, env EnvLookup) int {
	return jsNumberOr(env[RouterEnvName(provider, RouterEnvKnobPort)], provider.Router.Port)
}

// RouterBaseURL is the router's base URL, the one ANTHROPIC_BASE_URL must point at.
func RouterBaseURL(provider Provider, env EnvLookup) string {
	return fmt.Sprintf("http://127.0.0.1:%d", RouterPort(provider, env))
}

// jsNumberOr is `Number(text) || fallback`: whitespace is trimmed, an unparsable value is NaN
// and falls back, and so does 0. Values no int can hold (a fractional, negative-safe JS number
// stays itself, but no int represents Infinity) fall back too.
func jsNumberOr(text string, fallback int) int {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return fallback
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value == 0 || value < math.MinInt64 || value > math.MaxInt64 {
		return fallback
	}
	return int(value)
}
