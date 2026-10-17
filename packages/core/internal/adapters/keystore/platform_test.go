package keystore_test

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/keystore"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// keyID is the reference provider's identity in a secret store.
var keyID = keystore.NewKeyIdentity(testkit.ReferenceProvider)

func strPtr(text string) *string { return &text }

// okRes is a tool run that exited 0 with no output.
func okRes() testkit.RunResult {
	code := 0
	return testkit.RunResult{Code: &code}
}

// res is a tool run that exited code with the given output.
func res(code int, stdout string, stderr string) testkit.RunResult {
	return testkit.RunResult{Code: &code, Stdout: stdout, Stderr: stderr}
}

// missingRes is a tool that could not be started.
func missingRes() testkit.RunResult {
	return testkit.RunResult{Missing: true}
}

// asRunner adapts a FakeRunner to the keystore Runner: the signatures match, the named result
// types live one per package (the adapter cannot import the test kit).
func asRunner(fake *testkit.FakeRunner) keystore.Runner {
	return func(ctx context.Context, cmd string, args []string, stdin *string) keystore.RunResult {
		answer := fake.Run(ctx, cmd, args, stdin)
		return keystore.RunResult{Code: answer.Code, Stdout: answer.Stdout, Stderr: answer.Stderr, Missing: answer.Missing}
	}
}

// assertCall checks one recorded run: the command, its argv, and the stdin it was handed (nil:
// none). The values are never printed: the key travels on some of these stdins.
func assertCall(t *testing.T, got testkit.RunCall, cmd string, args []string, stdin *string) {
	t.Helper()
	if got.Cmd != cmd {
		t.Errorf("cmd = %q, want %q", got.Cmd, cmd)
	}
	if !slices.Equal(got.Args, args) {
		t.Errorf("args = %v, want %v", got.Args, args)
	}
	if !stdinEqual(got.Stdin, stdin) {
		t.Error("stdin mismatch")
	}
}

func stdinEqual(got *string, want *string) bool {
	if got == nil || want == nil {
		return got == want
	}
	return *got == *want
}

// expectKeyOnlyOnStdin: the key must be in the stdin of at least one call and in no argv element.
func expectKeyOnlyOnStdin(t *testing.T, fake *testkit.FakeRunner) {
	t.Helper()
	for _, arg := range fake.Argv() {
		if strings.Contains(arg, testkit.TEST_KEY) {
			t.Fatal("the key reached an argv element")
		}
	}
	for _, call := range fake.Calls {
		if call.Stdin != nil && strings.Contains(*call.Stdin, testkit.TEST_KEY) {
			return
		}
	}
	t.Fatal("the key never travelled on stdin")
}

func TestKeyShape(t *testing.T) {
	t.Run("accepts 16-512 chars of [A-Za-z0-9._-] and nothing else", func(t *testing.T) {
		for _, key := range []string{
			testkit.TEST_KEY,
			strings.Repeat("a", 16),
			strings.Repeat("a", 512),
		} {
			if !keystore.IsValidKey(key) {
				t.Errorf("IsValidKey(%d chars) = false, want true", len(key))
			}
		}
		for _, key := range []string{
			strings.Repeat("a", 15),
			strings.Repeat("a", 513),
			strings.Repeat("a", 16) + `"`,
			strings.Repeat("a", 16) + " x",
			strings.Repeat("a", 16) + "\n",
		} {
			if keystore.IsValidKey(key) {
				t.Errorf("IsValidKey(%d chars) = true, want false", len(key))
			}
		}
	})

	t.Run("names the service <name>-plugin-cc and the account api-key; an odd name is refused", func(t *testing.T) {
		want := keystore.KeyIdentity{Service: "zai-plugin-cc", Account: "api-key", Display: "Z.ai GLM"}
		if keyID != want {
			t.Errorf("identity = %+v, want %+v", keyID, want)
		}
		defer func() {
			recovered := recover()
			if recovered == nil {
				t.Fatal("KeyIdentity did not refuse an odd service name")
			}
			if message := fmt.Sprint(recovered); !strings.Contains(message, "unsupported key service name") {
				t.Errorf("panic = %q, want the unsupported-service message", message)
			}
		}()
		keystore.NewKeyIdentity(domain.Provider{Name: `x" -w`, Display: "X"})
	})
}

func TestMacOSKeychain(t *testing.T) {
	ctx := context.Background()

	t.Run("stores through `security -i` with the command line on stdin, then reads it back", func(t *testing.T) {
		fake := testkit.NewFakeRunner()
		fake.Answer = func(call testkit.RunCall) testkit.RunResult {
			if call.Args[0] == "find-generic-password" {
				return res(0, testkit.TEST_KEY+"\n", "")
			}
			return okRes()
		}
		if err := keystore.MacosKeyStore(keyID, asRunner(fake)).Set(ctx, testkit.TEST_KEY); err != nil {
			t.Fatalf("set: %v", err)
		}
		assertCall(t, fake.Calls[0], keystore.Security, []string{"-i"},
			strPtr(`add-generic-password -U -s "zai-plugin-cc" -a "api-key" -w "`+testkit.TEST_KEY+`"`+"\n"))
		assertCall(t, fake.Calls[1], keystore.Security,
			[]string{"find-generic-password", "-s", "zai-plugin-cc", "-a", "api-key", "-w"}, nil)
		expectKeyOnlyOnStdin(t, fake)
	})

	t.Run("a write the read-back does not confirm fails without naming the key", func(t *testing.T) {
		fake := testkit.NewFakeRunner()
		fake.Answer = func(call testkit.RunCall) testkit.RunResult {
			if call.Args[0] == "find-generic-password" {
				return res(44, "", "")
			}
			return okRes()
		}
		err := keystore.MacosKeyStore(keyID, asRunner(fake)).Set(ctx, testkit.TEST_KEY)
		if err == nil || err.Error() != "could not store the key in macOS Keychain (exit 44)" {
			t.Fatalf("set error = %v, want the exit 44 failure", err)
		}
		fake.Answer = func(testkit.RunCall) testkit.RunResult {
			return res(1, "", "bad "+testkit.TEST_KEY)
		}
		err = keystore.MacosKeyStore(keyID, asRunner(fake)).Set(ctx, testkit.TEST_KEY)
		if err == nil || err.Error() != "could not store the key in macOS Keychain (exit 1)" {
			t.Fatalf("set error = %v, want the exit 1 failure", err)
		}
		if strings.Contains(err.Error(), testkit.TEST_KEY) {
			t.Error("the failure names the key")
		}
	})

	t.Run("get trims the newline; not found is undefined; remove deletes through stdin; available probes", func(t *testing.T) {
		fake := testkit.NewFakeRunner()
		store := keystore.MacosKeyStore(keyID, asRunner(fake))
		fake.Answer = func(testkit.RunCall) testkit.RunResult { return res(0, testkit.TEST_KEY+"\n", "") }
		if value, found := store.Get(ctx); value != testkit.TEST_KEY || !found {
			t.Errorf("get = %d chars %v, want the key", len(value), found)
		}
		fake.Answer = func(testkit.RunCall) testkit.RunResult { return res(44, "", "not found") }
		if _, found := store.Get(ctx); found {
			t.Error("get found a key the tool did not return")
		}
		fake.Answer = func(testkit.RunCall) testkit.RunResult { return okRes() }
		if _, found := store.Get(ctx); found {
			t.Error("get found a key in empty output")
		}
		if err := store.Remove(ctx); err != nil {
			t.Fatalf("remove: %v", err)
		}
		assertCall(t, fake.Calls[len(fake.Calls)-1], keystore.Security, []string{"-i"},
			strPtr(`delete-generic-password -s "zai-plugin-cc" -a "api-key"`+"\n"))
		if !store.Available(ctx) {
			t.Error("available = false, want true")
		}
		if want := []string{"default-keychain"}; !slices.Equal(fake.Calls[len(fake.Calls)-1].Args, want) {
			t.Errorf("available probe args = %v, want %v", fake.Calls[len(fake.Calls)-1].Args, want)
		}
		fake.Answer = func(testkit.RunCall) testkit.RunResult { return missingRes() }
		if store.Available(ctx) {
			t.Error("available = true with the tool missing, want false")
		}
		err := store.Remove(ctx)
		if err == nil || err.Error() != "could not remove the key in macOS Keychain (tool not found)" {
			t.Fatalf("remove error = %v, want the tool-not-found failure", err)
		}
		if store.Label() != "macOS Keychain" {
			t.Errorf("label = %q", store.Label())
		}
	})
}

func TestSecretService(t *testing.T) {
	ctx := context.Background()

	t.Run("stores with the key on stdin only (no trailing newline), labelled with the provider", func(t *testing.T) {
		fake := testkit.NewFakeRunner()
		if err := keystore.LinuxKeyStore(keyID, asRunner(fake)).Set(ctx, testkit.TEST_KEY); err != nil {
			t.Fatalf("set: %v", err)
		}
		if len(fake.Calls) != 1 {
			t.Fatalf("runs = %d, want 1", len(fake.Calls))
		}
		assertCall(t, fake.Calls[0], "secret-tool",
			[]string{"store", "--label=Z.ai GLM API key", "service", "zai-plugin-cc", "account", "api-key"},
			strPtr(testkit.TEST_KEY))
		expectKeyOnlyOnStdin(t, fake)
		fake.Answer = func(testkit.RunCall) testkit.RunResult { return res(1, "", "") }
		err := keystore.LinuxKeyStore(keyID, asRunner(fake)).Set(ctx, testkit.TEST_KEY)
		if err == nil || err.Error() != "could not store the key in Secret Service (exit 1)" {
			t.Fatalf("set error = %v, want the exit 1 failure", err)
		}
	})

	t.Run("lookup and clear by service and account", func(t *testing.T) {
		fake := testkit.NewFakeRunner()
		store := keystore.LinuxKeyStore(keyID, asRunner(fake))
		fake.Answer = func(testkit.RunCall) testkit.RunResult { return res(0, testkit.TEST_KEY, "") }
		if value, found := store.Get(ctx); value != testkit.TEST_KEY || !found {
			t.Errorf("get = %d chars %v, want the key", len(value), found)
		}
		if want := []string{"lookup", "service", "zai-plugin-cc", "account", "api-key"}; !slices.Equal(fake.Calls[0].Args, want) {
			t.Errorf("lookup args = %v, want %v", fake.Calls[0].Args, want)
		}
		if store.Label() != "Secret Service" {
			t.Errorf("label = %q", store.Label())
		}
		fake.Answer = func(testkit.RunCall) testkit.RunResult { return res(1, "", "") }
		if _, found := store.Get(ctx); found {
			t.Error("get found a key the tool did not return")
		}
		if err := store.Remove(ctx); err != nil {
			t.Fatalf("remove: %v", err)
		}
		want := []string{"clear", "service", "zai-plugin-cc", "account", "api-key"}
		if !slices.Equal(fake.Calls[len(fake.Calls)-1].Args, want) {
			t.Errorf("clear args = %v, want %v", fake.Calls[len(fake.Calls)-1].Args, want)
		}
		fake.Answer = func(testkit.RunCall) testkit.RunResult { return missingRes() }
		if err := store.Remove(ctx); err == nil || !strings.Contains(err.Error(), "tool not found") {
			t.Fatalf("remove error = %v, want the tool-not-found failure", err)
		}
	})

	t.Run("is unavailable when secret-tool is missing or the bus has no secret service", func(t *testing.T) {
		fake := testkit.NewFakeRunner()
		store := keystore.LinuxKeyStore(keyID, asRunner(fake))
		cases := []struct {
			answer    testkit.RunResult
			available bool
		}{
			{res(0, testkit.TEST_KEY, ""), true},
			{res(1, "", ""), true},
			{res(1, "", "Cannot autolaunch D-Bus without X11 $DISPLAY"), false},
			{res(1, "", "The name org.freedesktop.secrets was not provided"), false},
			{missingRes(), false},
		}
		for _, c := range cases {
			fake.Answer = func(testkit.RunCall) testkit.RunResult { return c.answer }
			if store.Available(ctx) != c.available {
				t.Errorf("available after code %v stderr %q = %v, want %v",
					c.answer.Code, c.answer.Stderr, !c.available, c.available)
			}
		}
	})
}

func TestEveryPlatformStore(t *testing.T) {
	ctx := context.Background()
	stores := []struct {
		name   string
		create func(keystore.KeyIdentity, keystore.Runner) ports.KeyStore
	}{
		{"macos", keystore.MacosKeyStore},
		{"linux", keystore.LinuxKeyStore},
	}
	for _, store := range stores {
		t.Run(store.name+": an invalid key is rejected before any command runs", func(t *testing.T) {
			fake := testkit.NewFakeRunner()
			keyStore := store.create(keyID, asRunner(fake))
			for _, bad := range []string{
				"short",
				strings.Repeat("a", 20) + `" ; rm -rf ~`,
				strings.Repeat("a", 20) + "\nsecond line",
			} {
				err := keyStore.Set(ctx, bad)
				var invalid keystore.InvalidKeyError
				if !errors.As(err, &invalid) {
					t.Fatalf("set(%d chars) error = %v, want InvalidKeyError", len(bad), err)
				}
				if strings.Contains(err.Error(), bad) {
					t.Error("the error names the rejected key")
				}
			}
			if len(fake.Calls) != 0 {
				t.Fatalf("runs = %d, want 0", len(fake.Calls))
			}
		})
	}
}

func TestPlatformKeyStore(t *testing.T) {
	home := "/Users/someone"

	t.Run("picks the platform's store, none elsewhere", func(t *testing.T) {
		fake := testkit.NewFakeRunner()
		pick := func(options keystore.PlatformOptions) string {
			store := keystore.PlatformKeyStore(testkit.ReferenceProvider, domain.EnvLookup{"HOME": home}, options)
			if store == nil {
				return "none"
			}
			return string(store.Kind())
		}
		for _, c := range []struct{ platform, want string }{
			{"darwin", "macos"},
			{"linux", "linux"},
			{"freebsd", "none"},
		} {
			options := keystore.PlatformOptions{
				Platform:    strPtr(c.platform),
				Runner:      asRunner(fake),
				AccountHome: strPtr(home),
			}
			if got := pick(options); got != c.want {
				t.Errorf("pick(%q) = %q, want %q", c.platform, got, c.want)
			}
		}
		// No account home given: the login account's own, whatever the host resolved it to.
		defaults := keystore.PlatformOptions{Platform: strPtr("darwin"), Runner: asRunner(fake)}
		if store := keystore.PlatformKeyStore(testkit.ReferenceProvider, domain.EnvLookup{}, defaults); store == nil || store.Kind() != ports.KeyStoreMacOS {
			t.Error("an env without HOME gets the OS store without an account home too")
		}
		if len(fake.Calls) != 0 {
			t.Errorf("runs = %d, want 0", len(fake.Calls))
		}
	})

	t.Run("a HOME that is not the account's home (a sandbox) gets no OS store", func(t *testing.T) {
		options := keystore.PlatformOptions{Platform: strPtr("darwin"), AccountHome: strPtr(home)}
		if store := keystore.PlatformKeyStore(testkit.ReferenceProvider, domain.EnvLookup{"HOME": "/tmp/sandbox"}, options); store != nil {
			t.Errorf("sandbox store = %q, want none", store.Kind())
		}
		if store := keystore.PlatformKeyStore(testkit.ReferenceProvider, domain.EnvLookup{"HOME": home + "/"}, options); store == nil || store.Kind() != ports.KeyStoreMacOS {
			t.Error("a HOME with a trailing slash is the account's home")
		}
		if store := keystore.PlatformKeyStore(testkit.ReferenceProvider, domain.EnvLookup{}, options); store == nil || store.Kind() != ports.KeyStoreMacOS {
			t.Error("an env without HOME gets the OS store")
		}
	})
}
