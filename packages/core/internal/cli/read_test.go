package cli_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
)

// assertNodeMessage checks the full Node sentence.
func assertNodeMessage(t *testing.T, got string, want string) {
	t.Helper()
	if got != want {
		t.Fatalf("message = %q, want %q", got, want)
	}
}

func TestReadText(t *testing.T) {
	path := filepath.Join(t.TempDir(), "brief.md")
	if err := os.WriteFile(path, []byte("---\ntitle: T\n---\nDo it.\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	t.Run("reads a file's text", func(t *testing.T) {
		got, err := cli.ReadText(t.Context(), path)
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if got != "---\ntitle: T\n---\nDo it.\n" {
			t.Fatalf("got = %q", got)
		}
	})

	t.Run("a missing file is a brief_unreadable error with node's sentence", func(t *testing.T) {
		missing := filepath.Join(t.TempDir(), "nope.md")
		_, err := cli.ReadText(t.Context(), missing)
		var appErr *app.AppError
		if !errors.As(err, &appErr) {
			t.Fatalf("err = %v, want an AppError", err)
		}
		if appErr.Kind != app.AppErrorBriefUnreadable {
			t.Fatalf("kind = %q", appErr.Kind)
		}
		if appErr.Path != missing {
			t.Fatalf("path = %q, want %q", appErr.Path, missing)
		}
		assertNodeMessage(t, appErr.Message, "ENOENT: no such file or directory, open '"+missing+"'")
	})

	t.Run("an unreadable file says permission denied", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root reads through mode 000")
		}
		secret := filepath.Join(t.TempDir(), "secret.md")
		if err := os.WriteFile(secret, []byte("key"), 0o000); err != nil {
			t.Fatalf("write: %v", err)
		}
		_, err := cli.ReadText(t.Context(), secret)
		var appErr *app.AppError
		if !errors.As(err, &appErr) {
			t.Fatalf("err = %v, want an AppError", err)
		}
		assertNodeMessage(t, appErr.Message, "EACCES: permission denied, open '"+secret+"'")
	})

	t.Run("a directory is a read failure that names no path", func(t *testing.T) {
		dir := t.TempDir()
		_, err := cli.ReadText(t.Context(), dir)
		var appErr *app.AppError
		if !errors.As(err, &appErr) {
			t.Fatalf("err = %v, want an AppError", err)
		}
		assertNodeMessage(t, appErr.Message, "EISDIR: illegal operation on a directory, read")
	})

	t.Run("a path under a regular file is not a directory", func(t *testing.T) {
		dir := t.TempDir()
		regular := filepath.Join(dir, "file.md")
		if err := os.WriteFile(regular, []byte("x"), 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
		under := filepath.Join(regular, "child.md")
		_, err := cli.ReadText(t.Context(), under)
		var appErr *app.AppError
		if !errors.As(err, &appErr) {
			t.Fatalf("err = %v, want an AppError", err)
		}
		assertNodeMessage(t, appErr.Message, "ENOTDIR: not a directory, open '"+under+"'")
	})

	t.Run("a name past the limit is too long", func(t *testing.T) {
		long := filepath.Join(t.TempDir(), strings.Repeat("a", 300)+".md")
		_, err := cli.ReadText(t.Context(), long)
		var appErr *app.AppError
		if !errors.As(err, &appErr) {
			t.Fatalf("err = %v, want an AppError", err)
		}
		assertNodeMessage(t, appErr.Message, "ENAMETOOLONG: name too long, open '"+long+"'")
	})

	t.Run("a symlink loop is too many symbolic links", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.Symlink(filepath.Join(dir, "b"), filepath.Join(dir, "a")); err != nil {
			t.Fatalf("symlink a: %v", err)
		}
		if err := os.Symlink(filepath.Join(dir, "a"), filepath.Join(dir, "b")); err != nil {
			t.Fatalf("symlink b: %v", err)
		}
		_, err := cli.ReadText(t.Context(), filepath.Join(dir, "a"))
		var appErr *app.AppError
		if !errors.As(err, &appErr) {
			t.Fatalf("err = %v, want an AppError", err)
		}
		assertNodeMessage(t, appErr.Message, "ELOOP: too many symbolic links encountered, open '"+filepath.Join(dir, "a")+"'")
	})

	t.Run("a failure without a described errno keeps the error's own text", func(t *testing.T) {
		_, wantErr := os.ReadFile("/bad\x00path")
		if wantErr == nil {
			t.Fatal("reading a path with a NUL byte should fail")
		}
		_, err := cli.ReadText(t.Context(), "/bad\x00path")
		var appErr *app.AppError
		if !errors.As(err, &appErr) {
			t.Fatalf("err = %v, want an AppError", err)
		}
		if appErr.Message != wantErr.Error() {
			t.Fatalf("message = %q, want %q", appErr.Message, wantErr.Error())
		}
	})
}

func TestReadBrief(t *testing.T) {
	path := filepath.Join(t.TempDir(), "brief.md")
	if err := os.WriteFile(path, []byte("from file"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	t.Run("- reads stdin", func(t *testing.T) {
		got, err := cli.ReadBrief(t.Context(), "-", func(context.Context) (string, error) { return "from stdin", nil })
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if got != "from stdin" {
			t.Fatalf("got = %q", got)
		}
	})

	t.Run("a path reads the file", func(t *testing.T) {
		got, err := cli.ReadBrief(t.Context(), path, func(context.Context) (string, error) {
			t.Fatal("stdin must not be read for a path")
			return "", nil
		})
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if got != "from file" {
			t.Fatalf("got = %q", got)
		}
	})

	t.Run("a stdin failure comes back as it is", func(t *testing.T) {
		want := errors.New("pipe torn")
		_, err := cli.ReadBrief(t.Context(), "-", func(context.Context) (string, error) { return "", want })
		if !errors.Is(err, want) {
			t.Fatalf("err = %v, want %v", err, want)
		}
	})
}

func TestReadStdin(t *testing.T) {
	path := filepath.Join(t.TempDir(), "in.txt")
	if err := os.WriteFile(path, []byte("line one\nline two"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer file.Close()
	old := os.Stdin
	os.Stdin = file
	defer func() { os.Stdin = old }()

	got, err := cli.ReadStdin(t.Context())
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if got != "line one\nline two" {
		t.Fatalf("got = %q", got)
	}
}

func TestReadStdinFails(t *testing.T) {
	// Reading a directory fd fails where reading a file ends, so stdin pointing at one is the
	// error path.
	dir := t.TempDir()
	file, err := os.Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer file.Close()
	old := os.Stdin
	os.Stdin = file
	defer func() { os.Stdin = old }()

	if _, err = cli.ReadStdin(t.Context()); err == nil {
		t.Fatal("reading a directory as stdin should fail")
	}
}
