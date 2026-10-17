// The passthrough the front serves itself when its worker will not stay up, and the emergency
// process serves when the main router cannot start at all: every request that is not for this
// provider's models goes to Anthropic exactly as it came (method, path, query, headers minus
// hop-by-hop, body, the caller's own credentials, the streamed answer and its status); a
// provider-model request gets an Anthropic-shaped 503 that says what to run. A body that does not
// parse, or names no model, is Anthropic's: never block on it.
package router

import (
	"fmt"
	"net/http"
	"net/url"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// PassthroughOptions is what the passthrough needs to know: whose models to refuse, and how to
// word the refusal.
type PassthroughOptions struct {
	// Name is the plugin's short name, as in `/<name>:setup`.
	Name string
	// Display is the provider as people know it, e.g. "Z.ai GLM".
	Display string
	// Claim is the model ids this provider claims (refused here); every other request is
	// Anthropic's.
	Claim domain.ModelClaim
	// Anthropic is where every other request goes: https://api.anthropic.com unless overridden.
	Anthropic *url.URL
	Env       ProxyEnv
	// State is why provider models are refused: "degraded after repeated crashes" or "in emergency
	// passthrough".
	State string
	// IdleMs is the silence budget of a call; 0 is the default ten minutes.
	IdleMs int64
	Log    func(line string)
}

// DegradedMessage is the 503 a provider-model request gets while the router is not fully up.
func DegradedMessage(name, display, state string) string {
	return fmt.Sprintf("%s router %s; Claude models still work. Run /%s:setup.", display, state, name)
}

// PassThrough serves one request whose body has already been read.
func PassThrough(options PassthroughOptions, req *http.Request, res *Response, body []byte) {
	path, ok := SafePath(req.RequestURI)
	if !ok {
		AnthropicError(res, 400, "invalid_request_error", "bad request path")
		return
	}
	model := RequestModel(body)
	if domain.Claims(options.Claim, model) {
		if options.Log != nil {
			options.Log(fmt.Sprintf("%s %s model=%s → refused (%s)", req.Method, path, model, options.State))
		}
		AnthropicError(res, 503, "api_error", DegradedMessage(options.Name, options.Display, options.State))
		return
	}
	target, err := UpstreamURL(options.Anthropic, path)
	if err != nil {
		// The path came through SafePath and the target is configured; a URL that still does not
		// parse is a bad request path, not a crash.
		AnthropicError(res, 400, "invalid_request_error", "bad request path")
		return
	}
	SendUpstream(req.Context(), UpstreamCall{
		URL:     target,
		Method:  req.Method,
		Headers: ForwardHeaders(req.Header, target, len(body)),
		Body:    body,
		Env:     options.Env,
		IdleMs:  options.IdleMs,
	}, res, UpstreamHooks{
		Answered: func(answer *http.Response) {
			if options.Log != nil {
				options.Log(fmt.Sprintf("%s %s model=%s → anthropic %d (passthrough)", req.Method, path, modelOrDash(model), answer.StatusCode))
			}
		},
		Failed: func(failure UpstreamFailure) {
			if options.Log != nil {
				options.Log(fmt.Sprintf("%s %s model=%s → anthropic error %s (passthrough)", req.Method, path, modelOrDash(model), failure.Code))
			}
			if !failure.AfterHeaders {
				AnthropicError(res, 502, "api_error", fmt.Sprintf("%s router: anthropic unreachable (%s)", options.Name, failure.Code))
			}
		},
	})
}

// modelOrDash is the model a log line names, "-" when the request carried none.
func modelOrDash(model string) string {
	if model == "" {
		return "-"
	}
	return model
}
