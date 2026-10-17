package adapters

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// loadKey and keySource. Every test reads and writes under a temp dir; the real HOME and its
// key files are never touched.

// hostOtherKey is a file-held key, distinct from the store's TEST_KEY.
const hostOtherKey = "zt-FILE.key_0123456789abcdef"

// hostKeyFile writes content as a key file with the exact mode.
func hostKeyFile(t *testing.T, content string, mode fs.FileMode) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "env")
	if err := os.WriteFile(file, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(file, mode); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestLoadKey(t *testing.T) {
	t.Run("env wins over the file, and the source names the env var", func(t *testing.T) {
		file := hostKeyFile(t, "ZAI_API_KEY=from-file\n", 0o600)

		key, err := LoadKey(context.Background(), testkit.ReferenceProvider,
			domain.EnvLookup{"ZAI_API_KEY": "from-env"}, file, nil)

		if err != nil || key != (ports.ProviderKey{Value: "from-env", Source: "ZAI_API_KEY"}) {
			t.Fatalf("loadKey = (%+v, %v), want from-env from ZAI_API_KEY", key, err)
		}
	})

	t.Run("the first of the provider's key env names that is set wins", func(t *testing.T) {
		provider := testkit.AcmeProvider
		provider.KeyEnv = []string{"ACME_API_KEY", "ACME_LEGACY_KEY"}
		nowhere := filepath.Join(t.TempDir(), "missing")

		primary, err := LoadKey(context.Background(), provider,
			domain.EnvLookup{"ACME_API_KEY": "new", "ACME_LEGACY_KEY": "old"}, nowhere, nil)
		legacy, legacyErr := LoadKey(context.Background(), provider,
			domain.EnvLookup{"ACME_LEGACY_KEY": "old"}, nowhere, nil)

		if err != nil || primary != (ports.ProviderKey{Value: "new", Source: "ACME_API_KEY"}) {
			t.Fatalf("loadKey = (%+v, %v), want new from ACME_API_KEY", primary, err)
		}
		if legacyErr != nil || legacy != (ports.ProviderKey{Value: "old", Source: "ACME_LEGACY_KEY"}) {
			t.Fatalf("loadKey = (%+v, %v), want old from ACME_LEGACY_KEY", legacy, legacyErr)
		}
	})

	t.Run("reads the file: any key env name, optional export and quotes, comments ignored", func(t *testing.T) {
		variants := []struct {
			content string
			key     string
		}{
			{"ZAI_API_KEY=\"double-quoted\"\n", "double-quoted"},
			{"ZAI_API_KEY='single-quoted'\n", "single-quoted"},
			{"export ZAI_API_KEY=bare\n", "bare"},
			{"# comment\nOTHER=1\nZAI_API_KEY=last\n", "last"},
		}
		for _, variant := range variants {
			file := hostKeyFile(t, variant.content, 0o600)
			key, err := LoadKey(context.Background(), testkit.ReferenceProvider, domain.EnvLookup{}, file, nil)
			if err != nil || key.Value != variant.key || key.Source == "" {
				t.Fatalf("loadKey(%q) = (%+v, %v), want %q from the file", variant.content, key, err, variant.key)
			}
		}
	})

	t.Run("a key file looser than 0600 is refused, whatever it holds", func(t *testing.T) {
		worldReadable := hostKeyFile(t, "ZAI_API_KEY=x", 0o644)
		groupReadable := hostKeyFile(t, "ZAI_API_KEY=x", 0o640)
		ownerOnly := hostKeyFile(t, "ZAI_API_KEY=x", 0o400)

		loose, err := LoadKey(context.Background(), testkit.ReferenceProvider, domain.EnvLookup{}, worldReadable, nil)
		if err == nil || err.Kind != ports.WorkerErrorInsecureKeyFile ||
			err.Label != "Z.ai GLM key file" || err.Path != worldReadable || err.Mode != "0644" {
			t.Fatalf("loadKey(0644) = (%+v, %v), want insecure_key_file naming the file and mode", loose, err)
		}
		group, err := LoadKey(context.Background(), testkit.ReferenceProvider, domain.EnvLookup{}, groupReadable, nil)
		if err == nil || err.Kind != ports.WorkerErrorInsecureKeyFile || err.Mode != "0640" {
			t.Fatalf("loadKey(0640) = (%+v, %v), want insecure_key_file with mode 0640", group, err)
		}
		tight, err := LoadKey(context.Background(), testkit.ReferenceProvider, domain.EnvLookup{}, ownerOnly, nil)
		if err != nil || tight.Value != "x" {
			t.Fatalf("loadKey(0400) = (%+v, %v), want the key", tight, err)
		}
	})

	t.Run("no env and no usable file → no_key with a setup hint naming the provider", func(t *testing.T) {
		missing := filepath.Join(t.TempDir(), "missing")
		noLine := hostKeyFile(t, "OTHER=1\n", 0o600)

		none, err := LoadKey(context.Background(), testkit.ReferenceProvider, domain.EnvLookup{}, missing, nil)
		want := &ports.WorkerError{
			Kind: ports.WorkerErrorNoKey,
			Message: "no Z.ai GLM key: run /zai:setup to enter it once and keep it in the " +
				"OS keystore",
		}
		if err == nil || *err != *want {
			t.Fatalf("loadKey(missing) = (%+v, %v), want %+v", none, err, want)
		}
		blank, err := LoadKey(context.Background(), testkit.ReferenceProvider,
			domain.EnvLookup{"ZAI_API_KEY": " "}, noLine, nil)
		if err == nil || err.Kind != ports.WorkerErrorNoKey {
			t.Fatalf("loadKey(blank env) = (%+v, %v), want no_key", blank, err)
		}
	})

	t.Run("expands a leading ~ from HOME (the default key file is one)", func(t *testing.T) {
		dir := t.TempDir()
		file := filepath.Join(dir, "env")
		if err := os.WriteFile(file, []byte("ACME_API_KEY=tilde\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(file, 0o600); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(testkit.ReferenceProvider.KeyFile, "~/") {
			t.Fatalf("the reference provider's key file is %q, want it under ~", testkit.ReferenceProvider.KeyFile)
		}
		env := domain.EnvLookup{"HOME": dir}

		found, err := LoadKey(context.Background(), testkit.AcmeProvider, env, "~/env", nil)
		missing, missingErr := LoadKey(context.Background(), testkit.AcmeProvider, env, "~/missing", nil)

		if err != nil || found != (ports.ProviderKey{Value: "tilde", Source: file}) {
			t.Fatalf("loadKey(~/env) = (%+v, %v), want tilde from %s", found, err, file)
		}
		if missingErr == nil || missingErr.Kind != ports.WorkerErrorNoKey {
			t.Fatalf("loadKey(~/missing) = (%+v, %v), want no_key", missing, missingErr)
		}
	})
}

// hostLockedKeyStore is a store that cannot answer: Get answers false, the interface's spelling
// of "no key to give".
type hostLockedKeyStore struct{}

var _ ports.KeyStore = hostLockedKeyStore{}

func (hostLockedKeyStore) Kind() ports.KeyStoreKind           { return ports.KeyStoreMacOS }
func (hostLockedKeyStore) Label() string                      { return "macOS Keychain" }
func (hostLockedKeyStore) Available(context.Context) bool     { return true }
func (hostLockedKeyStore) Get(context.Context) (string, bool) { return "", false }
func (hostLockedKeyStore) Set(context.Context, string) error  { return nil }
func (hostLockedKeyStore) Remove(context.Context) error       { return nil }

func TestLoadKeyWithAKeyStore(t *testing.T) {
	t.Run("looks up env, then the store, then the file; the source names where the key was", func(t *testing.T) {
		file := hostKeyFile(t, "ZAI_API_KEY="+hostOtherKey+"\n", 0o600)
		store := testkit.NewMemoryKeyStore(ports.KeyStoreMacOS, "macOS Keychain", testkit.TEST_KEY)

		fromEnv, err := LoadKey(context.Background(), testkit.ReferenceProvider,
			domain.EnvLookup{"ZAI_API_KEY": "from-env"}, file, store)
		if err != nil || fromEnv != (ports.ProviderKey{Value: "from-env", Source: "ZAI_API_KEY"}) {
			t.Fatalf("loadKey(env) = (%+v, %v), want from-env from ZAI_API_KEY", fromEnv, err)
		}
		fromStore, err := LoadKey(context.Background(), testkit.ReferenceProvider, domain.EnvLookup{}, file, store)
		if err != nil || fromStore != (ports.ProviderKey{Value: testkit.TEST_KEY, Source: "macOS Keychain"}) {
			t.Fatalf("loadKey(store) = (%+v, %v), want the store's key named by its label", fromStore, err)
		}
		store.Value = ""
		fromFile, err := LoadKey(context.Background(), testkit.ReferenceProvider, domain.EnvLookup{}, file, store)
		if err != nil || fromFile != (ports.ProviderKey{Value: hostOtherKey, Source: file}) {
			t.Fatalf("loadKey(file) = (%+v, %v), want the file's key named by its path", fromFile, err)
		}
		noStore, err := LoadKey(context.Background(), testkit.ReferenceProvider, domain.EnvLookup{}, file, nil)
		if err != nil || noStore != (ports.ProviderKey{Value: hostOtherKey, Source: file}) {
			t.Fatalf("loadKey(nil store) = (%+v, %v), want the file's key named by its path", noStore, err)
		}
	})

	t.Run("a store that fails to answer is skipped, never fatal", func(t *testing.T) {
		file := hostKeyFile(t, "ZAI_API_KEY="+hostOtherKey+"\n", 0o600)

		key, err := LoadKey(context.Background(), testkit.ReferenceProvider, domain.EnvLookup{}, file,
			hostLockedKeyStore{})

		if err != nil || key != (ports.ProviderKey{Value: hostOtherKey, Source: file}) {
			t.Fatalf("loadKey(locked store) = (%+v, %v), want the file's key", key, err)
		}
	})

	t.Run("an unreadable key file is an error naming the file", func(t *testing.T) {
		// os.MkdirTemp makes 0700 dirs, so the mode check passes and the read itself fails.
		dir, mkdirErr := os.MkdirTemp(t.TempDir(), "unreadable-")
		if mkdirErr != nil {
			t.Fatal(mkdirErr)
		}
		// Reading a directory as a file fails its read with EISDIR.
		want := dir + " (EISDIR)"

		key, err := LoadKey(context.Background(), testkit.ReferenceProvider, domain.EnvLookup{}, dir, nil)

		if err == nil || err.Kind != ports.WorkerErrorNoKey ||
			!strings.Contains(err.Message, "cannot read Z.ai GLM key file "+want) {
			t.Fatalf("loadKey(dir) = (%+v, %v), want no_key naming the file and its errno", key, err)
		}
	})
}

func TestKeySource(t *testing.T) {
	t.Run("names the source of a loaded key", func(t *testing.T) {
		source, err := KeySource(ports.ProviderKey{Value: testkit.TEST_KEY, Source: "macOS Keychain"}, nil)
		if err != nil || source != "macOS Keychain" {
			t.Fatalf("keySource = (%q, %v), want the store's label", source, err)
		}
	})

	t.Run("passes the loader's error through", func(t *testing.T) {
		want := &ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "no key"}
		source, err := KeySource(ports.ProviderKey{}, want)
		if err != want || source != "" {
			t.Fatalf("keySource = (%q, %v), want the loader's error", source, err)
		}
	})
}
