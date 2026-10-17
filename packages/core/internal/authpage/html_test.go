package authpage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/testkit"
)

// The page's HTML is a fixed fixture, one page per view under testdata/authpage/, compared
// byte for byte, next to the manifest describing it.

type goldenState struct {
	Kind    string  `json:"kind"`
	CSRF    string  `json:"csrf"`
	Error   *string `json:"error"`
	Limited bool    `json:"limited"`
	Text    string  `json:"text"`
}

type goldenView struct {
	Name       string      `json:"name"`
	File       string      `json:"file"`
	Nonce      string      `json:"nonce"`
	Plugin     string      `json:"plugin"`
	Version    *string     `json:"version"`
	Display    string      `json:"display"`
	StoreLabel string      `json:"storeLabel"`
	KeysURL    string      `json:"keysUrl"`
	BillingURL string      `json:"billingUrl"`
	State      goldenState `json:"state"`
}

// firstDifference names where two pages come apart, so a golden failure points at the spot.
func firstDifference(got string, want string) (int, byte, byte) {
	limit := len(got)
	if len(want) < limit {
		limit = len(want)
	}
	for i := 0; i < limit; i++ {
		if got[i] != want[i] {
			return i, got[i], want[i]
		}
	}
	if len(got) > limit {
		return limit, got[limit], 0
	}
	return limit, 0, want[limit]
}

func TestRenderPageGoldens(t *testing.T) {
	dir := filepath.Join(testkit.ModuleRoot(t), "testdata", "authpage")
	manifest, err := os.ReadFile(filepath.Join(dir, "views.json"))
	if err != nil {
		t.Fatalf("read the golden manifest: %v", err)
	}
	var views []goldenView
	if err := json.Unmarshal(manifest, &views); err != nil {
		t.Fatalf("parse the golden manifest: %v", err)
	}
	if len(views) < 7 {
		t.Fatalf("%d golden views, want the seven the generator writes", len(views))
	}
	for _, view := range views {
		t.Run(view.Name, func(t *testing.T) {
			expected, err := os.ReadFile(filepath.Join(dir, view.File))
			if err != nil {
				t.Fatalf("read the golden page: %v", err)
			}
			state := PageState{
				Kind:    PageStateKind(view.State.Kind),
				CSRF:    view.State.CSRF,
				Error:   view.State.Error,
				Limited: view.State.Limited,
				Text:    view.State.Text,
			}
			got := RenderPage(PageView{
				PageBase: PageBase{
					Plugin:     view.Plugin,
					Version:    view.Version,
					Display:    view.Display,
					StoreLabel: view.StoreLabel,
					KeysURL:    view.KeysURL,
					BillingURL: view.BillingURL,
				},
				State: state,
			}, view.Nonce)
			if got != string(expected) {
				at, gotByte, wantByte := firstDifference(got, string(expected))
				t.Errorf("the page differs from %s at byte %d (got %q, want %q):\n%s",
					view.File, at, gotByte, wantByte, excerpt(got, at))
			}
		})
	}
}

// excerpt is the 120 bytes around a difference, so the failure names the spot.
func excerpt(page string, at int) string {
	from := at - 60
	if from < 0 {
		from = 0
	}
	to := at + 60
	if to > len(page) {
		to = len(page)
	}
	return strings.ReplaceAll(page[from:to], "\n", "\\n")
}
