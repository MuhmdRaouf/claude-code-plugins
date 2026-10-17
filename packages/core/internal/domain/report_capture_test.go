package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestExtractReportReadsTheReportOutOfAFinalMessage(t *testing.T) {
	fromCases := []struct {
		name string
		text string
		want string
	}{
		{"the whole text", `{"summary":"done"}`, `{"summary":"done"}`},
		{"a fenced block", "Here it is:\n```json\n{\"summary\":\"done\"}\n```\nThanks.", `{"summary":"done"}`},
		{"an unlabelled fence", "```\n{\"summary\":\"done\"}\n```", `{"summary":"done"}`},
		{"the outermost braces in prose", "The report is {\"summary\":\"done\"} as asked.", `{"summary":"done"}`},
		{"zeta before alpha, byte for byte as JSON.stringify writes it",
			`{"zeta":1,"alpha":2}`, `{"zeta":1,"alpha":2}`},
		{"a pretty report compacts without reordering",
			"{\n  \"zeta\": 1,\n  \"alpha\": 2\n}", `{"zeta":1,"alpha":2}`},
	}
	for _, tc := range fromCases {
		t.Run("from "+tc.name, func(t *testing.T) {
			got := ExtractReport(tc.text)
			if string(got) != tc.want {
				t.Fatalf("ExtractReport(%q) = %s, want %s", tc.text, got, tc.want)
			}
		})
	}

	nullCases := []struct {
		name string
		text string
	}{
		{"no JSON at all", "all done"},
		{"an array", "[1, 2]"},
		{"a scalar", "42"},
		{"a fence holding an array", "```\n[1]\n```"},
		{"braces holding a scalar", "{1}"},
		{"broken braces", `{"summary": `},
	}
	for _, tc := range nullCases {
		t.Run("is null for "+tc.name, func(t *testing.T) {
			if got := ExtractReport(tc.text); got != nil {
				t.Fatalf("ExtractReport(%q) = %s, want null", tc.text, got)
			}
		})
	}
}

func TestTheReportContractInWords(t *testing.T) {
	t.Run("appends the schema to the prompt and asks for one JSON object", func(t *testing.T) {
		text := ReportInstructions("Do the thing.", json.RawMessage(`{"type":"object"}`))
		if !strings.HasPrefix(text, "Do the thing.\n\n## Final report\n") {
			t.Fatalf("ReportInstructions() prefix is wrong:\n%s", text)
		}
		if !strings.Contains(text, "Work unattended.") {
			t.Fatalf("ReportInstructions() misses the unattended line:\n%s", text)
		}
		if !strings.Contains(text, "only the report as one JSON object") {
			t.Fatalf("ReportInstructions() misses the one-object line:\n%s", text)
		}
		if !strings.Contains(text, "```json\n{\n  \"type\": \"object\"\n}\n```") {
			t.Fatalf("ReportInstructions() misses the schema fence:\n%s", text)
		}
	})

	t.Run("indents the schema exactly as JSON.stringify(x, null, 2), key order kept", func(t *testing.T) {
		got := ReportInstructions("P.", json.RawMessage(`{"z":1,"a":2,"m":3}`))
		want := strings.Join([]string{
			"P.",
			"",
			"## Final report",
			"",
			"Work unattended. Make reasonable task decisions within the brief; record blockers in the final report instead of asking for input.",
			"Your final message must contain only the report as one JSON object, and nothing else.",
			"The report must satisfy this JSON schema:",
			"",
			"```json",
			"{\n  \"z\": 1,\n  \"a\": 2,\n  \"m\": 3\n}",
			"```",
		}, "\n")
		if got != want {
			t.Fatalf("ReportInstructions() =\n%s\nwant\n%s", got, want)
		}
	})

	t.Run("keeps nested key order and JS's empty containers", func(t *testing.T) {
		text := ReportInstructions("P.", json.RawMessage(`{"outer":{"z":1,"a":[1,2]},"empty":{},"earr":[]}`))
		if !strings.Contains(text, "\"outer\": {\n    \"z\": 1,\n    \"a\": [\n      1,\n      2\n    ]\n  }") {
			t.Fatalf("ReportInstructions() reorders or reformats the nested schema:\n%s", text)
		}
		if !strings.Contains(text, "\"empty\": {}") || !strings.Contains(text, "\"earr\": []") {
			t.Fatalf("ReportInstructions() does not keep empty containers on one line:\n%s", text)
		}
	})

	t.Run("no schema leaves an empty line, like JSON.stringify(undefined)", func(t *testing.T) {
		if text := ReportInstructions("P.", nil); !strings.Contains(text, "```json\n\n```") {
			t.Fatalf("ReportInstructions() with no schema =\n%s", text)
		}
	})

	t.Run("asks for a correction naming every problem", func(t *testing.T) {
		got := CorrectionPrompt([]string{"summary: required", "files: expected array"})
		want := "Your report was invalid: summary: required; files: expected array. Reply with only the corrected JSON object."
		if got != want {
			t.Fatalf("CorrectionPrompt() = %q, want %q", got, want)
		}
	})

	t.Run("schema bytes that are not JSON panic, as JSON.stringify throws", func(t *testing.T) {
		defer func() {
			if recover() == nil {
				t.Fatal("jsonTwoSpace(not JSON) did not panic")
			}
		}()
		jsonTwoSpace(json.RawMessage("{bad"))
	})
}
