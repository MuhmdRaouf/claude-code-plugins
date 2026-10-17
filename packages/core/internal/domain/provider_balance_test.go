package domain

import (
	"bytes"
	"encoding/json"
	"testing"
)

// balanceBody decodes a JSON body the way the router hands it to OutOfBalance.
func balanceBody(t *testing.T, text string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		t.Fatalf("decode %s: %v", text, err)
	}
	return value
}

// balanceBodyAsNumbers decodes with UseNumber, the other decoded shape a caller may hold.
func balanceBodyAsNumbers(t *testing.T, text string) any {
	t.Helper()
	var value any
	decoder := json.NewDecoder(bytes.NewReader([]byte(text)))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("decode %s: %v", text, err)
	}
	return value
}

func TestOutOfBalance(t *testing.T) {
	cases := []struct {
		name   string
		status int64
		body   string
		want   bool
	}{
		{"DeepSeek's 402 says it whatever the body", 402, `{"error":{"code":"x"}}`, true},
		{"DeepSeek's 402 with no body at all", 402, `null`, true},
		{"Z.ai's 1113 in error.code", 429, `{"error":{"code":"1113","message":"Insufficient balance or no resource package"}}`, true},
		{"Z.ai's 1316 as a number", 429, `{"error":{"code":1316}}`, true},
		{"Moonshot's type in error.type", 429, `{"error":{"type":"exceeded_current_quota_error"}}`, true},
		{"DashScope's Arrearage at the top", 400, `{"code":"Arrearage"}`, true},
		{"DashScope out of service at the top", 400, `{"type":"isv.OUT_OF_SERVICE"}`, true},
		{"MiniMax's 1008 in base_resp.status_code", 200, `{"base_resp":{"status_code":1008}}`, true},
		{"the wording alone, in error.message", 429, `{"error":{"message":"Insufficient balance or no resource package"}}`, true},
		{"the wording alone, uppercase", 429, `{"message":"INSUFFICIENT BALANCE"}`, true},
		{"the wording in the good-standing phrase", 400, `{"message":"Access denied, please make sure your account is in good standing"}`, true},
		{"the wording in Chinese", 400, `{"message":"余额不足，请充值"}`, true},
		{"the wording in base_resp.status_msg", 200, `{"base_resp":{"status_msg":"账户欠费"}}`, true},
		{"another code and another message say no", 500, `{"error":{"code":"1234","message":"rate limited"}}`, false},
		{"no body says no", 500, `null`, false},
		{"an array body says no", 500, `[1,2]`, false},
		{"a boolean code is not a code", 500, `{"error":{"code":true}}`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := OutOfBalance(tc.status, balanceBody(t, tc.body)); got != tc.want {
				t.Fatalf("OutOfBalance(%d, %s) = %v, want %v", tc.status, tc.body, got, tc.want)
			}
		})
	}

	t.Run("a json.Number code counts too", func(t *testing.T) {
		body := balanceBodyAsNumbers(t, `{"error":{"code":1113}}`)
		if !OutOfBalance(429, body) {
			t.Fatal("OutOfBalance(429, code as json.Number) = false, want true")
		}
	})
}

func TestOutOfBalanceText(t *testing.T) {
	status402 := int64(402)
	status429 := int64(429)
	cases := []struct {
		name   string
		status *int64
		text   string
		want   bool
	}{
		{"DeepSeek's 402 says it", &status402, "Payment Required", true},
		{"a known code in the JSON the text carries", nil, `API Error: 429 {"code":"1113","message":"x"}`, true},
		{"a known type with spaces around the colon", nil, `{"type": "exceeded_current_quota_error"}`, true},
		{"a known status code as a bare number", nil, `upstream said {"status_code":1008}`, true},
		{"Arrearage in a fragment", nil, `{"code":"Arrearage"}`, true},
		{"an unknown code falls through to the wording", nil, `{"code":"1234"} insufficient balance`, true},
		{"an unknown code alone says no", nil, `{"code":"1234"}`, false},
		{"the wording, any case", nil, "Insufficient Balance for extra usage", true},
		{"the wording in Chinese", nil, "余额不足", true},
		{"an ordinary error says no", &status429, "API Error: 429 too many requests", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := OutOfBalanceText(tc.status, tc.text); got != tc.want {
				t.Fatalf("OutOfBalanceText(%v, %q) = %v, want %v", tc.status, tc.text, got, tc.want)
			}
		})
	}
}

func TestBalanceCodeText(t *testing.T) {
	cases := []struct {
		name  string
		code  any
		want  string
		valid bool
	}{
		{"a string is itself", "1113", "1113", true},
		{"a float64 formats without a fraction", float64(1316), "1316", true},
		{"an int64 formats", int64(1008), "1008", true},
		{"a json.Number is its text", json.Number("1113"), "1113", true},
		{"a boolean is not a code", true, "", false},
		{"nil is not a code", nil, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := balanceCodeText(tc.code)
			if ok != tc.valid || got != tc.want {
				t.Fatalf("balanceCodeText(%v) = %q, %v; want %q, %v", tc.code, got, ok, tc.want, tc.valid)
			}
		})
	}
}
