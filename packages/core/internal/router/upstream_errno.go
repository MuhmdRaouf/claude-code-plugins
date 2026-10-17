// The errno tests failureCode makes: the kernel's own errno values, matched through the error
// chain.

package router

import (
	"errors"
	"syscall"
)

func resetErrno(err error) bool   { return errors.Is(err, syscall.ECONNRESET) }
func pipeErrno(err error) bool    { return errors.Is(err, syscall.EPIPE) }
func refusedErrno(err error) bool { return errors.Is(err, syscall.ECONNREFUSED) }
