// The router's budget gate: what Radar's budget-status.json says about this plugin, read at most
// every five seconds. Only a regular file under 1 MiB is read (a FIFO or a device there must never
// block the worker), and any trouble reading or parsing it stops nothing.
package router

import (
	"encoding/json"
	"io"
	"path/filepath"
	"sync"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/spool"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// BudgetCacheMs is how long one reading of the files holds.
const BudgetCacheMs int64 = 5000

// maxBudgetBytes is the largest status or budgets file worth reading.
const maxBudgetBytes int64 = 1024 * 1024

// BudgetStatusFile is Radar's budget status file, beside its spool.
func BudgetStatusFile(env domain.EnvLookup) string {
	return filepath.Join(spool.RadarHome(env), "budget-status.json")
}

// BudgetsFile is Radar's budgets file (the user's settings).
func BudgetsFile(env domain.EnvLookup) string {
	return filepath.Join(spool.RadarHome(env), "budgets.json")
}

// readSmallJSON reads a small regular file as JSON; nil for anything else (missing, a FIFO, too
// big, unreadable, not JSON). It is opened without blocking and checked through the open handle, so
// a file swapped for a FIFO between a check and the read can never block the worker.
func readSmallJSON(path string) any {
	file, err := openNonBlock(path)
	if err != nil {
		return nil
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxBudgetBytes {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(file, maxBudgetBytes+1))
	if err != nil || int64(len(data)) > maxBudgetBytes {
		return nil
	}
	var parsed any
	if json.Unmarshal(data, &parsed) != nil {
		return nil
	}
	return parsed
}

// budgetGate is one gate's held reading.
type budgetGate struct {
	mu      sync.Mutex
	plugin  string
	env     domain.EnvLookup
	now     func() int64
	cacheMs int64
	// read is false until the first call: a bool stands in for a negative-infinity readAt,
	// without the overflow.
	read    bool
	readAt  int64
	stop    domain.BudgetStop
	stopped bool
}

// check is the gate's answer: the stop in force, re-reading at most once per cache window (and
// again the moment the clock steps back).
func (g *budgetGate) check() (domain.BudgetStop, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	at := g.now()
	if g.read && at-g.readAt < g.cacheMs && at >= g.readAt {
		return g.stop, g.stopped
	}
	g.read = true
	g.readAt = at
	status := readSmallJSON(BudgetStatusFile(g.env))
	if status == nil {
		g.stop, g.stopped = domain.BudgetStop{}, false
	} else {
		g.stop, g.stopped = domain.BudgetStopFor(g.plugin, status, readSmallJSON(BudgetsFile(g.env)), at)
	}
	return g.stop, g.stopped
}

// CreateBudgetGate is the gate: the stop in force for plugin's models, or false when none is. A nil
// now reads the wall clock and a zero cacheMs is BudgetCacheMs.
func CreateBudgetGate(
	plugin string,
	env domain.EnvLookup,
	now func() int64,
	cacheMs int64,
) func() (domain.BudgetStop, bool) {
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	if cacheMs == 0 {
		cacheMs = BudgetCacheMs
	}
	gate := &budgetGate{plugin: plugin, env: env, now: now, cacheMs: cacheMs}
	return gate.check
}
