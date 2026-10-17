// What a provider route answers when the provider refuses the key, the account has run dry, or the
// user's budget in the Radar dashboard is used up. Claude Code reads a 401
// or 403 as its own Anthropic login failing ("run /login"), and retries a 429 or a 5xx with backoff
// for minutes, so on a provider route neither may reach it as it came: a refused or missing key and
// an empty balance both become a 400 that is not retried (`x-should-retry: false`) and says what to
// run or where to top up. `claude-*` and peer routes never come through here. No upstream text is
// copied into the answer, so nothing the provider echoes (a key included) can leak through it.
package router

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// Refusal is why a provider answer is rewritten: the key was refused (or there is none), or the
// account has no balance.
type Refusal string

const (
	RefusalKey     Refusal = "key"
	RefusalBalance Refusal = "balance"
)

// refusalStatus is the status every refusal is answered with: a 400 is neither a login failure nor
// retried.
const refusalStatus = 400

// MayRefuse is true of the upstream answers worth reading before they are sent: every error. A
// success streams through untouched.
func MayRefuse(status int) bool {
	return status >= 400
}

// RefusalOf is why the provider's answer is a refusal, or false for any other answer (sent as it
// came).
func RefusalOf(status int, body []byte) (Refusal, bool) {
	if status < 400 {
		return "", false
	}
	if domain.OutOfBalance(int64(status), parseBody(body)) {
		return RefusalBalance, true
	}
	if status == 401 || status == 403 {
		return RefusalKey, true
	}
	return "", false
}

// parseBody is the body as JSON, or nothing when it does not parse.
func parseBody(body []byte) any {
	var parsed any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil
	}
	return parsed
}

// RefusalNames is the provider subset a refusal's wording needs.
type RefusalNames struct {
	Display    string
	Slash      string
	BillingURL string
}

// refusalMessage is the message a refusal carries; why says what the router saw (an upstream
// status, or no key).
func refusalMessage(provider RefusalNames, refusal Refusal, why string) string {
	if refusal == RefusalKey {
		return fmt.Sprintf("%s key refused or missing: run %ssetup (%s). Claude models are not affected.", provider.Display, provider.Slash, why)
	}
	return fmt.Sprintf("%s says this key has no balance or quota left (%s): top up at %s, then retry. Claude models are not affected.", provider.Display, why, provider.BillingURL)
}

// RefusalAnswer is the Anthropic-shaped, non-retryable answer for a refusal.
func RefusalAnswer(provider RefusalNames, refusal Refusal, why string) Replacement {
	return refused(refusalMessage(provider, refusal, why))
}

// BudgetAnswer is the answer for a provider request while Radar's budget for it is stopped: the
// refusal's shape.
func BudgetAnswer(message string) Replacement {
	return refused(message)
}

// refused is the refusal's own envelope.
func refused(message string) Replacement {
	return Replacement{
		Status:  refusalStatus,
		Headers: http.Header{"Content-Type": {"application/json"}, "X-Should-Retry": {"false"}},
		Body:    marshalCompact(anthropicEvent{Type: "error", Error: anthropicDetail{Type: "invalid_request_error", Message: message}}),
	}
}

// RemovedAnswer is the answer for a provider or peer request on a retired router: the plugin is
// gone, and only a restart moves the session off this router.
func RemovedAnswer(display string) Replacement {
	return refused(display + " was removed: restart Claude Code to stop using its router")
}
