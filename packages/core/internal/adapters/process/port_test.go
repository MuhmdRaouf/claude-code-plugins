package process

import (
	"context"
	"net"
	"testing"
	"time"
)

func TestPortAnswers(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()
	if !PortAnswers(context.Background(), port, 1_000) {
		t.Fatal("portAnswers = false for an open port, want true")
	}
	listener.Close()
	time.Sleep(10 * time.Millisecond)
	if PortAnswers(context.Background(), port, 1_000) {
		t.Fatal("portAnswers = true for a closed port, want false")
	}
}
