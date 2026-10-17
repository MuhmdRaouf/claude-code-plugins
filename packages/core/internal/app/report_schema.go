package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// draft07 is the only $schema a report schema may declare: every worker's validator speaks it, and
// a 2020-12 one is rejected outright.
const draft07 = "http://json-schema.org/draft-07/schema#"

// TextReader is the part of ports.JobFiles a report schema needs: reading one named file.
type TextReader interface {
	ReadText(ctx context.Context, path string) (string, error)
}

// ReportContract is the brief's report as the worker receives it: its name, its schema and the
// core's check.
func ReportContract(ctx context.Context, files TextReader, report domain.Report) (ports.ReportContract, error) {
	if report.Kind == domain.ReportKindBuiltin {
		return BuiltinContract(report.Name), nil
	}
	schema, err := ReportSchema(ctx, files, report)
	if err != nil {
		return ports.ReportContract{}, err
	}
	// A custom schema is trusted to have been enforced by the worker, so the check is only
	// object-ness.
	contract := domain.ReportContract{Kind: domain.ReportContractFile}
	return ports.ReportContract{
		Name:       report.Path,
		JSONSchema: schema,
		Validate: func(value json.RawMessage) domain.ReportCheck {
			return domain.CheckReport(value, contract)
		},
	}, nil
}

// BuiltinContract is a built-in report's contract: its name, its draft-07 schema and its check.
func BuiltinContract(name domain.BuiltinReport) ports.ReportContract {
	return ports.ReportContract{
		Name:       string(name),
		JSONSchema: domain.BuiltinJSONSchema(name),
		Validate: func(value json.RawMessage) domain.ReportCheck {
			return domain.CheckReport(value, domain.ReportContract{
				Kind: domain.ReportContractBuiltin,
				Name: name,
			})
		},
	}
}

// ReportSchema is the JSON schema the worker's report must follow, as the compact JSON handed to
// the worker: a built-in, or the brief's schema file, which must hold a JSON object in draft-07
// or with no $schema.
func ReportSchema(ctx context.Context, files TextReader, report domain.Report) (json.RawMessage, error) {
	if report.Kind == domain.ReportKindBuiltin {
		return domain.BuiltinJSONSchema(report.Name), nil
	}
	text, err := files.ReadText(ctx, report.Path)
	if err != nil {
		return nil, errors.New("cannot read " + report.Path + ": " + err.Error())
	}
	fields, ok := jsonObjectFields([]byte(text))
	if !ok {
		return nil, errors.New(report.Path + " must hold a JSON schema object")
	}
	if raw, declared := fields["$schema"]; declared {
		if err := checkSchemaDraft(report.Path, raw); err != nil {
			return nil, err
		}
	}
	return compactJSON([]byte(text)), nil
}

// checkSchemaDraft rejects a $schema that is not draft-07, naming the value as JSON.stringify
// renders it.
func checkSchemaDraft(path string, raw json.RawMessage) error {
	trimmed := bytes.TrimSpace(raw)
	stringified := string(compactJSON(trimmed))
	if !isJSONNull(trimmed) {
		var declared string
		if json.Unmarshal(trimmed, &declared) == nil {
			stringified = quoteJSON(declared)
		}
	}
	if stringified == quoteJSON(draft07) {
		return nil
	}
	return errors.New(path + " declares $schema " + stringified +
		"; a report schema must be draft-07 (" + draft07 + ") or declare no $schema")
}

// compactJSON strips insignificant whitespace without reordering keys, as JSON.stringify of the
// parsed value does.
func compactJSON(raw json.RawMessage) json.RawMessage {
	var buf bytes.Buffer
	// The caller validated the JSON, so compaction cannot fail.
	_ = json.Compact(&buf, raw)
	return buf.Bytes()
}

// quoteJSON renders a string the way JSON.stringify does: double quotes, no HTML escaping.
func quoteJSON(text string) string {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	// Encoding a string cannot fail.
	_ = encoder.Encode(text)
	return string(bytes.TrimSuffix(buf.Bytes(), []byte("\n")))
}
