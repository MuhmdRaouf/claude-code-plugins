package adapters

import (
	"os"
	"testing"
)

// The runtime line names no JS runtime: plugin-core is one static binary, so Runtime names the
// binary itself, its build-time version and its path.

func TestRuntime(t *testing.T) {
	t.Run("defaults to this process", func(t *testing.T) {
		self, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		want := "plugin-core dev (" + self + ")"
		if got := Runtime(); got != want {
			t.Fatalf("Runtime() = %q, want %q", got, want)
		}
	})
	t.Run("a version and path, or no parentheses without a path", func(t *testing.T) {
		if got := RuntimeLabel("0.1.0", "/bin/plugin-core"); got != "plugin-core 0.1.0 (/bin/plugin-core)" {
			t.Fatalf("RuntimeLabel(0.1.0) = %q", got)
		}
		if got := RuntimeLabel("0.1.0", ""); got != "plugin-core 0.1.0" {
			t.Fatalf("RuntimeLabel(0.1.0, \"\") = %q", got)
		}
	})
}
