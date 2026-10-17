// What the platform key stores share: the runner they call their tools through, the key's names in a
// store, the key's accepted shape and the failure text. A key only ever travels on a tool's stdin:
// never in argv, never in an error message.
package keystore

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// RunResult is what a platform tool returned. A nil Code is a signal; Missing means the tool
// itself could not be started.
type RunResult struct {
	Code    *int
	Stdout  string
	Stderr  string
	Missing bool
}

// Runner runs one tool without a shell; stdin, when given, is written and closed. Tests pass a
// fake.
type Runner func(ctx context.Context, cmd string, args []string, stdin *string) RunResult

// KeyIdentity is the store's names for one provider: service `<name>-plugin-cc`, account
// `api-key`.
type KeyIdentity struct {
	Service string
	Account string
	// Display is the provider as people know it, for the Secret Service label.
	Display string
}

// keyAccount is the account name every provider's key uses.
const keyAccount = "api-key"

// serviceShape keeps the service name quotable into a `security -i` command line.
var serviceShape = regexp.MustCompile(`^[a-z0-9-]+$`)

// NewKeyIdentity returns the store's names for the provider: service `<name>-plugin-cc`, account
// `api-key`. It panics on a service name that is not plain [a-z0-9-]: the name is quoted into a
// `security -i` command line, so an odd one is a programmer error.
func NewKeyIdentity(provider domain.Provider) KeyIdentity {
	service := provider.Name + "-plugin-cc"
	if !serviceShape.MatchString(service) {
		panic("unsupported key service name " + strconv.Quote(service))
	}
	return KeyIdentity{Service: service, Account: keyAccount, Display: provider.Display}
}

// keyShape is a provider key as the stores accept it: 16-512 characters of [A-Za-z0-9._-]. This
// also keeps quoting safe.
var keyShape = regexp.MustCompile(`^[A-Za-z0-9._-]{16,512}$`)

// IsValidKey reports whether key fits the stores' accepted shape.
func IsValidKey(key string) bool {
	return keyShape.MatchString(key)
}

// InvalidKeyError is returned before any tool runs; its message never contains the key.
type InvalidKeyError struct{}

func (InvalidKeyError) Error() string {
	return "the key must be 16-512 characters of letters, digits, '.', '_' or '-'"
}

// AssertValidKey returns InvalidKeyError when key is not a shape the stores accept.
func AssertValidKey(key string) error {
	if !IsValidKey(key) {
		return InvalidKeyError{}
	}
	return nil
}

// StoreFailure is a store failure that names the store and the exit code, never stdin or the
// tool's output.
func StoreFailure(label string, action string, result RunResult) error {
	why := "signal"
	switch {
	case result.Missing:
		why = "tool not found"
	case result.Code != nil:
		why = fmt.Sprintf("exit %d", *result.Code)
	}
	return fmt.Errorf("could not %s the key in %s (%s)", action, label, why)
}

// TrimNewline is tool output minus one trailing line break.
func TrimNewline(text string) string {
	text = strings.TrimSuffix(text, "\n")
	return strings.TrimSuffix(text, "\r")
}

// exited reports whether the tool ran to the given exit code (a signal or a missing tool did
// not).
func (r RunResult) exited(code int) bool {
	return r.Code != nil && *r.Code == code
}

// trimmedKey is a get's stdout as a stored key: one trailing line break gone, empty means none.
func trimmedKey(stdout string) (string, bool) {
	value := TrimNewline(stdout)
	if value == "" {
		return "", false
	}
	return value, true
}
