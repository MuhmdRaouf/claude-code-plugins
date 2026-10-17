package domain

import (
	"fmt"
	"testing"
)

func TestParsePid(t *testing.T) {
	t.Run("takes digits around whitespace", func(t *testing.T) {
		pid, ok := ParsePid("4242\n")
		if !ok || pid != 4242 {
			t.Fatalf("parsePid(\"4242\\n\") = (%d, %v), want 4242", pid, ok)
		}
		pid, ok = ParsePid("  17 ")
		if !ok || pid != 17 {
			t.Fatalf("parsePid(\"  17 \") = (%d, %v), want 17", pid, ok)
		}
	})

	for _, text := range []string{"", "0", "1", "-5", "+5", "1e3", "12abc", "3.5", "99999999999999999999"} {
		t.Run(fmt.Sprintf("refuses %q", text), func(t *testing.T) {
			if pid, ok := ParsePid(text); ok {
				t.Fatalf("parsePid(%q) = %d, want refused", text, pid)
			}
		})
	}
}
