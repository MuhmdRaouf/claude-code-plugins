package adapters

import (
	"fmt"
	"os"
)

// version is the binary's version: "dev" unless the build sets it with
// -ldflags "-X <pkg>.version=<VERSION>" (scripts/build and scripts/host-build.sh).
var version = "dev"

// Runtime names what the CLI runs on, for setup's runtime line: plugin-core is one static binary
// that runs on no runtime, so the line names the binary itself with its version and path
// (runtimeLabel's "name version (path)").
func Runtime() string {
	self, err := os.Executable()
	path := ""
	if err == nil {
		path = self
	}
	return RuntimeLabel(version, path)
}

// RuntimeLabel is the runtime line for a version and executable path: "plugin-core <version>
// (<path>)", without the parentheses when there is no path to name.
func RuntimeLabel(version, path string) string {
	if path == "" {
		return "plugin-core " + version
	}
	return fmt.Sprintf("plugin-core %s (%s)", version, path)
}
