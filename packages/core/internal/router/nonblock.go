// The budget gate's open: a FIFO must never block the reader.

package router

import (
	"os"
	"syscall"
)

// openNonBlock opens path read-only without ever blocking on what sits there: a FIFO with no writer
// opens at once, and the caller's check of the open handle rejects it before any read.
func openNonBlock(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
}
