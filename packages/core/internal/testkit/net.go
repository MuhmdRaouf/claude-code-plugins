package testkit

import (
	"net"
	"testing"
)

// Loopback ports for tests.

// FreePort returns a port nothing listens on: it listens on 127.0.0.1:0, takes the OS-chosen port
// and closes the listener again.
func FreePort(t testing.TB) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen on 127.0.0.1:0: %v", err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}
