package domain

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// marshalJobJSON renders a job the way job.json is written: JavaScript's
// JSON.stringify(job, null, 2) plus a newline, with no HTML escaping (`<`, `>` and `&` stay raw).
func marshalJobJSON(t *testing.T, job Job) string {
	t.Helper()
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(job); err != nil {
		t.Fatalf("encode job: %v", err)
	}
	return buf.String()
}

// The golden is a fixed fixture: a job.json with every field shape the format can carry,
// serialized exactly as the store writes it. Reading it and writing it back must not change
// one byte.
func TestJobJSONRoundTrip(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "job", "job.json"))
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var job Job
	if err := json.Unmarshal(raw, &job); err != nil {
		t.Fatalf("decode golden: %v", err)
	}
	if got := marshalJobJSON(t, job); got != string(raw) {
		t.Fatalf("round trip changed the bytes:\ngot:  %q\nwant: %q", got, string(raw))
	}
}

func TestWorkerOutcomeJSONVariants(t *testing.T) {
	outcomes := []WorkerOutcome{
		{Kind: WorkerOutcomeCompleted},
		{Kind: WorkerOutcomeTimeout},
		{Kind: WorkerOutcomeStopped},
		{Kind: WorkerOutcomeAPIError, Message: "Insufficient balance", Status: i64Ptr(429), Quota: boolPtr(true)},
		{Kind: WorkerOutcomeCrashed, ExitCode: i64Ptr(1), StderrTail: "boom\nat line 3"},
	}
	for _, outcome := range outcomes {
		encoded, err := json.Marshal(outcome)
		if err != nil {
			t.Fatalf("%s: marshal: %v", outcome.Kind, err)
		}
		var decoded WorkerOutcome
		if err := json.Unmarshal(encoded, &decoded); err != nil {
			t.Fatalf("%s: unmarshal %s: %v", outcome.Kind, encoded, err)
		}
		if !reflect.DeepEqual(decoded, outcome) {
			t.Errorf("%s: decoded %+v, want %+v", outcome.Kind, decoded, outcome)
		}
	}
}

func TestWorkerOutcomeUnknownKind(t *testing.T) {
	if _, err := json.Marshal(WorkerOutcome{Kind: "bogus"}); err == nil {
		t.Error("marshal of an unknown kind succeeds, want an error")
	}
	if err := json.Unmarshal([]byte(`{"kind":"bogus"}`), &WorkerOutcome{}); err == nil {
		t.Error("unmarshal of an unknown kind succeeds, want an error")
	}
	if err := json.Unmarshal([]byte(`{"kind":3}`), &WorkerOutcome{}); err == nil {
		t.Error("unmarshal of a non-string kind succeeds, want an error")
	}
	if err := json.Unmarshal([]byte(`not json`), &WorkerOutcome{}); err == nil {
		t.Error("unmarshal of malformed json succeeds, want an error")
	}
	for _, malformed := range []string{
		`{"kind":"api_error","message":3}`,
		`{"kind":"api_error","status":"x"}`,
		`{"kind":"api_error","quota":"yes"}`,
		`{"kind":"crashed","exitCode":true}`,
		`{"kind":"crashed","signal":7}`,
		`{"kind":"crashed","stderrTail":[]}`,
	} {
		if err := json.Unmarshal([]byte(malformed), &WorkerOutcome{}); err == nil {
			t.Errorf("unmarshal of %s succeeds, want an error", malformed)
		}
	}
}

func TestJobOrigin(t *testing.T) {
	valid := "00000000-0000-4000-8000-00000000000f"
	if got := JobOrigin(valid); got == nil || got.SessionID != valid {
		t.Errorf("JobOrigin(%q) = %+v, want the origin", valid, got)
	}
	upper := "00000000-0000-4000-8000-00000000000F"
	if got := JobOrigin(upper); got == nil || got.SessionID != upper {
		t.Errorf("JobOrigin(%q) = %+v, want the origin (the pattern is case-insensitive)", upper, got)
	}
	for _, invalid := range []any{"nope", "", nil, float64(42), "0000000-0000-4000-8000-000000000000"} {
		if got := JobOrigin(invalid); got != nil {
			t.Errorf("JobOrigin(%v) = %+v, want nil", invalid, got)
		}
	}
}

func TestStoredOrigin(t *testing.T) {
	valid := "00000000-0000-4000-8000-000000000001"
	if got := StoredOrigin(map[string]any{"sessionId": valid}); got == nil || got.SessionID != valid {
		t.Errorf("StoredOrigin(valid) = %+v, want the origin", got)
	}
	for _, foreign := range []any{
		nil,
		"00000000-0000-4000-8000-000000000001",
		map[string]any{"sessionId": "not-a-session-id"},
		map[string]any{},
	} {
		if got := StoredOrigin(foreign); got != nil {
			t.Errorf("StoredOrigin(%v) = %+v, want nil", foreign, got)
		}
	}
}
