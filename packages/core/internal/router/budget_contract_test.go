package router

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// TestBudgetStatusFixtureIsRead reads the committed contract fixture
// (testdata/contract/budget-status.json, whose identical copy the huddle repository keeps) as a
// real budget-status.json and proves the gate refuses the provider it stops and lets every other
// provider through: the file's schema is the contract, not a test double's.
func TestBudgetStatusFixtureIsRead(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "testdata", "contract", "budget-status.json"))
	if err != nil {
		t.Fatal(err)
	}
	var parsed struct {
		UpdatedAt float64 `json:"updatedAt"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatal(err)
	}
	now := func() int64 { return int64(parsed.UpdatedAt) }

	env := domain.EnvLookup{
		"HOME":       filepath.Join(t.TempDir(), "home"),
		"RADAR_HOME": filepath.Join(t.TempDir(), "radar"),
	}
	if err := os.MkdirAll(env["RADAR_HOME"], 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(BudgetStatusFile(env), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	// The budgets file is the user's own settings, not part of the shared fixture contract: the
	// test writes a minimal one, naming the month budget the fixture's spend row is over.
	budgets := `{"version":1,"budgets":[{"id":"zai-month","scope":"provider:zai","period":"month","limitUsd":20,"action":"stop"}]}`
	if err := os.WriteFile(BudgetsFile(env), []byte(budgets), 0o600); err != nil {
		t.Fatal(err)
	}

	stop, stopped := CreateBudgetGate("zai", env, now, 0)()
	if !stopped {
		t.Fatal("the fixture's stopped provider:zai scope did not stop the zai gate")
	}
	if stop.Scope != "provider:zai" {
		t.Fatalf("stop scope = %q, want provider:zai", stop.Scope)
	}
	if stop.Period == nil || *stop.Period != domain.BudgetMonth {
		t.Fatalf("stop period = %v, want month", stop.Period)
	}

	_, stopped = CreateBudgetGate("kimi", env, now, 0)()
	if stopped {
		t.Fatal("the fixture stops only provider:zai, yet the kimi gate was stopped")
	}

	// The same fixture goes stale: ten minutes on, nothing is stopped any more.
	later := func() int64 { return int64(parsed.UpdatedAt) + (domain.BUDGET_STALE_MS + time.Minute.Milliseconds()) }
	if _, stopped = CreateBudgetGate("zai", env, later, 0)(); stopped {
		t.Fatal("a stale fixture must stop nothing")
	}
}
