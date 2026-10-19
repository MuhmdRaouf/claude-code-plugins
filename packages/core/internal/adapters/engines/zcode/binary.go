// The zcode binary: where it is and how it runs. The desktop app bundles its CLI as plain
// JavaScript, often without an executable bit, so a script is launched through a JS runtime
// instead of executed directly.
package zcode

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// zcodeScript matches the desktop bundle's CLI names: .js, .cjs and .mjs, any case.
var zcodeScript = regexp.MustCompile(`(?i)\.(c?js|mjs)$`)

// IsZcodeScript says whether bin is the desktop bundle's JavaScript CLI.
func IsZcodeScript(bin string) bool {
	return zcodeScript.MatchString(bin)
}

// ZcodeCommand is how bin runs: a script goes through the desktop app's own Electron executable
// when one sits beside it (as plain node under ELECTRON_RUN_AS_NODE=1), else through node. The
// binary runs on no JS runtime, so the worker resolves "node" against the tool's own environment
// (Start and Preflight), never the orchestrator's PATH. Anything that is not a script runs as
// itself.
func ZcodeCommand(bin string) (string, []string) {
	if !IsZcodeScript(bin) {
		return bin, nil
	}
	if app := ElectronApp(bin); app != "" {
		return app, []string{bin}
	}
	return "node", []string{bin}
}

// ElectronApp is the desktop app's own executable for an app-bundled script — the Electron binary,
// which runs the script as plain node once ELECTRON_RUN_AS_NODE=1 is set:
// <X>.app/Contents/Resources/glm/zcode.cjs runs on <X>.app/Contents/MacOS/ZCode. Empty when
// that does not exist beside the script (or bin is not a script): the script then needs node.
func ElectronApp(script string) string {
	if !IsZcodeScript(script) {
		return ""
	}
	// Three directories up from the script: …/Contents for an app bundle.
	root := filepath.Dir(filepath.Dir(filepath.Dir(script)))
	for _, candidate := range []string{
		filepath.Join(root, "MacOS", "ZCode"),
	} {
		if isExecutableFile(candidate) {
			return candidate
		}
	}
	return ""
}

// isExecutableFile says whether path is a regular file that runs: an executable bit set.
func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	return info.Mode().Perm()&0o111 != 0
}

// isRegularFile says whether path is a regular file, executable or not.
func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// builtinProviderConfigEnv names the variable that points the bundled CLI at its built-in
// provider config.
const builtinProviderConfigEnv = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"

// CLIScriptFor is the desktop bundle's CLI script when bin is the app's GUI executable: zcode on
// PATH can be a symlink to <X>.app/Contents/MacOS/ZCode — Electron, which without
// ELECTRON_RUN_AS_NODE starts the GUI and dies — while the CLI is the bundle's
// Contents/Resources/glm/zcode.cjs, run by that same executable as plain node. Empty for any
// other binary, which runs as itself.
func CLIScriptFor(bin string) string {
	resolved, err := filepath.EvalSymlinks(bin)
	if err != nil {
		return ""
	}
	// <X>.app/Contents/MacOS/<exe>: the CLI lives two directories up, in Resources/glm.
	if filepath.Base(filepath.Dir(resolved)) != "MacOS" ||
		filepath.Base(filepath.Dir(filepath.Dir(resolved))) != "Contents" {
		return ""
	}
	script := filepath.Join(filepath.Dir(filepath.Dir(resolved)), "Resources", "glm", "zcode.cjs")
	if ReadableZcodeScript(script) {
		return script
	}
	return ""
}

// BuiltinProviderConfig is the built-in provider config of the app bundle an app-bundled script
// belongs to: started from Resources/glm the CLI looks for it in glm/provider/ and five
// directories up, while the file sits in Contents/Resources/config/provider/zcode-builtin.json.
// Empty when the script runs from no app bundle or the bundle has no such file.
func BuiltinProviderConfig(script string) string {
	if ElectronApp(script) == "" {
		return ""
	}
	// glm/zcode.cjs → glm → Resources: the config sits under the script's own Resources.
	config := filepath.Join(filepath.Dir(filepath.Dir(script)),
		"config", "provider", "zcode-builtin.json")
	if isRegularFile(config) {
		return config
	}
	return ""
}

// SetAppRunnerEnv prepares env for the desktop app's own executable running the bundle's CLI as
// plain node: ELECTRON_RUN_AS_NODE=1, and the bundle's built-in provider config when it has one.
// A config the environment already names is kept. It runs after the environment was filtered, so
// reservedName cannot strip the value the plugin adds.
func SetAppRunnerEnv(env map[string]string, script string) {
	env["ELECTRON_RUN_AS_NODE"] = "1"
	if config := BuiltinProviderConfig(script); config != "" {
		if _, ok := env[builtinProviderConfigEnv]; !ok {
			env[builtinProviderConfigEnv] = config
		}
	}
}

// RunnerEnv is the environment for the desktop app's own executable running the bundle's CLI as
// plain node (`--version` and the like): the parent's environment with SetAppRunnerEnv applied,
// as name=value sorted by name.
func RunnerEnv(parent domain.EnvLookup, script string) []string {
	env := make(map[string]string, len(parent)+2)
	for name, value := range parent {
		env[name] = value
	}
	SetAppRunnerEnv(env, script)
	return envList(env)
}

// ReadableZcodeScript says whether bin is a script the runtime can read: present, readable and a
// regular file. No executable bit is needed.
func ReadableZcodeScript(bin string) bool {
	if !IsZcodeScript(bin) {
		return false
	}
	reader, err := os.Open(bin)
	if err != nil {
		return false
	}
	info, err := reader.Stat()
	reader.Close()
	return err == nil && info.Mode().IsRegular()
}

// ZcodeBinary finds the zcode CLI: an explicit override wins, then ZCODE_CLI, then an executable
// PATH entry, then the app's bundled script (Linux needs PATH or an override). A found or
// overridden binary that is the desktop app's GUI executable maps to the CLI it stands for.
// platform is the Node platform name ("darwin", "linux"), not runtime.GOOS's.
func ZcodeBinary(env domain.EnvLookup, override string, platform string) string {
	bin := zcodeBinary(env, override, platform)
	if script := CLIScriptFor(bin); script != "" {
		return script
	}
	return bin
}

// zcodeBinary is the found or overridden binary, before the GUI-executable mapping.
func zcodeBinary(env domain.EnvLookup, override string, platform string) string {
	if override != "" {
		return override
	}
	if cli := env["ZCODE_CLI"]; cli != "" {
		return cli
	}
	if found := onPath(env["PATH"]); found != "" {
		return found
	}
	for _, candidate := range bundleCandidates(env, platform) {
		if ReadableZcodeScript(candidate) {
			return candidate
		}
	}
	return "zcode"
}

// onPath is the first PATH entry holding an executable regular file named zcode; empty segments
// and failures keep the search going.
func onPath(path string) string {
	return executableOnPath(path, "zcode")
}

// executableOnPath is the first PATH entry holding an executable regular file named name.
func executableOnPath(path, name string) string {
	for _, dir := range strings.Split(path, string(os.PathListSeparator)) {
		if dir == "" {
			continue
		}
		candidate := filepath.Join(dir, name)
		if isExecutableFile(candidate) {
			return candidate
		}
		// Keep searching the remaining PATH entries.
	}
	return ""
}

// NodeOnPath is node resolved from the tool's own environment: the fallback runner for a bundled
// script with no app executable beside it. The orchestrator's PATH is never consulted — the Go
// binary must not depend on, or accidentally run, whatever node the orchestrator happens to use.
func NodeOnPath(env domain.EnvLookup) (string, bool) {
	if found := executableOnPath(env["PATH"], "node"); found != "" {
		return found, true
	}
	return "", false
}

// bundleCandidates is where the desktop app installs its bundled CLI, per platform.
func bundleCandidates(env domain.EnvLookup, platform string) []string {
	switch platform {
	case "darwin":
		candidates := []string{"/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"}
		if home := env["HOME"]; home != "" {
			candidates = append(candidates,
				filepath.Join(home, "Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"))
		}
		return candidates
	}
	return []string{}
}
