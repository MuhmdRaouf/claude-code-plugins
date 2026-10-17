package keystore_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/keystore"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// The test binary doubles as the tool SpawnRunner spawns: these args make it act like a small
// helper script, so no other runtime is needed on the machine.
const (
	echoHelperArg   = "--keystore-test-echo"   // reads stdin, prints its length, writes "e", exits 3
	quietHelperArg  = "--keystore-test-quiet"  // prints "x", exits 0
	ignoreHelperArg = "--keystore-test-ignore" // exits 0 without reading stdin
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case echoHelperArg:
			data, _ := io.ReadAll(os.Stdin)
			fmt.Fprintf(os.Stdout, "%d", len(data))
			fmt.Fprint(os.Stderr, "e")
			os.Exit(3)
		case quietHelperArg:
			fmt.Fprint(os.Stdout, "x")
			os.Exit(0)
		case ignoreHelperArg:
			os.Exit(0)
		}
	}
	// No test reaches a real OS secret store: every default store runs its tools through a
	// refusing fake.
	keystore.ReplaceSystemRunner(func(context.Context, string, []string, *string) keystore.RunResult {
		return keystore.RunResult{Missing: true}
	})
	os.Exit(m.Run())
}

// otherKey is a second throwaway key, so tests can tell lines apart.
const otherKey = "zt-OTHER.key_9876543210fedcba"

func fileMode(t *testing.T, path string, created fs.FileMode) fs.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	return info.Mode().Perm()
}

func TestKeyFileStore(t *testing.T) {
	ctx := context.Background()
	provider := testkit.ReferenceProvider

	t.Run("writes NAME=<key> as 0600 in a 0700 directory, keeping other lines and replacing an old key line", func(t *testing.T) {
		dir := filepath.Join(testkit.TempDir(t, "keys-"), "conf")
		file := filepath.Join(dir, "env")
		store := keystore.FileKeyStore(provider, file)
		if err := store.Set(ctx, otherKey); err != nil {
			t.Fatalf("set: %v", err)
		}
		content, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if string(content) != "ZAI_API_KEY="+otherKey+"\n" {
			t.Errorf("content = %q, want the one key line", content)
		}
		if got := fileMode(t, file, 0o600); got != 0o600 {
			t.Errorf("file mode = %o, want 600", got)
		}
		if got := fileMode(t, dir, 0o700); got != 0o700 {
			t.Errorf("dir mode = %o, want 700", got)
		}
		if err := os.WriteFile(file, []byte("# mine\nZAI_MAX_CONCURRENCY=4\nexport ZAI_API_KEY=\""+otherKey+"\"\n\n"), 0o600); err != nil {
			t.Fatalf("seed: %v", err)
		}
		if err := store.Set(ctx, testkit.TEST_KEY); err != nil {
			t.Fatalf("set: %v", err)
		}
		content, err = os.ReadFile(file)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		want := "# mine\nZAI_MAX_CONCURRENCY=4\nZAI_API_KEY=" + testkit.TEST_KEY + "\n"
		if string(content) != want {
			t.Errorf("content = %q, want %q", content, want)
		}
		if value, found := store.Get(ctx); value != testkit.TEST_KEY || !found {
			t.Errorf("get = %d chars %v, want the key", len(value), found)
		}
		if !store.Available(ctx) {
			t.Error("available = false, want true")
		}
		if store.Kind() != ports.KeyStoreFile {
			t.Errorf("kind = %q, want file", store.Kind())
		}
		if store.Label() != file {
			t.Errorf("label = %q, want %q", store.Label(), file)
		}
		err = store.Set(ctx, "not a key")
		if err == nil || !strings.Contains(err.Error(), "16-512") {
			t.Fatalf("set(invalid) = %v, want the 16-512 message", err)
		}
		if err := keystore.FileKeyStore(provider, dir).Set(ctx, testkit.TEST_KEY); err == nil {
			t.Error("set into a directory should fail")
		}
	})

	t.Run("get is undefined for a missing file, a file without the line, or a loose file", func(t *testing.T) {
		dir := testkit.TempDir(t, "get-")
		file := filepath.Join(dir, "env")
		store := keystore.FileKeyStore(provider, file)
		if _, found := store.Get(ctx); found {
			t.Error("get found a key with no file at all")
		}
		if err := os.WriteFile(file, []byte("OTHER=1\n"), 0o600); err != nil {
			t.Fatalf("seed: %v", err)
		}
		if _, found := store.Get(ctx); found {
			t.Error("get found a key in a file without the line")
		}
		// The loose-mode refusal is ReadKeyFile's rule.
		loose := filepath.Join(dir, "loose")
		if err := os.WriteFile(loose, []byte("ZAI_API_KEY="+testkit.TEST_KEY+"\n"), 0o644); err != nil {
			t.Fatalf("seed: %v", err)
		}
		if _, found := keystore.FileKeyStore(provider, loose).Get(ctx); found {
			t.Error("get found a key in a file looser than 0600")
		}
		blocked := filepath.Join(dir, "blocked")
		if err := os.WriteFile(blocked, []byte("x"), 0o600); err != nil {
			t.Fatalf("seed: %v", err)
		}
		if _, _, err := keystore.ReadKeyFile(ctx, provider, filepath.Join(blocked, "env")); err == nil {
			t.Error("reading under a file should fail")
		}
		tight := filepath.Join(dir, "tight")
		if err := os.Mkdir(tight, 0o700); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if _, _, err := keystore.ReadKeyFile(ctx, provider, tight); err == nil {
			t.Error("reading a directory should fail")
		}
	})

	t.Run("removeKeyLine drops only the matching line, deletes a file left empty, and reports what it did", func(t *testing.T) {
		dir := testkit.TempDir(t, "remove-")
		file := filepath.Join(dir, "env")
		if err := os.WriteFile(file, []byte("# keep\nZAI_API_KEY="+testkit.TEST_KEY+"\nZAI_MAX_CONCURRENCY=4\n"), 0o600); err != nil {
			t.Fatalf("seed: %v", err)
		}
		if removed, err := keystore.RemoveKeyLine(ctx, provider, file, strPtr(otherKey)); err != nil || removed {
			t.Fatalf("remove(other key) = %v %v, want false nil", removed, err)
		}
		if removed, err := keystore.RemoveKeyLine(ctx, provider, file, strPtr(testkit.TEST_KEY)); err != nil || !removed {
			t.Fatalf("remove(the key) = %v %v, want true nil", removed, err)
		}
		content, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if string(content) != "# keep\nZAI_MAX_CONCURRENCY=4\n" {
			t.Errorf("content = %q, want the other lines kept", content)
		}
		if got := fileMode(t, file, 0o600); got != 0o600 {
			t.Errorf("mode = %o, want 600", got)
		}

		if err := os.WriteFile(file, []byte("ZAI_API_KEY='"+testkit.TEST_KEY+"'\n\n"), 0o600); err != nil {
			t.Fatalf("seed: %v", err)
		}
		if removed, err := keystore.RemoveKeyLine(ctx, provider, file, strPtr(testkit.TEST_KEY)); err != nil || !removed {
			t.Fatalf("remove(the key) = %v %v, want true nil", removed, err)
		}
		if _, err := os.Stat(file); !errors.Is(err, fs.ErrNotExist) {
			t.Errorf("stat after emptying = %v, want not-exist", err)
		}
		if removed, err := keystore.RemoveKeyLine(ctx, provider, file, strPtr(testkit.TEST_KEY)); err != nil || removed {
			t.Errorf("remove with no file = %v %v, want false nil", removed, err)
		}

		if err := os.WriteFile(file, []byte("ZAI_API_KEY="+testkit.TEST_KEY+"\nX=1\n"), 0o600); err != nil {
			t.Fatalf("seed: %v", err)
		}
		if err := keystore.FileKeyStore(provider, file).Remove(ctx); err != nil {
			t.Fatalf("store remove: %v", err)
		}
		content, err = os.ReadFile(file)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if string(content) != "X=1\n" {
			t.Errorf("content = %q, want X=1 only", content)
		}
		if _, err := keystore.RemoveKeyLine(ctx, provider, dir, nil); err == nil {
			t.Error("removing lines from a directory should fail")
		}
	})

	t.Run("keyFilePath expands ~ from the env's HOME", func(t *testing.T) {
		env := domain.EnvLookup{"HOME": "/h"}
		expanded := filepath.Join("/h", ".config", "zai-plugin-cc", "env")
		if got := keystore.KeyFilePath(provider, env, provider.KeyFile); got != expanded {
			t.Errorf("path = %q, want the expanded key file %q", got, expanded)
		}
		if got := keystore.KeyFilePath(provider, env, "/abs/env"); got != "/abs/env" {
			t.Errorf("absolute path = %q, want it unchanged", got)
		}
		t.Setenv("HOME", "/host-home")
		if got := keystore.KeyFilePath(provider, domain.EnvLookup{}, provider.KeyFile); got != filepath.Join("/host-home", ".config", "zai-plugin-cc", "env") {
			t.Errorf("path = %q, want the host home's key file", got)
		}
		t.Setenv("HOME", "")
		if got := keystore.KeyFilePath(provider, domain.EnvLookup{}, "/abs/env"); got != "/abs/env" {
			t.Errorf("path with no home anywhere = %q, want it unchanged", got)
		}
	})
}

func TestWritableKeyStore(t *testing.T) {
	ctx := context.Background()
	provider := testkit.ReferenceProvider

	t.Run("the platform store when it answers, else the key file", func(t *testing.T) {
		home := testkit.TempDir(t, "home-")
		fake := testkit.NewFakeRunner()
		platform := "darwin"
		options := keystore.PlatformOptions{Platform: &platform, Runner: asRunner(fake), AccountHome: &home}
		env := domain.EnvLookup{"HOME": home}
		if store := keystore.WritableKeyStore(ctx, provider, env, options); store.Kind() != ports.KeyStoreMacOS {
			t.Errorf("kind = %q, want macos", store.Kind())
		}
		fake.Answer = func(testkit.RunCall) testkit.RunResult { return res(1, "", "") }
		fallback := keystore.WritableKeyStore(ctx, provider, env, options)
		if want := filepath.Join(home, ".config/zai-plugin-cc/env"); fallback.Label() != want {
			t.Errorf("label = %q, want %q", fallback.Label(), want)
		}
		sandbox := domain.EnvLookup{"HOME": testkit.TempDir(t, "sandbox-")}
		if store := keystore.WritableKeyStore(ctx, provider, sandbox, options); store.Kind() != ports.KeyStoreFile {
			t.Errorf("sandbox kind = %q, want file", store.Kind())
		}
	})

	t.Run("under test, the default runner reaches no real tool", func(t *testing.T) {
		home := testkit.TempDir(t, "default-")
		env := domain.EnvLookup{"HOME": home}
		store := keystore.WritableKeyStore(ctx, provider, env, keystore.PlatformOptions{AccountHome: &home})
		if store.Kind() != ports.KeyStoreFile {
			t.Errorf("kind = %q, want file", store.Kind())
		}
		swapped := keystore.Runner(func(context.Context, string, []string, *string) keystore.RunResult {
			code := 7
			return keystore.RunResult{Code: &code, Stdout: "swapped"}
		})
		previous := keystore.ReplaceSystemRunner(swapped)
		// previous is the refusing runner the test binary installs: every tool is missing.
		if answer := previous(ctx, keystore.Security, nil, nil); !answer.Missing {
			t.Error("the default runner reaches a real tool")
		}
		restored := keystore.ReplaceSystemRunner(previous)
		if answer := restored(ctx, "anything", nil, nil); answer.Code == nil || *answer.Code != 7 || answer.Stdout != "swapped" {
			t.Error("replacing the runner back did not return the runner set")
		}
	})
}

func TestSpawnRunner(t *testing.T) {
	ctx := context.Background()

	t.Run("passes stdin, collects stdout and stderr and the exit code, and never puts stdin in argv", func(t *testing.T) {
		self, err := os.Executable()
		if err != nil {
			t.Fatalf("test binary: %v", err)
		}
		result := keystore.SpawnRunner(ctx, self, []string{echoHelperArg}, strPtr(testkit.TEST_KEY))
		if result.Missing || result.Code == nil || *result.Code != 3 {
			t.Errorf("code = %v missing = %v, want exit 3", result.Code, result.Missing)
		}
		if result.Stdout != fmt.Sprint(len(testkit.TEST_KEY)) {
			t.Errorf("stdout = %q, want the stdin length", result.Stdout)
		}
		if result.Stderr != "e" {
			t.Errorf("stderr = %q, want e", result.Stderr)
		}
		quiet := keystore.SpawnRunner(ctx, self, []string{quietHelperArg}, nil)
		if quiet.Missing || quiet.Code == nil || *quiet.Code != 0 || quiet.Stdout != "x" || quiet.Stderr != "" {
			t.Errorf("result = %+v, want exit 0 with stdout x", quiet)
		}
	})

	t.Run("a missing tool is `missing`; a tool that ignores stdin does not break the runner", func(t *testing.T) {
		missing := keystore.SpawnRunner(ctx, filepath.Join(testkit.TempDir(t, "tool-"), "no-such-tool"), nil, strPtr(testkit.TEST_KEY))
		if !missing.Missing || missing.Code != nil || missing.Stdout != "" || missing.Stderr != "" {
			t.Errorf("result = %+v, want missing", missing)
		}
		self, err := os.Executable()
		if err != nil {
			t.Fatalf("test binary: %v", err)
		}
		big := strings.Repeat("x", 1<<20)
		quick := keystore.SpawnRunner(ctx, self, []string{ignoreHelperArg}, &big)
		if quick.Missing || quick.Code == nil || *quick.Code != 0 {
			t.Errorf("code = %v missing = %v, want exit 0", quick.Code, quick.Missing)
		}
	})
}
