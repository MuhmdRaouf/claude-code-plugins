package domain

import "testing"

func TestPluginRouters(t *testing.T) {
	want := map[int64]string{
		18787: "zai",
		18788: "kimi",
		18789: "deepseek",
		18790: "minimax",
		18791: "qwen",
	}
	if len(PluginRouters) != len(want) {
		t.Fatalf("PluginRouters has %d entries, want %d", len(PluginRouters), len(want))
	}
	for port, plugin := range want {
		if PluginRouters[port] != plugin {
			t.Fatalf("PluginRouters[%d] = %q, want %q", port, PluginRouters[port], plugin)
		}
	}
}

func TestPortOf(t *testing.T) {
	cases := []struct {
		url  string
		want int64
	}{
		{"http://localhost:18787/", 18787},
		{"http://127.0.0.1:18791/x", 18791},
		{"http://LOCALHOST:18788", 18788},
		{"http://x:043/", 43},
		{"http://localhost:8080", 8080},
		{"https://localhost:8443", 8443},
		{"https://api.z.ai", -1},
		{"http://localhost/", -1},
		{"https://localhost:443/", -1},
		{"http://x:80/", -1},
		{"ws://x:80/", -1},
		{"http://x:99999999999999999999/", -1},
		{"http://[::1", -1},
		{"http://x:abc/", -1},
		{"//localhost:18787", -1},
		{"localhost:18787", -1},
		{"not a url", -1},
		{"", -1},
	}
	for _, tc := range cases {
		if got := PortOf(tc.url); got != tc.want {
			t.Errorf("PortOf(%q) = %d, want %d", tc.url, got, tc.want)
		}
	}
}

func TestIsLoopback(t *testing.T) {
	cases := []struct {
		hostname string
		want     bool
	}{
		{"localhost", true},
		{"::1", true},
		{"127.0.0.1", true},
		{"127.1", true},
		{"[::1]", false},
		{"::ffff:127.0.0.1", false},
		{"LocalHost", false},
		{"localhost.example", false},
		{"example.com", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := IsLoopback(tc.hostname); got != tc.want {
			t.Errorf("IsLoopback(%q) = %v, want %v", tc.hostname, got, tc.want)
		}
	}
}

func TestIsPluginRouterURL(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"http://localhost:18787/", true},
		{"http://127.0.0.1:18791/x", true},
		{"HTTP://LOCALHOST:18788", true},
		{"https://api.z.ai", false},
		{"http://localhost:8080", false},
		{"http://example.com:18787", false},
		{"http://[::1]:18787", false},
		{"http://localhost", false},
		{"//localhost:18787", false},
		{"localhost:18787", false},
		{"http://[::1", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := IsPluginRouterURL(tc.url); got != tc.want {
			t.Errorf("IsPluginRouterURL(%q) = %v, want %v", tc.url, got, tc.want)
		}
	}
}

func TestPlanBaseUrl(t *testing.T) {
	const routerURL = "http://127.0.0.1:18787"
	kimi := "http://localhost:18788"

	t.Run("unset points it at this router", func(t *testing.T) {
		plan := PlanBaseUrl(nil, routerURL, nil)
		if plan.Kind != BaseUrlPlanSet || plan.URL != routerURL {
			t.Fatalf("plan = %+v, want set %q", plan, routerURL)
		}
		if want := "pointed ANTHROPIC_BASE_URL at " + routerURL; plan.Report == nil || *plan.Report != want {
			t.Fatalf("report = %v, want %q", plan.Report, want)
		}
	})

	t.Run("already this router keeps it silently", func(t *testing.T) {
		current := routerURL
		plan := PlanBaseUrl(&current, routerURL, nil)
		if plan.Kind != BaseUrlPlanKeep || plan.Report != nil {
			t.Fatalf("plan = %+v, want keep with no report", plan)
		}
	})

	t.Run("a live plugin router keeps it silently", func(t *testing.T) {
		current := kimi
		plan := PlanBaseUrl(&current, routerURL, []string{kimi})
		if plan.Kind != BaseUrlPlanKeep || plan.Report != nil {
			t.Fatalf("plan = %+v, want keep with no report", plan)
		}
	})

	t.Run("a dead plugin router moves it here", func(t *testing.T) {
		current := kimi
		plan := PlanBaseUrl(&current, routerURL, []string{"http://localhost:18790"})
		if plan.Kind != BaseUrlPlanSet || plan.URL != routerURL {
			t.Fatalf("plan = %+v, want set %q", plan, routerURL)
		}
		want := "moved ANTHROPIC_BASE_URL from the kimi plugin's router (" + kimi + ", not running) to " + routerURL
		if plan.Report == nil || *plan.Report != want {
			t.Fatalf("report = %v, want %q", plan.Report, want)
		}
	})

	t.Run("the user's own proxy is kept and reported", func(t *testing.T) {
		current := "https://proxy.example.com"
		plan := PlanBaseUrl(&current, routerURL, nil)
		if plan.Kind != BaseUrlPlanKeep {
			t.Fatalf("plan = %+v, want keep", plan)
		}
		want := "kept ANTHROPIC_BASE_URL (https://proxy.example.com): your own proxy"
		if plan.Report == nil || *plan.Report != want {
			t.Fatalf("report = %v, want %q", plan.Report, want)
		}
	})

	t.Run("a loopback server on an unknown port is the user's own too", func(t *testing.T) {
		current := "http://localhost:8080"
		plan := PlanBaseUrl(&current, routerURL, nil)
		if plan.Kind != BaseUrlPlanKeep {
			t.Fatalf("plan = %+v, want keep", plan)
		}
		if plan.Report == nil || *plan.Report != "kept ANTHROPIC_BASE_URL (http://localhost:8080): your own proxy" {
			t.Fatalf("report = %v, want the own-proxy note", plan.Report)
		}
	})
}

func TestPlanBaseUrlRemoval(t *testing.T) {
	const routerURL = "http://127.0.0.1:18787"

	t.Run("nothing set keeps it silently", func(t *testing.T) {
		plan := PlanBaseUrlRemoval(nil, routerURL, nil)
		if plan.Kind != BaseUrlPlanKeep || plan.Report != nil {
			t.Fatalf("plan = %+v, want keep with no report", plan)
		}
	})

	t.Run("another URL is not ours to remove", func(t *testing.T) {
		current := "https://proxy.example.com"
		plan := PlanBaseUrlRemoval(&current, routerURL, nil)
		if plan.Kind != BaseUrlPlanKeep || plan.Report != nil {
			t.Fatalf("plan = %+v, want keep with no report", plan)
		}
	})

	t.Run("ours with no other live router removes it", func(t *testing.T) {
		current := routerURL
		plan := PlanBaseUrlRemoval(&current, routerURL, nil)
		if plan.Kind != BaseUrlPlanRemove {
			t.Fatalf("plan = %+v, want remove", plan)
		}
		if want := "removed ANTHROPIC_BASE_URL (" + routerURL + ")"; plan.Report == nil || *plan.Report != want {
			t.Fatalf("report = %v, want %q", plan.Report, want)
		}
	})

	t.Run("ours with another live router repoints it", func(t *testing.T) {
		current := routerURL
		others := []string{"http://localhost:18790"}
		plan := PlanBaseUrlRemoval(&current, routerURL, others)
		if plan.Kind != BaseUrlPlanSet || plan.URL != others[0] {
			t.Fatalf("plan = %+v, want set %q", plan, others[0])
		}
		want := "pointed ANTHROPIC_BASE_URL at another plugin's router (http://localhost:18790)"
		if plan.Report == nil || *plan.Report != want {
			t.Fatalf("report = %v, want %q", plan.Report, want)
		}
	})
}

func TestKeptPrefix(t *testing.T) {
	if KeptPrefix != "kept " {
		t.Fatalf("KeptPrefix = %q, want %q", KeptPrefix, "kept ")
	}
}
