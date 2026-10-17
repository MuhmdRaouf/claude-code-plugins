package adapters

import (
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
)

// retryable reports whether retryBusy waits err out: EBUSY only. An access denied is a real
// permission error, so it never waits.
func retryable(err error) bool {
	return fsutil.ErrnoCode(err) == "EBUSY"
}
