package cli_test

import (
	"reflect"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/cli"
)

// node:util parseArgs semantics, as the commands rely on them: strict flags (long names only, the
// plugins define no shorts), any number of positionals, and node's first sentence as the error.
func TestParse(t *testing.T) {
	options := map[string]cli.OptionSpec{
		"json":   {Type: cli.OptionTypeBoolean},
		"help":   {Type: cli.OptionTypeBoolean},
		"reason": {Type: cli.OptionTypeString},
	}
	ambiguous := "Option '--reason' argument is ambiguous.\n" +
		"Did you forget to specify the option argument for '--reason'?\n" +
		"To specify an option argument starting with a dash use '--reason=-XYZ'."
	cases := []struct {
		name        string
		argv        []string
		values      map[string]any
		positionals []string
		errText     string
	}{
		{"flags and positionals", []string{"a", "b", "--json", "--reason", "r"},
			map[string]any{"json": true, "reason": "r"}, []string{"a", "b"}, ""},
		{"empty argv", nil, map[string]any{}, []string{}, ""},
		{"a bare dash is a positional", []string{"-"}, map[string]any{}, []string{"-"}, ""},
		{"an empty argument is a positional", []string{""}, map[string]any{}, []string{""}, ""},
		{"string option with an inline value", []string{"--reason=x"}, map[string]any{"reason": "x"}, []string{}, ""},
		{"string option with an empty inline value", []string{"--reason="}, map[string]any{"reason": ""}, []string{}, ""},
		{"string option may take a bare dash", []string{"--reason", "-"}, map[string]any{"reason": "-"}, []string{}, ""},
		{"a repeated string option keeps the last value", []string{"--reason", "a", "--reason", "b"},
			map[string]any{"reason": "b"}, []string{}, ""},
		{"a repeated boolean stays true", []string{"--json", "a", "--json"},
			map[string]any{"json": true}, []string{"a"}, ""},
		{"a boolean's word is a positional", []string{"--json", "true"},
			map[string]any{"json": true}, []string{"true"}, ""},
		{"everything after -- is positional", []string{"--", "--bogus", "-x"},
			map[string]any{}, []string{"--bogus", "-x"}, ""},
		{"a lone --", []string{"--"}, map[string]any{}, []string{}, ""},
		{"unknown long option", []string{"--bogus"}, nil, nil, "Unknown option '--bogus'"},
		{"unknown long option with an inline value", []string{"--bogus=x"}, nil, nil, "Unknown option '--bogus'"},
		{"unknown long name in the value", []string{"--=x"}, nil, nil, "Unknown option '--=x'"},
		{"unknown short option", []string{"-abc"}, nil, nil, "Unknown option '-a'"},
		{"unknown negative-looking option", []string{"-5"}, nil, nil, "Unknown option '-5'"},
		{"unknown short option outside ASCII", []string{"-é"}, nil, nil, "Unknown option '-é'"},
		{"boolean does not take an argument", []string{"--json=x"}, nil, nil,
			"Option '--json' does not take an argument"},
		{"boolean does not take an empty argument", []string{"--json="}, nil, nil,
			"Option '--json' does not take an argument"},
		{"string option without its value", []string{"--reason"}, nil, nil,
			"Option '--reason <value>' argument missing"},
		{"string option whose value looks like a flag", []string{"--reason", "--json"}, nil, nil, ambiguous},
		{"string option whose value looks negative", []string{"--reason", "-5"}, nil, nil, ambiguous},
		{"string option whose value is --", []string{"--reason", "--"}, nil, nil, ambiguous},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parsed, err := cli.Parse(tc.argv, options)
			if tc.errText != "" {
				if err == nil {
					t.Fatalf("err = nil, want %q", tc.errText)
				}
				if err.Error() != tc.errText {
					t.Fatalf("err = %q, want %q", err.Error(), tc.errText)
				}
				return
			}
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			if !reflect.DeepEqual(parsed.Values, tc.values) {
				t.Fatalf("values = %#v, want %#v", parsed.Values, tc.values)
			}
			if !reflect.DeepEqual(parsed.Positionals, tc.positionals) {
				t.Fatalf("positionals = %#v, want %#v", parsed.Positionals, tc.positionals)
			}
		})
	}
}
