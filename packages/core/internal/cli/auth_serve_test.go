package cli_test

// The auth-serve suite: the key check's wire, the served page end to end, and plugin.json's
// version.

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/authpage"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit/fakedeps"
)

// authSeen is one request the fake provider endpoint saw.
type authSeen struct {
	path          string
	authorization string
	body          string
}

// authFakeProvider is a provider endpoint answering status, recording what it was sent.
func authFakeProvider(t *testing.T, status func() int) (string, *[]authSeen) {
	t.Helper()
	var mu sync.Mutex
	seen := &[]authSeen{}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		*seen = append(*seen, authSeen{
			path:          r.URL.Path,
			authorization: r.Header.Get("Authorization"),
			body:          string(body),
		})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status())
		_, _ = w.Write([]byte("{}"))
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server.URL + "/api/anthropic/", seen
}

// authProviderWith is the reference provider pointed at base.
func authProviderWith(base string) domain.Provider {
	provider := testkit.ReferenceProvider
	provider.BaseURL = base
	return provider
}

func TestAuthServeCheckKey(t *testing.T) {
	t.Run("sends one minimal ping-tier request with the key as a Bearer token", func(t *testing.T) {
		ok := http.StatusOK
		base, seen := authFakeProvider(t, func() int { return ok })

		verdict := authpage.CheckKey(context.Background(), authProviderWith(base), testkit.TEST_KEY, nil)

		if verdict != ports.KeyVerdictAccepted {
			t.Fatalf("verdict = %q", verdict)
		}
		if len(*seen) != 1 {
			t.Fatalf("requests = %d, want 1", len(*seen))
		}
		request := (*seen)[0]
		if request.path != "/api/anthropic/v1/messages" {
			t.Fatalf("path = %q", request.path)
		}
		if request.authorization != "Bearer "+testkit.TEST_KEY {
			t.Fatalf("authorization = %q", request.authorization)
		}
		wantBody := `{"model":"glm-5.3-flash","max_tokens":1,"messages":[{"role":"user","content":"ping"}]}`
		if request.body != wantBody {
			t.Fatalf("body = %s, want %s", request.body, wantBody)
		}
	})

	t.Run("401 and 403 are refused; 429 and 402 are a known key held back; anything else or no answer is unknown", func(t *testing.T) {
		status := 401
		base, seen := authFakeProvider(t, func() int { return status })
		provider := authProviderWith(base)
		verdict := func() ports.KeyVerdict {
			return authpage.CheckKey(context.Background(), provider, testkit.TEST_KEY, nil)
		}
		if got := verdict(); got != ports.KeyVerdictRefused {
			t.Fatalf("401 = %q", got)
		}
		status = 403
		if got := verdict(); got != ports.KeyVerdictRefused {
			t.Fatalf("403 = %q", got)
		}
		for _, limited := range []int{429, 402} {
			status = limited
			if got := verdict(); got != ports.KeyVerdictLimited {
				t.Fatalf("%d = %q", limited, got)
			}
		}
		for _, unknown := range []int{400, 500} {
			status = unknown
			if got := verdict(); got != ports.KeyVerdictUnknown {
				t.Fatalf("%d = %q", unknown, got)
			}
		}
		if got := authpage.CheckKey(context.Background(), authProviderWith("http://127.0.0.1:1"), testkit.TEST_KEY, nil); got != ports.KeyVerdictUnknown {
			t.Fatalf("no answer = %q", got)
		}
		_ = seen
	})
}

// authPostKey posts the key the page's form takes, the way a browser does.
func authPostKey(t *testing.T, url, key string) string {
	t.Helper()
	page, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	html, _ := io.ReadAll(page.Body)
	page.Body.Close()
	csrf := regexp.MustCompile(`name="csrf" value="([^"]+)"`).FindStringSubmatch(string(html))
	csrfValue := ""
	if csrf != nil {
		csrfValue = csrf[1]
	}
	parsed := strings.SplitN(strings.SplitN(url, "//", 2)[1], "/", 2)
	target, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(fmt.Sprintf("csrf=%s&key=%s", csrfValue, key)))
	target.Header.Set("Origin", "http://"+parsed[0])
	target.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := http.DefaultClient.Do(target)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	return string(body)
}

func TestAuthServeCommand(t *testing.T) {
	t.Run("prints only the URL, checks the key, stores it (the key file in a sandbox HOME) and exits 0", func(t *testing.T) {
		ok := http.StatusOK
		base, _ := authFakeProvider(t, func() int { return ok })
		home := testkit.TempDir(t, "auth-home-")
		provider := authProviderWith(base)
		world := fakedeps.FakeDepsIn(t, map[string]string{"HOME": home}, fakedeps.FakeWorld{Provider: &provider})

		done := make(chan cli.ExitCode, 1)
		go func() {
			done <- cli.RunCli(context.Background(), []string{"auth-serve"}, world.Deps, "/repo")
		}()
		url := authWaitForURL(t, world)
		if !regexp.MustCompile(`^http://127\.0\.0\.1:\d+/[A-Za-z0-9_-]{43}$`).MatchString(url) {
			t.Fatalf("url = %q", url)
		}
		if body := authPostKey(t, url, testkit.TEST_KEY); !strings.Contains(body, "Saved in ") {
			t.Fatalf("page said %q", body)
		}
		select {
		case code := <-done:
			if code != cli.ExitOK {
				t.Fatalf("exit = %d, want 0", code)
			}
		case <-time.After(30 * time.Second):
			t.Fatal("auth-serve did not end")
		}
		file := filepath.Join(home, ".config", "zai-plugin-cc", "env")
		text, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("key file: %v", err)
		}
		if string(text) != "ZAI_API_KEY="+testkit.TEST_KEY+"\n" {
			t.Fatalf("key file = %q", text)
		}
		info, err := os.Stat(file)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o777 != 0o600 {
			t.Fatalf("mode = %v", info.Mode().Perm())
		}
		if !equalStrings(world.Out.Lines, []string{url}) {
			t.Fatalf("lines = %q", world.Out.Lines)
		}
		if len(world.Out.Errors) != 0 {
			t.Fatalf("errors = %q", world.Out.Errors)
		}
	})

	t.Run("exits 6 when the page ends without a key", func(t *testing.T) {
		status := 401
		base, _ := authFakeProvider(t, func() int { return status })
		provider := authProviderWith(base)
		world := fakedeps.FakeDepsIn(t, map[string]string{"HOME": testkit.TempDir(t, "auth-home-")}, fakedeps.FakeWorld{Provider: &provider})
		// A plugin manifest beside the bundle puts the plugin's version on the page.
		manifest := filepath.Join(filepath.Dir(world.Deps.BundlePath), "..", ".claude-plugin", "plugin.json")
		if err := os.MkdirAll(filepath.Dir(manifest), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(manifest, []byte(`{"version":"0.0.1"}`), 0o644); err != nil {
			t.Fatal(err)
		}

		done := make(chan cli.ExitCode, 1)
		go func() {
			done <- cli.RunCli(context.Background(), []string{"auth-serve"}, world.Deps, "/repo")
		}()
		url := authWaitForURL(t, world)
		for i := 0; i < 5; i++ {
			authPostKey(t, url, testkit.TEST_KEY)
		}
		select {
		case code := <-done:
			if code != cli.ExitNotReady {
				t.Fatalf("exit = %d, want 6", code)
			}
		case <-time.After(30 * time.Second):
			t.Fatal("auth-serve did not end")
		}
		if transcript := strings.Join(append(append([]string{}, world.Out.Lines...), world.Out.Errors...), "\n"); strings.Contains(transcript, testkit.TEST_KEY) {
			t.Fatal("the key leaked into the output")
		}
	})
}

// authWaitForURL waits for the URL line the detached page prints (the read goes through the
// record's lock: the page writes from its own goroutine).
func authWaitForURL(t *testing.T, world fakedeps.Fakes) string {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if first, _, found := strings.Cut(world.Out.Text(), "\n"); found || first != "" {
			return first
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("auth-serve printed no URL")
	return ""
}

// equalStrings is reflect.DeepEqual for two string slices, spelled for readability.
func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

func TestAuthServePluginVersion(t *testing.T) {
	t.Run("reads plugin.json beside the bundle's dist/, and is undefined when it is missing or odd", func(t *testing.T) {
		root := testkit.TempDir(t, "auth-plugin-")
		if err := os.MkdirAll(filepath.Join(root, ".claude-plugin"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(root, "dist"), 0o755); err != nil {
			t.Fatal(err)
		}
		bundle := filepath.Join(root, "dist", "zai.js")
		if version, ok := cli.PluginVersion(bundle); ok {
			t.Fatalf("version = %q, want none", version)
		}
		if err := os.WriteFile(filepath.Join(root, ".claude-plugin", "plugin.json"), []byte(`{"version":"0.0.1"}`), 0o644); err != nil {
			t.Fatal(err)
		}
		if version, ok := cli.PluginVersion(bundle); !ok || version != "0.0.1" {
			t.Fatalf("version = %q", version)
		}
		if err := os.WriteFile(filepath.Join(root, ".claude-plugin", "plugin.json"), []byte(`{"version":"<b>"}`), 0o644); err != nil {
			t.Fatal(err)
		}
		if version, ok := cli.PluginVersion(bundle); ok {
			t.Fatalf("version = %q, want none", version)
		}
		if err := os.WriteFile(filepath.Join(root, ".claude-plugin", "plugin.json"), []byte("{not json"), 0o644); err != nil {
			t.Fatal(err)
		}
		if version, ok := cli.PluginVersion(bundle); ok {
			t.Fatalf("version = %q, want none", version)
		}
		if err := os.WriteFile(filepath.Join(root, ".claude-plugin", "plugin.json"), []byte(`{"version":5}`), 0o644); err != nil {
			t.Fatal(err)
		}
		if version, ok := cli.PluginVersion(bundle); ok {
			t.Fatalf("version = %q, want none", version)
		}
	})
}
