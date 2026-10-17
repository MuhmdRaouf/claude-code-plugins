package testkit

import (
	"os"
	"path/filepath"
	"testing"
)

// ModuleRoot is the core module's root; the recorded fixtures live under its testdata. It
// walks up from the test's working directory until go.mod.
func ModuleRoot(t testing.TB) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("module root: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("module root: no go.mod above %s", dir)
		}
		dir = parent
	}
}
