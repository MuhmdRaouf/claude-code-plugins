package app_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// schemaFile writes value as a report schema file and returns its path.
func schemaFile(t *testing.T, value string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "report.json")
	if err := os.WriteFile(path, []byte(value), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestReportSchema(t *testing.T) {
	ctx := context.Background()
	files := adapters.CreateFsJobFiles(t.TempDir())

	t.Run("returns a built-in as draft-07", func(t *testing.T) {
		raw, err := app.ReportSchema(ctx, files, domain.Report{
			Kind: domain.ReportKindBuiltin, Name: domain.BuiltinReportSweep,
		})
		if err != nil {
			t.Fatal(err)
		}
		var schema map[string]json.RawMessage
		if err := json.Unmarshal(raw, &schema); err != nil {
			t.Fatal(err)
		}
		if string(schema["$schema"]) != `"http://json-schema.org/draft-07/schema#"` {
			t.Errorf("$schema = %s, want draft-07", schema["$schema"])
		}
	})

	t.Run("accepts a schema file with no $schema or a draft-07 one", func(t *testing.T) {
		for _, schema := range []string{
			`{"type": "object"}`,
			`{"$schema": "http://json-schema.org/draft-07/schema#", "type": "object"}`,
		} {
			path := schemaFile(t, schema)
			if _, err := app.ReportSchema(ctx, files, domain.Report{
				Kind: domain.ReportKindFile, Path: path,
			}); err != nil {
				t.Errorf("ReportSchema(%s) failed: %v", schema, err)
			}
		}
	})

	t.Run("rejects a schema file declaring another draft, before any worker starts (draft-07 is what every worker validates)", func(t *testing.T) {
		path := schemaFile(t, `{"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object"}`)
		_, err := app.ReportSchema(ctx, files, domain.Report{Kind: domain.ReportKindFile, Path: path})
		if err == nil || !strings.Contains(err.Error(), "draft-07") {
			t.Errorf("ReportSchema() error = %v, want the draft-07 rule", err)
		}
	})

	t.Run("explains the draft rule without naming a worker", func(t *testing.T) {
		path := schemaFile(t, `{"$schema": "https://json-schema.org/draft/2020-12/schema"}`)
		_, err := app.ReportSchema(ctx, files, domain.Report{Kind: domain.ReportKindFile, Path: path})
		if err == nil {
			t.Fatal("ReportSchema() should refuse another draft")
		}
		message := err.Error()
		rule := regexp.MustCompile(`a report schema must be draft-07 \(.+\) or declare no \$schema$`)
		if !rule.MatchString(message) {
			t.Errorf("message %q does not state the draft rule", message)
		}
		if worker := regexp.MustCompile(`(?i)claude|omp`); worker.MatchString(message) {
			t.Errorf("message %q names a worker", message)
		}
	})
}

func TestReportContract(t *testing.T) {
	ctx := context.Background()
	files := adapters.CreateFsJobFiles(t.TempDir())

	t.Run("a schema file's contract is named by its path, carries the schema and checks only object-ness", func(t *testing.T) {
		path := schemaFile(t, `{"type": "object", "required": ["answer"]}`)

		contract, err := app.ReportContract(ctx, files, domain.Report{Kind: domain.ReportKindFile, Path: path})
		if err != nil {
			t.Fatal(err)
		}
		if contract.Name != path {
			t.Errorf("Name = %q, want the schema file's path", contract.Name)
		}
		if string(contract.JSONSchema) != `{"type":"object","required":["answer"]}` {
			t.Errorf("JSONSchema = %s, want the file's schema", contract.JSONSchema)
		}
		if got := contract.Validate(json.RawMessage(`{"anything": 1}`)); !reflect.DeepEqual(got,
			domain.ReportCheck{Present: true, Valid: true, Problems: []string{}}) {
			t.Errorf("Validate(object) = %+v, want any object to pass", got)
		}
		if got := contract.Validate(json.RawMessage(`null`)); got.Present || got.Valid {
			t.Errorf("Validate(null) = %+v, want no report", got)
		}
	})

	t.Run("a schema the worker could not take is no contract", func(t *testing.T) {
		path := schemaFile(t, `["not", "an", "object"]`)

		_, err := app.ReportContract(ctx, files, domain.Report{Kind: domain.ReportKindFile, Path: path})
		if err == nil || err.Error() != path+" must hold a JSON schema object" {
			t.Errorf("ReportContract() error = %v, want the object rule", err)
		}
	})
}
