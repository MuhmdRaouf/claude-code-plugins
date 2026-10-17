package cli

// Setup's key step: move a key file's key into the OS store, and when there is no key (or the
// provider refuses it) open the one-time page and wait for the store to fill, so setup goes on in
// the same run. A key from the environment is the user's own: left alone.

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// EntryWaitMs is how long setup waits for the page's key: 9 minutes — the page itself lasts 10,
// and a Claude Code Bash call at most 600000 ms, so the rest of setup (key check, router, /model,
// agents) still finishes inside the call once the key lands near the end.
const EntryWaitMs int64 = 9 * 60_000

// entryPollMs is how often setup re-reads the store while the page is open.
const entryPollMs int64 = 1000

// setupSay is where a key step's progress line goes.
type setupSay func(text string)

// setupSayer routes progress lines: under --json stdout carries one JSON document, so they go to
// stderr.
func setupSayer(call Invocation) setupSay {
	if call.Flag("json") {
		return call.Deps().Out.Error
	}
	return call.Deps().Out.Line
}

// EnsureKey is setup's key step. ok false: go on with setup; true: setup ends with the code (a
// nobody saved a key in time, or the page ended).
func EnsureKey(ctx context.Context, call Invocation) (ExitCode, bool) {
	deps := call.Deps()
	entry := deps.Host.KeyEntry
	if entry == nil {
		return ExitOK, false
	}
	loaded, loadErr := deps.Host.LoadKey(ctx)
	if loadErr == nil && slices.Contains(deps.Provider.KeyEnv, loaded.Source) {
		return ExitOK, false
	}
	if loadErr != nil {
		var workerErr *ports.WorkerError
		if !errors.As(loadErr, &workerErr) || workerErr.Kind != ports.WorkerErrorNoKey {
			return ExitOK, false
		}
	}
	say := setupSayer(call)
	store := entry.Store(ctx)
	if loadErr != nil {
		return enterKey(ctx, call, entry, store, say, nil)
	}
	if store.Kind() != ports.KeyStoreFile && loaded.Source != store.Label() {
		migrateKey(ctx, entry, store, loaded, say)
	}
	verdict := entry.Check(ctx, loaded.Value)
	if verdict == ports.KeyVerdictLimited {
		say(fmt.Sprintf(
			"key: %s knows the key but is not taking requests with it yet (a rate limit, or no balance left: top up at %s)",
			deps.Provider.Display, deps.Provider.BillingURL))
	}
	if verdict != ports.KeyVerdictRefused {
		return ExitOK, false
	}
	say("key: " + deps.Provider.Display + " refused the stored key; enter a new one.")
	refused := loaded.Value
	return enterKey(ctx, call, entry, store, say, &refused)
}

// enterKey opens the page and polls the store each second, for up to EntryWaitMs, for a key other
// than the refused one; it stops early when the page ends without one (out of tries, timed out,
// closed).
func enterKey(
	ctx context.Context,
	call Invocation,
	entry ports.KeyEntry,
	store ports.KeyStore,
	say setupSay,
	refused *string,
) (ExitCode, bool) {
	deps := call.Deps()
	opened, err := entry.OpenPage(ctx)
	if err != nil {
		say("key: cannot open the key page (" + err.Error() + ")")
		return ExitOK, false
	}
	say(fmt.Sprintf("Add your %s key on this page; setup waits up to %d minutes for it:",
		deps.Provider.Display, EntryWaitMs/60_000))
	say("  " + opened)
	deadline := deps.Clock.Now() + EntryWaitMs
	saved := func() bool {
		current, ok := store.Get(ctx)
		if !ok || (refused != nil && current == *refused) {
			return false
		}
		say("key: saved in " + store.Label())
		return true
	}
	for deps.Clock.Now() < deadline {
		if err := deps.Clock.Sleep(ctx, entryPollMs); err != nil {
			break
		}
		if saved() {
			return ExitOK, false
		}
		if !entry.PageOpen(ctx, opened) {
			// The page stores the key before it closes: one more read tells a saved key from a
			// page that gave up.
			if saved() {
				return ExitOK, false
			}
			break
		}
	}
	say("Finish in the browser, then run " + deps.Provider.Slash + "setup again.")
	return ExitNotReady, true
}

// migrateKey moves a key file's key into the store, confirmed by a read-back before the file's
// line goes. A failure keeps the file as it was.
func migrateKey(ctx context.Context, entry ports.KeyEntry, store ports.KeyStore, key ports.ProviderKey, say setupSay) {
	err := store.Set(ctx, key.Value)
	if err == nil {
		current, ok := store.Get(ctx)
		if !ok || current != key.Value {
			err = errors.New(store.Label() + " did not return the key")
		}
	}
	if err != nil {
		say("key: kept in " + key.Source + ": " + err.Error())
		return
	}
	removed := entry.RemoveFromFile(ctx, key.Value)
	line := "key: moved from " + key.Source + " to " + store.Label()
	if !removed {
		line += " (the file line was already gone)"
	}
	say(line)
}

// RemoveStoredKey is `setup --remove`: the key leaves the store too.
func RemoveStoredKey(ctx context.Context, call Invocation) {
	entry := call.Deps().Host.KeyEntry
	if entry == nil {
		return
	}
	say := setupSayer(call)
	store := entry.Store(ctx)
	if err := store.Remove(ctx); err != nil {
		say("key: FAILED to remove from " + store.Label() + ": " + err.Error())
		return
	}
	say("key: removed from " + store.Label())
}
