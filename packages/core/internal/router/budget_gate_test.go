// The budget gate's cases, inputs and expected outputs. The through-the-router cases live with
// router.go's own tests.
package router

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// budgetStatusJSON writes Radar's budget-status.json with the given stopped scopes, updated at
// updatedAt.
func budgetStatusJSON(stopped []string, updatedAt int64) string {
	quoted := make([]string, len(stopped))
	for i, scope := range stopped {
		quoted[i] = fmt.Sprintf("%q", scope)
	}
	return fmt.Sprintf(`{"version":1,"updatedAt":%d,"stopped":[%s],"spend":[]}`, updatedAt, strings.Join(quoted, ","))
}

// budgetRadarEnv is a fake environment whose Radar home is a fresh directory beside a fresh home.
func budgetRadarEnv(t *testing.T) domain.EnvLookup {
	t.Helper()
	base := t.TempDir()
	radar := filepath.Join(base, "radar")
	if err := os.MkdirAll(radar, 0o700); err != nil {
		t.Fatal(err)
	}
	return domain.EnvLookup{"HOME": filepath.Join(base, "home"), "RADAR_HOME": radar}
}

// writeRadarFile writes one of Radar's files.
func writeRadarFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestCreateBudgetGate(t *testing.T) {
	t.Parallel()
	t.Run("reads the status and the budgets beside the spool, and stops what the status stops", func(t *testing.T) {
		env := budgetRadarEnv(t)
		gate := CreateBudgetGate("zai", env, func() int64 { return 1000 }, 5000)
		if _, ok := gate(); ok {
			t.Fatal("the gate stopped with nothing installed")
		}
		fresh := budgetRadarEnv(t)
		writeRadarFile(t, BudgetStatusFile(fresh), budgetStatusJSON([]string{"provider:zai"}, time.Now().UnixMilli()))
		writeRadarFile(t, BudgetsFile(fresh), `{"version":1,"budgets":[`+
			`{"id":"b","scope":"provider:zai","period":"week","limitUsd":1,"action":"stop"}]}`)
		stop, ok := CreateBudgetGate("zai", fresh, nil, 0)()
		if !ok || stop.Scope != "provider:zai" {
			t.Fatalf("the gate = %+v (stopped %v), want provider:zai", stop, ok)
		}
		if stop.Period == nil || *stop.Period != domain.BudgetWeek {
			t.Fatalf("the gate's period = %v, want week", stop.Period)
		}
		if _, ok := CreateBudgetGate("kimi", fresh, nil, 0)(); ok {
			t.Fatal("the gate stopped another plugin's models")
		}
	})

	t.Run("holds one reading for five seconds, then reads again; a clock that steps back reads again too", func(t *testing.T) {
		env := budgetRadarEnv(t)
		now := int64(1_000_000)
		gate := CreateBudgetGate("zai", env, func() int64 { return now }, 0)
		writeRadarFile(t, BudgetStatusFile(env), budgetStatusJSON([]string{"provider:zai"}, now))
		if stop, ok := gate(); !ok || stop.Scope != "provider:zai" {
			t.Fatalf("the gate = %+v (stopped %v), want provider:zai", stop, ok)
		}
		writeRadarFile(t, BudgetStatusFile(env), budgetStatusJSON(nil, now))
		now += 4999
		if stop, ok := gate(); !ok || stop.Scope != "provider:zai" {
			t.Fatalf("the gate re-read within its cache window: %+v (stopped %v)", stop, ok)
		}
		now++
		if _, ok := gate(); ok {
			t.Fatal("the gate held its reading past the cache window")
		}
		writeRadarFile(t, BudgetStatusFile(env), budgetStatusJSON([]string{"total"}, now))
		now -= 60_000
		if stop, ok := gate(); !ok || stop.Scope != "total" {
			t.Fatalf("a clock that stepped back did not read again: %+v (stopped %v)", stop, ok)
		}
	})

	t.Run("never blocks or throws on what it finds there: a directory, a FIFO, a huge file, garbage, a stale status", func(t *testing.T) {
		env := budgetRadarEnv(t)
		file := BudgetStatusFile(env)
		gate := func() bool {
			_, ok := CreateBudgetGate("zai", env, nil, 0)()
			return ok
		}
		if err := os.MkdirAll(file, 0o700); err != nil {
			t.Fatal(err)
		}
		if gate() {
			t.Fatal("the gate stopped on a directory")
		}
		if err := os.RemoveAll(file); err != nil {
			t.Fatal(err)
		}
		mkfifo, err := exec.LookPath("mkfifo")
		if err != nil {
			t.Skipf("no mkfifo on this platform: %v", err)
		}
		if err := exec.Command(mkfifo, file).Run(); err != nil {
			t.Fatal(err)
		}
		// Reading a FIFO with no writer would block forever; the gate looks before it reads.
		if gate() {
			t.Fatal("the gate stopped on a FIFO")
		}
		if err := os.Remove(file); err != nil {
			t.Fatal(err)
		}
		huge := strings.TrimSuffix(budgetStatusJSON([]string{"provider:zai"}, time.Now().UnixMilli()), "}") +
			strings.Repeat(" ", 1024*1024) + "}"
		writeRadarFile(t, file, huge)
		if gate() {
			t.Fatal("the gate read a file over its size cap")
		}
		writeRadarFile(t, file, "{not json")
		if gate() {
			t.Fatal("the gate read garbage")
		}
		writeRadarFile(t, file, budgetStatusJSON([]string{"provider:zai"}, time.Now().UnixMilli()-11*60_000))
		if gate() {
			t.Fatal("the gate obeyed a stale status")
		}
	})
}
