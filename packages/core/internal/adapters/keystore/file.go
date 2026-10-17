// The key file (`NAME=<key>` lines, mode 0600, directory 0700): read by every key lookup, and the
// store setup writes only where the platform has no secret store. A file other users can read is
// refused, whatever it holds.
package keystore

import (
	"context"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// privateFile is the mode every key file is written with.
const privateFile fs.FileMode = 0o600

// ExpandHome expands a leading ~ to home.
func ExpandHome(path string, home string) string {
	if path == "~" || strings.HasPrefix(path, "~/") {
		return filepath.Join(home, path[1:])
	}
	return path
}

// keyLine matches line `NAME=<key>` (optional `export`, optional quotes) for any of the
// provider's key env names.
func keyLine(names []string) *regexp.Regexp {
	quoted := make([]string, len(names))
	for i, name := range names {
		quoted[i] = regexp.QuoteMeta(name)
	}
	return regexp.MustCompile(`^(?:export\s+)?(?:` + strings.Join(quoted, "|") + `)\s*=\s*(.*)$`)
}

// lineValue is the key a raw line holds, when it holds one.
func lineValue(raw string, line *regexp.Regexp) (string, bool) {
	match := line.FindStringSubmatch(strings.TrimSpace(raw))
	if match == nil {
		return "", false
	}
	return unquote(strings.TrimSpace(match[1])), true
}

func unquote(value string) string {
	if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
		return value[1 : len(value)-1]
	}
	return value
}

// ReadKeyFile is the key in file: found false when there is no file or no key line; an error when
// the file is looser than 0600 or cannot be read. One open file serves the mode check and the
// read, so the file cannot be swapped in between.
func ReadKeyFile(ctx context.Context, provider domain.Provider, file string) (string, bool, error) {
	handle, err := os.Open(file)
	if err != nil {
		return readFailure(provider, file, err)
	}
	defer handle.Close()
	info, err := handle.Stat()
	if err != nil {
		return readFailure(provider, file, err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return "", false, &ports.WorkerError{
			Kind:  ports.WorkerErrorInsecureKeyFile,
			Label: provider.Display + " key file",
			Path:  file,
			Mode:  formatMode(info.Mode()),
		}
	}
	content, err := io.ReadAll(handle)
	if err != nil {
		return readFailure(provider, file, err)
	}
	line := keyLine(provider.KeyEnv)
	for _, raw := range strings.Split(string(content), "\n") {
		if value, ok := lineValue(raw, line); ok {
			return value, true, nil
		}
	}
	return "", false, nil
}

// readFailure is a read that did not answer: no file is no key, anything else names the errno.
func readFailure(provider domain.Provider, file string, err error) (string, bool, error) {
	code := fsutil.ErrnoCode(err)
	if code == "ENOENT" {
		return "", false, nil
	}
	if code == "" {
		code = "unknown error"
	}
	return "", false, &ports.WorkerError{
		Kind:    ports.WorkerErrorNoKey,
		Message: fmt.Sprintf("cannot read %s key file %s (%s)", provider.Display, file, code),
	}
}

// formatMode is the permission bits in Node's spelling: octal, four digits.
func formatMode(mode fs.FileMode) string {
	return fmt.Sprintf("%04o", mode.Perm())
}

// readText is the file's whole text, nil when there is no file.
func readText(file string) (*string, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		if fsutil.ErrnoCode(err) == "ENOENT" {
			return nil, nil
		}
		return nil, err
	}
	text := string(data)
	return &text, nil
}

// writePrivate writes text as a 0600 file in a 0700 directory, atomically.
func writePrivate(ctx context.Context, file string, text string) error {
	_, err := fsutil.WriteFileAtomic(ctx, file, []byte(text), fsutil.WriteOptions{
		Mode:  fsutil.Perm(privateFile),
		Mkdir: true,
	})
	return err
}

// RemoveKeyLine removes the provider's key lines from file (only those holding value, when
// given), keeping every other line. The file goes away when nothing but blank lines would remain.
// It reports whether a line was removed.
func RemoveKeyLine(ctx context.Context, provider domain.Provider, file string, value *string) (bool, error) {
	text, err := readText(file)
	if err != nil {
		return false, err
	}
	if text == nil {
		return false, nil
	}
	line := keyLine(provider.KeyEnv)
	lines := strings.Split(*text, "\n")
	kept := make([]string, 0, len(lines))
	for _, raw := range lines {
		found, ok := lineValue(raw, line)
		if !ok || (value != nil && found != *value) {
			kept = append(kept, raw)
		}
	}
	if len(kept) == len(lines) {
		return false, nil
	}
	if onlyBlanks(kept) {
		return true, os.Remove(file)
	}
	return true, writePrivate(ctx, file, strings.Join(kept, "\n"))
}

// onlyBlanks reports whether nothing but blank lines would remain.
func onlyBlanks(lines []string) bool {
	for _, raw := range lines {
		if strings.TrimSpace(raw) != "" {
			return false
		}
	}
	return true
}

type fileStore struct {
	provider domain.Provider
	file     string
}

// FileKeyStore is the key file as a KeyStore: always available, the first key env name as the
// line it writes.
func FileKeyStore(provider domain.Provider, file string) ports.KeyStore {
	return &fileStore{provider: provider, file: file}
}

func (s *fileStore) Kind() ports.KeyStoreKind { return ports.KeyStoreFile }

func (s *fileStore) Label() string { return s.file }

func (s *fileStore) Available(context.Context) bool { return true }

func (s *fileStore) Get(ctx context.Context) (string, bool) {
	value, found, err := ReadKeyFile(ctx, s.provider, s.file)
	if err != nil || value == "" {
		return "", false
	}
	return value, found
}

func (s *fileStore) Set(ctx context.Context, key string) error {
	if err := AssertValidKey(key); err != nil {
		return err
	}
	line := keyLine(s.provider.KeyEnv)
	text, err := readText(s.file)
	if err != nil {
		return err
	}
	content := ""
	if text != nil {
		content = *text
	}
	var others []string
	for _, raw := range strings.Split(content, "\n") {
		if !line.MatchString(strings.TrimSpace(raw)) {
			others = append(others, raw)
		}
	}
	for len(others) > 0 && others[len(others)-1] == "" {
		others = others[:len(others)-1]
	}
	name := "API_KEY"
	if len(s.provider.KeyEnv) > 0 {
		name = s.provider.KeyEnv[0]
	}
	return writePrivate(ctx, s.file, strings.Join(append(others, name+"="+key), "\n")+"\n")
}

func (s *fileStore) Remove(ctx context.Context) error {
	_, err := RemoveKeyLine(ctx, s.provider, s.file, nil)
	return err
}
