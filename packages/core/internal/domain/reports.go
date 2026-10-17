package domain

import (
	"bytes"
	"encoding/json"
)

// ReportContractKind says whether a job's report contract is one of the plugin's built-ins or a
// JSON schema file the brief named.
type ReportContractKind string

const (
	ReportContractBuiltin ReportContractKind = "builtin"
	ReportContractFile    ReportContractKind = "file"
)

// ReportContract is the contract a worker report is checked against: a builtin name, or "file"
// for a custom schema the worker itself already enforced.
type ReportContract struct {
	Kind ReportContractKind
	Name BuiltinReport
}

// jsonObject is a decoded JSON object that keeps its keys in document order, the order JSON.parse
// gives a JS object and zod's unrecognized-keys message lists them in.
type jsonObject struct {
	keys   []string
	values map[string]any
}

// BuiltinJSONSchema is a builtin contract's JSON Schema for the worker's `--json-schema`. Every
// worker's validator speaks draft-07; a 2020-12 `$schema` is rejected outright.
func BuiltinJSONSchema(name BuiltinReport) json.RawMessage {
	return BuiltinReports[name]
}

// CheckReport checks a worker report (the raw JSON job.json carries) against its contract.
// Builtins are validated with their schema (problems as "path: message"). A custom schema file is
// trusted to have been enforced by the worker, so only presence and object-ness are checked.
func CheckReport(report json.RawMessage, contract ReportContract) ReportCheck {
	if len(report) == 0 {
		return ReportCheck{Present: false, Valid: false, Problems: []string{"no structured report"}}
	}
	value, err := decodeOrdered(report)
	if err != nil {
		return ReportCheck{Present: true, Valid: false, Problems: []string{reportIssue("", err.Error())}}
	}
	if value == nil {
		return ReportCheck{Present: false, Valid: false, Problems: []string{"no structured report"}}
	}
	problems := make([]string, 0, 4)
	if contract.Kind == ReportContractFile {
		if _, ok := value.(jsonObject); !ok {
			problems = append(problems, reportIssue("", "expected a JSON object"))
		}
	} else {
		validateReport(builtinValidators[contract.Name], value, "", &problems)
	}
	return ReportCheck{Present: true, Valid: len(problems) == 0, Problems: problems}
}

// decodeOrdered decodes raw JSON keeping every object's keys in document order (jsonObject); a
// decoded Go map has no order, and the report's problem messages quote it.
func decodeOrdered(rawJSON []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(rawJSON))
	decoder.UseNumber()
	return decodeJSONValue(decoder)
}

// decodeJSONValue reads one value: the current token and everything under it.
func decodeJSONValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	delim, isDelim := token.(json.Delim)
	if !isDelim {
		return token, nil // string, json.Number, bool or nil
	}
	if delim == '[' {
		array := make([]any, 0, 8)
		for decoder.More() {
			item, err := decodeJSONValue(decoder)
			if err != nil {
				return nil, err
			}
			array = append(array, item)
		}
		// Consume the closing bracket: an outer container's More() must not see it as content.
		// The read cannot fail — More() turned false only because the bracket is next.
		_, _ = decoder.Token()
		return array, nil
	}
	// The remaining delimiter opens an object (Token never opens a value with '}' or ']').
	object := jsonObject{values: make(map[string]any)}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, err
		}
		key, _ := keyToken.(string)
		value, err := decodeJSONValue(decoder)
		if err != nil {
			return nil, err
		}
		// A repeated key keeps its first position and its last value, as JSON.parse does.
		if _, seen := object.values[key]; !seen {
			object.keys = append(object.keys, key)
		}
		object.values[key] = value
	}
	// Consume the closing brace, as the array branch does its bracket.
	_, _ = decoder.Token()
	return object, nil
}
