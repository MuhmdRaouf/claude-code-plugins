package cli

import (
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
)

// OrphanLaunch is the binary's `--orphan-launch <log> <command> [args...]` mode: the short-lived
// launcher SpawnOrphan re-runs this binary as (see process.OrphanLaunch). cmd dispatches it before
// the provider table because it is a plumbing mode, not a plugin entry.
func OrphanLaunch(argv []string) int {
	return process.OrphanLaunch(argv)
}
