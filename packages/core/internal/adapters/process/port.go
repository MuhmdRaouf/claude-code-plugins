// The process helpers the ensure hook's bundle imports; the bundle must stay tiny.
package process

import (
	"context"
	"net"
	"strconv"
	"time"
)

// PortAnswers reports whether something accepts a TCP connection on the loopback port within the budget.
func PortAnswers(ctx context.Context, port int, timeoutMs int64) bool {
	dialer := net.Dialer{Timeout: time.Duration(timeoutMs) * time.Millisecond}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return false
	}
	return conn.Close() == nil
}
