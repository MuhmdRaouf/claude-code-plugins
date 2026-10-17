package cli

// `auth-serve`: internal. Setup starts it detached; it prints the page URL as its only output
// line, serves the page until the key is saved (exit 0), 10 minutes pass or 5 tries fail (exit
// 6), and never prints anything else.

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/keystore"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/authpage"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// authServeVersionShape is the version strings plugin.json may carry.
var authServeVersionShape = regexp.MustCompile(`^[\w.+-]{1,32}$`)

// PluginVersion is the plugin's version from plugin/.claude-plugin/plugin.json beside the
// bundle's dist/, when it is there.
func PluginVersion(bundlePath string) (string, bool) {
	manifest := filepath.Join(filepath.Dir(bundlePath), "..", ".claude-plugin", "plugin.json")
	data, err := os.ReadFile(manifest)
	if err != nil {
		return "", false
	}
	var document struct {
		Version any `json:"version"`
	}
	if json.Unmarshal(data, &document) != nil {
		return "", false
	}
	version, ok := document.Version.(string)
	if !ok || !authServeVersionShape.MatchString(version) {
		return "", false
	}
	return version, true
}

// AuthServeCommand serves setup's one-time key page.
type AuthServeCommand struct{}

var _ Command = AuthServeCommand{}

// Name is the command's.
func (AuthServeCommand) Name() string { return "auth-serve" }

// Synopsis is the command's one line.
func (AuthServeCommand) Synopsis() []string { return []string{"auth-serve"} }

// Options: none; the server takes its settings from the environment it starts in.
func (AuthServeCommand) Options() map[string]OptionSpec { return map[string]OptionSpec{} }

// Hidden: an internal entry point stays out of help.
func (AuthServeCommand) Hidden() bool { return true }

// Run serves the page and exits 0 only when a key was saved.
func (AuthServeCommand) Run(ctx context.Context, call Invocation) (ExitCode, error) {
	deps := call.Deps()
	provider := deps.Provider
	env := domain.EnvLookup(deps.Env)
	store := keystore.WritableKeyStore(ctx, provider, env, keystore.PlatformOptions{})
	options := authpage.AuthPageOptions{
		Plugin:     provider.Name + "-plugin-cc",
		Display:    provider.Display,
		KeysURL:    provider.KeysURL,
		BillingURL: provider.BillingURL,
		StoreLabel: store.Label(),
		Check: func(ctx context.Context, key string) (ports.KeyVerdict, error) {
			return authpage.CheckKey(ctx, provider, key, nil), nil
		},
		Save: store.Set,
	}
	if version, ok := PluginVersion(deps.BundlePath); ok {
		options.Version = &version
	}
	page, err := authpage.StartAuthPage(options)
	if err != nil {
		return ExitUnexpected, err
	}
	deps.Out.Line(page.URL)
	if <-page.Done == authpage.AuthOutcomeSaved {
		return ExitOK, nil
	}
	return ExitNotReady, nil
}
