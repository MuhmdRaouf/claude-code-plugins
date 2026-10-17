// The five provider plugins' routers as any of them sees the others: where each listens, and what `setup` may do with
// Claude Code's ANTHROPIC_BASE_URL given where it points now. Pure: no I/O, so the settings merge, the router and the
// setup report share one answer.
package domain

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// PluginRouters maps every plugin's router TCP port to its plugin name, so one plugin can tell
// another's router from its own.
var PluginRouters = map[int64]string{
	18787: "zai",
	18788: "kimi",
	18789: "deepseek",
	18790: "minimax",
	18791: "qwen",
}

// schemeDefaultPort lists the ports a WHATWG URL drops as the scheme's default; new URL("https://x:443/") has none.
var schemeDefaultPort = map[string]int64{
	"http":  80,
	"https": 443,
	"ws":    80,
	"wss":   443,
	"ftp":   21,
}

// PortOf is a URL's port, or -1 when it has none or does not parse.
func PortOf(rawURL string) int64 {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" {
		return -1
	}
	return routerPortOf(parsed)
}

// routerPortOf reads the port the way a WHATWG URL reports it: absent, or the scheme's default, or above 65535 all
// count as none (new URL rejects the last outright).
func routerPortOf(parsed *url.URL) int64 {
	text := parsed.Port()
	if text == "" {
		return -1
	}
	port, err := strconv.ParseInt(text, 10, 64)
	if err != nil || port > 65535 {
		return -1
	}
	if schemeDefaultPort[parsed.Scheme] == port {
		return -1
	}
	return port
}

// IsLoopback reports whether only this machine may be an http upstream: tests point it at loopback fakes, and
// everything else must be https.
func IsLoopback(hostname string) bool {
	return hostname == "localhost" || hostname == "::1" || strings.HasPrefix(hostname, "127.")
}

// IsPluginRouterURL reports whether the URL is one of the five plugin routers (loopback host, known port) — the only
// base URL setup may replace. Anything else is the user's own proxy.
func IsPluginRouterURL(rawURL string) bool {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" {
		return false
	}
	return IsLoopback(urlHostname(parsed)) && PluginRouters[routerPortOf(parsed)] != ""
}

// IsPluginRouterProxy reports whether a proxy variable's value names one of the five plugin routers, adding `http://`
// when the value has no scheme the way a proxy URL is read. Proxy mode must not hand such a proxy on: a process
// sending its own upstream requests through the router loops back into itself.
func IsPluginRouterProxy(raw string) bool {
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	return IsPluginRouterURL(raw)
}

// urlHostname mirrors a WHATWG URL's hostname: the host without its port, lowercased, IPv6 brackets kept (JS reports
// "[::1]", never "::1").
func urlHostname(parsed *url.URL) string {
	host := parsed.Host
	if port := parsed.Port(); port != "" {
		host = strings.TrimSuffix(host, ":"+port)
	}
	return strings.ToLower(host)
}

// BaseUrlPlanKind discriminates a BaseUrlPlan.
type BaseUrlPlanKind string

const (
	BaseUrlPlanSet    BaseUrlPlanKind = "set"
	BaseUrlPlanRemove BaseUrlPlanKind = "remove"
	BaseUrlPlanKeep   BaseUrlPlanKind = "keep"
)

// BaseUrlPlan is what happens to env.ANTHROPIC_BASE_URL.
type BaseUrlPlan struct {
	Kind BaseUrlPlanKind
	// URL is where the base URL goes on a set.
	URL string
	// Report is the change to report; a keep that changed nothing has none (a note, not a change: the hook stays
	// silent about it).
	Report *string
}

// KeptPrefix is the report line of a plan that changed nothing: a note, not a change (the hook stays silent about it).
const KeptPrefix = "kept "

// PlanBaseUrl applies: point it at this plugin's router when unset or at a plugin router that is down; a live plugin
// router keeps it (every plugin's router serves every plugin's models, so there is nothing to win by moving it, and
// five hooks moving it back and forth is what this prevents); anything else is the user's own proxy, kept and
// reported.
func PlanBaseUrl(current *string, routerURL string, livePluginURLs []string) BaseUrlPlan {
	if current == nil {
		return setBaseUrlPlan(routerURL, fmt.Sprintf("pointed ANTHROPIC_BASE_URL at %s", routerURL))
	}
	if *current == routerURL {
		return BaseUrlPlan{Kind: BaseUrlPlanKeep}
	}
	other := ""
	if IsPluginRouterURL(*current) {
		other = PluginRouters[PortOf(*current)]
	}
	if other != "" && pluginURLIsLive(livePluginURLs, *current) {
		return BaseUrlPlan{Kind: BaseUrlPlanKeep}
	}
	if other != "" {
		return setBaseUrlPlan(routerURL, fmt.Sprintf(
			"moved ANTHROPIC_BASE_URL from the %s plugin's router (%s, not running) to %s",
			other, *current, routerURL))
	}
	note := fmt.Sprintf("%sANTHROPIC_BASE_URL (%s): your own proxy", KeptPrefix, *current)
	return BaseUrlPlan{Kind: BaseUrlPlanKeep, Report: &note}
}

// PlanBaseUrlRemoval clears: take it out when it points at this plugin's router, repointing it at another live one
// when there is any.
func PlanBaseUrlRemoval(current *string, routerURL string, others []string) BaseUrlPlan {
	if current == nil || *current != routerURL {
		return BaseUrlPlan{Kind: BaseUrlPlanKeep}
	}
	if len(others) == 0 {
		report := fmt.Sprintf("removed ANTHROPIC_BASE_URL (%s)", routerURL)
		return BaseUrlPlan{Kind: BaseUrlPlanRemove, Report: &report}
	}
	first := others[0]
	return setBaseUrlPlan(first, fmt.Sprintf(
		"pointed ANTHROPIC_BASE_URL at another plugin's router (%s)", first))
}

func setBaseUrlPlan(routerURL string, report string) BaseUrlPlan {
	return BaseUrlPlan{Kind: BaseUrlPlanSet, URL: routerURL, Report: &report}
}

func pluginURLIsLive(livePluginURLs []string, want string) bool {
	for _, live := range livePluginURLs {
		if live == want {
			return true
		}
	}
	return false
}
