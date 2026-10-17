package adapters

// zai is the reference provider, so the shared suites run on a copy of its names and of the
// claude worker's terms.

import (
	"reflect"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/providers"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

func TestZaiIsCoresReferenceProvider(t *testing.T) {
	t.Run("core's shared suites assert zai's names, its state root and the claude worker's terms", func(t *testing.T) {
		if !reflect.DeepEqual(providers.Zai, testkit.ReferenceProvider) {
			t.Fatal("zai's provider drifted from core's reference copy")
		}
		// The reference provider's state-root rule (core's testing REFERENCE_STATE_ROOT).
		want := StateRootRule{EnvVar: "ZAI_STATE_DIR", DataPrefix: "zai-", XdgName: "zai"}
		if got := NewStateRootRule(providers.Zai); !reflect.DeepEqual(got, want) {
			t.Fatalf("state root rule = %+v, want %+v", got, want)
		}
		if !reflect.DeepEqual(ClaudeCaps, testkit.ReferenceCaps) {
			t.Fatal("the claude worker's caps drifted from core's reference copy")
		}
	})
}
