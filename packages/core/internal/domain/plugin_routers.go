// The five provider plugins' routers as any of them sees the others: where each listens, and what `setup` may do with
// Claude Code's ANTHROPIC_BASE_URL given where it points now. Pure: no I/O, so the settings merge, the router and the
// setup report share one answer.
package domain

import (
	"fmt"
	"net/url"
	"slices"
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

// ── proxy mode ───────────────────────────────────────────────────────────────────────────────────────────────────────

// ProxyPlanKind discriminates a ProxyPlan.
type ProxyPlanKind string

const (
	ProxyPlanSet     ProxyPlanKind = "proxy-set"
	ProxyPlanKeep    ProxyPlanKind = "proxy-keep"
	ProxyPlanRemove  ProxyPlanKind = "proxy-remove"
	ProxyPlanBaseURL ProxyPlanKind = "base-url"
)

// ownProxyNote is the report of a plan that leaves the user's own proxy or CA alone: proxy mode
// would have to own their keys, so the routing falls back to the base URL.
const ownProxyNote = "kept your own proxy/CA; Remote Control needs ANTHROPIC_BASE_URL unset, so routing uses the base URL"

// ProxySettings is what Claude Code's settings env holds for the proxy keys and the base URL; nil
// is unset.
type ProxySettings struct {
	HTTPSProxy *string
	CA         *string
	NoProxy    *string
	BaseURL    *string
}

// ProxyPlan is what happens to the proxy keys in env, mirroring what a BaseUrlPlan does for
// ANTHROPIC_BASE_URL.
type ProxyPlan struct {
	Kind ProxyPlanKind
	// Proxy, CA and NoProxy are the values a set writes; a keep writes only NoProxy, and only
	// when it carries one; a remove takes HTTPS_PROXY and NODE_EXTRA_CA_CERTS out and leaves NO_PROXY, which
	// may hold the user's own entries and whose loopback ones are harmless.
	Proxy   string
	CA      string
	NoProxy string
	// RemoveBaseURL takes a plugin router's ANTHROPIC_BASE_URL out on the way: proxy mode
	// replaces it.
	RemoveBaseURL bool
	// Report is the change to report; a keep that changed nothing has none (a note, not a change:
	// the hook stays silent about it).
	Report *string
}

// ProxyRouterName is the plugin whose router a proxy variable's value names (a missing scheme is
// added the way a proxy URL is read), "" when it names none of the five.
func ProxyRouterName(raw string) string {
	if !IsPluginRouterProxy(raw) {
		return ""
	}
	return PluginRouters[PortOf(proxyURL(raw))]
}

// ProxyRouterIsLive is whether any of the live plugin router URLs belongs to that plugin.
func ProxyRouterIsLive(livePluginURLs []string, name string) bool {
	for _, url := range livePluginURLs {
		if PluginRouters[PortOf(url)] == name {
			return true
		}
	}
	return false
}

// proxyURL adds the scheme a proxy URL without one reads with.
func proxyURL(raw string) string {
	if !strings.Contains(raw, "://") {
		return "http://" + raw
	}
	return raw
}

// ProxyIsThisRouter is whether a proxy variable's value points at this router: its loopback host
// with this router's port, whatever port that is (the `${P}_ROUTER_PORT` override moves the router
// off the five canonical ones, and a router of ours there is still ours).
func ProxyIsThisRouter(raw, routerURL string) bool {
	port := PortOf(routerURL)
	if port == -1 {
		return false
	}
	parsed, err := url.Parse(proxyURL(raw))
	return err == nil && PortOf(proxyURL(raw)) == port && IsLoopback(urlHostname(parsed))
}

// PlanProxy decides the proxy keys the way PlanBaseUrl decides the base URL: point them at this
// router when unset or at a plugin router that is down; a live plugin router's keys stay (five
// hooks moving them back and forth is what this prevents); the user's own proxy or CA is never
// touched and the plan falls back to base-URL mode instead.
func PlanProxy(env ProxySettings, routerURL, caPath string, livePluginURLs []string) ProxyPlan {
	if env.HTTPSProxy != nil && !ProxyIsThisRouter(*env.HTTPSProxy, routerURL) && ProxyRouterName(*env.HTTPSProxy) == "" {
		note := ownProxyNote
		return ProxyPlan{Kind: ProxyPlanBaseURL, Report: &note}
	}
	ours := env.HTTPSProxy != nil && ProxyIsThisRouter(*env.HTTPSProxy, routerURL)
	// A CA we did not write is only in the way when this plan would have to own it: next to this
	// router a foreign CA cannot reach it, while next to another live plugin router it rides along
	// with that one.
	if env.CA != nil && *env.CA != caPath && (env.HTTPSProxy == nil || ours) {
		note := ownProxyNote
		return ProxyPlan{Kind: ProxyPlanBaseURL, Report: &note}
	}
	noProxy, appended := mergeNoProxy(env.NoProxy)
	staleBaseURL := env.BaseURL != nil && IsPluginRouterURL(*env.BaseURL)
	switch {
	case env.HTTPSProxy == nil:
		report := fmt.Sprintf("pointed HTTPS_PROXY at %s", routerURL)
		return ProxyPlan{Kind: ProxyPlanSet, Proxy: routerURL, CA: caPath, NoProxy: noProxy,
			RemoveBaseURL: staleBaseURL, Report: &report}
	case ours || ProxyRouterIsLive(livePluginURLs, ProxyRouterName(*env.HTTPSProxy)):
		plan := ProxyPlan{Kind: ProxyPlanKeep, RemoveBaseURL: staleBaseURL}
		// A NO_PROXY the user never set is not ours to start on a keep; their own list gets the
		// loopback entries it lacks.
		if env.NoProxy != nil && len(appended) > 0 {
			report := fmt.Sprintf("appended %s to NO_PROXY", strings.Join(appended, " and "))
			plan.NoProxy, plan.Report = noProxy, &report
		}
		return plan
	default:
		name := ProxyRouterName(*env.HTTPSProxy)
		report := fmt.Sprintf("moved HTTPS_PROXY from the %s plugin's router (%s, not running) to %s",
			name, *env.HTTPSProxy, routerURL)
		return ProxyPlan{Kind: ProxyPlanSet, Proxy: routerURL, CA: caPath, NoProxy: noProxy,
			RemoveBaseURL: staleBaseURL, Report: &report}
	}
}

// PlanProxyRemoval clears: take the proxy and CA out when HTTPS_PROXY points at this router,
// repointing it at another live one when there is any; anything else is not ours to touch.
func PlanProxyRemoval(env ProxySettings, routerURL string, others []string) ProxyPlan {
	if env.HTTPSProxy == nil || !ProxyIsThisRouter(*env.HTTPSProxy, routerURL) {
		return ProxyPlan{Kind: ProxyPlanKeep}
	}
	staleBaseURL := env.BaseURL != nil && IsPluginRouterURL(*env.BaseURL)
	if len(others) == 0 {
		report := fmt.Sprintf("removed HTTPS_PROXY and NODE_EXTRA_CA_CERTS (%s)", routerURL)
		return ProxyPlan{Kind: ProxyPlanRemove, RemoveBaseURL: staleBaseURL, Report: &report}
	}
	report := fmt.Sprintf("pointed HTTPS_PROXY at another plugin's router (%s)", others[0])
	return ProxyPlan{Kind: ProxyPlanSet, Proxy: others[0], RemoveBaseURL: staleBaseURL, Report: &report}
}

// mergeNoProxy keeps the user's NO_PROXY entries in their order and appends the loopback entries
// they lack; a nil current starts a fresh list.
func mergeNoProxy(current *string) (merged string, appended []string) {
	entries := []string{}
	if current != nil {
		for _, entry := range strings.Split(*current, ",") {
			if entry = strings.TrimSpace(entry); entry != "" {
				entries = append(entries, entry)
			}
		}
	}
	for _, loopback := range []string{"localhost", "127.0.0.1"} {
		if !slices.Contains(entries, loopback) {
			entries = append(entries, loopback)
			appended = append(appended, loopback)
		}
	}
	return strings.Join(entries, ","), appended
}
