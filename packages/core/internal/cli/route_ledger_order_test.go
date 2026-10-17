// The ledger's agents must land on disk in the order they were recorded (JSON.stringify's
// insertion order), never Go's alphabetical map order, and with the ledger's keys in the order
// the recorded read leaves them. The goldens are fixed fixtures: the exact bytes this sequence
// must write.
package cli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

func TestLedgerAgentsOrderMatchesTS(t *testing.T) {
	ctx := context.Background()
	root := testkit.TempDir(t, "core-ledger-order-")
	strp := func(text string) *string { return &text }
	deps := SetupDeps{
		Provider:     testkit.ReferenceProvider,
		Env:          domain.EnvLookup{"HOME": filepath.Join(root, "home")},
		StateRoot:    root,
		BundlePath:   filepath.Join(root, "plugin", "dist", "zai.js"),
		SettingsPath: "/ROOT/home/.claude/settings.json",
	}
	layout := domain.NewStateLayout(root)

	// Setup's own write: a first run, no previous ledger, no delta, no key stored.
	recordLedger(ctx, deps, nil, false)
	assertLedgerGolden(t, "after-setup.json", layout.Ledger, root)

	// The tier agents' before-values: an unchanged agent is skipped, the changed ones land in the
	// order setup touched them, one with no `model:` line at all (null).
	recordAgentsBefore(ctx, deps, AgentsResult{OK: true, Value: []AgentModel{
		{Tier: "main", Agent: "zealot", Model: "glm-5.3", Changed: true, Before: strp("opus")},
		{Tier: "flash", Agent: "alpha", Model: "glm-5.3-flash", Changed: true},
		{Tier: "omp", Agent: "mid", Model: "glm-5.3", Changed: true, Before: strp("haiku")},
		{Tier: "pi", Agent: "skipped", Model: "glm-5.3", Before: strp("sonnet")},
	}})
	assertLedgerGolden(t, "after-agents.json", layout.Ledger, root)

	// The engine path: a fourth agent joins at the end, the first record never overwritten.
	RecordEngineAgentBefore(ctx, root, domain.EngineToolOmp, true, strp("sonnet"))
	assertLedgerGolden(t, "after-engine.json", layout.Ledger, root)
}

// assertLedgerGolden compares the ledger's bytes with the golden, the temp root standing in as
// /ROOT on every machine. The ledger records the root with the platform's own separators, and its
// JSON escaping doubles a backslash, so the escaped form is replaced first, then the plain one.
func assertLedgerGolden(t *testing.T, name, path, root string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read ledger: %v", err)
	}
	want, err := os.ReadFile(filepath.Join(testkit.ModuleRoot(t), "testdata", "ledger-agents", name))
	if err != nil {
		t.Fatalf("read golden %s: %v", name, err)
	}
	normalized := strings.ReplaceAll(string(got), strings.ReplaceAll(root, `\`, `\\`), "/ROOT")
	normalized = strings.ReplaceAll(normalized, root, "/ROOT")
	normalized = slashRootSeparators(normalized)
	if normalized != string(want) {
		t.Fatalf("ledger after %s =\n%s\nwant the golden bytes\n%s", name, normalized, want)
	}
}

// slashRootSeparators rewrites the separators left inside /ROOT-prefixed JSON values: the golden
// records them '/', the ledger writes the platform's separator (JSON-escaped). Values not
// starting with /ROOT are copied untouched, so a unix ledger passes through byte for byte.
func slashRootSeparators(doc string) string {
	var b strings.Builder
	b.Grow(len(doc))
	for i := 0; i < len(doc); {
		if doc[i] == '"' && strings.HasPrefix(doc[i+1:], "/ROOT") {
			end := strings.IndexByte(doc[i+1:], '"')
			if end < 0 {
				b.WriteString(doc[i:])
				break
			}
			b.WriteByte('"')
			b.WriteString(strings.ReplaceAll(doc[i+1:i+1+end], `\\`, `/`))
			i += end + 1
			continue
		}
		b.WriteByte(doc[i])
		i++
	}
	return b.String()
}

func TestRecordAgentsBeforeEarlyReturns(t *testing.T) {
	ctx := context.Background()
	root := testkit.TempDir(t, "core-ledger-order-")
	deps := SetupDeps{Provider: testkit.ReferenceProvider, StateRoot: root}
	changed := AgentsResult{OK: true, Value: []AgentModel{
		{Tier: "main", Agent: "zealot", Model: "glm-5.3", Changed: true},
	}}

	// No ledger on disk: nothing to record into, and no file appears.
	recordAgentsBefore(ctx, deps, changed)
	if _, err := os.Stat(domain.NewStateLayout(root).Ledger); !os.IsNotExist(err) {
		t.Fatal("a ledger appeared without setup, want none")
	}

	// The agents step failed: its outcome carries nothing to record.
	deps.SettingsPath = "/ROOT/home/.claude/settings.json"
	deps.BundlePath = filepath.Join(root, "plugin", "dist", "zai.js")
	recordLedger(ctx, deps, nil, false)
	before, err := os.ReadFile(domain.NewStateLayout(root).Ledger)
	if err != nil {
		t.Fatal(err)
	}
	recordAgentsBefore(ctx, deps, AgentsResult{Error: "agent file missing"})
	after, err := os.ReadFile(domain.NewStateLayout(root).Ledger)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("a failed agents step rewrote the ledger")
	}
}
