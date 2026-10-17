package domain

import (
	"encoding/json"
	"math"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// ParseBrief's cases, inputs and expected outputs; the fixtures are the reference providers.
// The parseDuration cases live in brief_duration_test.go.

var referenceProvider = DefineProvider(ProviderSpec{
	Name:         "zai",
	Display:      "Z.ai GLM",
	Slash:        "/zai:",
	AgentPrefix:  "zai:",
	BranchPrefix: "zai/",
	Harness:      "zai",
	ArtifactsEnv: "ZAI_ARTIFACTS",
	EnvPrefix:    "ZAI",
	Catalog: map[ModelTier]ModelRef{
		ModelTierMain: {
			Tier:            ModelTierMain,
			ID:              "glm-5.3",
			Label:           "GLM 5.3",
			BehavesAs:       strPtr("claude-opus-5-5"),
			MaxOutputTokens: i64Ptr(131072),
			DefaultEffort:   effortPtr(EffortLevelXhigh),
		},
		ModelTierFlash: {
			Tier:            ModelTierFlash,
			ID:              "glm-5.3-flash",
			Label:           "GLM 5.3 Flash",
			BehavesAs:       strPtr("claude-opus-5-5"),
			MaxOutputTokens: i64Ptr(131072),
			DefaultEffort:   effortPtr(EffortLevelXhigh),
		},
	},
	TierNames:      map[ModelTier]string{ModelTierMain: "glm", ModelTierFlash: "flash"},
	DefaultTier:    map[Mode]ModelTier{ModeEdit: ModelTierMain, ModeExec: ModelTierFlash, ModeReadonly: ModelTierFlash},
	PingTier:       ModelTierFlash,
	WorkerLabel:    "claude",
	BaseURL:        "https://api.z.ai/api/anthropic",
	Auth:           AuthBearer,
	KeyEnv:         []string{"ZAI_API_KEY"},
	KeyFile:        "~/.config/zai-plugin-cc/env",
	BillingURL:     "https://z.ai/manage-apikey/billing",
	KeysURL:        "https://z.ai/manage-apikey/apikey-list",
	Strip:          []string{},
	WebSearchModel: strPtr("glm-5.3"),
	Caveats:        []string{},
	Router: ProviderRouter{
		Port:          18787,
		Label:         "dev.muhmdraouf.zai-router",
		HealthPath:    "/zai-router/health",
		ModelPrefixes: []string{"glm-"},
	},
})

// A provider that shares no name with zai: rendering with it proves nothing zai-specific is hardcoded.
var acmeProvider = DefineProvider(ProviderSpec{
	Name:         "acme",
	Display:      "Acme Models",
	Slash:        "/acme:",
	AgentPrefix:  "acme:",
	BranchPrefix: "acme-jobs/",
	Harness:      "acme-harness",
	ArtifactsEnv: "ACME_OUT",
	EnvPrefix:    "ACME",
	Catalog: map[ModelTier]ModelRef{
		ModelTierMain:  {Tier: ModelTierMain, ID: "big-model-9", Label: "Big Model 9"},
		ModelTierFlash: {Tier: ModelTierFlash, ID: "small-model-9", Label: "Small Model 9"},
	},
	TierNames:   map[ModelTier]string{ModelTierMain: "big", ModelTierFlash: "quick"},
	DefaultTier: map[Mode]ModelTier{ModeEdit: ModelTierMain, ModeExec: ModelTierFlash, ModeReadonly: ModelTierFlash},
	PingTier:    ModelTierMain,
	WorkerLabel: "acmebot",
	BaseURL:     "https://api.acme.test/anthropic",
	Auth:        AuthBearer,
	KeyEnv:      []string{"ACME_API_KEY"},
	KeyFile:     "~/.config/acme/env",
	BillingURL:  "https://billing.example.test/top-up",
	KeysURL:     "https://keys.example.test/api-keys",
	Strip:       []string{"trace"},
	Caveats:     []string{"acme ignores the trace field"},
	Router: ProviderRouter{
		Port:          18800,
		Label:         "test.acme-router",
		HealthPath:    "/acme-router/health",
		ModelPrefixes: []string{"big-", "small-"},
	},
})

// The reference worker's terms: the claude worker's.
var referenceCaps = WorkerTerms{
	Efforts: []string{"low", "high", "max"},
	Budget:  true,
	BriefNotes: BriefNotes{
		Effort:    "passed to claude --effort",
		AddDirs:   "passed as --add-dir",
		BudgetUSD: "passed as --max-budget-usd",
		Readonly:  "plan mode, read tools only",
	},
}

// A worker that shares no term with the claude worker, and has no spending cap.
var acmeWorker = WorkerTerms{
	Efforts: []string{"gentle", "firm", "fierce"},
	Budget:  false,
	BriefNotes: BriefNotes{
		Effort:    "sent as acmebot --zeal",
		AddDirs:   "mounted read-only",
		BudgetUSD: "refused: acmebot has no spending cap",
		Readonly:  "answered from the repo, nothing written",
	},
}

var briefCtx = BriefContext{DefaultCwd: "/work/repo", Provider: referenceProvider, Worker: referenceCaps}

func strPtr(s string) *string              { return &s }
func i64Ptr(n int64) *int64                { return &n }
func effortPtr(e EffortLevel) *EffortLevel { return &e }

// aBrief builds a brief with sensible defaults and shallow overrides.
func aBrief(overrides ...func(*Brief)) Brief {
	brief := Brief{
		Title:     "Rename the helper",
		Body:      "Rename `foo` to `bar` everywhere.",
		Model:     ModelTierMain,
		Mode:      ModeEdit,
		Cwd:       "/repo",
		Base:      "HEAD",
		Scope:     []string{"**"},
		Forbid:    []string{},
		Gates:     []Gate{},
		TimeoutMs: 2 * 60 * 60 * 1000,
		Retries:   Retries{Fix: 1, Infra: 2},
		Report:    Report{Kind: ReportKindBuiltin, Name: BuiltinReportChange},
		AddDirs:   []string{},
		Env:       []string{},
		Tags:      []string{},
	}
	for _, override := range overrides {
		override(&brief)
	}
	return brief
}

// doc builds a brief document: front matter lines between --- fences, then the body.
func doc(frontMatter string) string {
	return docBody(frontMatter, "Rename `foo` to `bar` everywhere.\n")
}

func docBody(frontMatter, body string) string {
	return "---\n" + frontMatter + "\n---\n" + body
}

func parseOk(t *testing.T, text string) Brief {
	t.Helper()
	brief, errs := ParseBrief(text, briefCtx)
	if errs != nil {
		t.Fatalf("expected a brief, got %s", mustJSON(errs))
	}
	return brief
}

func parseErrors(t *testing.T, text string) []BriefError {
	t.Helper()
	brief, errs := ParseBrief(text, briefCtx)
	if errs == nil {
		t.Fatalf("expected errors, got %s", mustJSON(brief))
	}
	return errs
}

func mustJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err.Error()
	}
	return string(encoded)
}

func requireDeepEqual(t *testing.T, context string, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s: got %s, want %s", context, mustJSON(got), mustJSON(want))
	}
}

func TestParseBrief(t *testing.T) {
	t.Run("parses title, body and every documented front-matter field", func(t *testing.T) {
		text := doc(strings.Join([]string{
			"title: Rename the helper",
			"model: flash",
			"effort: high",
			"mode: edit",
			"cwd: /work/other",
			"base: main",
			`scope: ["src/**", "test/**"]`,
			`forbid: ["src/generated/**"]`,
			"gates:",
			"  - npm test",
			"  - { run: npm run lint, timeout: 5m }",
			"setup:",
			"  - npm ci",
			"regenerate:",
			"  - { paths: [package-lock.json], run: npm install --package-lock-only }",
			"timeout: 30m",
			"retries: { fix: 3, infra: 0 }",
			"report: notes",
			"addDirs: [/opt/shared]",
			"env: [GITHUB_TOKEN]",
			"budgetUsd: 2.5",
			"tags: [rename, batch-7]",
		}, "\n"))
		budget := 2.5
		requireDeepEqual(t, "brief", parseOk(t, text), Brief{
			Title:  "Rename the helper",
			Body:   "Rename `foo` to `bar` everywhere.\n",
			Model:  ModelTierFlash,
			Effort: strPtr("high"),
			Mode:   ModeEdit,
			Cwd:    resolvePath("/work/repo", "/work/other"),
			Base:   "main",
			Scope:  []string{"src/**", "test/**"},
			Forbid: []string{"src/generated/**"},
			Gates: []Gate{
				{Run: "npm test", TimeoutMs: 600_000},
				{Run: "npm run lint", TimeoutMs: 300_000},
			},
			Setup:      &[]string{"npm ci"},
			Regenerate: &[]regenerateRule{{Paths: []string{"package-lock.json"}, Run: "npm install --package-lock-only"}},
			TimeoutMs:  1_800_000,
			Retries:    Retries{Fix: 3, Infra: 0},
			Report:     Report{Kind: ReportKindBuiltin, Name: BuiltinReportNotes},
			AddDirs:    []string{resolvePath("/work/repo", "/opt/shared")},
			Env:        []string{"GITHUB_TOKEN"},
			BudgetUSD:  &budget,
			Tags:       []string{"rename", "batch-7"},
		})
	})

	t.Run("errors no_front_matter when the document has no leading --- block", func(t *testing.T) {
		for _, text := range []string{
			"Just a task, no front matter.\n",
			"\n---\ntitle: Late fence\n---\nBody\n",
			"---\ntitle: Never closed\nBody\n",
			"",
		} {
			requireDeepEqual(t, "errors", parseErrors(t, text), []BriefError{{Kind: BriefErrorNoFrontMatter}})
		}
	})

	t.Run("errors yaml with the parser message on malformed YAML", func(t *testing.T) {
		errors := parseErrors(t, doc("title: [unclosed\nmode: edit"))
		if len(errors) != 1 || errors[0].Kind != BriefErrorYaml || !strings.Contains(errors[0].Message, "Flow sequence") {
			t.Fatalf("errors = %s, want one yaml error containing \"Flow sequence\"", mustJSON(errors))
		}
	})

	t.Run("errors empty_body when the markdown body is blank", func(t *testing.T) {
		for _, body := range []string{"", "\n", "  \n\t\n"} {
			requireDeepEqual(t, "body", parseErrors(t, docBody("title: Rename the helper", body)),
				[]BriefError{{Kind: BriefErrorEmptyBody}})
		}
		requireDeepEqual(t, "no body", parseErrors(t, "---\ntitle: Rename the helper\n---"),
			[]BriefError{{Kind: BriefErrorEmptyBody}})
	})

	t.Run("requires title; reports field errors for every invalid field at once, not just the first", func(t *testing.T) {
		errors := parseErrors(t, docBody(strings.Join([]string{"mode: write", "effort: medium", "gates: [{ run: '' }]"}, "\n"), "\n"))
		if len(errors) != 5 {
			t.Fatalf("errors = %s, want 5", mustJSON(errors))
		}
		want := []struct {
			kind    BriefErrorKind
			field   string
			message string
		}{
			{BriefErrorField, "title", "required"},
			{BriefErrorField, "effort", "low, high, max"},
			{BriefErrorField, "mode", "edit"},
			{BriefErrorField, "gates.0.run", "must not be empty"},
			{BriefErrorEmptyBody, "", ""},
		}
		for i, wantAt := range want {
			if errors[i].Kind != wantAt.kind || errors[i].Field != wantAt.field || !strings.Contains(errors[i].Message, wantAt.message) {
				t.Fatalf("errors[%d] = %s, want %s containing %q", i, mustJSON(errors[i]), wantAt.kind, wantAt.message)
			}
		}
	})

	t.Run("rejects unknown front-matter keys (typo protection) naming the key", func(t *testing.T) {
		errors := parseErrors(t, doc(strings.Join([]string{"title: Rename the helper", "scopes: [src/**]", "retries: { fixes: 2 }"}, "\n")))
		if len(errors) != 2 {
			t.Fatalf("errors = %s, want 2", mustJSON(errors))
		}
		for _, error := range errors {
			if error.Kind != BriefErrorField || error.Message != "unknown field" ||
				(error.Field != "scopes" && error.Field != "retries.fixes") {
				t.Fatalf("error %s is neither {scopes, unknown field} nor {retries.fixes, unknown field}", mustJSON(error))
			}
		}
	})

	t.Run("defaults mode=edit, model=main for edit and flash for exec/readonly", func(t *testing.T) {
		if brief := parseOk(t, doc("title: t")); brief.Mode != ModeEdit || brief.Model != ModelTierMain {
			t.Fatalf("got mode=%s model=%s, want edit/main", brief.Mode, brief.Model)
		}
		if brief := parseOk(t, doc("title: t\nmode: exec")); brief.Mode != ModeExec || brief.Model != ModelTierFlash {
			t.Fatalf("got mode=%s model=%s, want exec/flash", brief.Mode, brief.Model)
		}
		if brief := parseOk(t, doc("title: t\nmode: readonly")); brief.Mode != ModeReadonly || brief.Model != ModelTierFlash {
			t.Fatalf("got mode=%s model=%s, want readonly/flash", brief.Mode, brief.Model)
		}
		if brief := parseOk(t, doc("title: t\nmode: exec\nmodel: glm")); brief.Mode != ModeExec || brief.Model != ModelTierMain {
			t.Fatalf("got mode=%s model=%s, want exec/main", brief.Mode, brief.Model)
		}
	})

	t.Run("defaults scope to ['**'] for edit and [] for exec/readonly; forbid to []", func(t *testing.T) {
		requireDeepEqual(t, "edit", parseOk(t, doc("title: t")).Scope, []string{"**"})
		requireDeepEqual(t, "edit forbid", parseOk(t, doc("title: t")).Forbid, []string{})
		requireDeepEqual(t, "exec", parseOk(t, doc("title: t\nmode: exec")).Scope, []string{})
		requireDeepEqual(t, "readonly", parseOk(t, doc("title: t\nmode: readonly")).Scope, []string{})
	})

	t.Run("defaults report to change/sweep/notes by mode; accepts a builtin name or a .json path (resolved against defaultCwd)", func(t *testing.T) {
		builtin := func(name BuiltinReport) Report { return Report{Kind: ReportKindBuiltin, Name: name} }
		requireDeepEqual(t, "edit", parseOk(t, doc("title: t")).Report, builtin(BuiltinReportChange))
		requireDeepEqual(t, "exec", parseOk(t, doc("title: t\nmode: exec")).Report, builtin(BuiltinReportSweep))
		requireDeepEqual(t, "readonly", parseOk(t, doc("title: t\nmode: readonly")).Report, builtin(BuiltinReportNotes))
		requireDeepEqual(t, "named", parseOk(t, doc("title: t\nreport: sweep")).Report, builtin(BuiltinReportSweep))
		requireDeepEqual(t, "relative", parseOk(t, doc("title: t\nreport: schemas/audit.json")).Report,
			Report{Kind: ReportKindFile, Path: resolvePath("/work/repo", "schemas/audit.json")})
		requireDeepEqual(t, "absolute", parseOk(t, doc("title: t\nreport: /etc/zai/audit.json")).Report,
			Report{Kind: ReportKindFile, Path: resolvePath("/work/repo", "/etc/zai/audit.json")})
		requireDeepEqual(t, "invalid", parseErrors(t, doc("title: t\nreport: summary")), []BriefError{
			{Kind: BriefErrorField, Field: "report", Message: "must be change, sweep, notes or a path to a .json schema"},
		})
	})

	t.Run("defaults timeout 2h, retries {fix: 1, infra: 2}, base HEAD, gates/addDirs/env/tags empty", func(t *testing.T) {
		requireDeepEqual(t, "brief", parseOk(t, doc("title: Rename the helper")),
			aBrief(func(b *Brief) {
				b.Cwd = "/work/repo"
				b.Body = "Rename `foo` to `bar` everywhere.\n"
			}))
		requireDeepEqual(t, "infra default", parseOk(t, doc("title: t\nretries: { infra: 5 }")).Retries, Retries{Fix: 1, Infra: 5})
		requireDeepEqual(t, "fix default", parseOk(t, doc("title: t\nretries: { fix: 0 }")).Retries, Retries{Fix: 0, Infra: 2})
	})

	t.Run("accepts gates as strings or {run, timeout}; gate timeout defaults to 10m", func(t *testing.T) {
		gates := strings.Join([]string{
			"gates:",
			"  - npm test",
			"  - run: npm run e2e",
			"    timeout: 1h",
			"  - { run: make lint }",
		}, "\n")
		requireDeepEqual(t, "gates", parseOk(t, doc("title: t\n"+gates)).Gates, []Gate{
			{Run: "npm test", TimeoutMs: 600_000},
			{Run: "npm run e2e", TimeoutMs: 3_600_000},
			{Run: "make lint", TimeoutMs: 600_000},
		})
		errors := parseErrors(t, doc("title: t\ngates: [{ run: make, timeout: soon }]"))
		if len(errors) != 1 || errors[0].Field != "gates.0.timeout" || !strings.Contains(errors[0].Message, `invalid duration "soon"`) {
			t.Fatalf("errors = %s, want gates.0.timeout containing invalid duration \"soon\"", mustJSON(errors))
		}
		errors = parseErrors(t, doc("title: t\ngates: [{ cmd: make }]"))
		found := false
		for _, error := range errors {
			if error.Kind == BriefErrorField && error.Field == "gates.0.cmd" && error.Message == "unknown field" {
				found = true
			}
		}
		if !found {
			t.Fatalf("errors = %s, want one {gates.0.cmd, unknown field}", mustJSON(errors))
		}
	})

	t.Run("resolves a relative cwd and addDirs against defaultCwd; keeps absolute ones", func(t *testing.T) {
		brief := parseOk(t, doc("title: t\ncwd: ../sibling\naddDirs: [docs, /opt/shared, ./vendor/lib]"))
		if want := resolvePath("/work/repo", "../sibling"); brief.Cwd != want {
			t.Fatalf("cwd = %q, want %q", brief.Cwd, want)
		}
		requireDeepEqual(t, "addDirs", brief.AddDirs, []string{
			resolvePath("/work/repo", "docs"),
			resolvePath("/work/repo", "/opt/shared"),
			resolvePath("/work/repo", "./vendor/lib"),
		})
		if brief := parseOk(t, doc("title: t\ncwd: /srv/app")); brief.Cwd != resolvePath("/work/repo", "/srv/app") {
			t.Fatalf("cwd = %q, want %q", brief.Cwd, resolvePath("/work/repo", "/srv/app"))
		}
	})

	t.Run("accepts model ids and tier names: glm-5.3 → main, glm-5.3-flash → flash", func(t *testing.T) {
		if brief := parseOk(t, doc("title: t\nmodel: glm-5.3")); brief.Model != ModelTierMain {
			t.Fatalf("glm-5.3 → %s, want main", brief.Model)
		}
		if brief := parseOk(t, doc("title: t\nmodel: glm-5.3-flash")); brief.Model != ModelTierFlash {
			t.Fatalf("glm-5.3-flash → %s, want flash", brief.Model)
		}
		if brief := parseOk(t, doc("title: t\nmodel: flash")); brief.Model != ModelTierFlash {
			t.Fatalf("flash → %s, want flash", brief.Model)
		}
		requireDeepEqual(t, "unknown model", parseErrors(t, doc("title: t\nmodel: sonnet")), []BriefError{
			{Kind: BriefErrorField, Field: "model", Message: "must be one of glm, glm-5.3, flash, glm-5.3-flash"},
		})
	})

	t.Run("rejects negative retries, non-positive timeouts and budgetUsd <= 0", func(t *testing.T) {
		fields := func(errors []BriefError) []string {
			names := make([]string, 0, len(errors))
			for _, error := range errors {
				if error.Kind == BriefErrorField {
					names = append(names, error.Field)
				} else {
					names = append(names, string(error.Kind))
				}
			}
			return names
		}
		requireDeepEqual(t, "retries", fields(parseErrors(t, doc("title: t\nretries: { fix: -1, infra: 1.5 }"))),
			[]string{"retries.fix", "retries.infra"})
		requireDeepEqual(t, "timeout 0", fields(parseErrors(t, doc("title: t\ntimeout: 0"))), []string{"timeout"})
		requireDeepEqual(t, "timeout -5m", fields(parseErrors(t, doc("title: t\ntimeout: -5m"))), []string{"timeout"})
		requireDeepEqual(t, "gate timeout", fields(parseErrors(t, doc("title: t\ngates: [{ run: make, timeout: 0s }]"))),
			[]string{"gates.0.timeout"})
		requireDeepEqual(t, "budget 0", fields(parseErrors(t, doc("title: t\nbudgetUsd: 0"))), []string{"budgetUsd"})
		requireDeepEqual(t, "budget -2", fields(parseErrors(t, doc("title: t\nbudgetUsd: -2"))), []string{"budgetUsd"})
		if budget := parseOk(t, doc("title: t\nbudgetUsd: 0.25")).BudgetUSD; budget == nil || *budget != 0.25 {
			t.Fatalf("budgetUsd = %v, want 0.25", budget)
		}
	})

	t.Run("validates env entries as shell variable names", func(t *testing.T) {
		requireDeepEqual(t, "valid", parseOk(t, doc("title: t\nenv: [GITHUB_TOKEN, _private, npm_config_cache2]")).Env,
			[]string{"GITHUB_TOKEN", "_private", "npm_config_cache2"})
		want := make([]BriefError, 0, 4)
		for _, field := range []string{"env.1", "env.2", "env.3", "env.4"} {
			want = append(want, BriefError{Kind: BriefErrorField, Field: field, Message: "must be a shell variable name"})
		}
		requireDeepEqual(t, "invalid", parseErrors(t, doc("title: t\nenv: [OK, 2FA, MY-VAR, 'A B', 'X=1']")), want)
	})

	t.Run("keeps the body byte-exact apart from trimming the separator newline", func(t *testing.T) {
		body := "\n  Indented first line  \n\n---\nnot front matter\n```yaml\nkey: value\n```\n\n\n"
		if got := parseOk(t, docBody("title: t", body)).Body; got != body {
			t.Fatalf("body = %q, want %q", got, body)
		}
		if got := parseOk(t, "---\r\ntitle: t\r\n---\r\nLine one\r\nLine two\r\n").Body; got != "Line one\r\nLine two\r\n" {
			t.Fatalf("body = %q, want %q", got, "Line one\r\nLine two\r\n")
		}
		if got := parseOk(t, "---\ntitle: t\n---\nNo trailing newline").Body; got != "No trailing newline" {
			t.Fatalf("body = %q, want %q", got, "No trailing newline")
		}
	})

	t.Run("treats empty front matter as no fields and a non-mapping one as a front-matter error", func(t *testing.T) {
		requireDeepEqual(t, "empty", parseErrors(t, "---\n---\nBody\n"),
			[]BriefError{{Kind: BriefErrorField, Field: "title", Message: "required"}})
		errors := parseErrors(t, doc("- just\n- a list"))
		if len(errors) != 1 || errors[0].Field != "front matter" || !strings.Contains(errors[0].Message, "expected object") {
			t.Fatalf("errors = %s, want one front-matter error containing \"expected object\"", mustJSON(errors))
		}
	})

	t.Run("allows trailing whitespace after either fence", func(t *testing.T) {
		brief := parseOk(t, "---  \ntitle: t\n--- \t\nBody\n")
		if brief.Title != "t" || brief.Body != "Body\n" {
			t.Fatalf("brief = %s, want title \"t\" and body \"Body\\n\"", mustJSON(brief))
		}
	})

	t.Run("trims text fields and rejects blank ones", func(t *testing.T) {
		brief := parseOk(t, doc("title: '  Padded title  '\ngates: ['  npm test  ']"))
		if brief.Title != "Padded title" {
			t.Fatalf("title = %q, want \"Padded title\"", brief.Title)
		}
		requireDeepEqual(t, "gate", brief.Gates, []Gate{{Run: "npm test", TimeoutMs: 600_000}})
		requireDeepEqual(t, "blank", parseErrors(t, doc("title: '   '\ngates: [{ run: '  ' }]")), []BriefError{
			{Kind: BriefErrorField, Field: "title", Message: "must not be empty"},
			{Kind: BriefErrorField, Field: "gates.0.run", Message: "must not be empty"},
		})
	})

	t.Run("accepts every effort level", func(t *testing.T) {
		for _, effort := range referenceCaps.Efforts {
			if got := parseOk(t, doc("title: t\neffort: "+effort)).Effort; got == nil || *got != effort {
				t.Fatalf("effort %q: got %v", effort, got)
			}
		}
	})

	t.Run("rejects any other effort level, naming the valid set in the message", func(t *testing.T) {
		for _, effort := range []string{"medium", "xhigh", "ultra"} {
			requireDeepEqual(t, effort, parseErrors(t, doc("title: t\neffort: "+effort)), []BriefError{
				{Kind: BriefErrorField, Field: "effort", Message: "must be one of low, high, max"},
			})
		}
	})
}

func TestIsSweepBrief(t *testing.T) {
	// Direct rows for IsSweepBrief, which the render layer reaches only through whole templates.
	sweep := parseOk(t, doc("title: t\nmode: exec"))
	file := parseOk(t, doc("title: t\nreport: schemas/audit.json"))
	change := parseOk(t, doc("title: t"))
	if !IsSweepBrief(sweep) || IsSweepBrief(file) || IsSweepBrief(change) {
		t.Fatalf("sweep=%v file=%v change=%v, want true false false", IsSweepBrief(sweep), IsSweepBrief(file), IsSweepBrief(change))
	}
}

var todoLine = regexp.MustCompile(`(?m)^TODO.*$`)

func TestBriefTemplate(t *testing.T) {
	reportByMode := map[Mode]BuiltinReport{ModeEdit: BuiltinReportChange, ModeExec: BuiltinReportSweep, ModeReadonly: BuiltinReportNotes}

	t.Run("renders a template that parseBrief accepts after the TODO body is filled in (round trip)", func(t *testing.T) {
		for _, mode := range []Mode{ModeEdit, ModeExec, ModeReadonly} {
			title := `Audit: the "legacy" #handlers`
			template := BriefTemplate(title, mode, referenceProvider, referenceCaps)
			if !strings.Contains(template, "TODO") {
				t.Fatalf("template has no TODO: %s", template)
			}
			filled := todoLine.ReplaceAllString(template, "Find every legacy handler.")
			want := aBrief(func(b *Brief) {
				b.Title = title
				b.Body = "Find every legacy handler.\n"
				b.Mode = mode
				if mode == ModeEdit {
					b.Model = ModelTierMain
				} else {
					b.Model = ModelTierFlash
				}
				b.Cwd = "/work/repo"
				if mode == ModeEdit {
					b.Scope = []string{"**"}
				} else {
					b.Scope = []string{}
				}
				b.Report = Report{Kind: ReportKindBuiltin, Name: reportByMode[mode]}
			})
			brief, errs := ParseBrief(filled, briefCtx)
			if errs != nil {
				t.Fatalf("%s: parseBrief(filled) = %s", mode, mustJSON(errs))
			}
			requireDeepEqual(t, string(mode), brief, want)
		}
	})

	t.Run("documents every field as a YAML comment and sets mode-specific defaults", func(t *testing.T) {
		fields := []string{"title", "model", "effort", "mode", "cwd", "base", "scope", "forbid", "gates", "timeout"}
		moreFields := []string{"retries", "report", "addDirs", "env", "budgetUsd", "tags"}
		allFields := append(fields, moreFields...)
		isFieldLine := func(line string) bool {
			for _, field := range allFields {
				if strings.HasPrefix(line, field+":") || strings.HasPrefix(line, "# "+field+":") {
					return true
				}
			}
			return false
		}
		lines := strings.Split(BriefTemplate("t", ModeExec, referenceProvider, referenceCaps), "\n")
		for _, field := range allFields {
			at := -1
			for i, line := range lines {
				if strings.HasPrefix(line, field+":") || strings.HasPrefix(line, "# "+field+":") {
					at = i
					break
				}
			}
			if at <= 0 {
				t.Fatalf("%s: no field line in template", field)
			}
			comment := lines[at-1]
			if !regexp.MustCompile(`^# [A-Za-z]`).MatchString(comment) {
				t.Fatalf("comment above %s = %q, want prose", field, comment)
			}
			if isFieldLine(comment) {
				t.Fatalf("comment above %s = %q, is a field line", field, comment)
			}
		}
		requireLines(t, lines, "exec", []string{"mode: exec", "model: flash", "scope: []", "report: sweep"})
		requireLines(t, strings.Split(BriefTemplate("t", ModeReadonly, referenceProvider, referenceCaps), "\n"), "readonly",
			[]string{"mode: readonly", "model: flash", "scope: []", "report: notes"})
		requireLines(t, strings.Split(BriefTemplate("t", ModeEdit, referenceProvider, referenceCaps), "\n"), "edit",
			[]string{"mode: edit", "model: glm", `scope: ["**"]`, "report: change"})
	})

	t.Run("documents the worker's effort levels in the comment", func(t *testing.T) {
		want := "# " + strings.Join(referenceCaps.Efforts, " | ") + ", passed to claude --effort. Default: unset."
		if !strings.Contains(BriefTemplate("t", ModeEdit, referenceProvider, referenceCaps), want) {
			t.Fatalf("template does not contain %q", want)
		}
	})

	t.Run("is stable: snapshot of the edit template", func(t *testing.T) {
		requireDeepEqual(t, "template", BriefTemplate("Rename the helper", ModeEdit, referenceProvider, referenceCaps),
			`---
# Short name shown on the board and in commit messages.
title: "Rename the helper"
# edit: own git worktree and branch zai/<id>; the worker may change files inside scope.
# exec: may run commands but must not change the repository; outputs go to $ZAI_ARTIFACTS.
# readonly: plan mode, read tools only.
mode: edit
# glm (glm-5.3) or flash (glm-5.3-flash). Default: glm for edit, flash otherwise.
model: glm
# low | high | max, passed to claude --effort. Default: unset.
# effort: high
# Repository the job works on; a relative path resolves against the default, the current git root.
# cwd: .
# Ref the worktree starts from.
base: HEAD
# Globs the change set may touch (picomatch, dotfiles included). Default: everything for edit, nothing otherwise.
scope: ["**"]
# Globs that must stay untouched even inside scope.
forbid: []
# Shell commands the plugin runs in the workspace after the worker, each a string or {run, timeout} (default 10m).
# Example: [npm test, { run: npm run lint, timeout: 5m }]
gates: []
# Per attempt: 90s, 15m, 2h, 1h30m or milliseconds.
timeout: 2h
# fix: auto-fix rounds after a failed verdict; infra: re-runs after infrastructure errors.
retries: { fix: 1, infra: 2 }
# Report contract: change, sweep, notes or a path to a JSON schema file. Default: by mode.
report: change
# Extra readable paths, passed as --add-dir.
addDirs: []
# Names of orchestrator environment variables passed to the worker and gates; values are never stored.
env: []
# Spending cap in USD, passed as --max-budget-usd. Default: unset.
# budgetUsd: 2
# high or normal: among jobs waiting for a free slot, high goes first. Default: high (run), normal (batch).
# priority: normal
# Free labels for batches and board filters.
tags: []
---
TODO: describe the task for the worker: what to change, where, and what done looks like.
`)
	})

	// Two provider shapes the reference provider cannot reach: a caveat line, and three distinct
	// default tiers.
	t.Run("renders the provider's caveats and every distinct default tier", func(t *testing.T) {
		withCaveats := BriefTemplate("t", ModeEdit, acmeProvider, acmeWorker)
		if !strings.Contains(withCaveats, "# Caveats: acme ignores the trace field") {
			t.Fatalf("caveats line missing: %s", withCaveats)
		}
		threeTiers := acmeProvider
		threeTiers.DefaultTier = map[Mode]ModelTier{ModeEdit: ModelTierMain, ModeExec: ModelTierMain, ModeReadonly: ModelTierFlash}
		line := "# big (big-model-9) or quick (small-model-9). Default: big for edit, big for exec, quick for readonly."
		if !strings.Contains(BriefTemplate("t", ModeEdit, threeTiers, acmeWorker), line) {
			t.Fatalf("tier line missing from %s", BriefTemplate("t", ModeEdit, threeTiers, acmeWorker))
		}
	})
}

func requireLines(t *testing.T, lines []string, context string, want []string) {
	t.Helper()
	for _, wanted := range want {
		found := false
		for _, line := range lines {
			if line == wanted {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("%s: %q is not a line of the template", context, wanted)
		}
	}
}

// Direct rows for the yaml conversion helpers in brief.go, against the behaviour the goldens show.
func TestYamlConversionHelpers(t *testing.T) {
	t.Run("parseIntScalar follows the core schema", func(t *testing.T) {
		cases := []struct {
			text string
			want any
		}{
			{"1500", int64(1500)},
			{"+5", int64(5)},
			{"017", int64(17)},
			{"0x1f", int64(31)},
			{"0o17", int64(15)},
			{"9999999999999999999", float64(9999999999999999999)},
			{"1_000", "1_000"},
			{"0b101", "0b101"},
			{"12e", "12e"},
		}
		for _, tc := range cases {
			if got := parseIntScalar(tc.text); got != tc.want {
				t.Fatalf("parseIntScalar(%q) = %#v, want %#v", tc.text, got, tc.want)
			}
		}
	})

	t.Run("parseFloatScalar follows the core schema", func(t *testing.T) {
		cases := []struct {
			text string
			want any
		}{
			{"1.5", float64(1.5)},
			{"1e3", float64(1000)},
			{"+.inf", math.Inf(1)},
			{"-.INF", math.Inf(-1)},
			{"1_0.5", "1_0.5"},
			{"x", "x"},
		}
		for _, tc := range cases {
			got := parseFloatScalar(tc.text)
			switch want := tc.want.(type) {
			case float64:
				number, ok := got.(float64)
				if !ok || math.IsNaN(number) != math.IsNaN(want) || number != want && !math.IsInf(want, 0) {
					t.Fatalf("parseFloatScalar(%q) = %#v, want %#v", tc.text, got, tc.want)
				}
			default:
				if got != tc.want {
					t.Fatalf("parseFloatScalar(%q) = %#v, want %#v", tc.text, got, tc.want)
				}
			}
		}
		if !math.IsNaN(parseFloatScalar(".nan").(float64)) {
			t.Fatalf("parseFloatScalar(.nan) is not NaN")
		}
	})

	t.Run("jsTypeName names the JS types zod quotes", func(t *testing.T) {
		cases := []struct {
			value any
			want  string
		}{
			{nil, "null"},
			{"s", "string"},
			{int64(1), "number"},
			{float64(1), "number"},
			{true, "boolean"},
			{yamlMap{}, "object"},
			{[]any{}, "array"},
			{struct{}{}, "undefined"},
		}
		for _, tc := range cases {
			if got := jsTypeName(tc.value); got != tc.want {
				t.Fatalf("jsTypeName(%#v) = %q, want %q", tc.value, got, tc.want)
			}
		}
	})

	t.Run("keys coerce the way a plain JS object's do", func(t *testing.T) {
		data, messages := parseYamlFrontMatter("1: a\ntrue: b\nnull: c\n1.5: d")
		if len(messages) != 0 {
			t.Fatalf("messages = %s", mustJSON(messages))
		}
		_, errors := ParseFrontMatter(data, briefCtx)
		fields := map[string]bool{}
		for _, fieldError := range errors {
			fields[fieldError.Field] = fieldError.Message == "unknown field"
		}
		for _, key := range []string{"1", "true", "null", "1.5"} {
			if !fields[key] {
				t.Fatalf("no unknown-field error for key %q: %s", key, mustJSON(errors))
			}
		}
	})

	t.Run("valueColumn finds a line's value, or gives column 1", func(t *testing.T) {
		source := "k: v\nlong key: value\nno colon\nk: \tvalue"
		if got := valueColumn(source, 1); got != 4 {
			t.Fatalf("valueColumn(1) = %d, want 4", got)
		}
		if got := valueColumn(source, 2); got != 11 {
			t.Fatalf("valueColumn(2) = %d, want 11", got)
		}
		if got := valueColumn(source, 3); got != 1 {
			t.Fatalf("valueColumn(3) = %d, want 1", got)
		}
		if got := valueColumn(source, 4); got != 5 {
			t.Fatalf("valueColumn(4) = %d, want 5 (past the tab)", got)
		}
		if got := valueColumn(source, 9); got != 1 {
			t.Fatalf("valueColumn(9) = %d, want 1", got)
		}
	})

	t.Run("hasNonSpace counts every non-space character", func(t *testing.T) {
		if hasNonSpace("") || hasNonSpace("   ") {
			t.Fatalf("spaces only must not count")
		}
		if !hasNonSpace(" \t") {
			t.Fatalf("a tab is a non-space")
		}
	})

	t.Run("translateYamlError passes unknown go-yaml messages through", func(t *testing.T) {
		if got := translateYamlError("yaml: line 2: unexpected token", "a: 1"); mustJSON(got) != `["yaml: line 2: unexpected token"]` {
			t.Fatalf("got %s", mustJSON(got))
		}
		if got := translateYamlError("boom", "a: 1"); mustJSON(got) != `["boom"]` {
			t.Fatalf("got %s", mustJSON(got))
		}
	})

	t.Run("flowDedentErrors tracks quotes and escapes", func(t *testing.T) {
		source := "a: [\"x\\\"y\", 'c''d'\nb: 1"
		messages := flowDedentErrors(source, "msg")
		if len(messages) != 1 || !strings.Contains(messages[0], "msg at line 2, column 1") {
			t.Fatalf("messages = %s", mustJSON(messages))
		}
		if got := flowDedentErrors("a: [1, 2]\nb: 3", "msg"); got != nil {
			t.Fatalf("a closed flow must not error: %s", mustJSON(got))
		}
	})

	t.Run("a BriefError carries its kind as its message", func(t *testing.T) {
		var failure error = BriefError{Kind: BriefErrorField}
		if failure.Error() != "field" {
			t.Fatalf("Error() = %q", failure.Error())
		}
	})
}

func TestYamlRenderHelpers(t *testing.T) {
	t.Run("jsKeyName falls back to the raw value for non-scalar keys", func(t *testing.T) {
		if got := jsKeyName(&yaml.Node{Kind: yaml.SequenceNode}); got != "" {
			t.Fatalf("jsKeyName(sequence) = %q, want \"\"", got)
		}
	})

	t.Run("utf16 helpers measure the way JS does", func(t *testing.T) {
		if got := utf16Len("a😀b"); got != 4 {
			t.Fatalf("utf16Len = %d, want 4", got)
		}
		if got := utf16Slice("a😀b", 0, 3); got != "a😀" {
			t.Fatalf("utf16Slice(0,3) = %q", got)
		}
		// A cut inside a surrogate pair drops the pair, as JS substring does.
		if got := utf16Slice("a😀b", 0, 2); got != "a" {
			t.Fatalf("utf16Slice(0,2) = %q, want \"a\"", got)
		}
		if got := utf16Slice("abc", -1, 99); got != "abc" {
			t.Fatalf("utf16Slice(-1,99) = %q", got)
		}
	})

	t.Run("prettify clamps a column past the line and trims from the end", func(t *testing.T) {
		if got := prettifyYamlError("ab", "m", 1, 9); got != "m at line 1, column 9:\n\nab\n  ^\n" {
			t.Fatalf("clamp: %q", got)
		}
		long := strings.Repeat("x", 60) + ": " + strings.Repeat("v", 48)
		want := "m at line 1, column 101:\n\n…" + strings.Repeat("x", 29) + ": " + strings.Repeat("v", 48) +
			"\n" + strings.Repeat(" ", 70) + "^\n"
		if got := prettifyYamlError(long, "m", 1, 101); got != want {
			t.Fatalf("end trim:\ngot  %q\nwant %q", got, want)
		}
	})

	t.Run("prettify drops the snippet for an all-space line", func(t *testing.T) {
		if got := prettifyYamlError("   \nab", "m", 1, 2); got != "m at line 1, column 2" {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("flowDedentErrors closes more than it opened and skips comment lines", func(t *testing.T) {
		if got := flowDedentErrors("a: ]x\n# note\nb: [1", "m"); len(got) != 1 ||
			!strings.Contains(got[0], "m at line 3, column 6") {
			t.Fatalf("got %s", mustJSON(got))
		}
		if got := flowDedentErrors("a: [\"x\ny\"\nb: 1", "m"); len(got) != 1 ||
			!strings.Contains(got[0], "m at line 3, column 1") {
			t.Fatalf("multiline quote: %s", mustJSON(got))
		}
	})

	t.Run("checkDuration rejects non-finite numbers like the zod union", func(t *testing.T) {
		if _, message, ok := checkDuration(math.NaN()); ok || message != "Invalid input" {
			t.Fatalf("NaN: (%q, %v)", message, ok)
		}
	})

	t.Run("checkCount rejects negative whole floats", func(t *testing.T) {
		if _, message, ok := checkCount(float64(-2)); ok || message != "Too small: expected number to be >=0" {
			t.Fatalf("got (%q, %v)", message, ok)
		}
	})
}

// The submitting spread (`{ ...parsed.value, priority }`) puts a defaulted priority after every
// brief field, tags included; the marshaled object keeps that order.
func TestBriefPriorityMarshalOrder(t *testing.T) {
	brief := func(priority *Priority) Brief {
		return Brief{
			Title:    "Fix the value",
			Body:     "Make the check pass.\n",
			Model:    ModelTierMain,
			Mode:     ModeEdit,
			Priority: priority,
			Cwd:      "/repo",
			Base:     "HEAD",
			Tags:     make([]string, 0),
		}
	}
	where := func(text string) (mode, cwd, tags, priority int) {
		return strings.Index(text, `"mode"`), strings.Index(text, `"cwd"`),
			strings.Index(text, `"tags"`), strings.Index(text, `"priority"`)
	}

	t.Run("a priority the brief carried keeps its schema place, between mode and cwd", func(t *testing.T) {
		high := PriorityHigh
		text, err := MarshalIndentJSON(brief(&high))
		if err != nil {
			t.Fatal(err)
		}
		mode, cwd, _, priority := where(string(text))
		if mode == -1 || cwd == -1 || priority == -1 || priority < mode || priority > cwd {
			t.Fatalf("marshaled brief puts priority at %d (mode %d, cwd %d); it belongs between them:\n%s",
				priority, mode, cwd, text)
		}
	})

	t.Run("a defaulted priority comes after every field the brief carried, the spread's order", func(t *testing.T) {
		submitted := brief(nil)
		submitted.DefaultPriorityTo(PriorityHigh)
		text, err := MarshalIndentJSON(submitted)
		if err != nil {
			t.Fatal(err)
		}
		_, _, tags, priority := where(string(text))
		if tags == -1 || priority == -1 || priority < tags {
			t.Fatalf("marshaled brief puts priority at %d, tags at %d; the defaulted priority belongs last:\n%s",
				priority, tags, text)
		}
	})
}
