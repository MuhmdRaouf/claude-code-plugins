package domain

import (
	"reflect"
	"testing"
)

const budgetNow = 1_800_000_000_000

// budgetStatus builds a Radar status one second old, as the router reads it.
func budgetStatus(stopped []any, extra map[string]any) map[string]any {
	value := map[string]any{
		"version":   float64(1),
		"updatedAt": float64(budgetNow - 1000),
		"stopped":   stopped,
		"spend":     []any{},
	}
	for key, override := range extra {
		value[key] = override
	}
	return value
}

func budgetSet(entries ...any) map[string]any {
	return map[string]any{"version": float64(1), "budgets": entries}
}

func budgetPeriodPtr(period BudgetPeriod) *BudgetPeriod {
	return &period
}

func TestBudgetStop(t *testing.T) {
	t.Run("stops a plugin whose own scope is stopped, and every plugin when total is", func(t *testing.T) {
		stop, ok := BudgetStopFor("zai", budgetStatus([]any{"provider:zai"}, nil), nil, budgetNow)
		if !ok || !reflect.DeepEqual(stop, BudgetStop{Scope: "provider:zai"}) {
			t.Fatalf("budgetStop(zai, provider:zai stopped) = (%#v, %v), want {Scope: provider:zai}, true", stop, ok)
		}
		if _, ok := BudgetStopFor("kimi", budgetStatus([]any{"provider:zai"}, nil), nil, budgetNow); ok {
			t.Fatal("budgetStop(kimi, provider:zai stopped) stopped the plugin, want nothing")
		}
		stop, ok = BudgetStopFor("kimi", budgetStatus([]any{"total"}, nil), nil, budgetNow)
		if !ok || !reflect.DeepEqual(stop, BudgetStop{Scope: "total"}) {
			t.Fatalf("budgetStop(kimi, total stopped) = (%#v, %v), want {Scope: total}, true", stop, ok)
		}
		// The plugin's own scope is named first when both are stopped.
		stop, _ = BudgetStopFor("zai", budgetStatus([]any{"total", "provider:zai"}, nil), nil, budgetNow)
		if stop.Scope != "provider:zai" {
			t.Fatalf("both scopes stopped named %q, want the plugin's own provider:zai", stop.Scope)
		}
		if got := ProviderScope("qwen"); got != "provider:qwen" {
			t.Fatalf("providerScope(qwen) = %q, want provider:qwen", got)
		}
	})

	t.Run("stops nothing when the status is missing, unparsable, of another version, or stale either way", func(t *testing.T) {
		cases := []struct {
			name   string
			status any
		}{
			{"missing", nil},
			{"unparsable", "garbage"},
			{"no version", map[string]any{"stopped": []any{"provider:zai"}}},
			{"another version", budgetStatus([]any{"provider:zai"}, map[string]any{"version": float64(2)})},
			{"stopped not a list", budgetStatus([]any{"provider:zai"}, map[string]any{"stopped": "provider:zai"})},
			{"stale", budgetStatus([]any{"provider:zai"}, map[string]any{
				"updatedAt": float64(budgetNow - BUDGET_STALE_MS - 1),
			})},
			{"stale from the future", budgetStatus([]any{"provider:zai"}, map[string]any{
				"updatedAt": float64(budgetNow + BUDGET_STALE_MS + 1),
			})},
		}
		for _, tc := range cases {
			if _, ok := BudgetStopFor("zai", tc.status, nil, budgetNow); ok {
				t.Fatalf("%s: budgetStop stopped the plugin, want nothing", tc.name)
			}
		}
		fresh := budgetStatus([]any{"provider:zai"}, map[string]any{
			"updatedAt": float64(budgetNow - BUDGET_STALE_MS),
		})
		if _, ok := BudgetStopFor("zai", fresh, nil, budgetNow); !ok {
			t.Fatal("a status exactly BUDGET_STALE_MS old stopped nothing, want a stop")
		}
	})

	t.Run("takes the period from the stop budget that is over, else the scope's first stop budget", func(t *testing.T) {
		set := budgetSet(
			map[string]any{"id": "w", "scope": "provider:zai", "period": "week", "limitUsd": float64(5), "action": "stop"},
			map[string]any{"id": "warn", "scope": "provider:zai", "period": "day", "limitUsd": float64(1), "action": "warn"},
			map[string]any{"id": "m", "scope": "provider:zai", "period": "month", "limitUsd": float64(20), "action": "stop"},
			map[string]any{"id": "t", "scope": "total", "period": "day", "limitUsd": float64(9), "action": "stop"},
		)
		over := budgetStatus([]any{"provider:zai"}, map[string]any{
			"spend": []any{map[string]any{"id": "m", "spentUsd": float64(21), "limitUsd": float64(20), "pct": float64(105)}},
		})
		stop, ok := BudgetStopFor("zai", over, set, budgetNow)
		if !ok || !reflect.DeepEqual(stop, BudgetStop{Scope: "provider:zai", Period: budgetPeriodPtr(BudgetMonth)}) {
			t.Fatalf("the over budget's period lost: got (%#v, %v), want month", stop, ok)
		}
		stop, ok = BudgetStopFor("zai", budgetStatus([]any{"provider:zai"}, nil), set, budgetNow)
		if !ok || !reflect.DeepEqual(stop, BudgetStop{Scope: "provider:zai", Period: budgetPeriodPtr(BudgetWeek)}) {
			t.Fatalf("the first stop budget's period lost: got (%#v, %v), want week", stop, ok)
		}
		stop, ok = BudgetStopFor("kimi", budgetStatus([]any{"total"}, nil), set, budgetNow)
		if !ok || !reflect.DeepEqual(stop, BudgetStop{Scope: "total", Period: budgetPeriodPtr(BudgetDay)}) {
			t.Fatalf("the total scope's period lost: got (%#v, %v), want day", stop, ok)
		}
	})

	t.Run("skips a budget entry that does not parse and keeps the rest; a broken spend list is no spend", func(t *testing.T) {
		set := budgetSet(
			map[string]any{"id": "x", "scope": "provider:zai", "period": "year", "action": "stop"},
			"nope",
			map[string]any{"id": "d", "scope": "provider:zai", "period": "day", "limitUsd": float64(1), "action": "stop"},
		)
		stop, ok := BudgetStopFor("zai", budgetStatus([]any{"provider:zai"}, map[string]any{"spend": "bad"}), set, budgetNow)
		if !ok || !reflect.DeepEqual(stop, BudgetStop{Scope: "provider:zai", Period: budgetPeriodPtr(BudgetDay)}) {
			t.Fatalf("a bad entry or spend list lost the good budgets: got (%#v, %v), want day", stop, ok)
		}
		stop, ok = BudgetStopFor("zai", budgetStatus([]any{"provider:zai"}, nil), map[string]any{"budgets": "no"}, budgetNow)
		if !ok || stop.Period != nil {
			t.Fatalf("a budgets file without a version gave (%#v, %v), want no period", stop, ok)
		}
	})

	t.Run("words the refusal the same in every router", func(t *testing.T) {
		got := BudgetMessage("Z.ai GLM", BudgetStop{Scope: "provider:zai", Period: budgetPeriodPtr(BudgetMonth)})
		want := "Z.ai GLM budget reached for this month: raise or lift it in the Radar dashboard (/radar:open)"
		if got != want {
			t.Fatalf("budgetMessage = %q, want %q", got, want)
		}
		got = BudgetMessage("Kimi", BudgetStop{Scope: "total"})
		want = "Kimi budget reached for this period: raise or lift it in the Radar dashboard (/radar:open)"
		if got != want {
			t.Fatalf("budgetMessage = %q, want %q", got, want)
		}
	})
}

// The zod shapes behind budgetStop, as direct tables: what parses and what does not.
func TestBudgetParsing(t *testing.T) {
	t.Run("budgetNumber reads JSON and YAML numbers the way zod's z.number does", func(t *testing.T) {
		cases := []struct {
			value any
			want  float64
			ok    bool
		}{
			{float64(2), 2, true},
			{3, 3, true},
			{int64(4), 4, true},
			{"5", 0, false},
			{nil, 0, false},
		}
		for _, tc := range cases {
			got, ok := budgetNumber(tc.value)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("budgetNumber(%#v) = (%v, %v), want (%v, %v)", tc.value, got, ok, tc.want, tc.ok)
			}
		}
	})

	t.Run("budgetsOf skips every entry that does not parse and keeps the rest", func(t *testing.T) {
		cases := []struct {
			name    string
			budgets any
			want    []budgetEntry
		}{
			{"nil", nil, nil},
			{"not an object", "no", nil},
			{"no version", map[string]any{"budgets": []any{}}, nil},
			{"budgets not a list", map[string]any{"version": float64(1), "budgets": "no"}, nil},
			{"mixed entries", map[string]any{"version": float64(1), "budgets": []any{
				map[string]any{"id": "d", "scope": "provider:zai", "period": "day", "action": "stop"},
				"nope",
				map[string]any{"id": "x", "scope": "provider:zai", "period": "year", "action": "stop"},
				map[string]any{"id": 1, "scope": "provider:zai", "period": "day", "action": "stop"},
				map[string]any{"id": "s", "scope": 2, "period": "day", "action": "stop"},
				map[string]any{"id": "s", "scope": "provider:zai", "period": 3, "action": "stop"},
				map[string]any{"id": "s", "scope": "provider:zai", "period": "day", "action": 4},
			}}, []budgetEntry{{id: "d", scope: "provider:zai", period: BudgetDay, action: "stop"}}},
		}
		for _, tc := range cases {
			if got := budgetsOf(tc.budgets); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("%s: budgetsOf = %#v, want %#v", tc.name, got, tc.want)
			}
		}
	})

	t.Run("parseRadarStatus rejects a stopped list that is not all strings", func(t *testing.T) {
		if _, ok := parseRadarStatus(budgetStatus([]any{1}, nil)); ok {
			t.Fatal("a stopped list holding a number parsed, want rejected")
		}
	})

	t.Run("parseRadarStatus rejects a status whose updatedAt is not a number", func(t *testing.T) {
		if _, ok := parseRadarStatus(budgetStatus([]any{"total"}, map[string]any{"updatedAt": "x"})); ok {
			t.Fatal("a status with a string updatedAt parsed, want rejected")
		}
	})

	t.Run("parseRadarStatus accepts a status without a spend list", func(t *testing.T) {
		got, ok := parseRadarStatus(map[string]any{
			"version":   float64(1),
			"updatedAt": float64(budgetNow),
			"stopped":   []any{"total"},
		})
		want := radarStatus{updatedAt: float64(budgetNow), stopped: []string{"total"}, spendOver: map[string]bool{}}
		if !ok || !reflect.DeepEqual(got, want) {
			t.Fatalf("a status without spend = (%#v, %v), want (%#v, true)", got, ok, want)
		}
	})

	t.Run("spendOver is all or nothing, and only ids at or over 100 percent count", func(t *testing.T) {
		cases := []struct {
			name  string
			spend any
			want  map[string]bool
			ok    bool
		}{
			{"not a list", "bad", nil, false},
			{"a row that is not an object", []any{1}, nil, false},
			{"an id that is not a string", []any{map[string]any{"id": 1, "pct": float64(105)}}, nil, false},
			{"a pct that is not a number", []any{map[string]any{"id": "a"}}, nil, false},
			{"mixed rows", []any{
				map[string]any{"id": "under", "pct": float64(50)},
				map[string]any{"id": "at", "pct": float64(100)},
			}, map[string]bool{"at": true}, true},
		}
		for _, tc := range cases {
			got, ok := spendOver(tc.spend)
			if ok != tc.ok || !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("%s: spendOver = (%v, %v), want (%v, %v)", tc.name, got, ok, tc.want, tc.ok)
			}
		}
	})
}
