// What setup needs to get a key in without the chat: the store to fill, a key check, the one-time
// page (started detached, then opened in the browser), and the key file's line to retire after a
// migration.
package authpage

import (
	"bufio"
	"context"
	"errors"
	"net"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/keystore"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// launchTimeoutMs bounds the wait for the page's first stdout line.
const launchTimeoutMs = 15_000

// probeTimeoutMs bounds the PageOpen probe; a probe that neither connects nor is refused in time
// counts as open, so a slow machine never ends setup's wait early.
const probeTimeoutMs = 2_000

// pageURLShape is the one URL the page may print: http://127.0.0.1:<port>/<token>.
var pageURLShape = regexp.MustCompile(`^http://127\.0\.0\.1:\d+/[A-Za-z0-9_-]+$`)

// PageLauncher starts the page's `auth-serve` (the provider's cli entry, run from this binary) and
// resolves its first stdout line, the URL.
type PageLauncher func(ctx context.Context, provider string, env domain.EnvLookup) (string, error)

// URLOpener opens a URL in the user's browser, detached; a failure only leaves the printed URL.
type URLOpener func(pageURL string)

// LaunchError is a page-launch failure; Reason is all it carries.
type LaunchError struct {
	Reason string
}

func (e *LaunchError) Error() string { return e.Reason }

// KeyEntryOptions shape CreateKeyEntry.
type KeyEntryOptions struct {
	keystore.PlatformOptions
	Provider domain.Provider
	Env      domain.EnvLookup
	// Launch starts the page; nil is LaunchPage.
	Launch PageLauncher
	// OpenURL opens the page's URL; nil is the platform's browser.
	OpenURL URLOpener
	// Fetch runs the key check's one request; nil is HTTPFetch.
	Fetch FetchFunc
}

type keyEntry struct {
	options KeyEntryOptions
	launch  PageLauncher
	openURL URLOpener
	fetch   FetchFunc
}

// nodePlatform is the host platform in Node's process.platform spelling, which matches GOOS.
func nodePlatform() string {
	return runtime.GOOS
}

// CreateKeyEntry is setup's KeyEntry: the store to fill, the key check, the one-time page and the
// key file's line.
func CreateKeyEntry(options KeyEntryOptions) ports.KeyEntry {
	launch := options.Launch
	if launch == nil {
		launch = LaunchPage
	}
	openURL := options.OpenURL
	if openURL == nil {
		platform := nodePlatform()
		if options.Platform != nil {
			platform = *options.Platform
		}
		openURL = func(pageURL string) { OpenInBrowser(pageURL, platform, BrowserStartDetached) }
	}
	fetch := options.Fetch
	if fetch == nil {
		fetch = HTTPFetch
	}
	return &keyEntry{options: options, launch: launch, openURL: openURL, fetch: fetch}
}

func (e *keyEntry) Store(ctx context.Context) ports.KeyStore {
	return keystore.WritableKeyStore(ctx, e.options.Provider, e.options.Env, e.options.PlatformOptions)
}

func (e *keyEntry) Check(ctx context.Context, key string) ports.KeyVerdict {
	return CheckKey(ctx, e.options.Provider, key, e.fetch)
}

func (e *keyEntry) OpenPage(ctx context.Context) (string, error) {
	pageURL, err := e.launch(ctx, e.options.Provider.Name, e.options.Env)
	if err == nil {
		e.openURL(pageURL)
	}
	return pageURL, err
}

func (e *keyEntry) PageOpen(ctx context.Context, pageURL string) bool {
	return PageOpen(ctx, pageURL)
}

// RemoveFromFile removes the key file's line holding value (the file too when nothing else is
// left). A file that cannot be read or written reports false, like a line that was not there.
func (e *keyEntry) RemoveFromFile(ctx context.Context, value string) bool {
	file := keystore.KeyFilePath(e.options.Provider, e.options.Env, e.options.Provider.KeyFile)
	removed, err := keystore.RemoveKeyLine(ctx, e.options.Provider, file, &value)
	return err == nil && removed
}

// LaunchPage starts the page's server detached (`<self> <provider> cli auth-serve`, the entry the
// running binary maps the bundle's `auth-serve` onto) and resolves its first stdout line, the URL;
// the server then runs on its own, outliving setup.
func LaunchPage(ctx context.Context, provider string, env domain.EnvLookup) (string, error) {
	return launchPage(ctx, os.Executable, provider, env)
}

// launchPage is LaunchPage with the running binary injectable, so a test can fail the start.
func launchPage(ctx context.Context, executable func() (string, error), provider string, env domain.EnvLookup) (string, error) {
	self, err := executable()
	if err != nil {
		return "", &LaunchError{Reason: "cannot start the key page"}
	}
	child, stdout, err := startPageChild(self, provider, env)
	if err != nil {
		return "", &LaunchError{Reason: "cannot start the key page"}
	}
	defer stdout.Close()
	exited := make(chan struct{})
	go func() {
		_ = child.Wait() // reap the child however it ends; it is not waited for anywhere else
		close(exited)
	}()
	firstLine := make(chan string, 1)
	go func() {
		first, _ := bufio.NewReader(stdout).ReadString('\n')
		firstLine <- first
	}()
	giveUp := make(chan struct{})
	var giveUpOnce sync.Once
	giveUpNow := func() { giveUpOnce.Do(func() { close(giveUp) }) }
	timer := time.AfterFunc(launchTimeoutMs*time.Millisecond, giveUpNow)
	defer timer.Stop()
	stopWatch := context.AfterFunc(ctx, giveUpNow)
	defer stopWatch()
	select {
	case <-giveUp:
		return "", &LaunchError{Reason: "the key page did not start in time"}
	case <-exited:
		return "", &LaunchError{Reason: "the key page exited before it started"}
	case first := <-firstLine:
		// A line without a break is the pipe closing: the child ended before printing one.
		if !strings.Contains(first, "\n") {
			return "", &LaunchError{Reason: "the key page exited before it started"}
		}
		pageURL := strings.TrimSpace(first)
		if pageURLShape.MatchString(pageURL) {
			return pageURL, nil
		}
		return "", &LaunchError{Reason: "the key page printed no URL"}
	}
}

// startPageChild spawns `<self> <provider> cli auth-serve` in its own session, stdout piped (the
// child holds the write end; the parent's end is returned for reading and must be closed by the
// caller): the binary re-enters through the same provider and entry the dist/run launcher maps
// the bundle's auth-serve onto.
func startPageChild(executable string, provider string, env domain.EnvLookup) (*exec.Cmd, *os.File, error) {
	stdout, writer, err := os.Pipe()
	if err != nil {
		return nil, nil, err
	}
	child := exec.Command(executable, provider, "cli", "auth-serve")
	child.Env = envStrings(env)
	child.Stdout = writer
	child.SysProcAttr = launchAttr()
	if err := child.Start(); err != nil {
		stdout.Close()
		writer.Close()
		return nil, nil, err
	}
	writer.Close()
	return child, stdout, nil
}

// envStrings is the env as the child receives it, exactly as given and nothing more.
func envStrings(env domain.EnvLookup) []string {
	list := make([]string, 0, len(env))
	for name, value := range env {
		list = append(list, name+"="+value)
	}
	return list
}

// PageOpen reports whether something still listens on the page's port: the page server closes its
// port when it ends.
func PageOpen(ctx context.Context, pageURL string) bool {
	parsed, err := url.Parse(pageURL)
	if err != nil {
		return false
	}
	dialer := net.Dialer{Timeout: probeTimeoutMs * time.Millisecond}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", parsed.Port()))
	if err == nil {
		conn.Close()
		return true
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return true
	}
	return false
}

// BrowserStartOptions are the page opener's start options.
type BrowserStartOptions struct{}

// BrowserStart is the detached start the opener uses; the default is BrowserStartDetached.
type BrowserStart func(command string, args []string, options BrowserStartOptions) process.Detached

// BrowserStartDetached starts the opener through the process adapter.
func BrowserStartDetached(command string, args []string, options BrowserStartOptions) process.Detached {
	return process.StartDetached(command, args, process.DetachedOptions{})
}

// OpenInBrowser opens the page's URL in the user's browser: `open` on macOS, `xdg-open` on Linux;
// detached, output ignored, errors swallowed (no opener: the printed URL is the way in).
func OpenInBrowser(pageURL string, platform string, start BrowserStart) {
	var opener string
	var args []string
	switch platform {
	case "darwin":
		opener, args = "open", []string{pageURL}
	default:
		opener, args = "xdg-open", []string{pageURL}
	}
	defer func() {
		_ = recover()
	}()
	start(opener, args, BrowserStartOptions{})
}
