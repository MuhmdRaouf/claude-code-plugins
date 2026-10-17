package adapters

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/keystore"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// Where the provider's API key comes from.

// KeySource is a loaded key's source as a status line sees it: the key's source, or the loader's
// error passed through — so the source is named without ever showing the key.
func KeySource(key ports.ProviderKey, loadErr *ports.WorkerError) (string, *ports.WorkerError) {
	if loadErr != nil {
		return "", loadErr
	}
	return key.Source, nil
}

// LoadKey is the provider's key, the one lookup every reader shares (setup, the router service,
// job workers): env (first of KeyEnv that is set), else the OS secret store, else the key file
// (mode 0600 or stricter), else no_key. The key is returned, never logged. store nil means none;
// the caller passes keystore.PlatformKeyStore's answer, and a store that cannot answer (locked, no
// session bus) is a store without the key — the file still gets its turn.
func LoadKey(ctx context.Context, provider domain.Provider, env domain.EnvLookup, path string, store ports.KeyStore) (ports.ProviderKey, *ports.WorkerError) {
	for _, name := range provider.KeyEnv {
		if fromEnv := strings.TrimSpace(env[name]); fromEnv != "" {
			return ports.ProviderKey{Value: fromEnv, Source: name}, nil
		}
	}
	if store != nil {
		if stored, ok := store.Get(ctx); ok {
			return ports.ProviderKey{Value: stored, Source: store.Label()}, nil
		}
	}
	file := keystore.KeyFilePath(provider, env, path)
	value, found, err := keystore.ReadKeyFile(ctx, provider, file)
	if err != nil {
		var worker *ports.WorkerError
		if errors.As(err, &worker) {
			return ports.ProviderKey{}, worker
		}
		return ports.ProviderKey{}, &ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: err.Error()}
	}
	if found {
		return ports.ProviderKey{Value: value, Source: file}, nil
	}
	return ports.ProviderKey{}, hostNoKey(provider)
}

// hostNoKey is the setup hint: the slash command that enters the key once and keeps it in the store.
func hostNoKey(provider domain.Provider) *ports.WorkerError {
	return &ports.WorkerError{
		Kind: ports.WorkerErrorNoKey,
		Message: fmt.Sprintf("no %s key: run %ssetup to enter it once and keep it in the OS keystore",
			provider.Display, provider.Slash),
	}
}
