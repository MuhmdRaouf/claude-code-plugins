// Routes Claude Code's API requests by model: the provider's own ids to it with its key, another
// plugin's ids to that plugin's router unchanged, and everything else — every `claude-*` request —
// to Anthropic as is. Only this machine may use it: the server listens on 127.0.0.1 and refuses
// any other Host (DNS rebinding). The router must never cut Claude off: every error path degrades
// to an answer, never a dropped connection.
package router

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf16"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// RouterOptions is what the router needs to know: whose router this is (the resolved provider:
// env model overrides applied), where each kind of request goes, and the plugs the caller owns
// (the key, the log, the spool, the budget gate, the front's token).
type RouterOptions struct {
	// Provider is whose router this is, as resolved for this process (ResolveProvider): the model
	// ids it claims, the fields it strips, its health path and every line it prints.
	Provider domain.Provider
	Port     int
	// Anthropic is where every request for a model this provider does not serve goes, unchanged.
	Anthropic *url.URL
	// ProviderURL is the provider's Anthropic-compatible endpoint.
	ProviderURL *url.URL
	// Key reads the provider's key, only when one of its models is requested (never on the
	// `claude-*` path); "" or an error when there is none. Never logged. The router serves it
	// through its key cache: one shared lookup at a time, kept until the provider refuses the key.
	Key func(ctx context.Context) (string, error)
	// Log receives one line per request: method, path, model, route, status. Never headers or
	// bodies.
	Log func(line string)
	// Peers says which other plugin's router serves a model this one does not; set by the service,
	// nil in tests.
	Peers func(model string) (PeerTarget, bool)
	// Events receives one spool event per forwarded request and the health events (refusals, rate
	// limits, a budget stop), when Radar's spool is reachable.
	Events func(event domain.SpoolEvent)
	// Budget is Radar's budget stop in force for this provider's models (cached by the caller);
	// false: none.
	Budget func() (domain.BudgetStop, bool)
	// Env is the proxy environment upstream requests honour (HTTPS_PROXY, NO_PROXY, …).
	Env ProxyEnv
	// OnUpstream is called just before a request goes upstream, so the front knows the upstream may
	// have seen it.
	OnUpstream func(req *http.Request)
	// Token is the front's token, required on the data path when set: a request without it is
	// answered 403 and never read or forwarded (the worker behind its front takes one; tests on
	// port 0 run without).
	Token string
	// KeyTimeoutMs is how long a key lookup may take before a provider request is answered 503; 0
	// is the default two seconds.
	KeyTimeoutMs int64
	// IdleMs is the upstream silence that ends a request; 0 is the default ten minutes (never a
	// total timeout).
	IdleMs int64
	// BodyLimit is the body limit; 0 is the default 64 MiB.
	BodyLimit int64
}

// PeerHop is the hop header a router stamps on a request it forwards to a peer, so no request is
// ever forwarded twice.
const PeerHop = "x-provider-router-hop"

// RequestID is the header the front stamps on a request it hands its worker, echoed back over IPC
// once it goes upstream.
const RequestID = "x-provider-router-request"

// keyTimeoutDefault is the key lookup's budget: a keychain prompt or a hung store answers the
// provider request 503, never hangs it.
const keyTimeoutDefault int64 = 2000

// keyStoreBudget is the store's share of the key budget: a store that does not answer in it is
// dropped for that lookup, so the key file still gets its turn inside the whole budget. Setup and
// the CLI read the store without it (their own 60 s tool budget stands).
func keyStoreBudget(timeoutMs int64) time.Duration {
	return time.Duration(timeoutMs*3/4) * time.Millisecond
}

// reasonBytes is the most of an error answer the router reads to say why it failed: the judge
// already holds the whole answer back, so these are its first bytes re-read — never a second read,
// and a success answer is never read at all.
const reasonBytes = 2048

// reasonChars is the longest reason a route event or a log line carries.
const reasonChars = 300

// usageLimitBytes is the most of a JSON answer usage tracking buffers: past it nothing more is
// kept and no usage is recorded (the same ceiling the router's other interception points keep, so
// a big answer is never held twice).
const usageLimitBytes = 64 * 1024

// promptRewriteLimitBytes is the most of a provider stream the prompt rewriter may hold back while
// waiting for its first `message_start`; past it the stream goes out as it came, unrewritten (the
// estimate is a courtesy, never a delay).
const promptRewriteLimitBytes = 64 * 1024

// captureMemoMax is the most hashes one router process remembers as already written; past it the
// oldest drops.
const captureMemoMax = 512

// newlineByte is the byte an SSE stream's lines are split on.
const newlineByte = 0x0a

// ── the request body's JSON ─────────────────────────────────────────────────────────────────────────────────────────

// jsonKind discriminates a jsonNode.
type jsonKind uint8

const (
	jsonObject jsonKind = iota
	jsonArray
	jsonString
	jsonNumber
	jsonBool
	jsonNull
)

// jsonNode is one JSON value of a request body. An object keeps its keys in arrival order and an
// array its items, because Go maps lose order and the bytes a provider or the spool reads keep the
// order the client wrote. A nil node is an absent value JSON.stringify drops; a present JSON null
// is a node of kind jsonNull.
type jsonNode struct {
	kind    jsonKind
	str     string
	num     json.Number
	boolean bool
	keys    []string
	fields  map[string]*jsonNode
	items   []*jsonNode
}

// newTextNode is one JSON string.
func newTextNode(value string) *jsonNode {
	return &jsonNode{kind: jsonString, str: value}
}

// newNumberNode is one JSON number.
func newNumberNode(value int64) *jsonNode {
	return &jsonNode{kind: jsonNumber, num: json.Number(strconv.FormatInt(value, 10))}
}

// isObject reports whether the node is an object (false for nil).
func (n *jsonNode) isObject() bool { return n != nil && n.kind == jsonObject }

// get is the key's value; nil when the object does not carry it.
func (n *jsonNode) get(key string) *jsonNode {
	if !n.isObject() {
		return nil
	}
	return n.fields[key]
}

// has reports whether the object carries the key (a JSON null counts).
func (n *jsonNode) has(key string) bool {
	if !n.isObject() {
		return false
	}
	_, present := n.fields[key]
	return present
}

// set assigns the key, appending it when the object does not carry it: a JS assignment, where an
// existing key keeps its position.
func (n *jsonNode) set(key string, value *jsonNode) {
	if n.fields == nil {
		n.fields = map[string]*jsonNode{}
	}
	if _, exists := n.fields[key]; !exists {
		n.keys = append(n.keys, key)
	}
	n.fields[key] = value
}

func (n *jsonNode) del(key string) {
	if n == nil {
		return
	}
	if _, exists := n.fields[key]; !exists {
		return
	}
	delete(n.fields, key)
	for i, k := range n.keys {
		if k == key {
			n.keys = append(n.keys[:i], n.keys[i+1:]...)
			return
		}
	}
}

// parseBodyNode is the parsed JSON body, or nil when it is not JSON.
func parseBodyNode(body []byte) *jsonNode {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	node, err := decodeJSONNode(decoder)
	if err != nil {
		return nil
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil
	}
	return node
}

func decodeJSONNode(decoder *json.Decoder) (*jsonNode, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch token := token.(type) {
	case json.Delim:
		if token == '[' {
			return decodeJSONArray(decoder)
		}
		return decodeJSONObject(decoder)
	case string:
		return newTextNode(token), nil
	case json.Number:
		return &jsonNode{kind: jsonNumber, num: token}, nil
	case bool:
		return &jsonNode{kind: jsonBool, boolean: token}, nil
	}
	// The one shape left is nil: JSON's null.
	return &jsonNode{kind: jsonNull}, nil
}

func decodeJSONObject(decoder *json.Decoder) (*jsonNode, error) {
	node := &jsonNode{kind: jsonObject, fields: map[string]*jsonNode{}}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		// Token() only ever yields a string for an object member name.
		value, err := decodeJSONNode(decoder)
		if err != nil {
			return nil, err
		}
		// A duplicate key overwrites the earlier value in place, as JSON.parse does.
		node.set(keyToken.(string), value)
	}
	// More() is only false at the closing delimiter, so this consumes it.
	_, _ = decoder.Token()
	return node, nil
}

func decodeJSONArray(decoder *json.Decoder) (*jsonNode, error) {
	node := &jsonNode{kind: jsonArray}
	for decoder.More() {
		item, err := decodeJSONNode(decoder)
		if err != nil {
			return nil, err
		}
		node.items = append(node.items, item)
	}
	_, _ = decoder.Token()
	return node, nil
}

// marshalNode is JSON.stringify(node): field order as the client wrote it, no indentation, and
// only ", \ and the C0 controls escaped (nothing else: <, >, &, U+2028 and U+2029 stay raw).
func marshalNode(node *jsonNode) string {
	var b strings.Builder
	writeJSONNode(&b, node)
	return b.String()
}

func writeJSONNode(b *strings.Builder, node *jsonNode) {
	if node == nil {
		// An absent value: JSON.stringify drops it wherever it can appear.
		return
	}
	switch node.kind {
	case jsonObject:
		b.WriteString("{")
		first := true
		for _, key := range node.keys {
			value := node.fields[key]
			if value == nil {
				continue
			}
			if !first {
				b.WriteString(",")
			}
			first = false
			writeJSONString(b, key)
			b.WriteString(":")
			writeJSONNode(b, value)
		}
		b.WriteString("}")
	case jsonArray:
		b.WriteString("[")
		for i, item := range node.items {
			if i > 0 {
				b.WriteString(",")
			}
			if item == nil {
				// JSON.stringify([undefined]) writes null; a parsed body never holds one.
				b.WriteString("null")
				continue
			}
			writeJSONNode(b, item)
		}
		b.WriteString("]")
	case jsonString:
		writeJSONString(b, node.str)
	case jsonNumber:
		b.WriteString(string(node.num))
	case jsonBool:
		if node.boolean {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case jsonNull:
		b.WriteString("null")
	}
}

// writeJSONString writes s quoted the way JSON.stringify quotes it: only ", \ and the C0 controls
// are escaped (\b \t \n \f \r as their two-character forms, the rest as lowercase \u00xx); nothing
// else (<, >, &, U+2028, U+2029) is.
func writeJSONString(b *strings.Builder, s string) {
	b.WriteString(`"`)
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if c < 0x20 {
				fmt.Fprintf(b, `\u%04x`, c)
			} else {
				b.WriteByte(c)
			}
		}
	}
	b.WriteString(`"`)
}

// modelIn is the `model` field of a parsed body, or "".
func modelIn(json *jsonNode) string {
	if model := json.get("model"); model != nil && model.kind == jsonString {
		return model.str
	}
	return ""
}

// ── the prompt capture ─────────────────────────────────────────────────────────────────────────────────────────────
// What a request carried at its top level — its `system` and `tools`, never a header, a key or a
// message — stored once per distinct content. Reading it costs nothing the request pays for: it
// reads the body the router already holds, and the gzip and spool write happen off the request's
// own goroutine.

// capturedHeaderRE is the response headers a route event may carry, case-insensitively; nothing
// else ever leaves.
var capturedHeaderRE = regexp.MustCompile(`^(?i:request-id|x-request-id|retry-after|content-type|anthropic-ratelimit-.+|x-ratelimit-.+)$`)

// CapturedHeaders is the allow-listed response headers one answer carries, lowercased the way the
// route event spells a header name; nil when it answered with none of them.
func CapturedHeaders(header http.Header) *map[string]string {
	out := map[string]string{}
	for name, values := range header {
		if capturedHeaderRE.MatchString(name) {
			// An array header is joined as Node's join(", ") reads it.
			out[strings.ToLower(name)] = strings.Join(values, ", ")
		}
	}
	if len(out) == 0 {
		return nil
	}
	return &out
}

// writeCanonical is the canonical JSON of one value: every object's keys sorted, so the same
// content hashes the same however it arrived. Only parsed values reach it, so no undefined guard
// is needed (PromptHashOf drops the absent tops first).
func writeCanonical(b *strings.Builder, node *jsonNode) {
	switch node.kind {
	case jsonObject:
		keys := append([]string(nil), node.keys...)
		sort.Strings(keys)
		b.WriteString("{")
		for i, key := range keys {
			if i > 0 {
				b.WriteString(",")
			}
			writeJSONString(b, key)
			b.WriteString(":")
			writeCanonical(b, node.fields[key])
		}
		b.WriteString("}")
	case jsonArray:
		b.WriteString("[")
		for i, item := range node.items {
			if i > 0 {
				b.WriteString(",")
			}
			writeCanonical(b, item)
		}
		b.WriteString("]")
	case jsonString:
		writeJSONString(b, node.str)
	case jsonNumber:
		b.WriteString(string(node.num))
	case jsonBool:
		if node.boolean {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case jsonNull:
		b.WriteString("null")
	}
}

// PromptHashOf is the capture hash of a parsed body — sha256 of the canonical JSON of its
// `system` and `tools` alone — false when the body carried neither (a null counts as carried).
func PromptHashOf(json *jsonNode) (string, bool) {
	if !json.isObject() {
		return "", false
	}
	system, tools := json.get("system"), json.get("tools")
	if system == nil && tools == nil {
		return "", false
	}
	var b strings.Builder
	b.WriteString("{")
	first := true
	for _, key := range []string{"system", "tools"} {
		value := json.get(key)
		if value == nil {
			continue
		}
		if !first {
			b.WriteString(",")
		}
		first = false
		writeJSONString(&b, key)
		b.WriteString(":")
		writeCanonical(&b, value)
	}
	b.WriteString("}")
	sum := sha256.Sum256([]byte(b.String()))
	return hex.EncodeToString(sum[:]), true
}

// captureMemo marks the hashes this process has already written; the oldest drops past the memo.
type captureMemo struct {
	mu    sync.Mutex
	seen  map[string]bool
	order []string
}

func newCaptureMemo() *captureMemo {
	return &captureMemo{seen: map[string]bool{}}
}

// first marks the hash as seen; true when this is its first time here (so the event is due).
func (m *captureMemo) first(hash string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.seen[hash] {
		return false
	}
	m.seen[hash] = true
	m.order = append(m.order, hash)
	if len(m.seen) > captureMemoMax {
		oldest := m.order[0]
		m.order = m.order[1:]
		delete(m.seen, oldest)
	}
	return true
}

// promptRef is one request's prompt hash, filled in as the request is dispatched; the route event
// reads it when the request completes.
type promptRef struct {
	mu   sync.Mutex
	hash string
	has  bool
}

func (p *promptRef) setHash(hash string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.hash, p.has = hash, true
}

func (p *promptRef) Hash() *string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.has {
		return nil
	}
	return &p.hash
}

// ── the provider-bound body ────────────────────────────────────────────────────────────────────────────────────────

// StripRejected removes the request fields a provider rejects, wherever they appear (top level,
// content blocks, metadata), and returns the original bytes when the body is not JSON or nothing
// was stripped.
func StripRejected(body []byte, fields []string) []byte {
	return stripParsedBody(body, parseBodyNode(body), fields)
}

// stripParsedBody is StripRejected on a body already parsed once.
func stripParsedBody(body []byte, json *jsonNode, fields []string) []byte {
	if len(fields) == 0 || json == nil {
		return body
	}
	rejected := make(map[string]bool, len(fields))
	for _, field := range fields {
		rejected[field] = true
	}
	if !stripFromNode(json, rejected) {
		return body
	}
	return []byte(marshalNode(json))
}

// stripFromNode removes the fields in place; true when at least one was present anywhere. Every
// element is visited: a field found in the first must not end the walk, or the rest keep theirs.
func stripFromNode(value *jsonNode, rejected map[string]bool) bool {
	switch {
	case value == nil:
		return false
	case value.kind == jsonArray:
		any := false
		for _, item := range value.items {
			if stripFromNode(item, rejected) {
				any = true
			}
		}
		return any
	case value.kind == jsonObject:
		stripped := false
		// The keys are snapshotted: del mutates the object's own order.
		for _, key := range append([]string(nil), value.keys...) {
			if rejected[key] {
				value.del(key)
				stripped = true
			} else if stripFromNode(value.fields[key], rejected) {
				stripped = true
			}
		}
		return stripped
	default:
		return false
	}
}

// providerBody is a provider-bound request as this provider accepts it: rejected fields stripped
// (every message, every block), `max_tokens` clamped to the model's cap, and a web_search tool sent
// to the catalog model that serves it. The original bytes and model when nothing changed, else the
// re-serialised body and the model it now names.
func providerBody(w *routerWorker, original []byte, json *jsonNode, model string, req *http.Request) ([]byte, string) {
	if !json.isObject() {
		return original, model
	}
	if !adaptBody(w, json, model, req) {
		return original, model
	}
	if named := json.get("model"); named == nil || named.kind != jsonString {
		return []byte(marshalNode(json)), model
	}
	return []byte(marshalNode(json)), modelIn(json)
}

// adaptBody is the in-place edits a provider-bound body needs, one truth each: rejected fields
// stripped, `max_tokens` clamped down to the model's cap, and a web_search tool rerouted to the
// model that takes it (one line when it happens).
func adaptBody(w *routerWorker, record *jsonNode, model string, req *http.Request) bool {
	provider := w.opts.Provider
	changed := false
	if len(provider.Strip) > 0 {
		rejected := make(map[string]bool, len(provider.Strip))
		for _, field := range provider.Strip {
			rejected[field] = true
		}
		changed = stripFromNode(record, rejected)
	}
	var cap *int64
	for _, tier := range []domain.ModelTier{domain.ModelTierMain, domain.ModelTierFlash} {
		if entry := provider.Catalog[tier]; entry.ID == model {
			cap = entry.MaxOutputTokens
			break
		}
	}
	if cap != nil {
		if tokens := record.get("max_tokens"); tokens != nil && tokens.kind == jsonNumber {
			if value, err := tokens.num.Float64(); err == nil && value > float64(*cap) {
				record.set("max_tokens", newNumberNode(*cap))
				changed = true
			}
		}
	}
	if provider.WebSearchModel != nil && model != *provider.WebSearchModel && carriesWebSearch(record.get("tools")) {
		record.set("model", newTextNode(*provider.WebSearchModel))
		changed = true
		w.log(fmt.Sprintf("%s %s model=%s → provider: web_search tool served by %s",
			req.Method, requestPath(req), model, *provider.WebSearchModel))
	}
	return changed
}

// carriesWebSearch is true when any tool of the request is a web_search server tool: its `type`
// starts with `web_search_` (`web_search_20250305`, …). A regular tool carries no `type` at all.
func carriesWebSearch(tools *jsonNode) bool {
	if tools == nil || tools.kind != jsonArray {
		return false
	}
	for _, tool := range tools.items {
		if typ := tool.get("type"); typ != nil && typ.kind == jsonString && strings.HasPrefix(typ.str, "web_search_") {
			return true
		}
	}
	return false
}

// requestPath is the request's own path with its query.
func requestPath(req *http.Request) string {
	if req.RequestURI != "" {
		return req.RequestURI
	}
	return req.URL.RequestURI()
}

// UpstreamHeaders is the client's headers for the upstream. A provider-bound request swaps the
// caller's Anthropic credentials for the provider's key, so they never reach the provider; every
// other route keeps them untouched.
func UpstreamHeaders(incoming http.Header, target *url.URL, length int, key string) http.Header {
	out := ForwardHeaders(incoming, target, length)
	out.Del(RequestID)
	out.Del(PeerHop)
	// The front's token belongs to the loopback hop alone; it never reaches an upstream.
	out.Del(TokenHeader)
	if key != "" {
		out.Del("X-Api-Key")
		out.Set("Authorization", "Bearer "+key)
	}
	return out
}

// forwardable is why a target may not be forwarded to, or false: an http upstream must be loopback.
func forwardable(route string, u *url.URL) (string, bool) {
	if u.Scheme == "https" || domain.IsLoopback(u.Hostname()) {
		return "", false
	}
	return fmt.Sprintf("%s upstream must be https unless it is loopback (%s)", route, u.Host), true
}

// ── the worker one router server owns ──────────────────────────────────────────────────────────────────────────────

// routerWorker is the state one router server serves with: the budget stop's health dedup, the
// prompt hashes already captured, and the conversation estimator.
type routerWorker struct {
	opts      RouterOptions
	provider  domain.Provider
	claim     domain.ModelClaim
	captured  *captureMemo
	estimator *PromptEstimator
	// keys is the provider key every request shares, kept until the provider refuses it.
	keys *keyCache
	// budgetStop dedups the budget_stop health events: the scope last seen.
	budgetMu    sync.Mutex
	budgetKnown bool
	budgetScope string
}

// log prints one line when the caller listens.
func (w *routerWorker) log(line string) {
	if w.opts.Log != nil {
		w.opts.Log(line)
	}
}

// health appends one health event for this router's plugin, when anyone listens. Never the key, a
// header or a body.
func (w *routerWorker) health(event domain.RouterHealth, reason, model string) {
	if w.opts.Events != nil {
		w.opts.Events(domain.HealthEvent(w.provider.Name, event, reason, model, time.Now().UnixMilli()))
	}
}

// budget is the stop in force, with one `budget_stop` event each time a scope newly turns this
// router's models off.
func (w *routerWorker) budget(model string) (domain.BudgetStop, bool) {
	var stop domain.BudgetStop
	stopped := false
	if w.opts.Budget != nil {
		stop, stopped = w.opts.Budget()
	}
	w.budgetMu.Lock()
	defer w.budgetMu.Unlock()
	if stopped && (!w.budgetKnown || stop.Scope != w.budgetScope) {
		period := "period"
		if stop.Period != nil {
			period = string(*stop.Period)
		}
		w.health(domain.HealthBudgetStop, fmt.Sprintf("%s budget reached for this %s", stop.Scope, period), model)
	}
	w.budgetKnown, w.budgetScope = stopped, stop.Scope
	return stop, stopped
}

// CreateRouter builds the router's server; listen on it (127.0.0.1) after.
func CreateRouter(opts RouterOptions) *http.Server {
	server, _ := createRouter(opts, nil)
	return server
}

// createRouter also returns the worker core, so the worker process can warm the key cache and
// answer its key checks from it. keyLookup is the worker's own key lookup (the key's source
// included, which its IPC answers name); nil adapts opts.Key.
func createRouter(opts RouterOptions, keyLookup func(ctx context.Context) (ports.ProviderKey, *ports.WorkerError)) (*http.Server, *routerWorker) {
	lookup := keyLookup
	if lookup == nil {
		lookup = func(ctx context.Context) (ports.ProviderKey, *ports.WorkerError) {
			// The plug's error and empty key are both "no key": a request is answered by the
			// outcome (no key, or the timeout), never by the error.
			if opts.Key == nil {
				return ports.ProviderKey{}, nil
			}
			value, err := opts.Key(ctx)
			if err != nil || value == "" {
				return ports.ProviderKey{}, nil
			}
			return ports.ProviderKey{Value: value}, nil
		}
	}
	timeout := keyTimeoutDefault
	if opts.KeyTimeoutMs != 0 {
		timeout = opts.KeyTimeoutMs
	}
	w := &routerWorker{
		opts:      opts,
		provider:  opts.Provider,
		claim:     opts.Provider.ModelClaim(),
		captured:  newCaptureMemo(),
		estimator: NewPromptEstimator(),
		keys:      newKeyCache(lookup, keyStoreBudget(timeout)),
	}
	limit := opts.BodyLimit
	if limit == 0 {
		limit = BodyLimitBytes
	}
	return Harden(&http.Server{Handler: http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		res := NewResponse(rw)
		// Port 0 (tests, and the worker behind its front) takes any Host: only the front faces
		// Claude Code.
		if opts.Port != 0 && RefuseHost(req, res, w.provider.Name, []int{opts.Port}) {
			return
		}
		if req.Method == http.MethodGet && req.URL.Path == w.provider.Router.HealthPath && req.URL.RawQuery == "" {
			res.Header().Set("Content-Type", "application/json")
			res.WriteHeader(200)
			res.End([]byte(marshalCompact(struct {
				OK       bool   `json:"ok"`
				Name     string `json:"name"`
				Provider string `json:"provider"`
			}{OK: true, Name: w.provider.Name, Provider: w.provider.Display})))
			return
		}
		// The worker's data path answers with the provider's key in play, so nothing is read or
		// forwarded before the front's token is on the request (the front stamps it on the hop it
		// hands its worker).
		if opts.Token != "" && req.Header.Get(TokenHeader) != opts.Token {
			AnthropicError(res, 403, "permission_error", w.provider.Name+" router: data path refused")
			return
		}
		Receive(req, res, w.provider.Name, limit, func(body []byte) {
			w.forward(req, res, body)
		})
	})}), w
}

// routeOf is where a request for this model goes: "provider", "anthropic", or "peer:<name>".
func routeOf(claim domain.ModelClaim, model string, peers func(string) (PeerTarget, bool)) (string, PeerTarget, bool) {
	if domain.Claims(claim, model) {
		return "provider", PeerTarget{}, false
	}
	if model != "" && peers != nil {
		if peer, ok := peers(model); ok {
			return "peer:" + peer.Name, peer, true
		}
	}
	return "anthropic", PeerTarget{}, false
}

// hopPresent reports whether the request already carries the peer-hop header.
func hopPresent(req *http.Request) bool {
	return len(req.Header.Values(PeerHop)) > 0
}

// threadsBeta collects the message-threads tokens of the anthropic-beta header: every
// comma-separated token, trimmed, across all header lines, named in the spelling the request
// carried; nil when none. The message-threads betas are Anthropic-only.
func threadsBeta(req *http.Request) []string {
	var tokens []string
	for _, value := range req.Header.Values("anthropic-beta") {
		for _, token := range strings.Split(value, ",") {
			if token = strings.TrimSpace(token); strings.HasPrefix(strings.ToLower(token), "message-threads-") {
				tokens = append(tokens, token)
			}
		}
	}
	return tokens
}

// textHeader is a request header as a non-empty string, or false.
func textHeader(req *http.Request, name string) (string, bool) {
	value := req.Header.Get(name)
	if value == "" {
		return "", false
	}
	return value, true
}

// eventNote is the route event for one request, emitted when it completes; nil when nobody
// listens.
type eventNote func(status int64, route, upstream string, usage domain.RouteUsage, reason *string, headers *map[string]string)

// noteOf builds the request's note: the ids Claude Code stamped the request with, the usage and
// the allow-listed headers the answer carried, and the prompt hash — each only when there was one.
func (w *routerWorker) noteOf(req *http.Request, model string, startedAt int64, prompt *promptRef) eventNote {
	if w.opts.Events == nil {
		return nil
	}
	return func(status int64, route, upstream string, usage domain.RouteUsage, reason *string, headers *map[string]string) {
		event := domain.RouteEvent{
			Ts:         isoNow(),
			Event:      domain.EventRoute,
			Plugin:     w.provider.Name,
			Model:      model,
			Upstream:   upstream,
			Route:      route,
			Status:     status,
			LatencyMs:  time.Now().UnixMilli() - startedAt,
			Error:      reason,
			Headers:    headers,
			PromptHash: prompt.Hash(),
		}
		if session, ok := textHeader(req, "x-claude-code-session-id"); ok {
			event.SessionID = &session
		}
		if agent, ok := textHeader(req, "x-claude-code-agent-id"); ok {
			event.AgentID = &agent
		}
		if parent, ok := textHeader(req, "x-claude-code-parent-agent-id"); ok {
			event.ParentAgentID = &parent
		}
		if len(usage) > 0 {
			carried := usage
			event.Usage = &carried
		}
		w.opts.Events(event)
	}
}

// capture reads what the request's body carried, once per distinct content, and writes its one
// capture event off the request's own goroutine; the hash is set synchronously so the route event
// always names it. A failure costs one log line.
func (w *routerWorker) capture(prompt *promptRef, json *jsonNode) {
	if w.opts.Events == nil {
		return
	}
	hash, ok := PromptHashOf(json)
	if !ok {
		return
	}
	prompt.setHash(hash)
	go func() {
		defer func() {
			if reason := recover(); reason != nil {
				w.log(fmt.Sprintf("route capture: %v", reason))
			}
		}()
		if !w.captured.first(hash) {
			return
		}
		body := marshalNode(&jsonNode{kind: jsonObject, keys: []string{"system", "tools"},
			fields: map[string]*jsonNode{"system": json.get("system"), "tools": json.get("tools")}})
		var compressed bytes.Buffer
		writer := gzip.NewWriter(&compressed)
		_, _ = writer.Write([]byte(body))
		_ = writer.Close()
		w.opts.Events(domain.CaptureEvent{
			Ts:         isoNow(),
			Event:      domain.EventCapture,
			Plugin:     w.provider.Name,
			PromptHash: hash,
			Gz:         base64.StdEncoding.EncodeToString(compressed.Bytes()),
		})
	}()
}

// ── usage tracking ─────────────────────────────────────────────────────────────────────────────────────────────────

// UsageTracker reads an answer's usage as it passes through, never ahead of the pipe: an SSE
// stream is parsed line by line as it goes (only a partial line is ever held), a JSON body carries
// it at the top level and is buffered up to a cap before it is read once it ends — past the cap
// nothing is buffered and no usage is recorded. A compressed answer is read through its
// decompressed copy.
type UsageTracker struct {
	push  func(chunk []byte)
	usage func() domain.RouteUsage
}

// NewUsageTracker tracks the usage of one answer of this content type ("" when the answer carried
// none).
func NewUsageTracker(contentType, encoding string) *UsageTracker {
	if strings.Contains(contentType, "text/event-stream") {
		return sseUsageTracker()
	}
	if strings.Contains(contentType, "application/json") {
		return jsonUsageTracker(encoding)
	}
	return &UsageTracker{}
}

// Push reads one chunk of the passing answer.
func (t *UsageTracker) Push(chunk []byte) {
	if t != nil && t.push != nil {
		t.push(chunk)
	}
}

// Usage is the usage the answer carried; nil when it carried none.
func (t *UsageTracker) Usage() domain.RouteUsage {
	if t == nil || t.usage == nil {
		return nil
	}
	return t.usage()
}

// jsonUsageTracker buffers a JSON answer up to the cap, then reads its top-level usage once.
func jsonUsageTracker(encoding string) *UsageTracker {
	var chunks [][]byte
	size, over := int64(0), false
	var parsed domain.RouteUsage
	done := false
	return &UsageTracker{
		push: func(chunk []byte) {
			size += int64(len(chunk))
			if size > usageLimitBytes {
				over = true
			}
			if !over {
				chunks = append(chunks, append([]byte(nil), chunk...))
			}
		},
		usage: func() domain.RouteUsage {
			if !done {
				done = true
				if !over {
					parsed = topLevelUsage(concatChunks(chunks), encoding)
				}
			}
			return parsed
		},
	}
}

// topLevelUsage is the `usage` at the top level of the collected JSON body, when it parses and
// carries one.
func topLevelUsage(body []byte, encoding string) domain.RouteUsage {
	var parsed any
	if json.Unmarshal(InspectBody(body, encoding), &parsed) != nil {
		return nil
	}
	return nestedUsage(parsed)
}

// sseUsageTracker reads an SSE stream's usage line by line: message_start carries it inside
// `message`, message_delta at its top level; the later event's counters win.
func sseUsageTracker() *UsageTracker {
	rest := ""
	var usage domain.RouteUsage
	take := func(line string) {
		event, ok := sseEventAny(line)
		if !ok {
			return
		}
		var found domain.RouteUsage
		switch event["type"] {
		case "message_start":
			found = nestedUsage(event["message"])
		case "message_delta":
			found = nestedUsage(event)
		}
		if found == nil {
			return
		}
		if usage == nil {
			usage = domain.RouteUsage{}
		}
		for key, value := range found {
			usage[key] = value
		}
	}
	return &UsageTracker{
		push: func(chunk []byte) {
			rest += string(chunk)
			for {
				at := strings.IndexByte(rest, '\n')
				if at < 0 {
					break
				}
				line := rest[:at]
				rest = rest[at+1:]
				take(line)
			}
		},
		usage: func() domain.RouteUsage {
			if len(usage) == 0 {
				return nil
			}
			return usage
		},
	}
}

// sseEventAny is the `data:` line's event object — an SSE event only when it parses to one.
func sseEventAny(line string) (map[string]any, bool) {
	if !strings.HasPrefix(line, "data:") {
		return nil, false
	}
	var event any
	if json.Unmarshal([]byte(strings.TrimSpace(line[len("data:"):])), &event) != nil {
		return nil, false
	}
	object, ok := event.(map[string]any)
	return object, ok
}

// nestedUsage is the `usage` object a value carries, when it carries one.
func nestedUsage(value any) domain.RouteUsage {
	object, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	usage, ok := object["usage"].(map[string]any)
	if !ok {
		return nil
	}
	return domain.RouteUsage(usage)
}

// bodyTap reads the answer once for the tracker as it passes to the client: the pipe comes first,
// so the client never waits on it.
type bodyTap struct {
	source io.ReadCloser
	push   func(chunk []byte)
}

func (t *bodyTap) Read(p []byte) (int, error) {
	n, err := t.source.Read(p)
	if n > 0 {
		t.push(append([]byte(nil), p[:n]...))
	}
	return n, err
}

func (t *bodyTap) Close() error { return t.source.Close() }

// ── the prompt rewriter ────────────────────────────────────────────────────────────────────────────────────────────

// promptRewriter is the stream a provider answer's first `message_start` is rewritten through: a
// pass-through reader that gives it a real prompt size. Z.ai (and other providers) send zeros
// there and only the real numbers in the final `message_delta`, which left Claude Code showing
// "183 tokens" for a subagent holding a 150k-token context. `input_tokens` becomes the
// conversation's estimate and the cache fields are added as 0; every other line goes out byte for
// byte. Whole lines only are looked at (a line may straddle chunks, and no UTF-8 sequence ever
// contains a newline byte), and bytes are held only until the first `message_start` has gone out —
// rewritten or not.
type promptRewriter struct {
	source    io.Reader
	prompt    PromptHint
	estimator *PromptEstimator
	pending   []byte
	out       []byte
	decided   bool
	done      bool
	flushed   bool
}

// Read hands out the rewritten stream, holding back only a partial line until the first
// `message_start` has gone out; after that every byte passes through as it came.
func (r *promptRewriter) Read(p []byte) (int, error) {
	for {
		if len(r.out) > 0 {
			n := copy(p, r.out)
			r.out = r.out[n:]
			return n, nil
		}
		if r.decided {
			return r.source.Read(p)
		}
		if r.done {
			// A stream that ended before its first `message_start` goes out as it came.
			if !r.flushed && len(r.pending) > 0 {
				r.flushed = true
				r.out = r.pending
				r.pending = nil
				continue
			}
			return 0, io.EOF
		}
		buffer := make([]byte, 32*1024)
		n, err := r.source.Read(buffer)
		if n > 0 {
			head := rewriteHead(r.pending, buffer[:n], r.prompt, r.estimator)
			r.pending = nil
			r.decided = head.decided
			if head.decided {
				r.out = append(concatChunks(head.out), head.rest...)
			} else {
				r.out = concatChunks(head.out)
				r.pending = head.rest
			}
		}
		if err == io.EOF {
			r.done = true
		} else if err != nil {
			return 0, err
		}
	}
}

// rewriteResult is one pass of the rewriter: the whole lines ready to go out, the incomplete tail
// held again, and whether the first `message_start` has gone out.
type rewriteResult struct {
	out     [][]byte
	rest    []byte
	decided bool
}

// rewriteHead is one pass of the rewriter over the bytes held so far plus a new chunk: every line
// before the first `message_start` and that line itself (rewritten when it needs it) go out; the
// rest is held again, or given up on past the limit.
func rewriteHead(held, chunk []byte, prompt PromptHint, estimator *PromptEstimator) rewriteResult {
	rest := chunk
	if len(held) > 0 {
		rest = append(append([]byte(nil), held...), chunk...)
	}
	var out [][]byte
	for {
		at := bytes.IndexByte(rest, newlineByte)
		if at < 0 {
			break
		}
		line := rest[:at+1]
		rest = rest[at+1:]
		text := string(line)
		rewritten, decided, changed := rewrittenStartLine(text, prompt, estimator)
		if !decided {
			out = append(out, line)
			continue
		}
		if !changed {
			out = append(out, line)
		} else {
			out = append(out, []byte(rewritten))
		}
		return rewriteResult{out: out, rest: rest, decided: true}
	}
	return rewriteResult{out: out, rest: rest, decided: len(rest) > promptRewriteLimitBytes}
}

// rewrittenStartLine is the replacement for one complete SSE line — the first `message_start`'s
// zero usage rewritten to this conversation's estimate, or the line unchanged when it carries a
// real prompt size or the cache fields already — decided false for any other line.
func rewrittenStartLine(line string, prompt PromptHint, estimator *PromptEstimator) (rewritten string, decided, changed bool) {
	event := sseEventNode(line)
	if event == nil || event.get("type") == nil || event.get("type").str != "message_start" {
		return "", false, false
	}
	usage := event.get("message").get("usage")
	// A real prompt size, or the cache fields Claude Code reads beside it, are left exactly as
	// they came.
	if usage == nil || !usage.isObject() || !zeroInputTokens(usage) || usage.has("cache_read_input_tokens") {
		return line, true, false
	}
	usage.set("input_tokens", newNumberNode(estimator.EstimatePrompt(prompt.Key, prompt.BodyChars)))
	usage.set("cache_creation_input_tokens", newNumberNode(0))
	usage.set("cache_read_input_tokens", newNumberNode(0))
	ending := "\n"
	if strings.HasSuffix(line, "\r\n") {
		ending = "\r\n"
	}
	return "data: " + marshalNode(event) + ending, true, true
}

// zeroInputTokens is the lie the rewriter exists to paper over: an input_tokens of exactly 0.
func zeroInputTokens(usage *jsonNode) bool {
	tokens := usage.get("input_tokens")
	if tokens == nil || tokens.kind != jsonNumber {
		return false
	}
	value, err := tokens.num.Float64()
	return err == nil && value == 0
}

// sseEventNode is the `data:` line's event as an ordered node, when it parses to an object.
func sseEventNode(line string) *jsonNode {
	if !strings.HasPrefix(line, "data:") {
		return nil
	}
	node := parseBodyNode([]byte(strings.TrimSpace(line[len("data:"):])))
	if !node.isObject() {
		return nil
	}
	return node
}

// promptHintOf is the conversation a provider request belongs to, as its stream's first
// `message_start` may need it: the key and the request body's length, the measure the estimate
// grows by. The parts are the body's own bytes, so the key stays byte-stable.
func promptHintOf(body []byte, bodyChars int64) *PromptHint {
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(body, &raw)
	var first json.RawMessage
	if messages, ok := raw["messages"]; ok {
		var list []json.RawMessage
		if json.Unmarshal(messages, &list) == nil && len(list) > 0 {
			first = list[0]
		}
	}
	return &PromptHint{Key: PromptKey(raw["system"], first), BodyChars: bodyChars}
}

// ── the provider key ───────────────────────────────────────────────────────────────────────────────────────────────

// keyOutcome is what a key lookup ended in.
type keyOutcome int

const (
	keyValue keyOutcome = iota
	keyNone
	keyTimeout
)

// keyWithin is the provider's key within the budget: the key, none when there is none, a timeout
// when the lookup hung. The budget bounds the wait, never the shared lookup itself: it runs on
// under the cache's own deadline and the next request joins it.
func keyWithin(ctx context.Context, w *routerWorker) (string, keyOutcome) {
	timeout := keyTimeoutDefault
	if w.opts.KeyTimeoutMs != 0 {
		timeout = w.opts.KeyTimeoutMs
	}
	type lookup struct {
		key     string
		outcome keyOutcome
	}
	found := make(chan lookup, 1)
	go func() {
		answer := w.keys.get(ctx)
		switch {
		case answer.key.Value != "":
			found <- lookup{key: answer.key.Value, outcome: keyValue}
		case answer.timedOut:
			found <- lookup{outcome: keyTimeout}
		default:
			found <- lookup{outcome: keyNone}
		}
	}()
	select {
	case result := <-found:
		return result.key, result.outcome
	case <-time.After(time.Duration(timeout) * time.Millisecond):
		return "", keyTimeout
	}
}

// ── the forward ────────────────────────────────────────────────────────────────────────────────────────────────────

// forward is one request's decision core: where it goes, what it may carry, and what its event
// says.
func (w *routerWorker) forward(req *http.Request, res *Response, original []byte) {
	provider := w.provider
	body := parseBodyNode(original)
	model := modelIn(body)
	prompt := &promptRef{}
	note := w.noteOf(req, model, time.Now().UnixMilli(), prompt)
	route, peer, hasPeer := routeOf(w.claim, model, w.opts.Peers)
	// A request another plugin's router forwarded here is served when it is this provider's model;
	// anything else would be a second hop (a loop, or two routers disagreeing about who serves the
	// model), so it is refused.
	if hopPresent(req) && route != "provider" {
		w.log(fmt.Sprintf("%s %s model=%s → refused: second peer hop", req.Method, requestPath(req), modelOrDash(model)))
		AnthropicError(res, 508, "api_error", provider.Name+" router: refusing to forward a request twice")
		if note != nil {
			reason := "refusing to forward a request twice"
			note(508, "refused", "-", nil, &reason, nil)
		}
		return
	}
	// The request is on its way: read what its body carried, once per content.
	w.capture(prompt, body)
	if hasPeer {
		target := &url.URL{Scheme: "http", Host: net.JoinHostPort("127.0.0.1", strconv.FormatInt(peer.Port, 10))}
		w.dispatch(req, res, original, model, route, target, note, &peer, "", nil)
		return
	}
	if route != "provider" {
		w.dispatch(req, res, original, model, route, w.opts.Anthropic, note, nil, "", nil)
		return
	}
	// The message-threads beta is Anthropic-only: Claude Code sends only the newest messages and
	// expects the server to hold the rest, which the provider keeps no thread of. This exact 400
	// is the one Claude Code reads as "beta rejected": it drops the header and resends the whole
	// conversation, which the router then forwards in full.
	if tokens := threadsBeta(req); len(tokens) > 0 {
		w.log(fmt.Sprintf("%s %s model=%s → refused: message threads", req.Method, requestPath(req), modelOrDash(model)))
		AnthropicError(res, 400, "invalid_request_error", "Unexpected value(s) `"+strings.Join(tokens, "`, `")+"` for the `anthropic-beta` header: "+provider.Name+" keeps no server-side message thread, so Claude Code must resend the whole conversation.")
		if note != nil {
			reason := "message threads beta"
			note(400, "refused", "-", nil, &reason, nil)
		}
		return
	}
	// A stopped budget turns the provider's models off before anything else, the key included;
	// Claude traffic never reaches this line.
	if stop, stopped := w.budget(model); stopped {
		w.budgetStopped(req, res, model, stop, note)
		return
	}
	// Only a provider request ever reads the key: a keychain prompt or a missing key never delays
	// Claude traffic. The client is watched while it reads: one that leaves during the lookup is
	// answered by nobody, so nothing goes upstream for it.
	gone := WatchClient(req)
	key, outcome := keyWithin(req.Context(), w)
	if gone() {
		return
	}
	if outcome != keyValue {
		w.noKey(req, res, model, outcome, note)
		return
	}
	adapted, named := providerBody(w, original, body, model, req)
	w.dispatch(req, res, adapted, named, "provider", w.opts.ProviderURL, note, nil, key, promptHintOf(original, int64(len(adapted))))
}

// budgetStopped answers a provider request while its budget is stopped: the same non-retryable
// 400 as a refused key, naming the dashboard.
func (w *routerWorker) budgetStopped(req *http.Request, res *Response, model string, stop domain.BudgetStop, note eventNote) {
	provider := w.provider
	w.log(fmt.Sprintf("%s %s model=%s → provider: budget stopped (%s)", req.Method, requestPath(req), model, stop.Scope))
	answer := BudgetAnswer(domain.BudgetMessage(provider.Display, stop))
	writeHead(res, answer.Status, answer.Headers)
	res.End([]byte(answer.Body))
	w.health(domain.HealthRefusal, "budget: "+stop.Scope, model)
	if note != nil {
		note(int64(answer.Status), "provider", w.opts.ProviderURL.Host, nil, nil, nil)
	}
}

// noKey answers a provider request without a key: a non-retryable 400 that names setup when there
// is none (never a 401, which Claude Code would read as its own login failing), 503 when the
// lookup timed out.
func (w *routerWorker) noKey(req *http.Request, res *Response, model string, outcome keyOutcome, note eventNote) {
	provider := w.provider
	timedOut := outcome == keyTimeout
	why := "no key"
	if timedOut {
		why = "key lookup timed out"
	}
	w.log(fmt.Sprintf("%s %s model=%s → provider: %s", req.Method, requestPath(req), model, why))
	if timedOut {
		AnthropicError(res, 503, "api_error", fmt.Sprintf("%s router: reading the %s key timed out", provider.Name, provider.Display))
		if note != nil {
			note(503, "provider", w.opts.ProviderURL.Host, nil, nil, nil)
		}
		return
	}
	answer := RefusalAnswer(RefusalNames{Display: provider.Display, Slash: provider.Slash, BillingURL: provider.BillingURL}, RefusalKey, "no key is set")
	writeHead(res, answer.Status, answer.Headers)
	res.End([]byte(answer.Body))
	w.health(domain.HealthRefusal, "key: no key is set", model)
	if note != nil {
		note(int64(answer.Status), "provider", w.opts.ProviderURL.Host, nil, nil, nil)
	}
}

// ── the error reason ───────────────────────────────────────────────────────────────────────────────────────────────

// secretLike is a run of key- and token-shaped characters long enough to be a credential: gone
// before a reason is stored.
var secretLike = regexp.MustCompile(`[A-Za-z0-9._-]{24,}`)

// whitespaceRun is the runs of whitespace a reason collapses into one space of.
var whitespaceRun = regexp.MustCompile(`\s+`)

// UpstreamErrorReason is the one-line reason an upstream error answer gives, or false when it
// gives none: its `type: message` (or the `code`-shaped errors Z.ai answers with), else the first
// 300 characters of its text — whitespace collapsed, the route's own key and every
// credential-shaped run redacted, so no secret ever reaches a log or the spool, and no request
// content ever appears in an error answer to begin with.
func UpstreamErrorReason(body []byte, key string) (string, bool) {
	if len(body) > reasonBytes {
		body = body[:reasonBytes]
	}
	text := string(body)
	said, ok := errorMessage(text)
	if !ok {
		said = text
	}
	if key != "" {
		said = strings.ReplaceAll(said, key, "…")
	}
	line := strings.TrimSpace(whitespaceRun.ReplaceAllString(said, " "))
	line = secretLike.ReplaceAllString(line, "…")
	line = strings.TrimSpace(line)
	line = utf16Slice(line, reasonChars)
	line = strings.TrimRightFunc(line, unicode.IsSpace)
	if line == "" {
		return "", false
	}
	return line, true
}

// utf16Slice keeps the first units UTF-16 code units of text: the measure a JS String.slice takes.
func utf16Slice(text string, units int) string {
	if utf16Len(text) <= int64(units) {
		return text
	}
	var b strings.Builder
	count := 0
	for _, r := range text {
		width := max(utf16.RuneLen(r), 1)
		if count+width > units {
			break
		}
		b.WriteRune(r)
		count += width
	}
	return b.String()
}

// errorMessage is the message an upstream error body carries, in the shapes providers actually
// send: Anthropic's `{error:{type,message}}` and the `code`-shaped errors Z.ai answers with
// (`{error:{code,message}}`, `{code,msg}`); false for anything else, leaving the raw text as the
// reason.
func errorMessage(text string) (string, bool) {
	var parsed any
	if json.Unmarshal([]byte(text), &parsed) != nil {
		return "", false
	}
	body, ok := parsed.(map[string]any)
	if !ok {
		return "", false
	}
	if inner, ok := body["error"].(map[string]any); ok {
		return saidWhat(errorField(inner, "type"), errorField(inner, "code"), errorField(inner, "message"))
	}
	message := errorField(body, "msg")
	if message == "" {
		message = errorField(body, "message")
	}
	return saidWhat(errorField(body, "code"), "", message)
}

// errorField is a field of a parsed error body that is a non-empty string.
func errorField(record map[string]any, name string) string {
	if value, ok := record[name].(string); ok && value != "" {
		return value
	}
	return ""
}

// saidWhat is an error's `what: message`, its message alone without a `what`, false without both.
func saidWhat(what, alt, message string) (string, bool) {
	if what == "" {
		what = alt
	}
	if message == "" {
		return what, what != ""
	}
	if what == "" {
		return message, true
	}
	return what + ": " + message, true
}

// ── the provider route's error answers ─────────────────────────────────────────────────────────────────────────────

// providerError is what a provider's error answer becomes: a refused key or an empty balance the
// non-retryable refusal, an error that quotes the key itself the same answer with the key blanked
// out; false to send it as it came. A refusal and a rate limit are reported as health events (the
// status only, never the body).
func (w *routerWorker) providerError(answer *http.Response, body []byte, key, model string) (Replacement, string, bool) {
	provider := w.provider
	status := answer.StatusCode
	refusal, refused := RefusalOf(status, body)
	if !refused && status == 429 {
		w.health(domain.HealthRateLimited, "HTTP 429", model)
	}
	if refused {
		w.health(domain.HealthRefusal, fmt.Sprintf("%s: HTTP %d", refusal, status), model)
		why := "out of balance"
		if refusal == RefusalKey {
			why = "key refused"
			// The key may have been rotated: the kept answer is dropped so the next request
			// reads it again. Only the provider's answers reach here — Anthropic's never do.
			w.keys.clear()
		}
		names := RefusalNames{Display: provider.Display, Slash: provider.Slash, BillingURL: provider.BillingURL}
		return RefusalAnswer(names, refusal, fmt.Sprintf("%s answered HTTP %d", provider.Display, status)), why, true
	}
	text := string(body)
	if key == "" || !strings.Contains(text, key) {
		return Replacement{}, "", false
	}
	// The replacement goes out plain, so it does not claim the encoding the provider's bytes came
	// with.
	headers := ResponseHeaders(answer.Header)
	headers.Del("Content-Length")
	headers.Del("Content-Encoding")
	return Replacement{
		Status:  status,
		Headers: headers,
		Body:    strings.ReplaceAll(text, key, "[key redacted]"),
	}, "key redacted", true
}

// inspection is what one request's inspection decided: the status the client was answered instead
// of the upstream's, when the router rewrote its answer, and why the upstream failed (once its
// held-back body has been read).
type inspection struct {
	rewritten *int
	reason    *string
}

// providerInspection is the hooks that read a provider route's error answers (the only route
// carrying a key): each held-back answer is read once — refused or not — and its one log line
// carries the reason.
func (w *routerWorker) providerInspection(req *http.Request, u *url.URL, route, model, key string, decided *inspection) (func(*http.Response) func([]byte) (Replacement, bool), func(*http.Response)) {
	line := func(status int, why string) string {
		return fmt.Sprintf("%s %s model=%s → %s %d%s", req.Method, u.Path, modelOrDash(model), route, status, why)
	}
	inspect := func(answer *http.Response) func([]byte) (Replacement, bool) {
		if !MayRefuse(answer.StatusCode) {
			return nil
		}
		return func(text []byte) (Replacement, bool) {
			// A compressed answer is judged through its decompressed copy; its own bytes are what
			// the client gets.
			body := InspectBody(text, answer.Header.Get("Content-Encoding"))
			replacement, why, rewritten := w.providerError(answer, body, key, model)
			// A rewritten answer's why is already on its health event, and its text never leaves
			// the router (a refusal quotes nothing upstream, one quoting the key is blanked out);
			// only an error that went through as it came records its reason — the route's key
			// redacted out regardless.
			if !rewritten {
				if reason, ok := UpstreamErrorReason(body, key); ok {
					decided.reason = &reason
				} else {
					decided.reason = nil
				}
			} else {
				decided.reason = nil
			}
			why0 := ""
			if decided.reason != nil {
				why0 = " (" + *decided.reason + ")"
			}
			w.log(line(answer.StatusCode, why0))
			if rewritten {
				answered := replacement.Status
				decided.rewritten = &answered
				w.log(line(answer.StatusCode, fmt.Sprintf(" answered %d (%s)", replacement.Status, why)))
			}
			return replacement, rewritten
		}
	}
	// An answer too big for its judge went out as it came, its reason unread: the line is logged
	// plain.
	oversize := func(answer *http.Response) {
		w.log(line(answer.StatusCode, ""))
	}
	return inspect, oversize
}

// dispatch sends one request on its route and pipes its answer back, streaming it.
func (w *routerWorker) dispatch(req *http.Request, res *Response, body []byte, model, route string, target *url.URL, note eventNote, peer *PeerTarget, key string, prompt *PromptHint) {
	provider := w.provider
	u, err := UpstreamURL(target, requestPath(req))
	if err != nil {
		AnthropicError(res, 502, "api_error", provider.Name+" router: bad request path")
		if note != nil {
			note(502, route, target.Host, nil, nil, nil)
		}
		return
	}
	if why, refused := forwardable(route, u); refused {
		w.log(fmt.Sprintf("%s %s model=%s → %s refused", req.Method, u.Path, modelOrDash(model), route))
		AnthropicError(res, 502, "api_error", provider.Name+" router: "+why)
		if note != nil {
			note(502, route, u.Host, nil, nil, nil)
		}
		return
	}
	headers := UpstreamHeaders(req.Header, target, len(body), key)
	if peer != nil {
		headers.Set(PeerHop, "1")
	}
	// The answer's allow-listed headers, read once as its head arrives, for the route event's
	// note; usage is parsed out of the passing stream, so the client never waits on it.
	var tracker *UsageTracker
	var answerHeaders *map[string]string
	// What this answer's inspection decided (a provider route only): the client's status when the
	// answer was rewritten, and why the upstream failed.
	decided := inspection{}
	if w.opts.OnUpstream != nil {
		w.opts.OnUpstream(req)
	}
	hooks := UpstreamHooks{
		Answered: func(answer *http.Response) {
			// A provider error answer is held back for its judge, so its line waits and carries
			// the reason; every other answer is logged the moment its headers arrive.
			if !(key != "" && MayRefuse(answer.StatusCode)) {
				w.log(fmt.Sprintf("%s %s model=%s → %s %d", req.Method, u.Path, modelOrDash(model), route, answer.StatusCode))
			}
			if note != nil {
				tracker = NewUsageTracker(answer.Header.Get("Content-Type"), answer.Header.Get("Content-Encoding"))
				answer.Body = &bodyTap{source: answer.Body, push: tracker.Push}
				answerHeaders = CapturedHeaders(answer.Header)
			}
		},
		Rewrite: func(answer *http.Response) io.Reader {
			if prompt == nil {
				return nil
			}
			if !strings.Contains(answer.Header.Get("Content-Type"), "text/event-stream") {
				return nil
			}
			return &promptRewriter{source: answer.Body, prompt: *prompt, estimator: w.estimator}
		},
		Finished: func(answer *http.Response) {
			// The final numbers are the real ones: remembered here, so the conversation's next
			// turn can estimate the prompt size its provider will not report until the end.
			if prompt != nil {
				w.estimator.RecordPrompt(prompt.Key, tracker.Usage(), prompt.BodyChars)
			}
			if note != nil {
				status := int64(answer.StatusCode)
				if status == 0 {
					status = 502
				}
				if decided.rewritten != nil {
					status = int64(*decided.rewritten)
				}
				note(status, route, u.Host, tracker.Usage(), decided.reason, answerHeaders)
			}
		},
		Failed: func(failure UpstreamFailure) {
			w.log(fmt.Sprintf("%s %s model=%s → %s error %s", req.Method, u.Path, modelOrDash(model), route, failure.Code))
			if !failure.AfterHeaders {
				status := 502
				if failure.Code == "ETIMEDOUT" {
					status = 504
				}
				message := fmt.Sprintf("%s router: %s unreachable (%s)", provider.Name, route, failure.Code)
				if peer != nil {
					message = fmt.Sprintf("%s router: the %s plugin's router is down; run /%s:setup to restart it",
						provider.Name, peer.Name, peer.Name)
				}
				AnthropicError(res, status, "api_error", message)
			}
			if note != nil {
				status := int64(502)
				if failure.Code == "ETIMEDOUT" && !failure.AfterHeaders {
					status = 504
				}
				// the errno is the whole reason a dropped connection has; never a header or a
				// body byte
				reason := "connection failed (" + failure.Code + ")"
				note(status, route, u.Host, nil, &reason, nil)
			}
		},
	}
	// Only a provider route (the one carrying the key) has its error answers read; Anthropic's and
	// a peer's always go through as they came.
	if key != "" {
		hooks.Inspect, hooks.Oversize = w.providerInspection(req, u, route, model, key, &decided)
	}
	SendUpstream(req.Context(), UpstreamCall{
		URL:     u,
		Method:  req.Method,
		Headers: headers,
		Body:    body,
		Env:     w.opts.Env,
		Direct:  peer != nil,
		IdleMs:  w.opts.IdleMs,
	}, res, hooks)
}
