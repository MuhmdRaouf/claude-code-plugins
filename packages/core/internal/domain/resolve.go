package domain

import (
	"path/filepath"
)

// ResolvePath is Node's path.resolve(cwd, path): a rooted path cleans as it stands, a relative
// one joins onto cwd.
func ResolvePath(cwd, path string) string {
	if path == "" {
		return filepath.Clean(cwd)
	}
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	return filepath.Join(cwd, path)
}
