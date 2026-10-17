// Package fsutil is the one way a state file is written and the one way a JSON file is read,
// in a package of its own so process and keystore can use it without importing
// internal/adapters (which imports them).
package fsutil

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

const (
	// State files are private.
	privateFile fs.FileMode = 0o600
	privateDir  fs.FileMode = 0o700
)

// FileMode resolves the permission bits a write uses, taking the target's path: Perm(n) writes
// with n, Preserve keeps the target's own bits (0600 when it does not exist yet), and nil
// defaults to 0600: state files are private.
type FileMode func(path string) fs.FileMode

// Perm is an explicit permission bit set, e.g. fsutil.Perm(0o600).
func Perm(perm fs.FileMode) FileMode {
	return func(string) fs.FileMode { return perm }
}

// Preserve keeps the target file's own permission bits.
func Preserve(path string) fs.FileMode {
	if info, err := os.Stat(path); err == nil {
		return info.Mode().Perm()
	}
	return privateFile
}

// WriteOptions are the options of WriteFileAtomic; the zero value writes a private file in an
// existing directory.
type WriteOptions struct {
	// Mode is the file's permission bits.
	Mode FileMode
	// Mkdir creates the parent directory (0700) when it is missing.
	Mkdir bool
	// CommitIf is checked between the fsync and the rename: false leaves the target as it is
	// and the write reports false (a compare-and-swap for a file someone else may have changed
	// meanwhile).
	CommitIf func() bool
}

// WriteFileAtomic writes data to a temp file beside the target, fsyncs it and renames it over
// the target, then fsyncs the directory: a reader sees the old file or the new one, never a
// torn one, and a crash after the rename does not lose it. False only when CommitIf said no.
func WriteFileAtomic(ctx context.Context, path string, data []byte, options WriteOptions) (bool, error) {
	mode := resolveMode(path, options.Mode)
	if options.Mkdir {
		if err := os.MkdirAll(filepath.Dir(path), privateDir); err != nil {
			return false, err
		}
	}
	tmp := tempName(path)
	err := writeTemp(tmp, data, mode)
	if err == nil {
		// The umask may have narrowed the mode the file was created with.
		err = os.Chmod(tmp, mode)
	}
	if err == nil && options.CommitIf != nil && !options.CommitIf() {
		removeTemp(tmp)
		return false, nil
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		removeTemp(tmp)
		return false, err
	}
	syncDirectory(filepath.Dir(path))
	return true, nil
}

// ReadJSONFile returns the file's JSON decoded into T; ok is false when the file is missing,
// does not parse, or does not decode — one absent answer for all three. Decoding into T is the
// schema check.
func ReadJSONFile[T any](ctx context.Context, path string) (T, bool) {
	var zero T
	data, err := os.ReadFile(path)
	if err != nil {
		return zero, false
	}
	// A bare null parses, but no state file's shape is null: every schema read here is an
	// object.
	if bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return zero, false
	}
	var value T
	if err := json.Unmarshal(data, &value); err != nil {
		return zero, false
	}
	return value, true
}

// MarshalJSON encodes v the way state files are written: two-space-indented JSON plus a
// trailing newline, without HTML escaping — the format every state file keeps.
func MarshalJSON(v any) ([]byte, error) {
	return domain.MarshalIndentJSON(v)
}

// tempName is the temp file's name beside the target: per process and per write, so writers of
// the same path never share one.
func tempName(path string) string {
	return fmt.Sprintf("%s.tmp-%d-%s", path, os.Getpid(), rand.Text())
}

func resolveMode(path string, mode FileMode) fs.FileMode {
	if mode == nil {
		return privateFile
	}
	return mode(path)
}

// writeTemp writes data to a fresh temp file with the target's mode, fsyncs it and closes it.
func writeTemp(tmp string, data []byte, mode fs.FileMode) error {
	file, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err == nil {
		_, err = file.Write(data)
		if err == nil {
			err = file.Sync()
		}
		err = errors.Join(err, file.Close())
	}
	return err
}

// removeTemp drops a temp file best effort: the error that caused the drop outranks its failure.
func removeTemp(tmp string) {
	_ = os.Remove(tmp)
}

// syncDirectory persists the rename itself (the directory entry); best effort where directories
// cannot be fsynced.
func syncDirectory(dir string) {
	file, err := os.Open(dir)
	if err != nil {
		return
	}
	defer file.Close()
	// Not supported on this platform or filesystem: the rename is still atomic, just not yet
	// durable.
	_ = file.Sync()
}
