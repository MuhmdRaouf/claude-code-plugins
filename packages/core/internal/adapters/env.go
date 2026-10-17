// Package adapters does the engine's I/O — state roots and their migration, lock files, the
// environment a worker starts from. Decisions stay in domain and app; adapters only move
// bytes.
package adapters

import "github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"

// The environment workers and gates start from: a few basics from the parent, never its
// credentials.

// ENV_ALLOWLIST lists the variables copied from the parent environment. Gates (shell-gates) build
// their env from the same list, which must stay free of CLAUDE_* names; a worker that wants the
// orchestrator's CLAUDE* settings copies them itself (the claude worker's pickClaudeSettings).
// Everything else (the orchestrator's ANTHROPIC_*, plugin variables, tokens) is dropped.
var ENV_ALLOWLIST = []string{
	"PATH",
	"HOME",
	"LANG",
	"LC_ALL",
	"TERM",
	"SHELL",
	"TMPDIR",
	"USER",
	"LOGNAME",
}

// PickAllowlisted returns the ENV_ALLOWLIST names parent sets. A present empty value stands; a
// missing name is not added.
func PickAllowlisted(parent domain.EnvLookup) map[string]string {
	env := make(map[string]string)
	for _, name := range ENV_ALLOWLIST {
		if value, ok := parent[name]; ok {
			env[name] = value
		}
	}
	return env
}

// WithoutReserved returns passEnv without the names a worker reserves for its own routing and
// credentials. Brief `env` names are orchestrator-written, so a typo must not be able to send
// credentials elsewhere or re-route the worker.
func WithoutReserved(passEnv map[string]string, reserved func(name string) bool) map[string]string {
	env := make(map[string]string, len(passEnv))
	for name, value := range passEnv {
		if !reserved(name) {
			env[name] = value
		}
	}
	return env
}
