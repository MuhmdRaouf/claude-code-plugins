package ports

import "context"

// ProviderKey is a loaded key and where it came from, so status lines can name the source
// without ever showing the key.
type ProviderKey struct {
	Value string
	// The env var that held the key, the store ("macOS Keychain", "Secret Service"), or the file.
	Source string
}

// KeyStoreKind is which store a provider key lives in at rest.
type KeyStoreKind string

const (
	KeyStoreMacOS KeyStoreKind = "macos"
	KeyStoreLinux KeyStoreKind = "linux"
	KeyStoreFile  KeyStoreKind = "file"
)

// KeyStore is where the provider key lives at rest: the OS secret store, or the 0600 key file
// when there is none. Adapters implement this (adapters/key, adapters/keystore, auth-page).
type KeyStore interface {
	Kind() KeyStoreKind
	// How setup and status lines name the store: "macOS Keychain", "Secret Service", or a path.
	Label() string
	Available(ctx context.Context) bool
	Get(ctx context.Context) (string, bool)
	// Set rejects an invalid key before any tool runs; the error says why the store refused it,
	// never the key itself.
	Set(ctx context.Context, key string) error
	Remove(ctx context.Context) error
}

// KeyVerdict is what the provider says to one minimal request with a key.
type KeyVerdict string

const (
	// It answered.
	KeyVerdictAccepted KeyVerdict = "accepted"
	// It knows the key but refuses work for now (a rate limit, or an account out of balance): the
	// key is good, the user hears why it will not work yet.
	KeyVerdictLimited KeyVerdict = "limited"
	// The key itself is wrong.
	KeyVerdictRefused KeyVerdict = "refused"
	// No answer worth trusting (network, 5xx).
	KeyVerdictUnknown KeyVerdict = "unknown"
)

// KeyEntry is setup's way to get a key in without the chat: the OS store and the one-time page.
type KeyEntry interface {
	// The store a key goes to: the OS secret store, or the key file where there is none.
	Store(ctx context.Context) KeyStore
	// Check runs one minimal provider request with key.
	Check(ctx context.Context, key string) KeyVerdict
	// OpenPage starts the one-time page detached and opens it in the browser; it returns the page's
	// URL, or an error whose message is all it carries.
	OpenPage(ctx context.Context) (string, error)
	// PageOpen reports whether the page at url still serves: false once it saved a key, timed out,
	// ran out of tries or was closed.
	PageOpen(ctx context.Context, url string) bool
	// RemoveFromFile removes the key file's line holding value (the file too when nothing else is
	// left); it reports whether a line went.
	RemoveFromFile(ctx context.Context, value string) bool
}
