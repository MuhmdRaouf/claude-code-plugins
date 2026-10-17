package cli

import (
	"context"
	"io"
	"io/fs"
	"os"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
)

// ReadText reads a file's text; the failure is the CLI's brief_unreadable error, its message
// Node's own for the failed readFile: the errno sentence with the failing syscall and path.
func ReadText(ctx context.Context, path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		op, at := "open", path
		if pathErr, ok := err.(*fs.PathError); ok && pathErr.Op == "read" {
			// A read failure names no path in Node; reading a directory is the one ReadFile hits.
			op, at = "read", ""
		}
		return "", &app.AppError{Kind: app.AppErrorBriefUnreadable, Path: path, Message: fsutil.NodeMessage(err, op, at)}
	}
	return string(data), nil
}

// ReadBrief reads a brief's text; `-` reads stdin.
func ReadBrief(ctx context.Context, path string, stdin func(context.Context) (string, error)) (string, error) {
	if path == "-" {
		return stdin(ctx)
	}
	return ReadText(ctx, path)
}

// ReadStdin is all of stdin as text.
func ReadStdin(ctx context.Context) (string, error) {
	data, err := io.ReadAll(os.Stdin)
	if err != nil {
		return "", err
	}
	return string(data), nil
}
