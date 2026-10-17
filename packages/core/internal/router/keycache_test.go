// The router's key cache against a played store: a hung store never starves the key file, one
// lookup is shared by every request, the provider's 401 drops the kept key, and claude-* never
// waits for any of it. The store is a fake (a real keychain is never read); the upstreams are
// loopback fakes.
package router

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// fakeKeyStore is the OS store as the outage saw it: reads that hang until their context ends (a
// locked keychain waiting on an unlock prompt nobody answers), and the key once told. Every read
// is counted.
type fakeKeyStore struct {
	mu      sync.Mutex
	reads   int
	hangs   bool
	release chan struct{}
	key     string
}

// hangingKeyStore is a store whose reads hang until their context ends.
func hangingKeyStore() *fakeKeyStore {
	return &fakeKeyStore{hangs: true, release: make(chan struct{})}
}

// answeringKeyStore is a store that answers every read with key.
func answeringKeyStore(key string) *fakeKeyStore {
	return &fakeKeyStore{key: key}
}

func (s *fakeKeyStore) Kind() ports.KeyStoreKind { return ports.KeyStoreMacOS }

func (s *fakeKeyStore) Label() string { return "fake keychain" }

func (s *fakeKeyStore) Available(context.Context) bool { return true }

func (s *fakeKeyStore) Set(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.key = key
	return nil
}

func (s *fakeKeyStore) Remove(context.Context) error { return nil }

func (s *fakeKeyStore) Get(ctx context.Context) (string, bool) {
	s.mu.Lock()
	s.reads++
	hangs, release, key := s.hangs, s.release, s.key
	s.mu.Unlock()
	if !hangs {
		return key, key != ""
	}
	select {
	case <-ctx.Done():
		return "", false
	case <-release:
		return key, key != ""
	}
}

// setKey is the key every later read answers with (the rotated key placed in the store).
func (s *fakeKeyStore) setKey(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.key = key
}

// recover ends the hang and answers every later read with key (the keychain unlocked).
func (s *fakeKeyStore) recover(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hangs = false
	s.key = key
	if s.release != nil {
		close(s.release)
		s.release = nil
	}
}

// readCount is how many reads the store saw.
func (s *fakeKeyStore) readCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reads
}

// keyedProvider is the fake provider endpoint: it answers 401 to every key but want ("" accepts
// any), and records each Authorization it was asked with.
type keyedProvider struct {
	mu    sync.Mutex
	want  string
	asked []string
}

func (p *keyedProvider) serve(t *testing.T) *url.URL {
	t.Helper()
	port := serve(t, func(w http.ResponseWriter, req *http.Request) {
		_, _ = io.Copy(io.Discard, req.Body)
		authorization := req.Header.Get("Authorization")
		p.mu.Lock()
		p.asked = append(p.asked, authorization)
		want := p.want
		p.mu.Unlock()
		if want != "" && authorization != "Bearer "+want {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":{"type":"authentication_error","message":"Invalid key"}}`))
			return
		}
		res := NewResponse(w)
		res.Header().Set("Content-Type", "text/event-stream")
		res.WriteHeader(200)
		res.End([]byte("data: ok\n\n"))
	}, nil)
	return mustURL(t, fmt.Sprintf("http://127.0.0.1:%d/api/anthropic", port))
}

// accept is the key the provider answers 200 to (the rotated key).
func (p *keyedProvider) accept(key string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.want = key
}

// bearers is every Authorization the provider was asked with.
func (p *keyedProvider) bearers() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.asked...)
}

// keyRig is a provider router whose key comes from LoadKey over a fake store and a key file in a
// temp home, pointed at loopback fakes.
type keyRig struct {
	port      int
	store     *fakeKeyStore
	home      string
	anthropic *seenList
}

func newKeyRig(t *testing.T, store *fakeKeyStore, providerURL *url.URL) *keyRig {
	t.Helper()
	home := t.TempDir()
	env := domain.EnvLookup{"HOME": home}
	anthropicSeen := &seenList{}
	port := reservePort(t)
	server := CreateRouter(RouterOptions{
		Provider:    routerProvider,
		Port:        port,
		Anthropic:   recordingUpstream(t, "anthropic", "", anthropicSeen),
		ProviderURL: providerURL,
		Key: func(ctx context.Context) (string, error) {
			key, loadErr := adapters.LoadKey(ctx, routerProvider, env, filepath.Join(home, "key"), store)
			if loadErr != nil {
				return "", nil
			}
			return key.Value, nil
		},
		Log: func(string) {},
	})
	serveRouter(t, server, port)
	return &keyRig{port: port, store: store, home: home, anthropic: anthropicSeen}
}

// writeKeyFile puts the key in the home's key file, mode 0600, the line setup writes.
func (r *keyRig) writeKeyFile(t *testing.T, key string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(r.home, "key"), []byte("ZAI_API_KEY="+key+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// post sends one provider request (glm-5.3) and returns its answer and how long it took.
func (r *keyRig) post(t *testing.T) (answer, time.Duration) {
	t.Helper()
	started := time.Now()
	got, err := postAnswer(r.port, "glm-5.3", nil)
	if err != nil {
		t.Fatal(err)
	}
	return got, time.Since(started)
}

func TestRouterKeyCache(t *testing.T) {
	t.Parallel()
	t.Run("router up, store hangs, key file present: the file's key answers 200 within the budget", func(t *testing.T) {
		store := hangingKeyStore()
		providerSeen := &seenList{}
		rig := newKeyRig(t, store, recordingUpstream(t, "provider", "/api/anthropic", providerSeen))
		rig.writeKeyFile(t, "file-key-123")

		got, elapsed := rig.post(t)
		if got.status != 200 {
			t.Fatalf("status = %d, want 200 (body %s)", got.status, got.body)
		}
		if elapsed >= 2*time.Second {
			t.Errorf("the file key arrived after %v; the store's share of the 2 s budget must leave the file its turn", elapsed)
		}
		if seen := providerSeen.list(); len(seen) != 1 || seen[0].headers.Get("Authorization") != "Bearer file-key-123" {
			t.Errorf("the provider saw %v", seen)
		}
	})

	t.Run("store hangs, no key file: the 503 timeout inside the budget, then 200 once the store recovers", func(t *testing.T) {
		store := hangingKeyStore()
		providerSeen := &seenList{}
		rig := newKeyRig(t, store, recordingUpstream(t, "provider", "/api/anthropic", providerSeen))

		got, elapsed := rig.post(t)
		if got.status != 503 {
			t.Fatalf("status = %d, want 503 (body %s)", got.status, got.body)
		}
		if !strings.Contains(got.body, "timed out") {
			t.Errorf("body = %s", got.body)
		}
		if elapsed >= 2*time.Second {
			t.Errorf("the 503 arrived after %v; the store's share of the budget ends the wait sooner", elapsed)
		}

		store.recover("store-key-123")
		again, _ := rig.post(t)
		if again.status != 200 {
			t.Fatalf("status after recovery = %d, want 200 (body %s)", again.status, again.body)
		}
		if seen := providerSeen.list(); len(seen) != 1 || seen[0].headers.Get("Authorization") != "Bearer store-key-123" {
			t.Errorf("the provider saw %v", seen)
		}
	})

	t.Run("cached: 20 parallel provider requests make one store call", func(t *testing.T) {
		store := answeringKeyStore("store-key-123")
		providerSeen := &seenList{}
		rig := newKeyRig(t, store, recordingUpstream(t, "provider", "/api/anthropic", providerSeen))

		const requests = 20
		start := make(chan struct{})
		type result struct {
			status int
			err    error
		}
		results := make(chan result, requests)
		var wait sync.WaitGroup
		for i := 0; i < requests; i++ {
			wait.Add(1)
			go func() {
				defer wait.Done()
				<-start
				got, err := postAnswer(rig.port, "glm-5.3", nil)
				if err != nil {
					results <- result{err: err}
					return
				}
				results <- result{status: got.status}
			}()
		}
		close(start)
		wait.Wait()
		close(results)
		for got := range results {
			if got.err != nil {
				t.Fatal(got.err)
			}
			if got.status != 200 {
				t.Fatalf("status = %d, want 200", got.status)
			}
		}
		if reads := store.readCount(); reads != 1 {
			t.Errorf("%d parallel requests made %d store calls; one shared lookup serves them all", requests, reads)
		}
	})

	t.Run("401 clears: after the provider answers 401, the next request reads the store again", func(t *testing.T) {
		store := answeringKeyStore("stale-key-123")
		provider := &keyedProvider{want: "fresh-key-123"}
		rig := newKeyRig(t, store, provider.serve(t))

		refused, _ := rig.post(t)
		if refused.status != 400 {
			t.Fatalf("the refused key answered %d, want the refusal's 400 (body %s)", refused.status, refused.body)
		}
		if reads := store.readCount(); reads != 1 {
			t.Fatalf("store reads before the rotation = %d, want 1", reads)
		}

		store.setKey("fresh-key-123")
		again, _ := rig.post(t)
		if again.status != 200 {
			t.Fatalf("status after the rotation = %d, want 200 (body %s)", again.status, again.body)
		}
		if reads := store.readCount(); reads != 2 {
			t.Errorf("store reads after the 401 = %d; the kept key must be dropped so the store is read again", reads)
		}
		if bearers := provider.bearers(); len(bearers) != 2 || bearers[1] != "Bearer fresh-key-123" {
			t.Errorf("the provider was asked with %v", bearers)
		}
	})

	t.Run("claude-* untouched: with the store hung, an Anthropic request answers 200 at once", func(t *testing.T) {
		store := hangingKeyStore()
		rig := newKeyRig(t, store, recordingUpstream(t, "provider", "/api/anthropic", &seenList{}))

		started := time.Now()
		got, err := postAnswer(rig.port, "claude-sonnet-5-5", nil)
		if err != nil {
			t.Fatal(err)
		}
		elapsed := time.Since(started)
		if got.status != 200 {
			t.Fatalf("status = %d, want 200", got.status)
		}
		if elapsed >= 500*time.Millisecond {
			t.Errorf("claude-* waited %v for a hung store it never reads", elapsed)
		}
		if reads := store.readCount(); reads != 0 {
			t.Errorf("the store was read %d times for an Anthropic request", reads)
		}
	})
}
