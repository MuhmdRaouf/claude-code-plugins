package keystore_test

import (
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"runtime"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/keystore"
)

// The real macOS Keychain, end to end: set, read, update, remove a throwaway item through
// /usr/bin/security. The platform tests prove the command lines; this proves `security` accepts
// them. It touches the login keychain, so it runs only where CORE_KEYCHAIN_ROUNDTRIP=1 says so
// and GOOS is darwin, never on a developer's machine by accident.
func TestMacOSKeychainForReal(t *testing.T) {
	if os.Getenv("CORE_KEYCHAIN_ROUNDTRIP") != "1" || runtime.GOOS != "darwin" {
		t.Skip("set CORE_KEYCHAIN_ROUNDTRIP=1 on darwin to run the real Keychain round trip")
	}
	ctx := context.Background()
	id := keystore.KeyIdentity{
		Service: "muhmdraouf-ci-" + randomHex(t, 6),
		Account: "roundtrip",
		Display: "CI round trip",
	}
	store := keystore.MacosKeyStore(id, keystore.SpawnRunner)
	first := "ci-" + randomHex(t, 12)
	second := "ci-" + randomHex(t, 12)
	t.Cleanup(func() { _ = store.Remove(ctx) })
	if !store.Available(ctx) {
		t.Fatal("the Keychain is not available")
	}
	if _, found := store.Get(ctx); found {
		t.Fatal("the throwaway item already exists")
	}
	if err := store.Set(ctx, first); err != nil {
		t.Fatalf("set: %v", err)
	}
	if value, found := store.Get(ctx); !found || value != first {
		t.Fatalf("get = %d chars %v, want the first key", len(value), found)
	}
	if err := store.Set(ctx, second); err != nil {
		t.Fatalf("set: %v", err)
	}
	if value, found := store.Get(ctx); !found || value != second {
		t.Fatalf("get = %d chars %v, want the second key", len(value), found)
	}
	if err := store.Remove(ctx); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if _, found := store.Get(ctx); found {
		t.Fatal("the item is still there after remove")
	}
}

func randomHex(t *testing.T, size int) string {
	t.Helper()
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		t.Fatalf("random bytes: %v", err)
	}
	return fmt.Sprintf("%x", buf)
}
