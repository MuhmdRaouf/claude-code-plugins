package domain

import (
	"path/filepath"
	"testing"
)

// ResolvePath is Node's path.resolve(cwd, path), with the wants spelled through filepath.
func TestResolvePath(t *testing.T) {
	if got := ResolvePath("/work/repo", ""); got != filepath.Clean("/work/repo") {
		t.Errorf("empty path = %q, want the cleaned cwd", got)
	}
	if got := ResolvePath("/work/repo", "schemas/audit.json"); got != filepath.Join("/work/repo", "schemas/audit.json") {
		t.Errorf("relative = %q, want it joined", got)
	}
	if got := ResolvePath("/work/repo", "../sibling"); got != filepath.Join("/work/repo", "../sibling") {
		t.Errorf("dot-dot = %q, want it cleaned", got)
	}
	if got := ResolvePath("/work/repo", "./vendor/lib"); got != filepath.Join("/work/repo", "./vendor/lib") {
		t.Errorf("dot = %q, want it cleaned", got)
	}
	if got := ResolvePath("/work/repo", "/opt/shared"); got != "/opt/shared" {
		t.Errorf("rooted = %q, want it to stand as it is", got)
	}
}
