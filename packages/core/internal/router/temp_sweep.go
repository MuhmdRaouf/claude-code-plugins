// The start's sweep of atomic-write temps. A crash between a temp's write and its rename leaves
// a file nothing completes: the write shape `<target>.tmp-<pid>-<rand>` (fsutil.WriteFileAtomic)
// and the create-exclusive shape `<target>.<rand>.tmp` (adapters.CreateExclusive). The start —
// alone under the router lock — drops the stale ones in the state root and the router dir; a
// fresh temp may belong to a writer still running, so it stays.
package router

import (
	"os"
	"path/filepath"
	"strings"
)

// tempStaleMs is how old an atomic-write temp may be before a start sweeps it: no atomic write
// stays unfinished this long, and a younger one may be a live writer's.
const tempStaleMs = 60_000

// isTempName is whether a file name is one of the two atomic-write temp shapes.
func isTempName(name string) bool {
	return strings.HasSuffix(name, ".tmp") || strings.Contains(name, ".tmp-")
}

// sweepStaleTemps removes dir's atomic-write temps older than tempStaleMs. A missing dir sweeps
// nothing and no failure here ever stops a start.
func sweepStaleTemps(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() || !isTempName(entry.Name()) {
			continue
		}
		info, err := entry.Info()
		if err != nil || nowMs()-info.ModTime().UnixMilli() <= tempStaleMs {
			continue
		}
		_ = os.Remove(filepath.Join(dir, entry.Name()))
	}
}
