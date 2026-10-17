package main

import (
	"os/signal"
	"syscall"
)

// ignoreSigpipe keeps a closed stdout from killing the process before the CLI can exit 0 quietly.
func ignoreSigpipe() {
	signal.Ignore(syscall.SIGPIPE)
}

// syscallEPIPE is the errno a closed pipe reports.
const syscallEPIPE = syscall.EPIPE
