package adapters

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
)

// contentDigest reports what a path holds right now, so that a second edit to an already-dirty
// file changes the fingerprint even though its porcelain status line does not.
func contentDigest(file string) string {
	info, err := os.Lstat(file)
	if err != nil {
		return "unreadable"
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		target, err := os.Readlink(file)
		if err != nil {
			return "unreadable"
		}
		return "link:" + target
	}
	data, err := os.ReadFile(file)
	if err != nil {
		return "unreadable"
	}
	sum := sha256.Sum256(data)
	return "file:" + nodeMode(info) + ":" + hex.EncodeToString(sum[:])
}

// nodeMode is lstat's mode in octal with the file-type bits above the permission bits, so a 0644
// regular file is "100644" — the digest's shape, which recorded fingerprints keep. Only a
// regular file's bits can ever reach the digest: a symlink takes the link branch above, and
// reading any other type fails, which folds the whole path into "unreadable".
func nodeMode(info fs.FileInfo) string {
	return strconv.FormatUint(0o100000|uint64(info.Mode().Perm()), 8)
}

// Fingerprint is the sha256 over the HEAD state, the porcelain status and the content of every
// path the status lists.
func Fingerprint(ctx context.Context, dir, head, status string, paths []string) string {
	hash := sha256.New()
	hash.Write([]byte(head))
	hash.Write([]byte{0, 0})
	hash.Write([]byte(status))
	digests := make([]string, len(paths))
	for i, path := range paths {
		digests[i] = contentDigest(filepath.Join(dir, path))
	}
	for i, path := range paths {
		hash.Write([]byte{0})
		hash.Write([]byte(path))
		hash.Write([]byte{0})
		hash.Write([]byte(digests[i]))
	}
	return hex.EncodeToString(hash.Sum(nil))
}
