package fsutil

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// permOf returns a file's permission bits, the part of the mode the store reads and writes.
func permOf(t *testing.T, path string) fs.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return info.Mode().Perm()
}

// assertPerm checks the permission bits a path was created with.
func assertPerm(t *testing.T, path string, want fs.FileMode) {
	t.Helper()
	if mode := permOf(t, path); mode != want {
		t.Fatalf("mode %s = %o, want %o", path, mode, want)
	}
}

// noTempLeft fails when a write left its temp file behind.
func noTempLeft(t *testing.T, path string) {
	t.Helper()
	left, err := filepath.Glob(path + ".tmp-*")
	if err != nil {
		t.Fatalf("glob %s.tmp-*: %v", path, err)
	}
	if len(left) != 0 {
		t.Fatalf("temp files left behind: %v", left)
	}
}

func TestWriteFileAtomic(t *testing.T) {
	t.Run("creates a new private file and leaves no temp file", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "state.json")
		committed, err := WriteFileAtomic(t.Context(), path, []byte("{\"n\":1}\n"), WriteOptions{})
		if err != nil {
			t.Fatalf("writeFileAtomicSync error: %v", err)
		}
		if !committed {
			t.Fatal("writeFileAtomicSync = false, want true")
		}
		text, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		if string(text) != "{\"n\":1}\n" {
			t.Fatalf("content = %q, want %q", text, "{\"n\":1}\n")
		}
		assertPerm(t, path, 0o600)
		noTempLeft(t, path)
	})

	t.Run("replaces the target's content", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "state.json")
		if _, err := WriteFileAtomic(t.Context(), path, []byte("old"), WriteOptions{}); err != nil {
			t.Fatalf("first write: %v", err)
		}
		committed, err := WriteFileAtomic(t.Context(), path, []byte("new"), WriteOptions{})
		if err != nil || !committed {
			t.Fatalf("second write = (%v, %v), want (true, nil)", committed, err)
		}
		text, _ := os.ReadFile(path)
		if string(text) != "new" {
			t.Fatalf("content = %q, want %q", text, "new")
		}
		noTempLeft(t, path)
	})

	t.Run("keeps the target's own mode with Preserve", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "settings.json")
		if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
			t.Fatalf("seed %s: %v", path, err)
		}
		committed, err := WriteFileAtomic(t.Context(), path, []byte("new"), WriteOptions{Mode: Preserve})
		if err != nil || !committed {
			t.Fatalf("write = (%v, %v), want (true, nil)", committed, err)
		}
		assertPerm(t, path, 0o644)
		noTempLeft(t, path)
	})

	t.Run("falls back to 0600 with Preserve for a new file", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "state.json")
		if _, err := WriteFileAtomic(t.Context(), path, []byte("x"), WriteOptions{Mode: Preserve}); err != nil {
			t.Fatalf("write: %v", err)
		}
		assertPerm(t, path, 0o600)
	})

	t.Run("writes with an explicit Perm", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "state.json")
		if _, err := WriteFileAtomic(t.Context(), path, []byte("x"), WriteOptions{Mode: Perm(0o640)}); err != nil {
			t.Fatalf("write: %v", err)
		}
		assertPerm(t, path, 0o640)
	})

	t.Run("creates the parent directories with Mkdir", func(t *testing.T) {
		dir := t.TempDir()
		path := filepath.Join(dir, "one", "two", "state.json")
		committed, err := WriteFileAtomic(t.Context(), path, []byte("{}"), WriteOptions{Mkdir: true})
		if err != nil || !committed {
			t.Fatalf("write = (%v, %v), want (true, nil)", committed, err)
		}
		for _, created := range []string{filepath.Join(dir, "one"), filepath.Join(dir, "one", "two")} {
			assertPerm(t, created, 0o700)
		}
	})

	t.Run("reports the open error for a missing parent without Mkdir", func(t *testing.T) {
		dir := t.TempDir()
		committed, err := WriteFileAtomic(t.Context(), filepath.Join(dir, "missing", "state.json"), []byte("x"), WriteOptions{})
		if err == nil {
			t.Fatal("writeFileAtomicSync without mkdir succeeded for a missing parent, want an error")
		}
		if committed {
			t.Fatal("committed = true, want false")
		}
	})

	t.Run("reports the mkdir error when a parent path is a file", func(t *testing.T) {
		dir := t.TempDir()
		file := filepath.Join(dir, "a-file")
		if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
			t.Fatalf("seed %s: %v", file, err)
		}
		committed, err := WriteFileAtomic(t.Context(), filepath.Join(file, "sub", "state.json"), []byte("x"), WriteOptions{Mkdir: true})
		if err == nil {
			t.Fatal("writeFileAtomicSync with mkdir succeeded under a file parent, want an error")
		}
		if committed {
			t.Fatal("committed = true, want false")
		}
	})

	t.Run("reports false and leaves the target alone when CommitIf declines", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "settings.json")
		if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
			t.Fatalf("seed %s: %v", path, err)
		}
		committed, err := WriteFileAtomic(t.Context(), path, []byte("new"), WriteOptions{CommitIf: func() bool { return false }})
		if err != nil {
			t.Fatalf("commitIf decline reported an error: %v", err)
		}
		if committed {
			t.Fatal("writeFileAtomicSync = true, want false")
		}
		text, _ := os.ReadFile(path)
		if string(text) != "old" {
			t.Fatalf("content = %q, want the untouched %q", text, "old")
		}
		noTempLeft(t, path)
	})

	t.Run("commits when CommitIf approves", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "settings.json")
		if err := os.WriteFile(path, []byte("old"), 0o600); err != nil {
			t.Fatalf("seed %s: %v", path, err)
		}
		committed, err := WriteFileAtomic(t.Context(), path, []byte("new"), WriteOptions{CommitIf: func() bool { return true }})
		if err != nil || !committed {
			t.Fatalf("write = (%v, %v), want (true, nil)", committed, err)
		}
		text, _ := os.ReadFile(path)
		if string(text) != "new" {
			t.Fatalf("content = %q, want %q", text, "new")
		}
	})

	t.Run("removes the temp file and reports the rename error for a directory target", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "state.json")
		if err := os.Mkdir(path, 0o700); err != nil {
			t.Fatalf("mkdir %s: %v", path, err)
		}
		committed, err := WriteFileAtomic(t.Context(), path, []byte("x"), WriteOptions{})
		if err == nil {
			t.Skip("renaming over a directory succeeded on this platform")
		}
		if committed {
			t.Fatal("committed = true, want false")
		}
		noTempLeft(t, path)
		if info, err := os.Stat(path); err != nil || !info.IsDir() {
			t.Fatalf("target directory damaged by the failed write: (%v, %v)", info, err)
		}
	})
}

// storedShape mirrors the shape the callers decode into, as ReadJSONFile's target.
type storedShape struct {
	Pid  int64  `json:"pid"`
	Mode string `json:"mode"`
}

func TestReadJSONFile(t *testing.T) {
	write := func(t *testing.T, text string) string {
		t.Helper()
		path := filepath.Join(t.TempDir(), "state.json")
		if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
			t.Fatalf("seed %s: %v", path, err)
		}
		return path
	}

	t.Run("decodes a file that parses and matches", func(t *testing.T) {
		path := write(t, "{\"pid\":4242,\"mode\":\"router\"}\n")
		value, ok := ReadJSONFile[storedShape](t.Context(), path)
		if !ok {
			t.Fatal("readJsonFile = not ok, want ok")
		}
		if value.Pid != 4242 || value.Mode != "router" {
			t.Fatalf("readJsonFile = %+v, want {4242 router}", value)
		}
	})

	t.Run("ignores fields the shape does not know", func(t *testing.T) {
		path := write(t, "{\"pid\":7,\"mode\":\"router\",\"extra\":\"ignored\"}")
		value, ok := ReadJSONFile[storedShape](t.Context(), path)
		if !ok || value.Pid != 7 {
			t.Fatalf("readJsonFile = (%+v, %v), want the stripped {7 router}", value, ok)
		}
	})

	for _, text := range []string{"", "{ torn", "null", "\"just a string\""} {
		t.Run(fmt.Sprintf("is not ok for %q", text), func(t *testing.T) {
			_, ok := ReadJSONFile[storedShape](t.Context(), write(t, text))
			if ok {
				t.Fatalf("readJsonFile(%q) = ok, want undefined", text)
			}
		})
	}

	t.Run("is not ok for a value of the wrong shape", func(t *testing.T) {
		_, ok := ReadJSONFile[storedShape](t.Context(), write(t, "{\"pid\":\"one\",\"mode\":\"router\"}"))
		if ok {
			t.Fatal("readJsonFile of a mismatched shape = ok, want undefined")
		}
	})

	t.Run("is not ok for a missing file", func(t *testing.T) {
		_, ok := ReadJSONFile[storedShape](t.Context(), filepath.Join(t.TempDir(), "absent.json"))
		if ok {
			t.Fatal("ReadJSONFile of a missing file = ok, want not ok")
		}
	})
}

func TestMarshalJSON(t *testing.T) {
	t.Run("equals two-space-indented JSON plus a newline, unescaped", func(t *testing.T) {
		value := struct {
			Markup  string `json:"markup"`
			Unicode string `json:"unicode"`
			Nested  []any  `json:"nested"`
		}{
			Markup:  "<script>&</script>",
			Unicode: "héllo — 世界 \U0001f680",
			Nested:  []any{[]any{1, 2, 3}, map[string]any{"four": 4.5}},
		}
		got, err := MarshalJSON(value)
		if err != nil {
			t.Fatalf("marshalJSON error: %v", err)
		}
		want := "{\n" +
			"  \"markup\": \"<script>&</script>\",\n" +
			"  \"unicode\": \"héllo — 世界 \U0001f680\",\n" +
			"  \"nested\": [\n" +
			"    [\n" +
			"      1,\n" +
			"      2,\n" +
			"      3\n" +
			"    ],\n" +
			"    {\n" +
			"      \"four\": 4.5\n" +
			"    }\n" +
			"  ]\n" +
			"}\n"
		if string(got) != want {
			t.Fatalf("marshalJSON =\n%q\nwant\n%q", got, want)
		}
	})

	t.Run("reports a value that cannot be encoded", func(t *testing.T) {
		if _, err := MarshalJSON(struct{ C chan int }{}); err == nil {
			t.Fatal("marshalJSON of a chan field = nil error, want the encoding error")
		}
	})
}

func TestErrnoCode(t *testing.T) {
	t.Run("is empty for nil and for errors without an errno", func(t *testing.T) {
		if code := ErrnoCode(nil); code != "" {
			t.Fatalf("errnoCode(nil) = %q, want empty", code)
		}
		if code := ErrnoCode(errors.New("boom")); code != "" {
			t.Fatalf("errnoCode(new Error) = %q, want empty", code)
		}
	})

	t.Run("reads ENOENT off a real missing file", func(t *testing.T) {
		_, err := os.ReadFile(filepath.Join(t.TempDir(), "absent.json"))
		if err == nil {
			t.Fatal("readFile of a missing file succeeded")
		}
		if code := ErrnoCode(err); code != "ENOENT" {
			t.Fatalf("errnoCode = %q, want ENOENT", code)
		}
	})

	t.Run("reads EEXIST off a real exclusive create", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "lock")
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			t.Fatalf("first open: %v", err)
		}
		file.Close()
		if _, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600); err == nil {
			t.Fatal("second exclusive open succeeded")
		} else if code := ErrnoCode(err); code != "EEXIST" {
			t.Fatalf("errnoCode = %q, want EEXIST", code)
		}
	})

	t.Run("reads EACCES off a real unreadable file", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root bypasses permission bits")
		}
		path := filepath.Join(t.TempDir(), "private")
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatalf("seed %s: %v", path, err)
		}
		if err := os.Chmod(path, 0o000); err != nil {
			t.Fatalf("chmod %s: %v", path, err)
		}
		if _, err := os.ReadFile(path); err == nil {
			t.Fatal("readFile of a 0000 file succeeded")
		} else if code := ErrnoCode(err); code != "EACCES" {
			t.Fatalf("errnoCode = %q, want EACCES", code)
		}
	})

	t.Run("names every errno the messages print", func(t *testing.T) {
		for _, tc := range []struct {
			errno error
			want  string
		}{
			{syscall.ENOENT, "ENOENT"},
			{syscall.EEXIST, "EEXIST"},
			{syscall.EACCES, "EACCES"},
			{syscall.EPERM, "EPERM"},
			{syscall.EISDIR, "EISDIR"},
			{syscall.ENOTDIR, "ENOTDIR"},
			{syscall.ENOTEMPTY, "ENOTEMPTY"},
			{syscall.EMFILE, "EMFILE"},
			{syscall.ENFILE, "ENFILE"},
			{syscall.ENOSPC, "ENOSPC"},
			{syscall.EROFS, "EROFS"},
			{syscall.EBUSY, "EBUSY"},
			{syscall.ETXTBSY, "ETXTBSY"},
			{syscall.EXDEV, "EXDEV"},
			{syscall.ELOOP, "ELOOP"},
			{syscall.ENAMETOOLONG, "ENAMETOOLONG"},
		} {
			t.Run(tc.want, func(t *testing.T) {
				if code := ErrnoCode(tc.errno); code != tc.want {
					t.Fatalf("errnoCode(%s) = %q, want %s", tc.want, code, tc.want)
				}
			})
		}
	})

	t.Run("reads EISDIR off a real directory read as a file", func(t *testing.T) {
		_, err := os.ReadFile(t.TempDir())
		if err == nil {
			t.Fatal("readFile of a directory succeeded")
		}
		if code := ErrnoCode(err); code != "EISDIR" {
			t.Fatalf("errnoCode = %q, want EISDIR", code)
		}
	})

	t.Run("is empty for an errno the core does not discriminate", func(t *testing.T) {
		if code := ErrnoCode(syscall.EIO); code != "" {
			t.Fatalf("errnoCode(EIO) = %q, want empty", code)
		}
	})
}

func TestErrorMessage(t *testing.T) {
	t.Run("returns the error's message", func(t *testing.T) {
		if message := ErrorMessage(errors.New("disk on fire")); message != "disk on fire" {
			t.Fatalf("errorMessage = %q, want %q", message, "disk on fire")
		}
	})

	t.Run("is empty for nil", func(t *testing.T) {
		if message := ErrorMessage(nil); message != "" {
			t.Fatalf("errorMessage(nil) = %q, want empty", message)
		}
	})
}

func TestSyncDirectory(t *testing.T) {
	t.Run("ignores a directory it cannot open", func(t *testing.T) {
		syncDirectory(filepath.Join(t.TempDir(), "missing"))
	})
	t.Run("syncs an open directory without complaint", func(t *testing.T) {
		syncDirectory(t.TempDir())
	})
}

func TestNodeMessage(t *testing.T) {
	t.Run("one row per errno, as node's readFile prints it", func(t *testing.T) {
		// ENOENT, EACCES, EISDIR, ENOTDIR, ELOOP and ENAMETOOLONG were probed against node
		// 24.21.0's readFile; the rest are libuv's table, unreachable through a read.
		rows := []struct {
			errno syscall.Errno
			want  string
		}{
			{syscall.ENOENT, "ENOENT: no such file or directory"},
			{syscall.EACCES, "EACCES: permission denied"},
			{syscall.EPERM, "EPERM: operation not permitted"},
			{syscall.EEXIST, "EEXIST: file already exists"},
			{syscall.EISDIR, "EISDIR: illegal operation on a directory"},
			{syscall.ENOTDIR, "ENOTDIR: not a directory"},
			{syscall.ENOTEMPTY, "ENOTEMPTY: directory not empty"},
			{syscall.EMFILE, "EMFILE: too many open files"},
			{syscall.ENFILE, "ENFILE: file table overflow"},
			{syscall.ENOSPC, "ENOSPC: no space left on device"},
			{syscall.EROFS, "EROFS: read-only file system"},
			{syscall.EBUSY, "EBUSY: resource busy or locked"},
			{syscall.ETXTBSY, "ETXTBSY: text file is busy"},
			{syscall.EXDEV, "EXDEV: cross-device link not permitted"},
			{syscall.ELOOP, "ELOOP: too many symbolic links encountered"},
			{syscall.ENAMETOOLONG, "ENAMETOOLONG: name too long"},
		}
		for _, row := range rows {
			err := &fs.PathError{Op: "open", Path: "/x", Err: row.errno}
			if got := NodeMessage(err, "open", "/x"); got != row.want+", open '/x'" {
				t.Fatalf("NodeMessage(%v) = %q, want %q", row.errno, got, row.want+", open '/x'")
			}
		}
	})

	t.Run("a read failure names the syscall and no path", func(t *testing.T) {
		err := &fs.PathError{Op: "read", Path: "/x", Err: syscall.EISDIR}
		if got := NodeMessage(err, "read", ""); got != "EISDIR: illegal operation on a directory, read" {
			t.Fatalf("NodeMessage read form = %q", got)
		}
	})

	t.Run("an errno outside the table keeps Go's own text", func(t *testing.T) {
		err := &fs.PathError{Op: "open", Path: "/bad\x00", Err: syscall.EINVAL}
		if got := NodeMessage(err, "open", "/bad\x00"); got != err.Error() {
			t.Fatalf("NodeMessage fallback = %q, want %q", got, err.Error())
		}
		if got := NodeMessage(errors.New("disk on fire"), "open", "/x"); got != "disk on fire" {
			t.Fatalf("NodeMessage of a plain error = %q", got)
		}
	})
}
