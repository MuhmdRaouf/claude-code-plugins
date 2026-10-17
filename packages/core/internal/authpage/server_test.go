package authpage

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// The one-time key page. Raw HTTP requests drive it, so a test controls Host, Origin and the
// body exactly as an attacker could; nothing here starts a browser or touches a real key store.

type reply struct {
	status  int
	headers http.Header
	body    string
}

type requestInit struct {
	method  string
	path    string
	headers map[string]string
	body    string
	chunked bool
}

// send is one raw HTTP request with no keep-alive. The Host header is overridden through
// init.headers["Host"], the one header Go carries separately; a nil t is allowed for requests
// fired from a goroutine.
func send(t testing.TB, pageURL string, init requestInit) (reply, error) {
	if t != nil {
		t.Helper()
	}
	target, err := url.Parse(pageURL)
	if err != nil {
		return reply{}, err
	}
	requestPath := target.Path
	rawQuery := ""
	if init.path != "" {
		requestPath, rawQuery, _ = strings.Cut(init.path, "?")
	}
	method := init.method
	if method == "" {
		method = "GET"
	}
	request := &http.Request{
		Method: method,
		URL:    &url.URL{Scheme: "http", Host: target.Host, Path: requestPath, RawQuery: rawQuery},
		Host:   target.Host,
		Header: http.Header{},
	}
	for name, value := range init.headers {
		if strings.EqualFold(name, "Host") {
			request.Host = value
			continue
		}
		request.Header.Set(name, value)
	}
	if init.body != "" {
		request.Body = io.NopCloser(strings.NewReader(init.body))
		request.ContentLength = int64(len(init.body))
	}
	if init.chunked {
		request.ContentLength = -1
	}
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	response, err := client.Do(request)
	if err != nil {
		return reply{}, err
	}
	defer response.Body.Close()
	content, err := io.ReadAll(response.Body)
	if err != nil {
		return reply{}, err
	}
	return reply{status: response.StatusCode, headers: response.Header, body: string(content)}, nil
}

func mustSend(t *testing.T, pageURL string, init requestInit) reply {
	t.Helper()
	r, err := send(t, pageURL, init)
	if err != nil {
		t.Fatalf("request to %s (%s): %v", pageURL, init.method, err)
	}
	return r
}

var csrfField = regexp.MustCompile(`name="csrf" value="([^"]+)"`)

func csrfOf(t *testing.T, html string) string {
	t.Helper()
	match := csrfField.FindStringSubmatch(html)
	if match == nil {
		t.Fatal("no csrf field")
	}
	return match[1]
}

// formBody is the page's own encoding of a form (URLSearchParams).
func formBody(fields map[string]string) string {
	values := url.Values{}
	for name, value := range fields {
		values.Set(name, value)
	}
	return values.Encode()
}

// post is a well-formed POST from the page itself, overridable header by header.
func post(t *testing.T, page *AuthPage, fields map[string]string, headers map[string]string) reply {
	t.Helper()
	r, err := rawPost(page, fields, headers)
	if err != nil {
		t.Fatalf("post to the key page: %v", err)
	}
	return r
}

// rawPost is post without the test failure, so one case can post while another is in flight.
func rawPost(page *AuthPage, fields map[string]string, headers map[string]string) (reply, error) {
	target, _ := url.Parse(page.URL)
	all := map[string]string{"Content-Type": "application/x-www-form-urlencoded"}
	for name, value := range headers {
		all[name] = value
	}
	if _, ok := all["Origin"]; !ok {
		all["Origin"] = "http://" + target.Host
	}
	return send(nil, page.URL, requestInit{method: "POST", headers: all, body: formBody(fields)})
}

// pageOrigin is the page's own origin, exactly as the form's POST carries it.
func pageOrigin(t *testing.T, pageURL string) string {
	t.Helper()
	parsed, err := url.Parse(pageURL)
	if err != nil {
		t.Fatalf("parse %s: %v", pageURL, err)
	}
	return "http://" + parsed.Host
}

func i64Ptr(value int64) *int64 { return &value }

// captureStdLog redirects the standard logger and fails when the key leaks into it; the page
// logs nothing of its own, and net/http's default logger is the one place a request could reach
// a terminal.
func captureStdLog(t *testing.T) {
	t.Helper()
	captured := &strings.Builder{}
	log.SetOutput(captured)
	t.Cleanup(func() {
		log.SetOutput(os.Stderr)
		if strings.Contains(captured.String(), testkit.TEST_KEY) {
			t.Errorf("the standard log carried the key")
		}
	})
}

// harness is the fake provider and store the page talks to.
type harness struct {
	mu       sync.Mutex
	verdicts []ports.KeyVerdict
	checked  []string
	saved    []string
	failSave bool
}

func (h *harness) nextVerdict() ports.KeyVerdict {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.verdicts) == 0 {
		return ports.KeyVerdictAccepted
	}
	verdict := h.verdicts[0]
	h.verdicts = h.verdicts[1:]
	return verdict
}

func (h *harness) recordCheck(key string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.checked = append(h.checked, key)
}

func (h *harness) recordSave(key string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.saved = append(h.saved, key)
}

func (h *harness) checks() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string{}, h.checked...)
}

func (h *harness) saves() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string{}, h.saved...)
}

func (h *harness) options() AuthPageOptions {
	return AuthPageOptions{
		Plugin:     "zai-plugin-cc",
		Version:    strPtr("0.0.1"),
		Display:    "Z.ai GLM",
		KeysURL:    "https://z.ai/manage-apikey/apikey-list",
		BillingURL: "https://z.ai/manage-apikey/billing",
		StoreLabel: "macOS Keychain",
		Check: func(ctx context.Context, key string) (ports.KeyVerdict, error) {
			h.recordCheck(key)
			return h.nextVerdict(), nil
		},
		Save: func(ctx context.Context, key string) error {
			if h.failSave {
				return fmt.Errorf("could not store the key in macOS Keychain (exit 1)")
			}
			h.recordSave(key)
			return nil
		},
	}
}

type optionOverride func(*AuthPageOptions)

// open starts one page with the test's 30 s timeout, closing it when the test ends.
func open(t *testing.T, h *harness, overrides ...optionOverride) *AuthPage {
	t.Helper()
	options := h.options()
	options.TimeoutMs = i64Ptr(30_000)
	for _, override := range overrides {
		override(&options)
	}
	page, err := StartAuthPage(options)
	if err != nil {
		t.Fatalf("start the key page: %v", err)
	}
	t.Cleanup(func() { page.Close() })
	return page
}

func awaitDone(t *testing.T, page *AuthPage, want AuthOutcome) {
	t.Helper()
	select {
	case outcome := <-page.Done:
		if outcome != want {
			t.Fatalf("the page ended with %q, want %q", outcome, want)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("the page did not end with %q in time", want)
	}
}

// expectRefusedOnRestart asserts the page's port is gone.
func expectRefusedOnRestart(t *testing.T, page *AuthPage) {
	t.Helper()
	_, err := send(t, page.URL, requestInit{})
	refused := err != nil &&
		(strings.Contains(err.Error(), "connection refused") || strings.Contains(err.Error(), "actively refused"))
	if !refused {
		t.Fatalf("request after the page ended: err = %v, want connection refused", err)
	}
}

var cspShape = regexp.MustCompile(`^default-src 'none'; style-src 'nonce-([A-Za-z0-9+/=]+)'; script-src 'nonce-([A-Za-z0-9+/=]+)'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'$`)

func expectSecurityHeaders(t *testing.T, r reply) {
	t.Helper()
	csp := r.headers.Get("Content-Security-Policy")
	match := cspShape.FindStringSubmatch(csp)
	if match == nil {
		t.Fatalf("content-security-policy = %q", csp)
	}
	if match[1] != match[2] {
		t.Fatalf("the style and script nonces differ in %q", csp)
	}
	for name, want := range map[string]string{
		"Referrer-Policy":        "same-origin",
		"Cache-Control":          "no-store",
		"X-Content-Type-Options": "nosniff",
	} {
		if got := r.headers.Get(name); got != want {
			t.Errorf("%s = %q, want %q", name, got, want)
		}
	}
}

// rawDial opens a TCP connection to the page's port, writes one blob and reads everything back
// until the connection closes.
func rawDial(t *testing.T, page *AuthPage, write []byte, halfClose bool) string {
	t.Helper()
	parsed, err := url.Parse(page.URL)
	if err != nil {
		t.Fatalf("parse %s: %v", page.URL, err)
	}
	conn, err := net.Dial("tcp", parsed.Host)
	if err != nil {
		t.Fatalf("dial %s: %v", parsed.Host, err)
	}
	defer conn.Close()
	if _, err := conn.Write(write); err != nil {
		t.Fatalf("write: %v", err)
	}
	if halfClose {
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.CloseWrite()
		}
	}
	data, _ := io.ReadAll(conn)
	return string(data)
}

// badRequestBody sends a well-formed POST head whose body stops short of its Content-Length and
// closes the writing half, so the server's body read errors mid-stream.
func badRequestBody(t *testing.T, page *AuthPage, claimed int) string {
	t.Helper()
	target, _ := url.Parse(page.URL)
	head := fmt.Sprintf(
		"POST %s HTTP/1.1\r\nHost: %s\r\nOrigin: http://%s\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: %d\r\n\r\ncsrf=short",
		target.Path, target.Host, target.Host, claimed)
	return rawDial(t, page, []byte(head), true)
}

func TestStartAuthPage(t *testing.T) {
	captureStdLog(t)

	t.Run("serves one form at 127.0.0.1:<port>/<32-byte token> with the security headers and only nonce'd inline code", func(t *testing.T) {
		page := open(t, &harness{})
		if !regexp.MustCompile(`^http://127\.0\.0\.1:\d+/[A-Za-z0-9_-]{43}$`).MatchString(page.URL) {
			t.Fatalf("url = %q, want 127.0.0.1:<port>/<43-char token>", page.URL)
		}
		r := mustSend(t, page.URL, requestInit{})
		if r.status != 200 {
			t.Fatalf("status = %d, want 200", r.status)
		}
		expectSecurityHeaders(t, r)
		nonce := regexp.MustCompile(`'nonce-([^']+)'`).FindStringSubmatch(r.headers.Get("Content-Security-Policy"))[1]
		if !strings.Contains(r.body, `<style nonce="`+nonce+`">`) {
			t.Errorf("the style block does not carry the CSP nonce")
		}
		if count := strings.Count(r.body, "<script"); count != 1 {
			t.Errorf("the page has %d script tags, want one", count)
		}
		if !strings.Contains(r.body, `<script nonce="`+nonce+`">`) {
			t.Errorf("the script tag does not carry the CSP nonce")
		}
		for _, banned := range []*regexp.Regexp{
			regexp.MustCompile(`(?i)<script[^>]*\ssrc=`),
			regexp.MustCompile(`(?i)\son[a-z]+=`),
			regexp.MustCompile(`(?i)javascript:`),
		} {
			if banned.FindString(r.body) != "" {
				t.Errorf("the page carries code outside the nonce (%q)", banned.FindString(r.body))
			}
		}
		if !strings.Contains(r.body, `<input type="password" id="key" name="key" autocomplete="off"`) {
			t.Errorf("the key field is missing or wrong")
		}
		if !regexp.MustCompile(`name="csrf" value="[A-Za-z0-9_-]{43}"`).MatchString(r.body) {
			t.Errorf("the csrf field is missing or wrong")
		}
		for _, banned := range []*regexp.Regexp{
			regexp.MustCompile(`(?i)@import`),
			regexp.MustCompile(`(?i)url\(`),
			regexp.MustCompile(`(?i)<link`),
			regexp.MustCompile(`(?i)<img`),
			regexp.MustCompile(`(?i)<iframe`),
		} {
			if banned.FindString(r.body) != "" {
				t.Errorf("the page pulls an external resource (%q)", banned.FindString(r.body))
			}
		}
		// The only URL is the provider's key page, as a link that opens apart from this page.
		urls := regexp.MustCompile(`https?://[^"'<\s]+`).FindAllString(r.body, -1)
		want := []string{"https://z.ai/manage-apikey/apikey-list"}
		if strings.Join(urls, "|") != strings.Join(want, "|") {
			t.Errorf("urls = %v, want %v", urls, want)
		}
		if !strings.Contains(r.body, `target="_blank" rel="noopener noreferrer"`) {
			t.Errorf("the key-page link does not open apart")
		}
		if !strings.Contains(r.body, `<label class="step-title" for="key">Paste it here</label>`) {
			t.Errorf("the paste step is missing or wrong")
		}
		if !strings.Contains(r.body, "Connect Z.ai GLM") {
			t.Errorf("the title does not name the provider")
		}
		if !strings.Contains(r.body, "zai-plugin-cc v0.0.1") {
			t.Errorf("the version line is missing or wrong")
		}
	})

	t.Run("never sets a referrer policy under which browsers send Origin: null on the form's own POST", func(t *testing.T) {
		// Chrome sends `Origin: null` on a same-origin form POST when the policy is no-referrer;
		// the page then refuses its own form with 403. Policies that keep the real Origin on
		// same-origin requests are fine.
		nullOrigin := map[string]bool{"no-referrer": true, "": true}
		page := open(t, &harness{})
		r := mustSend(t, page.URL, requestInit{})
		metas := regexp.MustCompile(`<meta name="referrer" content="([^"]*)">`).FindAllStringSubmatch(r.body, -1)
		if len(metas) != 1 || metas[0][1] != "same-origin" {
			t.Fatalf("referrer metas = %v, want exactly same-origin", metas)
		}
		header := r.headers.Get("Referrer-Policy")
		for _, policy := range []string{header, metas[0][1]} {
			if nullOrigin[policy] {
				t.Errorf("referrer policy %q can strip the form's own Origin", policy)
			}
		}
		refusal := mustSend(t, page.URL, requestInit{method: "PUT"})
		if nullOrigin[refusal.headers.Get("Referrer-Policy")] {
			t.Errorf("the refusal's referrer policy %q can strip the form's own Origin", refusal.headers.Get("Referrer-Policy"))
		}
	})

	t.Run("anything but GET/POST /<token> with the exact Host is a 404 with an empty body", func(t *testing.T) {
		page := open(t, &harness{})
		parsed, _ := url.Parse(page.URL)
		host := parsed.Host
		localhost := "localhost" + host[strings.Index(host, ":"):]
		cases := []struct {
			label string
			init  requestInit
		}{
			{"root", requestInit{path: "/"}},
			{"token plus x", requestInit{path: parsed.Path + "x"}},
			{"token with query", requestInit{path: parsed.Path + "?a=1"}},
			{"token cut short", requestInit{path: parsed.Path[:len(parsed.Path)-1]}},
			{"PUT", requestInit{method: "PUT"}},
			{"DELETE", requestInit{method: "DELETE"}},
			{"localhost host", requestInit{headers: map[string]string{"Host": localhost}}},
			{"attacker host", requestInit{headers: map[string]string{"Host": "attacker.example"}}},
			{"host without port", requestInit{headers: map[string]string{"Host": "127.0.0.1"}}},
		}
		for _, c := range cases {
			r := mustSend(t, page.URL, c.init)
			if r.status != 404 || r.body != "" {
				t.Errorf("%s: status = %d, body = %q, want 404 with an empty body", c.label, r.status, r.body)
			}
			expectSecurityHeaders(t, r)
		}
	})

	t.Run("refuses a POST without the page's Origin, content type, CSRF value or a small body, and stores nothing", func(t *testing.T) {
		h := &harness{}
		page := open(t, h)
		csrf := csrfOf(t, mustSend(t, page.URL, requestInit{}).body)
		good := map[string]string{"csrf": csrf, "key": testkit.TEST_KEY}
		noOrigin := mustSend(t, page.URL, requestInit{
			method:  "POST",
			headers: map[string]string{"Content-Type": "application/x-www-form-urlencoded"},
			body:    formBody(good),
		})
		replies := []struct {
			r      reply
			status int
			label  string
		}{
			{noOrigin, 403, "no origin"},
			{post(t, page, good, map[string]string{"Origin": "http://attacker.example"}), 403, "attacker origin"},
			{post(t, page, good, map[string]string{"Origin": "null"}), 403, "null origin"},
			{post(t, page, good, map[string]string{"Origin": strings.Replace(pageOrigin(t, page.URL), "127.0.0.1", "localhost", 1)}), 403, "localhost origin"},
			{post(t, page, good, map[string]string{"Content-Type": "text/plain"}), 415, "text/plain"},
			{post(t, page, good, map[string]string{"Content-Type": "multipart/form-data; boundary=x"}), 415, "multipart"},
			{post(t, page, map[string]string{"key": testkit.TEST_KEY}, nil), 403, "no csrf"},
			{post(t, page, map[string]string{"csrf": csrf[1:] + "A", "key": testkit.TEST_KEY}, nil), 403, "shifted csrf"},
			{post(t, page, map[string]string{"csrf": "short", "key": testkit.TEST_KEY}, nil), 403, "short csrf"},
			{post(t, page, map[string]string{"csrf": csrf, "key": testkit.TEST_KEY, "pad": strings.Repeat("x", MaxBodyBytes)}, nil), 413, "oversized body"},
		}
		for _, c := range replies {
			if c.r.status != c.status || c.r.body != "" {
				t.Errorf("%s: status = %d, body = %q, want %d with an empty body", c.label, c.r.status, c.r.body, c.status)
			}
			expectSecurityHeaders(t, c.r)
		}
		if checks := h.checks(); len(checks) != 0 {
			t.Errorf("a refused POST still checked %d key(s)", len(checks))
		}
		if saves := h.saves(); len(saves) != 0 {
			t.Errorf("a refused POST still stored %d key(s)", len(saves))
		}
		// The page still works after all of that.
		if body := post(t, page, good, nil).body; !strings.Contains(body, "Saved in macOS Keychain.") {
			t.Errorf("the page stopped working: %q", body)
		}
		if saves := h.saves(); strings.Join(saves, "|") != testkit.TEST_KEY {
			t.Errorf("stored keys = %v, want the one good key", saves)
		}
	})

	t.Run("an oversized body that lies about its length is cut off at 4 KiB", func(t *testing.T) {
		h := &harness{}
		page := open(t, h)
		csrf := csrfOf(t, mustSend(t, page.URL, requestInit{}).body)
		body := formBody(map[string]string{"csrf": csrf, "key": testkit.TEST_KEY, "pad": strings.Repeat("y", MaxBodyBytes*4)})
		r, err := send(t, page.URL, requestInit{
			method:  "POST",
			headers: map[string]string{"Origin": pageOrigin(t, page.URL), "Content-Type": "application/x-www-form-urlencoded"},
			body:    body,
			chunked: true,
		})
		if err != nil {
			// The server may cut the connection before the client finishes sending; that counts
			// as the same 413.
			r = reply{status: 413}
		}
		if r.status != 413 {
			t.Errorf("status = %d, want 413", r.status)
		}
		if saves := h.saves(); len(saves) != 0 {
			t.Errorf("an oversized body still stored %d key(s)", len(saves))
		}
	})

	t.Run("a refused key shows the error and keeps the form; the next good key is stored once and the server exits", func(t *testing.T) {
		h := &harness{verdicts: []ports.KeyVerdict{ports.KeyVerdictRefused, ports.KeyVerdictUnknown}}
		page := open(t, h)
		csrf := csrfOf(t, mustSend(t, page.URL, requestInit{}).body)
		fields := map[string]string{"csrf": csrf, "key": testkit.TEST_KEY}

		refused := post(t, page, fields, nil)
		if refused.status != 200 {
			t.Fatalf("status = %d, want 200", refused.status)
		}
		if !strings.Contains(refused.body, "That key was refused. Try again.") {
			t.Errorf("the refusal does not say so")
		}
		if !strings.Contains(refused.body, `name="csrf"`) {
			t.Errorf("the form is not kept after a refusal")
		}
		if strings.Contains(refused.body, testkit.TEST_KEY) {
			t.Errorf("the page echoed the key")
		}
		expectSecurityHeaders(t, refused)

		unknown := post(t, page, fields, nil)
		if !strings.Contains(unknown.body, "could not be checked right now") {
			t.Errorf("an unknown verdict does not say so")
		}

		malformed := post(t, page, map[string]string{"csrf": csrf, "key": "not a key!"}, nil)
		if !strings.Contains(malformed.body, "does not look like an API key") {
			t.Errorf("a malformed key does not say so")
		}
		wantChecks := strings.Join([]string{testkit.TEST_KEY, testkit.TEST_KEY}, "|")
		if checks := h.checks(); strings.Join(checks, "|") != wantChecks {
			t.Errorf("checked keys = %v, want the two well-formed ones", checks)
		}

		saved := post(t, page, map[string]string{"csrf": csrf, "key": "  " + testkit.TEST_KEY + "  "}, nil)
		if !strings.Contains(saved.body, "Saved in macOS Keychain.") {
			t.Errorf("the saved page does not say so")
		}
		if strings.Contains(saved.body, `name="csrf"`) {
			t.Errorf("the saved page still carries a form")
		}
		awaitDone(t, page, AuthOutcomeSaved)
		if saves := h.saves(); strings.Join(saves, "|") != testkit.TEST_KEY {
			t.Errorf("stored keys = %v, want the one key", saves)
		}
		expectRefusedOnRestart(t, page)
	})

	t.Run("a key the provider rate limits or has no balance for is stored, with the reason on the page", func(t *testing.T) {
		h := &harness{verdicts: []ports.KeyVerdict{ports.KeyVerdictLimited}}
		page := open(t, h)
		csrf := csrfOf(t, mustSend(t, page.URL, requestInit{}).body)

		saved := post(t, page, map[string]string{"csrf": csrf, "key": testkit.TEST_KEY}, nil)
		if !strings.Contains(saved.body, "Saved in macOS Keychain.") {
			t.Errorf("the saved page does not say so")
		}
		if !strings.Contains(saved.body, "Z.ai GLM is not taking requests with this key yet") {
			t.Errorf("the limited verdict is not explained")
		}
		if !strings.Contains(saved.body, "https://z.ai/manage-apikey/billing") {
			t.Errorf("the top-up page is not linked")
		}
		awaitDone(t, page, AuthOutcomeSaved)
		if saves := h.saves(); strings.Join(saves, "|") != testkit.TEST_KEY {
			t.Errorf("stored keys = %v, want the one key", saves)
		}
	})

	t.Run("five failed tries end the page", func(t *testing.T) {
		h := &harness{verdicts: []ports.KeyVerdict{
			ports.KeyVerdictRefused, ports.KeyVerdictRefused, ports.KeyVerdictRefused,
			ports.KeyVerdictRefused, ports.KeyVerdictRefused,
		}}
		page := open(t, h)
		csrf := csrfOf(t, mustSend(t, page.URL, requestInit{}).body)
		fields := map[string]string{"csrf": csrf, "key": testkit.TEST_KEY}
		for i := 0; i < 4; i += 1 {
			if body := post(t, page, fields, nil).body; !strings.Contains(body, "Try again.") {
				t.Fatalf("try %d does not offer another one", i+1)
			}
		}
		last := post(t, page, fields, nil)
		if !strings.Contains(last.body, "That was the last try") {
			t.Errorf("the fifth try does not end the page")
		}
		if strings.Contains(last.body, `name="csrf"`) {
			t.Errorf("the ended page still carries a form")
		}
		awaitDone(t, page, AuthOutcomeRefused)
		if saves := h.saves(); len(saves) != 0 {
			t.Errorf("stored keys = %v, want none", saves)
		}
	})

	t.Run("a key the store will not take is reported, not lost in a crash; a throwing check counts as unknown", func(t *testing.T) {
		h := &harness{failSave: true}
		page := open(t, h, func(options *AuthPageOptions) {
			options.Check = func(ctx context.Context, key string) (ports.KeyVerdict, error) {
				return "", fmt.Errorf("boom %s", testkit.TEST_KEY)
			}
		})
		csrf := csrfOf(t, mustSend(t, page.URL, requestInit{}).body)
		unchecked := post(t, page, map[string]string{"csrf": csrf, "key": testkit.TEST_KEY}, nil)
		if !strings.Contains(unchecked.body, "could not be checked right now") {
			t.Errorf("a failing check does not count as unknown")
		}
		failing := open(t, h)
		csrf2 := csrfOf(t, mustSend(t, failing.URL, requestInit{}).body)
		r := post(t, failing, map[string]string{"csrf": csrf2, "key": testkit.TEST_KEY}, nil)
		if !strings.Contains(r.body, "accepted but could not be saved in macOS Keychain") {
			t.Errorf("a failing store is not reported")
		}
		if strings.Contains(r.body, testkit.TEST_KEY) {
			t.Errorf("the page echoed the key")
		}
	})

	t.Run("a second POST while the first is being checked is turned away", func(t *testing.T) {
		h := &harness{}
		entered := make(chan struct{})
		gate := make(chan struct{})
		page := open(t, h, func(options *AuthPageOptions) {
			options.Check = func(ctx context.Context, key string) (ports.KeyVerdict, error) {
				entered <- struct{}{}
				<-gate
				return ports.KeyVerdictAccepted, nil
			}
		})
		csrf := csrfOf(t, mustSend(t, page.URL, requestInit{}).body)
		fields := map[string]string{"csrf": csrf, "key": testkit.TEST_KEY}
		first := make(chan reply, 1)
		firstErr := make(chan error, 1)
		go func() {
			r, err := rawPost(page, fields, nil)
			if err != nil {
				firstErr <- err
				return
			}
			first <- r
		}()
		<-entered
		second := post(t, page, fields, nil)
		if second.status != 409 {
			t.Errorf("the concurrent POST: status = %d, want 409", second.status)
		}
		close(gate)
		select {
		case r := <-first:
			if !strings.Contains(r.body, "Saved in ") {
				t.Errorf("the first POST did not finish with the saved page")
			}
		case err := <-firstErr:
			t.Fatalf("the first POST failed: %v", err)
		case <-time.After(10 * time.Second):
			t.Fatal("the first POST never finished")
		}
		if saves := h.saves(); strings.Join(saves, "|") != testkit.TEST_KEY {
			t.Errorf("stored keys = %v, want the one key", saves)
		}
	})

	t.Run("a request that is not HTTP gets its connection closed", func(t *testing.T) {
		page := open(t, &harness{})
		if data := rawDial(t, page, []byte("NOT HTTP\r\n\r\n"), false); data != "" {
			t.Errorf("a non-HTTP request got %q back, want a closed connection", data)
		}
		// A connection that closes before sending anything, and one whose request line never
		// ends, are dropped the same way.
		if data := rawDial(t, page, nil, true); data != "" {
			t.Errorf("an empty connection got %q back, want a closed connection", data)
		}
		longLine := []byte("GET /" + strings.Repeat("A", 9*1024))
		if data := rawDial(t, page, longLine, true); data != "" {
			t.Errorf("an endless request line got %q back, want a closed connection", data)
		}
	})

	t.Run("a body that stops mid-stream is refused, not half-read", func(t *testing.T) {
		page := open(t, &harness{})
		data := badRequestBody(t, page, 100)
		if !strings.Contains(data, "HTTP/1.1 413") {
			t.Errorf("a broken body got %q, want a 413", data)
		}
	})

	t.Run("exits on its own after the timeout", func(t *testing.T) {
		page := open(t, &harness{}, func(options *AuthPageOptions) {
			options.TimeoutMs = i64Ptr(50)
		})
		awaitDone(t, page, AuthOutcomeTimeout)
		expectRefusedOnRestart(t, page)
	})

	t.Run("a smaller try budget ends the page sooner, closing a kept-open connection", func(t *testing.T) {
		h := &harness{verdicts: []ports.KeyVerdict{ports.KeyVerdictRefused, ports.KeyVerdictRefused}}
		page := open(t, h, func(options *AuthPageOptions) {
			budget := 2
			options.MaxTries = &budget
		})
		csrf := csrfOf(t, mustSend(t, page.URL, requestInit{}).body)
		// A browser holds its connection open, so the page's own shutdown has to close it.
		client := &http.Client{}
		fields := map[string]string{"csrf": csrf, "key": testkit.TEST_KEY}
		postKeepAlive := func() string {
			body := formBody(fields)
			request, err := http.NewRequest("POST", page.URL, strings.NewReader(body))
			if err != nil {
				t.Fatalf("build the POST: %v", err)
			}
			request.Header.Set("Origin", pageOrigin(t, page.URL))
			request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
			request.ContentLength = int64(len(body))
			response, err := client.Do(request)
			if err != nil {
				t.Fatalf("post over the kept-open connection: %v", err)
			}
			content, _ := io.ReadAll(response.Body)
			response.Body.Close()
			return string(content)
		}
		if body := postKeepAlive(); !strings.Contains(body, "Try again.") {
			t.Errorf("the first refusal does not offer another try")
		}
		if body := postKeepAlive(); !strings.Contains(body, "That was the last try") {
			t.Errorf("the second refusal does not end the page")
		}
		awaitDone(t, page, AuthOutcomeRefused)
		expectRefusedOnRestart(t, page)
	})
}
