// The OS secret store for a provider's key: picks the platform's store, falls back to the key
// file where there is none, and runs the platform tools through a Runner (the real one spawns
// them without a shell; tests pass fakes).
package keystore

import (
	"context"
	"os"
	"os/user"
	"path/filepath"
	"runtime"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/process"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// toolTimeoutMs bounds a tool that hangs (a keychain waiting on an unlock prompt nobody answers).
const toolTimeoutMs = 60_000

// SpawnRunner spawns cmd directly (no shell), writes stdin and closes it, and collects stdout
// and stderr. A tool that cannot start answers Missing; nothing fails, and no field carries
// stdin.
func SpawnRunner(ctx context.Context, cmd string, args []string, stdin *string) RunResult {
	timeout := int64(toolTimeoutMs)
	options := process.ToolOptions{TimeoutMs: &timeout}
	if stdin != nil {
		options.Stdin = stdin
	}
	run := process.RunTool(ctx, cmd, args, options)
	if run.Kind == process.ToolMissing {
		return RunResult{Missing: true}
	}
	return RunResult{Code: run.Code, Stdout: string(run.Stdout), Stderr: string(run.Stderr)}
}

// systemRunner is the runner every default store uses.
var systemRunner Runner = SpawnRunner

// ReplaceSystemRunner swaps the runner every default store uses and returns the previous one, so
// test setup can install a refusing runner once and put the real one back afterwards.
func ReplaceSystemRunner(runner Runner) Runner {
	previous := systemRunner
	systemRunner = runner
	return previous
}

// PlatformOptions steer PlatformKeyStore and WritableKeyStore in tests.
type PlatformOptions struct {
	// Platform picks the store in Node's process.platform spelling (darwin, linux); nil
	// is the host's.
	Platform *string
	// Runner runs the platform tools; nil is the system runner.
	Runner Runner
	// AccountHome is the login account's home; the OS store belongs to it. Nil: the account
	// database's entry.
	AccountHome *string
}

// accountHome is the login account's home: the account database's entry, $HOME when there is
// none.
func accountHome() string {
	if info, err := user.Current(); err == nil {
		return info.HomeDir
	}
	return userHomeDir()
}

// userHomeDir is os.homedir(): $HOME, empty when unset.
func userHomeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// nodePlatform is the host platform in Node's process.platform spelling, which matches GOOS.
func nodePlatform() string {
	return runtime.GOOS
}

// resolvePath is Node's path.resolve: an absolute path cleaned, a relative one joined to the
// working directory. It cannot fail for the same reason resolve cannot: the only error source is
// a working directory that no longer exists.
func resolvePath(path string) string {
	abs, _ := filepath.Abs(path)
	return abs
}

// PlatformKeyStore is the platform's secret store for the provider, or nil where there is none.
// A process whose HOME is not the login account's home (a sandbox, a test harness) is a different
// profile: it gets no OS store, only its key file.
func PlatformKeyStore(provider domain.Provider, env domain.EnvLookup, options PlatformOptions) ports.KeyStore {
	home := accountHome()
	if options.AccountHome != nil {
		home = *options.AccountHome
	}
	if envHome, ok := env["HOME"]; ok && resolvePath(envHome) != resolvePath(home) {
		return nil
	}
	id := NewKeyIdentity(provider)
	run := systemRunner
	if options.Runner != nil {
		run = options.Runner
	}
	platform := nodePlatform()
	if options.Platform != nil {
		platform = *options.Platform
	}
	switch platform {
	case "darwin":
		return MacosKeyStore(id, run)
	case "linux":
		return LinuxKeyStore(id, run)
	default:
		return nil
	}
}

// WritableKeyStore is where setup and the auth page put a key: the platform store when it
// answers, else the provider's key file.
func WritableKeyStore(ctx context.Context, provider domain.Provider, env domain.EnvLookup, options PlatformOptions) ports.KeyStore {
	platform := PlatformKeyStore(provider, env, options)
	if platform != nil && platform.Available(ctx) {
		return platform
	}
	return FileKeyStore(provider, KeyFilePath(provider, env, provider.KeyFile))
}

// KeyFilePath is the provider's key file with `~` expanded from the env's HOME (the host's when
// the env has none).
func KeyFilePath(provider domain.Provider, env domain.EnvLookup, path string) string {
	home, ok := env["HOME"]
	if !ok {
		home = userHomeDir()
	}
	return ExpandHome(path, home)
}
