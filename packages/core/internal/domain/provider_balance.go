// "This account has no balance or quota left": each provider says it its own way, on its own status. The router turns
// such an answer into one Claude Code does not retry, and a job that ran into one is not retried either: no retry can
// succeed until the user tops up.
package domain

import (
	"encoding/json"
	"regexp"
	"strconv"
)

// balanceCodes is each provider's own error codes for an account out of balance or quota, as each documents them:
//   - Z.ai: 1113 "Insufficient balance or no resource package" (HTTP 429), 1316/1317 usage cap reached with
//     "Insufficient balance for extra usage" (HTTP 429): https://docs.z.ai/api-reference/api-code
//   - Moonshot: error.type `exceeded_current_quota_error` (HTTP 429, "Account balance is insufficient or the account has
//     been disabled"): https://platform.kimi.ai/docs/api/errors
//   - DeepSeek: HTTP 402 "Insufficient Balance" (matched by status below):
//     https://api-docs.deepseek.com/quick_start/error_codes
//   - MiniMax: base_resp.status_code 1008 "insufficient balance": https://platform.minimax.io/docs/api-reference/errorcode
//   - Alibaba Model Studio (DashScope): `Arrearage` (HTTP 400, "Access denied, please make sure your account is in good
//     standing") and `isv.OUT_OF_SERVICE`: https://www.alibabacloud.com/help/en/model-studio/error-code
var balanceCodes = map[string]struct{}{
	"1113":                         {},
	"1316":                         {},
	"1317":                         {},
	"exceeded_current_quota_error": {},
	"1008":                         {},
	"Arrearage":                    {},
	"isv.OUT_OF_SERVICE":           {},
}

// balanceWording is the documented wording of those same errors, for a provider that sends the message without its
// code.
var balanceWording = regexp.MustCompile(`(?i)insufficient balance|account is in good standing|余额不足|欠费`)

// OutOfBalance reports whether an error answer (its status and its parsed JSON body, when it has one) says the account
// is out of balance or quota: DeepSeek's 402, or one of the codes or wordings above in the places each provider puts
// them.
func OutOfBalance(status int64, body any) bool {
	if status == 402 {
		return true
	}
	top := balanceRecord(body)
	if top == nil {
		return false
	}
	var errorObject, base map[string]any
	if object, ok := top["error"].(map[string]any); ok {
		errorObject = object
	}
	if object, ok := top["base_resp"].(map[string]any); ok {
		base = object
	}
	for _, code := range []any{errorObject["code"], errorObject["type"], top["code"], top["type"], base["status_code"]} {
		if text, ok := balanceCodeText(code); ok {
			if _, known := balanceCodes[text]; known {
				return true
			}
		}
	}
	for _, message := range []any{errorObject["message"], top["message"], base["status_msg"]} {
		if text, ok := message.(string); ok && balanceWording.MatchString(text) {
			return true
		}
	}
	return false
}

// codeInText finds a code in a JSON fragment of free text (a worker's "API Error: 429 {…}" line): `"code":"1113"`,
// `"type": "exceeded_current_quota_error"`, `"status_code":1008`, `"code":"Arrearage"`.
var codeInText = regexp.MustCompile(`"(?:code|type|status_code)"` + jsSpace + `*:` + jsSpace + `*"?([A-Za-z0-9_.]+)"?`)

// OutOfBalanceText gives the same verdict from an error's text alone, as a worker reports it: DeepSeek's 402, a known
// code in the JSON the text carries, or the documented wording.
func OutOfBalanceText(status *int64, text string) bool {
	if status != nil && *status == 402 {
		return true
	}
	for _, match := range codeInText.FindAllStringSubmatch(text, -1) {
		if _, known := balanceCodes[match[1]]; known {
			return true
		}
	}
	return balanceWording.MatchString(text)
}

// balanceRecord reads a JSON object; null and arrays read as none, so a malformed balance payload
// is no balance.
func balanceRecord(value any) map[string]any {
	if object, ok := value.(map[string]any); ok {
		return object
	}
	return nil
}

// balanceCodeText renders a code a provider reports the way JavaScript's String(code) does: a
// string stands, a number renders as its literal.
func balanceCodeText(code any) (string, bool) {
	switch value := code.(type) {
	case string:
		return value, true
	case float64:
		return strconv.FormatFloat(value, 'f', -1, 64), true
	case int64:
		return strconv.FormatInt(value, 10), true
	case json.Number:
		return value.String(), true
	}
	return "", false
}
