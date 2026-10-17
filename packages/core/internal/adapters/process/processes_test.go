package process

import (
	"context"
	"os"
	"testing"
)

func TestProcessList(t *testing.T) {
	t.Run("reads this machine's processes with ps, this test's own among them", func(t *testing.T) {
		list, ok := ProcessList(context.Background(), nil)
		if !ok {
			t.Fatal("processList = unknown, want this machine's processes")
		}
		own := int64(os.Getpid())
		found := false
		for _, entry := range list {
			if entry.Pid == own {
				found = true
			}
		}
		if !found {
			t.Fatalf("own pid %d missing from %d entries", own, len(list))
		}
	})

	t.Run("is unknown when ps fails", func(t *testing.T) {
		missing := func(context.Context, string, []string, ToolOptions) ToolResult {
			return ToolResult{Kind: ToolMissing, Message: "no ps"}
		}
		if _, ok := ProcessList(context.Background(), missing); ok {
			t.Fatal("processList with a missing ps = known, want unknown")
		}
	})
}
