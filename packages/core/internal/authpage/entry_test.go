package authpage

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/keystore"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// The page entry. The page server itself runs as the test binary in child mode (spawned as
// `<self> <provider> cli auth-serve`, the binary's own re-entry), reading its script from the
// fakeScript env name; no test opens a browser or touches a real OS key store.

const URL_LINE = "http://127.0.0.1:40123/abc_DEF-123"

// fakeScript carries the stand-in page server's script path to the child-mode test binary.
const fakeScript = "AUTHPAGE_FAKE_SCRIPT"

func TestMain(m *testing.M) {
	// The child the page launcher spawns: this binary, with the provider at argv[1], "cli" at
	// argv[2] and "auth-serve" at argv[3].
	if len(os.Args) > 3 && os.Args[2] == "cli" && os.Args[3] == "auth-serve" {
		runFakeBundle(os.Getenv(fakeScript))
		return
	}
	// No test reaches a real OS secret store: every default store runs its tools through a
	// refusing fake.
	keystore.ReplaceSystemRunner(func(context.Context, string, []string, *string) keystore.RunResult {
		return keystore.RunResult{Missing: true}
	})
	os.Exit(m.Run())
}

// runFakeBundle prints what its script says, then lingers a moment (as auth-serve would serve on).
func runFakeBundle(bundlePath string) {
	script, err := os.ReadFile(bundlePath)
	if err != nil {
		os.Exit(9)
	}
	output := ""
	lingerMs := 300
	for _, line := range strings.Split(string(script), "\n") {
		name, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		switch name {
		case "output":
			output = value
		case "linger":
			lingerMs, _ = strconv.Atoi(value)
		}
	}
	// The URL is one line: the script's output value carries no line break of its own, so one
	// is added here (an empty output prints nothing at all, as the .mjs did).
	if output != "" {
		_, _ = os.Stdout.WriteString(output + "\n")
	}
	time.Sleep(time.Duration(lingerMs) * time.Millisecond)
	os.Exit(0)
}

// bundle writes the stand-in page server's script: print output, then linger.
func bundle(t *testing.T, output string, lingerMs int) string {
	t.Helper()
	file := filepath.Join(t.TempDir(), "fake-bundle.txt")
	script := "output=" + output + "\nlinger=" + strconv.Itoa(lingerMs) + "\n"
	if err := os.WriteFile(file, []byte(script), 0o600); err != nil {
		t.Fatalf("write the fake bundle: %v", err)
	}
	return file
}

// pageEnv is the env a LaunchPage test passes: the fake server's script rides in fakeScript.
func pageEnv(t *testing.T, output string, lingerMs int) domain.EnvLookup {
	t.Helper()
	return domain.EnvLookup{fakeScript: bundle(t, output, lingerMs)}
}

// asRunner adapts a FakeRunner to the keystore Runner: the signatures match, the named result
// types live one per package (the adapter cannot import the test kit).
func asRunner(fake *testkit.FakeRunner) keystore.Runner {
	return func(ctx context.Context, cmd string, args []string, stdin *string) keystore.RunResult {
		answer := fake.Run(ctx, cmd, args, stdin)
		return keystore.RunResult{Code: answer.Code, Stdout: answer.Stdout, Stderr: answer.Stderr, Missing: answer.Missing}
	}
}

func TestPageOpen(t *testing.T) {
	t.Run("is true while the page's port listens and false once it closed", func(t *testing.T) {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("listen: %v", err)
		}
		go func() {
			for {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				conn.Close()
			}
		}()
		port := listener.Addr().(*net.TCPAddr).Port
		pageURL := fmt.Sprintf("http://127.0.0.1:%d/token", port)
		ctx := context.Background()
		if !PageOpen(ctx, pageURL) {
			t.Error("a listening port counts as closed")
		}
		entry := CreateKeyEntry(KeyEntryOptions{Provider: testkit.ReferenceProvider, Env: domain.EnvLookup{}})
		if !entry.PageOpen(ctx, pageURL) {
			t.Error("the entry's probe sees a listening port as closed")
		}
		listener.Close()
		if PageOpen(ctx, pageURL) {
			t.Error("a closed port counts as open")
		}
	})

	t.Run("an unparsable URL counts as closed, a probe out of time as open", func(t *testing.T) {
		if PageOpen(context.Background(), "http://exa mple/") {
			t.Error("an unparsable URL counts as open")
		}
		expired, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
		defer cancel()
		time.Sleep(time.Millisecond)
		if !PageOpen(expired, "http://127.0.0.1:1/token") {
			t.Error("a probe that ran out of time counts as closed")
		}
	})
}

func TestLaunchPage(t *testing.T) {
	t.Run("resolves the URL auth-serve prints first, leaving the server running detached", func(t *testing.T) {
		pageURL, err := LaunchPage(context.Background(), "zai", pageEnv(t, URL_LINE, 300))
		if err != nil {
			t.Fatalf("launch the page: %v", err)
		}
		if pageURL != URL_LINE {
			t.Errorf("url = %q, want %q", pageURL, URL_LINE)
		}
	})

	t.Run("anything but a 127.0.0.1 page URL, or an early exit, is an error", func(t *testing.T) {
		evil, err := LaunchPage(context.Background(), "zai", pageEnv(t, "http://evil.example/x", 300))
		if err == nil {
			t.Fatalf("an off-page URL launched: %q", evil)
		}
		var launchErr *LaunchError
		if !errors.As(err, &launchErr) || launchErr.Reason != "the key page printed no URL" {
			t.Errorf("err = %v, want 'the key page printed no URL'", err)
		}
		early, err := LaunchPage(context.Background(), "zai", pageEnv(t, "", 0))
		if err == nil {
			t.Fatalf("an early exit launched: %q", early)
		}
		if !errors.As(err, &launchErr) || launchErr.Reason != "the key page exited before it started" {
			t.Errorf("err = %v, want 'the key page exited before it started'", err)
		}
	})

	t.Run("a start that fails, or a wait that runs out of time, is an error", func(t *testing.T) {
		noBinary, err := launchPage(context.Background(), func() (string, error) {
			return "/nonexistent/page-binary", nil
		}, "zai", domain.EnvLookup{"HOME": "/tmp"})
		if err == nil {
			t.Fatalf("a missing binary launched: %q", noBinary)
		}
		var launchErr *LaunchError
		if !errors.As(err, &launchErr) || launchErr.Reason != "cannot start the key page" {
			t.Errorf("err = %v, want 'cannot start the key page'", err)
		}
		if err.Error() != launchErr.Reason {
			t.Errorf("Error() = %q, want the reason alone", err.Error())
		}
		noExecutable, err := launchPage(context.Background(), func() (string, error) {
			return "", errors.New("gone")
		}, "zai", domain.EnvLookup{})
		if err == nil {
			t.Fatalf("a missing executable launched: %q", noExecutable)
		}
		if !errors.As(err, &launchErr) || launchErr.Reason != "cannot start the key page" {
			t.Errorf("err = %v, want 'cannot start the key page'", err)
		}
		expired, cancel := context.WithCancel(context.Background())
		cancel()
		timedOut, err := launchPage(expired, os.Executable, "zai", pageEnv(t, "", 500))
		if err == nil {
			t.Fatalf("a cancelled launch resolved: %q", timedOut)
		}
		if !errors.As(err, &launchErr) || launchErr.Reason != "the key page did not start in time" {
			t.Errorf("err = %v, want 'the key page did not start in time'", err)
		}
	})
}

func TestCreateKeyEntry(t *testing.T) {
	t.Run("opens the launched page in the browser, and only a launched one", func(t *testing.T) {
		var opened []string
		home := t.TempDir()
		entry := CreateKeyEntry(KeyEntryOptions{
			Provider: testkit.ReferenceProvider,
			Env:      domain.EnvLookup{"HOME": home},
			Launch: func(ctx context.Context, provider string, env domain.EnvLookup) (string, error) {
				if provider == testkit.ReferenceProvider.Name {
					return URL_LINE, nil
				}
				return "", &LaunchError{Reason: "wrong provider"}
			},
			OpenURL: func(pageURL string) { opened = append(opened, pageURL) },
		})
		pageURL, err := entry.OpenPage(context.Background())
		if err != nil || pageURL != URL_LINE {
			t.Fatalf("openPage = %q, %v; want %q", pageURL, err, URL_LINE)
		}
		if strings.Join(opened, "|") != URL_LINE {
			t.Errorf("opened = %v, want the page's URL", opened)
		}
		failing := CreateKeyEntry(KeyEntryOptions{
			Provider: testkit.ReferenceProvider,
			Env:      domain.EnvLookup{"HOME": home},
			Launch: func(ctx context.Context, provider string, env domain.EnvLookup) (string, error) {
				return "", &LaunchError{Reason: "cannot start the key page"}
			},
			OpenURL: func(pageURL string) { opened = append(opened, pageURL) },
		})
		if _, err := failing.OpenPage(context.Background()); err == nil {
			t.Error("a failed launch opened a page")
		}
		if strings.Join(opened, "|") != URL_LINE {
			t.Errorf("opened = %v, want only the launched page's URL", opened)
		}
	})

	t.Run("the default opener opens a launched page through the browser start", func(t *testing.T) {
		// The platform's opener is a fake that records its argument: the real one would open a
		// browser window on the machine running the tests.
		shim := t.TempDir()
		saw := filepath.Join(shim, "opened")
		script := "#!/bin/sh\nprintf '%s\\n' \"$1\" > \"" + saw + "\"\n"
		for _, name := range []string{"open", "xdg-open"} {
			if err := os.WriteFile(filepath.Join(shim, name), []byte(script), 0o755); err != nil {
				t.Fatal(err)
			}
		}
		t.Setenv("PATH", shim)
		entry := CreateKeyEntry(KeyEntryOptions{
			Provider: testkit.ReferenceProvider,
			Env:      domain.EnvLookup{},
			Launch: func(ctx context.Context, provider string, env domain.EnvLookup) (string, error) {
				return URL_LINE, nil
			},
		})
		pageURL, err := entry.OpenPage(context.Background())
		if err != nil || pageURL != URL_LINE {
			t.Fatalf("openPage = %q, %v; want %q with the failure swallowed", pageURL, err, URL_LINE)
		}
		deadline := time.Now().Add(2 * time.Second)
		for {
			if raw, err := os.ReadFile(saw); err == nil {
				if string(raw) != URL_LINE+"\n" {
					t.Fatalf("the opener saw %q, want %q", raw, URL_LINE)
				}
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("the default opener never ran")
			}
			time.Sleep(25 * time.Millisecond)
		}
		if BrowserStartDetached("nonexistent-page-opener", []string{URL_LINE}, BrowserStartOptions{}).Pid != 0 {
			t.Error("a missing opener started a process")
		}
	})

	t.Run("stores through the platform store, checks through fetch, and retires the file line", func(t *testing.T) {
		home := testkit.TempDir(t, "auth-entry-home-")
		fake := testkit.NewFakeRunner()
		statuses := []int{}
		linux := "linux"
		entry := CreateKeyEntry(KeyEntryOptions{
			Provider: testkit.ReferenceProvider,
			Env:      domain.EnvLookup{"HOME": home},
			PlatformOptions: keystore.PlatformOptions{
				Platform:    &linux,
				Runner:      asRunner(fake),
				AccountHome: &home,
			},
			Fetch: func(ctx context.Context, request FetchRequest) (FetchResponse, error) {
				statuses = append(statuses, 401)
				return FetchResponse{Status: 401, OK: false}, nil
			},
		})
		ctx := context.Background()
		store := entry.Store(ctx)
		if store.Label() != "Secret Service" {
			t.Errorf("store label = %q, want the Secret Service", store.Label())
		}
		if verdict := entry.Check(ctx, testkit.TEST_KEY); verdict != ports.KeyVerdictRefused {
			t.Errorf("check = %q, want refused", verdict)
		}
		if len(statuses) != 1 || statuses[0] != 401 {
			t.Errorf("statuses = %v, want one 401", statuses)
		}

		file := filepath.Join(home, ".config/zai-plugin-cc/env")
		sandboxed := CreateKeyEntry(KeyEntryOptions{Provider: testkit.ReferenceProvider, Env: domain.EnvLookup{"HOME": home}})
		if err := sandboxed.Store(ctx).Set(ctx, testkit.TEST_KEY); err != nil {
			t.Fatalf("store the key in the sandbox's file: %v", err)
		}
		if err := os.WriteFile(file, []byte("X=1\nZAI_API_KEY="+testkit.TEST_KEY+"\n"), 0o600); err != nil {
			t.Fatalf("write the key file: %v", err)
		}
		if !entry.RemoveFromFile(ctx, testkit.TEST_KEY) {
			t.Error("the key file's line was not retired")
		}
		content, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read the key file: %v", err)
		}
		if string(content) != "X=1\n" {
			t.Errorf("the key file = %q, want %q", content, "X=1\n")
		}
	})
}

func TestOpenInBrowser(t *testing.T) {
	t.Run("open on macOS, xdg-open on Linux; a failure is swallowed", func(t *testing.T) {
		type started struct {
			cmd  string
			args []string
		}
		var calls []started
		fake := func(command string, args []string, options BrowserStartOptions) process.Detached {
			calls = append(calls, started{cmd: command, args: append([]string{}, args...)})
			return process.Detached{Pid: 1}
		}
		OpenInBrowser(URL_LINE, "darwin", fake)
		OpenInBrowser(URL_LINE, "linux", fake)
		want := []string{
			"open " + URL_LINE,
			"xdg-open " + URL_LINE,
		}
		for i, call := range calls {
			got := call.cmd + " " + strings.Join(call.args, " ")
			if got != want[i] {
				t.Errorf("started %d = %q, want %q", i, got, want[i])
			}
		}
		throwing := func(command string, args []string, options BrowserStartOptions) process.Detached {
			panic("no opener")
		}
		OpenInBrowser(URL_LINE, "linux", throwing)
	})
}
