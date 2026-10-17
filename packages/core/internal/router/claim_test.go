// The claim suite: one answer to "is this our model?" — the resolved provider's
// claim (env overrides included), shared by the worker's router, the front's passthrough and the
// peer registry. An overridden id outside the usual prefix is the provider's everywhere; a
// foreign id is nobody's. The emergency passthrough's case is emergency_test.go's, with the same
// name and assertions.
package router

import (
	"context"
	"fmt"
	"net/http"
	"reflect"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// claimOverride is zai's main model overridden to an id no prefix of it covers.
const claimOverride = "acme-coder-9"

const claimForeign = "kimi-k3"

func claimEnv(extra domain.EnvLookup) domain.EnvLookup {
	env := domain.EnvLookup{"ZAI_MODEL_MAIN": claimOverride}
	for name, value := range extra {
		env[name] = value
	}
	return env
}

func TestClaims(t *testing.T) {
	t.Parallel()
	t.Run("covers the resolved catalog ids and the prefixes, nothing else, and never the empty id", func(t *testing.T) {
		resolved := domain.ResolveProvider(routerProvider, claimEnv(nil))
		claim := resolved.ModelClaim()
		want := domain.ModelClaim{IDs: []string{claimOverride, "glm-5.3-flash"}, Prefixes: []string{"glm-"}}
		if !reflect.DeepEqual(claim, want) {
			t.Fatalf("claim = %+v, want %+v", claim, want)
		}
		for _, check := range []struct {
			model string
			want  bool
		}{
			{model: claimOverride, want: true},
			{model: "glm-anything", want: true},
			{model: claimForeign, want: false},
			{model: "claude-sonnet-5-5", want: false},
			{model: "", want: false},
		} {
			if got := domain.Claims(claim, check.model); got != check.want {
				t.Fatalf("claims(%q) = %v, want %v", check.model, got, check.want)
			}
		}
		// The shipped catalog does not claim the override: only the resolved provider does.
		if domain.Claims(routerProvider.ModelClaim(), claimOverride) {
			t.Fatal("the unresolved provider claims the overridden id")
		}
	})
}

func TestOverriddenModelId(t *testing.T) {
	t.Parallel()
	resolved := domain.ResolveProvider(routerProvider, claimEnv(nil))

	t.Run("is sent to the provider by the worker's router, and a foreign id to Anthropic", func(t *testing.T) {
		anthropic := serveAnthropic(t, "anthropic")
		provider := serveAnthropic(t, "provider")
		port := reservePort(t)
		server := CreateRouter(RouterOptions{
			Provider:    resolved,
			Port:        port,
			Anthropic:   anthropic,
			ProviderURL: provider,
			Key:         func(context.Context) (string, error) { return "k", nil },
			Log:         func(string) {},
		})
		serveRouter(t, server, port)
		if status, body := postBody(t, fmt.Sprintf("http://127.0.0.1:%d", port), "/v1/messages", fmt.Sprintf(`{"model":%q}`, claimOverride), nil); status != 200 || body != "provider" {
			t.Fatalf("the overridden id: %d %q, want the provider's answer", status, body)
		}
		if status, body := postBody(t, fmt.Sprintf("http://127.0.0.1:%d", port), "/v1/messages", fmt.Sprintf(`{"model":%q}`, claimForeign), nil); status != 200 || body != "anthropic" {
			t.Fatalf("a foreign id: %d %q, want anthropic's answer", status, body)
		}
	})

	t.Run("is refused by the front's passthrough, and a foreign id goes to Anthropic", func(t *testing.T) {
		anthropic := serveAnthropic(t, "anthropic")
		options := PassthroughOptions{
			Name:      resolved.Name,
			Display:   resolved.Display,
			Claim:     resolved.ModelClaim(),
			Anthropic: anthropic,
			Env:       ProxyEnv{},
			State:     "degraded after repeated crashes",
		}
		port := serve(t, func(w http.ResponseWriter, req *http.Request) {
			body, err := ReadBody(req, BodyLimitBytes)
			if err != nil {
				return
			}
			PassThrough(options, req, NewResponse(w), body)
		}, nil)
		if status, _ := postBody(t, fmt.Sprintf("http://127.0.0.1:%d", port), "/v1/messages", fmt.Sprintf(`{"model":%q}`, claimOverride), nil); status != 503 {
			t.Fatalf("the overridden id answered %d, want 503", status)
		}
		if status, body := postBody(t, fmt.Sprintf("http://127.0.0.1:%d", port), "/v1/messages", fmt.Sprintf(`{"model":%q}`, claimForeign), nil); status != 200 || body != "anthropic" {
			t.Fatalf("a foreign id: %d %q, want 200 anthropic", status, body)
		}
	})

	t.Run("is announced in the registry, so a peer forwards it here and not a foreign id", func(t *testing.T) {
		env := claimEnv(domain.EnvLookup{"PROVIDER_ROUTERS_HOME": t.TempDir()})
		entry := RegistryEntryFor(routerProvider, env, nil)
		if !domain.Claims(EntryClaim(entry), claimOverride) {
			t.Fatalf("the registry entry = %+v, want the overridden id claimed", entry)
		}
		if err := SaveRegistryEntry(context.Background(), env, entry); err != nil {
			t.Fatal(err)
		}
		lookup := CreatePeerLookup(env, "kimi", nil)
		target, ok := lookup(claimOverride)
		if !ok || target.Name != "zai" || target.Port != entry.Port {
			t.Fatalf("lookup(%q) = %+v %v, want zai on %d", claimOverride, target, ok, entry.Port)
		}
		if _, ok := lookup(claimForeign); ok {
			t.Fatalf("lookup(%q) found a peer, want none", claimForeign)
		}
	})
}
