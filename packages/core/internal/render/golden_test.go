package render

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// The goldens under testdata/render are fixed fixtures: every renderer's answers on a fixed
// table of inputs, number edge cases included, compared byte for byte.

// goldenRow is one recorded call: the inputs as the generator serialised them and the recorded
// answer.
type goldenRow struct {
	Input  json.RawMessage `json:"input"`
	Output json.RawMessage `json:"output"`
}

// goldenRows reads the generator's rows for one function.
func goldenRows(t *testing.T, name string) []goldenRow {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "render", name+".json"))
	if err != nil {
		t.Fatalf("read golden %s: %v", name, err)
	}
	var rows []goldenRow
	if err := json.Unmarshal(raw, &rows); err != nil {
		t.Fatalf("parse golden %s: %v", name, err)
	}
	if len(rows) == 0 {
		t.Fatalf("golden %s has no rows; the generator's set has shrunk", name)
	}
	return rows
}

// inputOf decodes one row's input object.
func inputOf[T any](t *testing.T, row goldenRow) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(row.Input, &value); err != nil {
		t.Fatalf("parse input %s: %v", row.Input, err)
	}
	return value
}

// outputOf decodes one row's output.
func outputOf[T any](t *testing.T, output json.RawMessage) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(output, &value); err != nil {
		t.Fatalf("parse output %s: %v", output, err)
	}
	return value
}

// checkString compares a rendered string against the golden output.
func checkString(t *testing.T, i int, got string, output json.RawMessage) {
	t.Helper()
	want := outputOf[string](t, output)
	if got != want {
		t.Errorf("row %d:\ngot  %q\nwant %q", i, got, want)
	}
}

// providerOf maps the golden's provider key to the testkit copy of that provider.
func providerOf(t *testing.T, name string) domain.Provider {
	t.Helper()
	switch name {
	case "reference":
		return testkit.ReferenceProvider
	case "acme":
		return testkit.AcmeProvider
	}
	t.Fatalf("unknown provider %q", name)
	return domain.Provider{}
}

// jobInput is a golden input that names a provider and carries a job.
type jobInput struct {
	Provider string     `json:"provider"`
	Job      domain.Job `json:"job"`
}
