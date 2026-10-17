package domain

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

var changeContract = ReportContract{Kind: ReportContractBuiltin, Name: BuiltinReportChange}
var fileContract = ReportContract{Kind: ReportContractFile}
var builtinNames = []BuiltinReport{BuiltinReportChange, BuiltinReportSweep, BuiltinReportNotes}

// raw builds the report's raw JSON bytes, the form job.json carries a report in.
func raw(t *testing.T, report string) json.RawMessage {
	t.Helper()
	if !json.Valid([]byte(report)) {
		t.Fatalf("test report is not valid JSON: %s", report)
	}
	return json.RawMessage(report)
}

// changeSchemaSnapshot pins the change contract's JSON schema, field by field.
const changeSchemaSnapshot = `{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "additionalProperties": false,
  "properties": {
    "files": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "path": {
            "type": "string"
          },
          "why": {
            "type": "string"
          }
        },
        "required": [
          "path",
          "why"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "open_items": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "root_cause": {
      "type": "string"
    },
    "summary": {
      "type": "string"
    },
    "tests_added": {
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "summary",
    "files",
    "tests_added",
    "open_items"
  ],
  "type": "object"
}`

// decodedSchema reads selected fields out of a schema's raw JSON.
type decodedSchema struct {
	Schema               string   `json:"$schema"`
	Type                 string   `json:"type"`
	Required             []string `json:"required"`
	AdditionalProperties bool     `json:"additionalProperties"`
}

func decodeSchema(t *testing.T, rawJSON json.RawMessage) decodedSchema {
	t.Helper()
	var schema decodedSchema
	if err := json.Unmarshal(rawJSON, &schema); err != nil {
		t.Fatalf("decode schema: %v", err)
	}
	return schema
}

// sortedJSON renders raw JSON decoded, keys sorted, two-space indent. Go's json.MarshalIndent
// sorts map keys, so the bytes come out the same.
func sortedJSON(t *testing.T, rawJSON json.RawMessage) string {
	t.Helper()
	var value any
	if err := json.Unmarshal(rawJSON, &value); err != nil {
		t.Fatalf("decode json: %v", err)
	}
	rendered, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatalf("render json: %v", err)
	}
	return string(rendered)
}

func assertReportCheck(t *testing.T, got, want ReportCheck) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("report check = %+v, want %+v", got, want)
	}
}

func TestBuiltinJSONSchema(t *testing.T) {
	t.Run("targets JSON Schema draft-07, the only draft every worker's validator accepts (2020-12 crashed the live ping)", func(t *testing.T) {
		for _, name := range builtinNames {
			if schema := decodeSchema(t, BuiltinJSONSchema(name)); schema.Schema != "http://json-schema.org/draft-07/schema#" {
				t.Errorf("%s: $schema = %q, want draft-07", name, schema.Schema)
			}
		}
	})

	t.Run("change/sweep/notes produce JSON Schema objects with type object and required fields as documented", func(t *testing.T) {
		want := map[BuiltinReport][]string{
			BuiltinReportChange: {"summary", "files", "tests_added", "open_items"},
			BuiltinReportSweep:  {"summary", "items", "open_items"},
			BuiltinReportNotes:  {"summary", "findings", "open_items"},
		}
		for _, name := range builtinNames {
			schema := decodeSchema(t, BuiltinJSONSchema(name))
			if schema.Type != "object" {
				t.Errorf("%s: type = %q, want object", name, schema.Type)
			}
			if !reflect.DeepEqual(schema.Required, want[name]) {
				t.Errorf("%s: required = %v, want %v", name, schema.Required, want[name])
			}
		}
	})

	t.Run("the change schema matches the documented contract field by field", func(t *testing.T) {
		if got := sortedJSON(t, BuiltinJSONSchema(BuiltinReportChange)); got != changeSchemaSnapshot {
			t.Fatalf("change schema =\n%s\nwant\n%s", got, changeSchemaSnapshot)
		}
	})

	t.Run("schemas disallow additional top-level properties", func(t *testing.T) {
		for _, name := range builtinNames {
			if schema := decodeSchema(t, BuiltinJSONSchema(name)); schema.AdditionalProperties {
				t.Errorf("%s: additionalProperties = true, want false", name)
			}
		}
	})
}

func TestJSONTypeName(t *testing.T) {
	cases := []struct {
		value any
		want  string
	}{
		{nil, "null"},
		{"s", "string"},
		{json.Number("1"), "number"},
		{true, "boolean"},
		{[]any{}, "array"},
		{jsonObject{}, "object"},
		{struct{ Name int }{}, "undefined"},
	}
	for _, testCase := range cases {
		if got := jsonTypeName(testCase.value); got != testCase.want {
			t.Errorf("jsonTypeName(%#v) = %q, want %q", testCase.value, got, testCase.want)
		}
	}
}

func TestDecodeOrderedMalformed(t *testing.T) {
	for _, malformed := range []string{`[`, `[1,`, `[[`, `{`, `{"a"`, `{"a":`, `{"a":1,`, `{"a":[`, `{"a":1,x}`} {
		value, err := decodeOrdered([]byte(malformed))
		if err == nil || value != nil {
			t.Errorf("decodeOrdered(%s) = (%v, %v), want no value and an error", malformed, value, err)
		}
	}
}

func TestCheckReport(t *testing.T) {
	t.Run("a conforming change report is present and valid", func(t *testing.T) {
		valid := ReportCheck{Present: true, Valid: true, Problems: []string{}}
		conforming := `{
			"summary": "Fixed the off-by-one",
			"files": [{ "path": "src/range.ts", "why": "end bound was exclusive" }],
			"tests_added": ["test/range.test.ts"],
			"open_items": []
		}`
		assertReportCheck(t, CheckReport(raw(t, conforming), changeContract), valid)

		withRootCause := `{
			"summary": "Fixed the off-by-one",
			"files": [{ "path": "src/range.ts", "why": "end bound was exclusive" }],
			"root_cause": "< instead of <=",
			"tests_added": ["test/range.test.ts"],
			"open_items": []
		}`
		assertReportCheck(t, CheckReport(raw(t, withRootCause), changeContract), valid)
	})

	t.Run("undefined/null → present false, valid false", func(t *testing.T) {
		missing := ReportCheck{Present: false, Valid: false, Problems: []string{"no structured report"}}
		assertReportCheck(t, CheckReport(nil, changeContract), missing)
		assertReportCheck(t, CheckReport(raw(t, `null`), changeContract), missing)
		assertReportCheck(t, CheckReport(raw(t, `null`), fileContract), missing)
	})

	t.Run("a non-conforming builtin report lists problems as 'path: message'", func(t *testing.T) {
		report := raw(t, `{
			"summary": "x",
			"files": [{ "path": "a.ts", "why": 3 }],
			"open_items": [],
			"extra": true
		}`)
		want := ReportCheck{Present: true, Valid: false, Problems: []string{
			"files.0.why: Invalid input: expected string, received number",
			"tests_added: Invalid input: expected array, received undefined",
			`(root): Unrecognized key: "extra"`,
		}}
		assertReportCheck(t, CheckReport(report, changeContract), want)
	})

	t.Run("unrecognized keys are listed in the document's order, as zod lists them", func(t *testing.T) {
		report := raw(t, `{
			"zeta": 1, "alpha": 2, "mid": 3,
			"summary": "x", "files": [], "tests_added": [], "open_items": []
		}`)
		check := CheckReport(report, changeContract)
		wantProblems := []string{`(root): Unrecognized keys: "zeta", "alpha", "mid"`}
		if !reflect.DeepEqual(check.Problems, wantProblems) {
			t.Errorf("problems = %v, want %v", check.Problems, wantProblems)
		}

		nested := raw(t, `{
			"summary": "s",
			"files": [{ "why": "w", "path": "a.ts", "zz": 1, "aa": 2 }],
			"tests_added": [], "open_items": []
		}`)
		nestedCheck := CheckReport(nested, changeContract)
		wantNested := []string{`files.0: Unrecognized keys: "zz", "aa"`}
		if !reflect.DeepEqual(nestedCheck.Problems, wantNested) {
			t.Errorf("nested problems = %v, want %v", nestedCheck.Problems, wantNested)
		}
	})

	t.Run("sweep and notes reports are validated against their own contracts", func(t *testing.T) {
		sweep := raw(t, `{
			"summary": "s",
			"items": [{ "id": "a", "status": "done", "detail": "" }],
			"open_items": []
		}`)
		notes := raw(t, `{
			"summary": "n",
			"findings": [{ "title": "t", "detail": "d", "refs": ["src/a.ts:3"] }],
			"open_items": []
		}`)

		sweepCheck := CheckReport(sweep, ReportContract{Kind: ReportContractBuiltin, Name: BuiltinReportSweep})
		wantSweepProblems := []string{`items.0.status: Invalid option: expected one of "ok"|"fail"|"gap"`}
		if !reflect.DeepEqual(sweepCheck.Problems, wantSweepProblems) {
			t.Errorf("sweep problems = %v, want %v", sweepCheck.Problems, wantSweepProblems)
		}
		assertReportCheck(t, CheckReport(notes, ReportContract{Kind: ReportContractBuiltin, Name: BuiltinReportNotes}),
			ReportCheck{Present: true, Valid: true, Problems: []string{}})
		if CheckReport(notes, changeContract).Valid {
			t.Error("a notes report is valid against the change contract, want invalid")
		}
	})

	t.Run("a builtin report that is not an object is invalid at the root", func(t *testing.T) {
		want := ReportCheck{Present: true, Valid: false,
			Problems: []string{"(root): Invalid input: expected object, received string"}}
		assertReportCheck(t, CheckReport(raw(t, `"done!"`), changeContract), want)
	})

	t.Run("custom contract: any object is valid; a non-object is invalid", func(t *testing.T) {
		valid := ReportCheck{Present: true, Valid: true, Problems: []string{}}
		assertReportCheck(t, CheckReport(raw(t, `{ "anything": ["goes"] }`), fileContract), valid)

		want := ReportCheck{Present: true, Valid: false, Problems: []string{"(root): expected a JSON object"}}
		for _, notObject := range []string{`"text"`, `42`, `true`, `[{ "a": 1 }]`} {
			assertReportCheck(t, CheckReport(raw(t, notObject), fileContract), want)
		}
	})

	// Direct rows for branches no other layer reaches; the wording is the schema validator's
	// own, which the report problems pin.
	t.Run("type mismatches follow the same schema wording", func(t *testing.T) {
		cases := []struct {
			name     string
			report   string
			problems []string
		}{
			{
				"a null where a string is expected",
				`{ "summary": null, "files": [], "tests_added": [], "open_items": [] }`,
				[]string{"summary: Invalid input: expected string, received null"},
			},
			{
				"an object where an array is expected",
				`{ "summary": "s", "files": { "a": 1 }, "tests_added": [], "open_items": [] }`,
				[]string{"files: Invalid input: expected array, received object"},
			},
			{
				"a missing string property",
				`{ "files": [], "tests_added": [], "open_items": [] }`,
				[]string{"summary: Invalid input: expected string, received undefined"},
			},
			{
				"a non-object array item",
				`{ "summary": "s", "files": [true], "tests_added": [], "open_items": [] }`,
				[]string{"files.0: Invalid input: expected object, received boolean"},
			},
		}
		for _, testCase := range cases {
			got := CheckReport(raw(t, testCase.report), changeContract)
			if !reflect.DeepEqual(got.Problems, testCase.problems) {
				t.Errorf("%s: problems = %v, want %v", testCase.name, got.Problems, testCase.problems)
			}
		}

		missingStatus := `{ "summary": "s", "items": [{ "id": "a", "detail": "" }], "open_items": [] }`
		got := CheckReport(raw(t, missingStatus),
			ReportContract{Kind: ReportContractBuiltin, Name: BuiltinReportSweep})
		wantProblems := []string{`items.0.status: Invalid option: expected one of "ok"|"fail"|"gap"`}
		if !reflect.DeepEqual(got.Problems, wantProblems) {
			t.Errorf("missing enum key: problems = %v, want %v", got.Problems, wantProblems)
		}
	})

	t.Run("a report that is not valid JSON is invalid at the root", func(t *testing.T) {
		check := CheckReport(json.RawMessage(`not json`), changeContract)
		if !check.Present || check.Valid {
			t.Fatalf("report check = %+v, want present and invalid", check)
		}
		if len(check.Problems) != 1 || !strings.HasPrefix(check.Problems[0], "(root): ") {
			t.Errorf("problems = %v, want one (root): problem", check.Problems)
		}
	})
}
