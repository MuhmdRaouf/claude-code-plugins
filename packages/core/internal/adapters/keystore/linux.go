// The freedesktop Secret Service (GNOME Keyring, KWallet) through secret-tool. `store` reads the
// secret from stdin.
package keystore

import (
	"context"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

const (
	secretTool = "secret-tool"
	linuxLabel = "Secret Service"
)

type linuxStore struct {
	id  KeyIdentity
	run Runner
}

// LinuxKeyStore is the provider's key in the freedesktop Secret Service, through secret-tool.
func LinuxKeyStore(id KeyIdentity, run Runner) ports.KeyStore {
	return &linuxStore{id: id, run: run}
}

func (s *linuxStore) Kind() ports.KeyStoreKind { return ports.KeyStoreLinux }

func (s *linuxStore) Label() string { return linuxLabel }

// attributes are the secret's xdg:schema-less attribute pairs secret-tool looks it up by.
func (s *linuxStore) attributes() []string {
	return []string{"service", s.id.Service, "account", s.id.Account}
}

func (s *linuxStore) lookup(ctx context.Context) RunResult {
	return s.run(ctx, secretTool, append([]string{"lookup"}, s.attributes()...), nil)
}

func (s *linuxStore) Available(ctx context.Context) bool {
	result := s.lookup(ctx)
	if result.Missing {
		return false
	}
	// Exit 1 with nothing on stderr is "no such secret"; a D-Bus or "no secret service" failure
	// says why on stderr.
	return result.exited(0) || (result.exited(1) && strings.TrimSpace(result.Stderr) == "")
}

func (s *linuxStore) Get(ctx context.Context) (string, bool) {
	result := s.lookup(ctx)
	if !result.exited(0) {
		return "", false
	}
	return trimmedKey(result.Stdout)
}

func (s *linuxStore) Set(ctx context.Context, key string) error {
	if err := AssertValidKey(key); err != nil {
		return err
	}
	// No trailing newline: secret-tool stores stdin up to EOF as it is.
	args := append([]string{"store", "--label=" + s.id.Display + " API key"}, s.attributes()...)
	result := s.run(ctx, secretTool, args, &key)
	if !result.exited(0) {
		return StoreFailure(linuxLabel, "store", result)
	}
	return nil
}

func (s *linuxStore) Remove(ctx context.Context) error {
	result := s.run(ctx, secretTool, append([]string{"clear"}, s.attributes()...), nil)
	if result.Missing {
		return StoreFailure(linuxLabel, "remove", result)
	}
	return nil
}
