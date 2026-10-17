// macOS Keychain through /usr/bin/security. Writes and deletes go through `security -i`, which
// reads its command line from stdin, so the key never reaches argv (where `ps` would show it).
// Reads print the password on stdout.
package keystore

import (
	"context"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// Security is the macOS Keychain's tool.
const Security = "/usr/bin/security"

const macosLabel = "macOS Keychain"

type macosStore struct {
	id  KeyIdentity
	run Runner
}

// MacosKeyStore is the provider's key in the macOS Keychain, through /usr/bin/security.
func MacosKeyStore(id KeyIdentity, run Runner) ports.KeyStore {
	return &macosStore{id: id, run: run}
}

func (s *macosStore) Kind() ports.KeyStoreKind { return ports.KeyStoreMacOS }

func (s *macosStore) Label() string { return macosLabel }

// where is the item's names as `security -i` wants them on its command line. The service name is
// validated, so the double quotes cannot be broken out of.
func (s *macosStore) where() string {
	return `-s "` + s.id.Service + `" -a "` + s.id.Account + `"`
}

func (s *macosStore) read(ctx context.Context) RunResult {
	return s.run(ctx, Security, []string{"find-generic-password", "-s", s.id.Service, "-a", s.id.Account, "-w"}, nil)
}

func (s *macosStore) Available(ctx context.Context) bool {
	result := s.run(ctx, Security, []string{"default-keychain"}, nil)
	return !result.Missing && result.exited(0)
}

func (s *macosStore) Get(ctx context.Context) (string, bool) {
	result := s.read(ctx)
	if !result.exited(0) {
		return "", false
	}
	return trimmedKey(result.Stdout)
}

func (s *macosStore) Set(ctx context.Context, key string) error {
	if err := AssertValidKey(key); err != nil {
		return err
	}
	// `-U` updates an existing item.
	command := "add-generic-password -U " + s.where() + ` -w "` + key + `"` + "\n"
	result := s.run(ctx, Security, []string{"-i"}, &command)
	// `security -i` may exit 0 after a failed command: only a read-back proves the write.
	back := s.read(ctx)
	if !result.exited(0) {
		return StoreFailure(macosLabel, "store", result)
	}
	if !back.exited(0) || TrimNewline(back.Stdout) != key {
		return StoreFailure(macosLabel, "store", back)
	}
	return nil
}

func (s *macosStore) Remove(ctx context.Context) error {
	command := "delete-generic-password " + s.where() + "\n"
	result := s.run(ctx, Security, []string{"-i"}, &command)
	if result.Missing {
		return StoreFailure(macosLabel, "remove", result)
	}
	return nil
}
