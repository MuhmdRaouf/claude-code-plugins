package cli_test

// The setup key suite: setup's key step — the one-time page, the move from the key file to the
// store, and the removal.

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakedeps"
)

const setupKeyPageURL = "http://127.0.0.1:40123/AAAAtokenAAAA"
const setupKeyFile = "/home/u/.config/zai-plugin-cc/env"
const setupKeyOld = "zt-OLD.key_0123456789abcdef"

// setupKeyEntry is the fake page: opening it schedules the user's paste `after` polls later; the
// host then loads what the store holds.
type setupKeyEntry struct {
	keys    *testkit.MemoryKeyStore
	verdict ports.KeyVerdict
	opened  int
	checked []string
	removed []string

	launchURL string
	launchErr error
	// Polls before the user's key lands; negative: never.
	after int
	// Liveness probes before the page ends on its own; negative: it stays open.
	closesAfter int
	// The page ends right after it saves, before setup's next store read sees the key.
	closesOnSave     bool
	removeErr        error
	removeGone       bool
	getAlwaysMissing bool
	probes           int
	polls            int
	world            *fakedeps.Fakes
}

// setupKeyStore is the entry's store, counting the polls setup makes.
type setupKeyStore struct {
	*testkit.MemoryKeyStore
	entry *setupKeyEntry
}

func (s *setupKeyStore) Get(ctx context.Context) (string, bool) {
	if s.entry.opened > 0 && s.entry.after >= 0 {
		s.entry.polls++
		if s.entry.polls == s.entry.after {
			_ = s.MemoryKeyStore.Set(ctx, testkit.TEST_KEY)
		}
	}
	if s.entry.getAlwaysMissing {
		return "", false
	}
	value, ok := s.MemoryKeyStore.Get(ctx)
	if ok {
		s.entry.world.Host.Key = ports.ProviderKey{Value: value, Source: s.MemoryKeyStore.Label()}
		s.entry.world.Host.KeyErr = nil
	}
	return value, ok
}

func (s *setupKeyStore) Remove(ctx context.Context) error {
	if s.entry.removeErr != nil {
		return s.entry.removeErr
	}
	return s.MemoryKeyStore.Remove(ctx)
}

func (e *setupKeyEntry) Store(context.Context) ports.KeyStore {
	return &setupKeyStore{MemoryKeyStore: e.keys, entry: e}
}

func (e *setupKeyEntry) Check(context.Context, string) ports.KeyVerdict {
	e.checked = append(e.checked, "checked")
	return e.verdict
}

func (e *setupKeyEntry) OpenPage(context.Context) (string, error) {
	e.opened++
	return e.launchURL, e.launchErr
}

func (e *setupKeyEntry) PageOpen(ctx context.Context, url string) bool {
	if url != e.launchURL {
		return false
	}
	e.probes++
	if e.closesOnSave && e.after >= 0 && e.polls == e.after-1 {
		_ = e.keys.Set(ctx, testkit.TEST_KEY)
		e.after = -1
		return false
	}
	return e.closesAfter < 0 || e.probes < e.closesAfter
}

func (e *setupKeyEntry) RemoveFromFile(context.Context, string) bool {
	e.removed = append(e.removed, "removed")
	return !e.removeGone
}

// setupKeyWorld is the fakes plus the entry, the host reporting no key.
func setupKeyWorld(t *testing.T) (*fakedeps.Fakes, *setupKeyEntry) {
	t.Helper()
	world := fakedeps.FakeDeps(t)
	entry := &setupKeyEntry{
		keys:      testkit.NewMemoryKeyStore("", "", ""),
		verdict:   ports.KeyVerdictAccepted,
		launchURL: setupKeyPageURL,
		after:     3,
		// The page stays open until the key lands.
		closesAfter: -1,
		world:       &world,
	}
	world.Deps.Host.KeyEntry = entry
	world.Host.KeyEntry = entry
	world.Host.KeyErr = &ports.WorkerError{Kind: ports.WorkerErrorNoKey, Message: "no Z.ai GLM key: export ZAI_API_KEY"}
	return &world, entry
}

// setupKeyTranscript is everything the run printed.
func setupKeyTranscript(world fakedeps.Fakes) string {
	return strings.Join(append(append([]string{}, world.Out.Lines...), world.Out.Errors...), "\n")
}

func TestSetupWithoutAKey(t *testing.T) {
	t.Run("prints the page URL, waits for the store to fill, then finishes setup", func(t *testing.T) {
		world, entry := setupKeyWorld(t)
		if code := cliRun(t, *world, "setup"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		text := world.Out.Text()
		for _, want := range []string{
			"  " + setupKeyPageURL,
			"Add your Z.ai GLM key on this page; setup waits up to 9 minutes for it:",
			"key: saved in macOS Keychain",
			"  key:      present (macOS Keychain)",
		} {
			if !strings.Contains(text, want) {
				t.Fatalf("%q missing from\n%s", want, text)
			}
		}
		if !strings.Contains(text, "\nzai setup: ready.") {
			t.Fatalf("ready line missing from\n%s", text)
		}
		if entry.opened != 1 {
			t.Fatalf("opened = %d, want 1", entry.opened)
		}
		if transcript := setupKeyTranscript(*world); strings.Contains(transcript, testkit.TEST_KEY) {
			t.Fatal("the key leaked into the transcript")
		}
	})

	t.Run("waits 9 minutes for a page that stays open, then exits 6", func(t *testing.T) {
		world, _ := setupKeyWorld(t)
		world.Deps.Host.KeyEntry.(*setupKeyEntry).after = -1
		entry := world.Deps.Host.KeyEntry.(*setupKeyEntry)
		entry.after = -1
		start := world.Clock.Now()
		if code := cliRun(t, *world, "setup"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		if waited := world.Clock.Now() - start; waited != cli.EntryWaitMs {
			t.Fatalf("waited %d ms, want %d", waited, cli.EntryWaitMs)
		}
		if last := world.Out.Lines[len(world.Out.Lines)-1]; last != "Finish in the browser, then run /zai:setup again." {
			t.Fatalf("last line = %q", last)
		}
		if strings.Contains(world.Out.Text(), "ready") {
			t.Fatalf("report = %q", world.Out.Text())
		}
	})

	t.Run("a page that ends without a key (out of tries, timed out, closed) ends the wait at once with exit 6", func(t *testing.T) {
		world, entry := setupKeyWorld(t)
		entry.after = -1
		entry.closesAfter = 4
		start := world.Clock.Now()
		if code := cliRun(t, *world, "setup"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		if waited := world.Clock.Now() - start; waited != 4000 {
			t.Fatalf("waited %d ms, want 4000", waited)
		}
		if last := world.Out.Lines[len(world.Out.Lines)-1]; last != "Finish in the browser, then run /zai:setup again." {
			t.Fatalf("last line = %q", last)
		}
	})

	t.Run("a page that saves and closes between two reads still counts as saved", func(t *testing.T) {
		world, _ := setupKeyWorld(t)
		world.Deps.Host.KeyEntry.(*setupKeyEntry).closesOnSave = true
		if code := cliRun(t, *world, "setup"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if !strings.Contains(world.Out.Text(), "key: saved in macOS Keychain") {
			t.Fatalf("report = %q", world.Out.Text())
		}
		if !strings.Contains(world.Out.Text(), "\nzai setup: ready.") {
			t.Fatalf("report = %q", world.Out.Text())
		}
	})

	t.Run("under --json the progress goes to stderr and stdout stays one JSON document", func(t *testing.T) {
		world, _ := setupKeyWorld(t)
		if code := cliRun(t, *world, "setup", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if !strings.Contains(strings.Join(world.Out.Errors, "\n"), setupKeyPageURL) {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
		parsed := jsonOf(t, world.Out.Text())
		if parsed["ready"] != true {
			t.Fatalf("json = %v", parsed)
		}
		key := parsed["key"].(map[string]any)
		if key["ok"] != true || key["value"] != "macOS Keychain" {
			t.Fatalf("key = %v", key)
		}
	})

	t.Run("a page that cannot start leaves setup to report the missing key", func(t *testing.T) {
		world, entry := setupKeyWorld(t)
		entry.launchErr = errOf("cannot start the key page")
		if code := cliRun(t, *world, "setup"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		if !strings.Contains(world.Out.Text(), "key: cannot open the key page (cannot start the key page)") {
			t.Fatalf("report = %q", world.Out.Text())
		}
		if !strings.Contains(world.Out.Text(), "  key:      MISSING: no Z.ai GLM key") {
			t.Fatalf("report = %q", world.Out.Text())
		}
	})
}

func TestSetupWithAKey(t *testing.T) {
	t.Run("an env key is the user's own: no store, no check, no page", func(t *testing.T) {
		world, entry := setupKeyWorld(t)
		world.Host.Key = ports.ProviderKey{Value: testkit.TEST_KEY, Source: "ZAI_API_KEY"}
		world.Host.KeyErr = nil
		if code := cliRun(t, *world, "setup"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if entry.opened != 0 || len(entry.checked) != 0 || entry.keys.Sets != 0 {
			t.Fatalf("entry was used: opened %d checked %d sets %d", entry.opened, len(entry.checked), entry.keys.Sets)
		}
	})

	t.Run("a key only in the file moves to the store, confirmed by a read-back, and its file line goes", func(t *testing.T) {
		world, entry := setupKeyWorld(t)
		entry.after = -1
		world.Host.Key = ports.ProviderKey{Value: setupKeyOld, Source: setupKeyFile}
		world.Host.KeyErr = nil
		if code := cliRun(t, *world, "setup"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if entry.keys.Value != setupKeyOld {
			t.Fatalf("stored = %q", entry.keys.Value)
		}
		if len(entry.removed) != 1 {
			t.Fatalf("removedFromFile = %d calls", len(entry.removed))
		}
		if !strings.Contains(world.Out.Text(), "key: moved from "+setupKeyFile+" to macOS Keychain") {
			t.Fatalf("report = %q", world.Out.Text())
		}
		if entry.opened != 0 {
			t.Fatalf("opened = %d, want 0", entry.opened)
		}
	})

	t.Run("a store that will not take the key leaves the file alone", func(t *testing.T) {
		world, entry := setupKeyWorld(t)
		entry.after = -1
		entry.keys.FailSet = true
		world.Host.Key = ports.ProviderKey{Value: setupKeyOld, Source: setupKeyFile}
		world.Host.KeyErr = nil
		cliRun(t, *world, "setup")
		if len(entry.removed) != 0 {
			t.Fatalf("removedFromFile = %d calls, want 0", len(entry.removed))
		}
		if !strings.Contains(world.Out.Text(), "key: kept in "+setupKeyFile+": could not store the key in macOS Keychain (exit 1)") {
			t.Fatalf("report = %q", world.Out.Text())
		}
	})

	t.Run("a store that does not give the key back keeps the file; a file line already gone is said so", func(t *testing.T) {
		world, entry := setupKeyWorld(t)
		entry.after = -1
		entry.getAlwaysMissing = true
		world.Host.Key = ports.ProviderKey{Value: setupKeyOld, Source: setupKeyFile}
		world.Host.KeyErr = nil
		cliRun(t, *world, "setup")
		if !strings.Contains(world.Out.Text(), "key: kept in "+setupKeyFile+": macOS Keychain did not return the key") {
			t.Fatalf("report = %q", world.Out.Text())
		}
		if len(entry.removed) != 0 {
			t.Fatalf("removedFromFile = %d calls, want 0", len(entry.removed))
		}

		second, secondEntry := setupKeyWorld(t)
		secondEntry.after = -1
		secondEntry.removeGone = true
		second.Host.Key = ports.ProviderKey{Value: setupKeyOld, Source: setupKeyFile}
		second.Host.KeyErr = nil
		cliRun(t, *second, "setup")
		if !strings.Contains(second.Out.Text(), "key: moved from "+setupKeyFile+" to macOS Keychain (the file line was already gone)") {
			t.Fatalf("report = %q", second.Out.Text())
		}
	})

	t.Run("no migration where the only store is the key file itself", func(t *testing.T) {
		world, entry := setupKeyWorld(t)
		file := testkit.NewMemoryKeyStore(ports.KeyStoreFile, setupKeyFile, setupKeyOld)
		entry.keys = file
		entry.after = -1
		world.Host.Key = ports.ProviderKey{Value: setupKeyOld, Source: setupKeyFile}
		world.Host.KeyErr = nil
		if code := cliRun(t, *world, "setup"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if file.Sets != 0 {
			t.Fatalf("sets = %d, want 0", file.Sets)
		}
		if len(entry.removed) != 0 {
			t.Fatalf("removedFromFile = %d calls, want 0", len(entry.removed))
		}
	})

	t.Run("a stored key the provider refuses opens the page and waits for a different key", func(t *testing.T) {
		world, entry := setupKeyWorld(t)
		entry.verdict = ports.KeyVerdictRefused
		entry.keys.Value = setupKeyOld
		world.Host.Key = ports.ProviderKey{Value: setupKeyOld, Source: "macOS Keychain"}
		world.Host.KeyErr = nil
		if code := cliRun(t, *world, "setup"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if !strings.Contains(world.Out.Text(), "key: Z.ai GLM refused the stored key; enter a new one.") {
			t.Fatalf("report = %q", world.Out.Text())
		}
		if entry.opened != 1 {
			t.Fatalf("opened = %d, want 1", entry.opened)
		}
		if entry.keys.Value != testkit.TEST_KEY {
			t.Fatalf("stored = %q", entry.keys.Value)
		}
		if transcript := setupKeyTranscript(*world); strings.Contains(transcript, setupKeyOld) {
			t.Fatal("the refused key leaked into the transcript")
		}
	})

	t.Run("a stored key the provider rate limits or has no balance for stays, and setup says why it will not work yet", func(t *testing.T) {
		world, entry := setupKeyWorld(t)
		entry.verdict = ports.KeyVerdictLimited
		entry.keys.Value = setupKeyOld
		entry.after = -1
		world.Host.Key = ports.ProviderKey{Value: setupKeyOld, Source: "macOS Keychain"}
		world.Host.KeyErr = nil
		if code := cliRun(t, *world, "setup"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if !strings.Contains(world.Out.Text(),
			"key: Z.ai GLM knows the key but is not taking requests with it yet (a rate limit, or no balance left: top up at https://z.ai/manage-apikey/billing)") {
			t.Fatalf("report = %q", world.Out.Text())
		}
		if entry.opened != 0 {
			t.Fatalf("opened = %d, want 0", entry.opened)
		}
		if entry.keys.Value != setupKeyOld {
			t.Fatalf("stored = %q", entry.keys.Value)
		}
	})

	t.Run("a key file looser than 0600 is reported, not replaced", func(t *testing.T) {
		world, entry := setupKeyWorld(t)
		world.Host.KeyErr = &ports.WorkerError{
			Kind:  ports.WorkerErrorInsecureKeyFile,
			Label: "Z.ai GLM key file", Path: setupKeyFile, Mode: "0644",
		}
		if code := cliRun(t, *world, "setup"); code != cli.ExitNotReady {
			t.Fatalf("exit = %d, want 6", code)
		}
		if entry.opened != 0 {
			t.Fatalf("opened = %d, want 0", entry.opened)
		}
	})
}

func TestSetupRemoveKey(t *testing.T) {
	t.Run("removes the key from the store", func(t *testing.T) {
		world, entry := setupKeyWorld(t)
		entry.keys.Value = testkit.TEST_KEY
		if code := cliRun(t, *world, "setup", "--remove"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if entry.keys.Removes != 1 {
			t.Fatalf("removes = %d, want 1", entry.keys.Removes)
		}
		if !strings.Contains(world.Out.Text(), "key: removed from macOS Keychain") {
			t.Fatalf("report = %q", world.Out.Text())
		}
	})

	t.Run("a store that fails to remove says so and the rest of the removal still runs", func(t *testing.T) {
		world, entry := setupKeyWorld(t)
		entry.removeErr = errOf("could not remove the key in macOS Keychain (tool not found)")
		if code := cliRun(t, *world, "setup", "--remove", "--json"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if !strings.Contains(strings.Join(world.Out.Errors, "\n"), "key: FAILED to remove from macOS Keychain") {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
		parsed := jsonOf(t, world.Out.Text())
		if parsed["removed"] != true {
			t.Fatalf("json = %v", parsed)
		}
	})

	t.Run("without a key entry (a host that has none) setup says nothing about the key", func(t *testing.T) {
		world := fakedeps.FakeDeps(t)
		if code := cliRun(t, world, "setup", "--remove"); code != cli.ExitOK {
			t.Fatalf("exit = %d, want 0", code)
		}
		if strings.Contains(world.Out.Text(), "key:") {
			t.Fatalf("report = %q", world.Out.Text())
		}
	})
}

// errOf makes the one-line errors the entry's fields take.
func errOf(text string) error { return errors.New(text) }
