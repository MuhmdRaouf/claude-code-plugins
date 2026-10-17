package domain

import (
	"fmt"
	"regexp"
	"testing"
)

// The provider's prompt and brief answers. referenceProvider, acmeProvider, acmeWorker and
// requireDeepEqual come from brief_test.go's support fixtures.

const providerArtifacts = "/state/jobs/j1/artifacts"

var acmeCtx = BriefContext{DefaultCwd: "/work/repo", Provider: acmeProvider, Worker: acmeWorker}

func TestPromptsAndTemplateTakeEveryNameFromTheProvider(t *testing.T) {
	t.Run("the contract footer is headed with the provider's name and names its artifacts variable", func(t *testing.T) {
		exec := aBrief(func(b *Brief) { b.Mode = ModeExec; b.Scope = []string{} })
		prompts := []string{
			InitialPrompt(exec, providerArtifacts, acmeProvider),
			SelfContainedPrompt(exec, []Attempt{}, "Start over.", providerArtifacts, acmeProvider),
		}
		for _, prompt := range prompts {
			requireContains(t, prompt, "\n## acme contract\n")
			requireContains(t, prompt, "Write every output file to "+providerArtifacts+" (also in $ACME_OUT).")
			if regexp.MustCompile(`(?i)zai`).MatchString(prompt) {
				t.Fatalf("prompt names zai: %q", prompt)
			}
		}
	})

	for _, mode := range []Mode{ModeEdit, ModeExec, ModeReadonly} {
		t.Run(fmt.Sprintf("the %s template names the provider's branch, variable and models", mode), func(t *testing.T) {
			template := BriefTemplate("t", mode, acmeProvider, acmeWorker)
			requireContains(t, template, "# edit: own git worktree and branch acme-jobs/<id>;")
			requireContains(t, template, "outputs go to $ACME_OUT.")
			requireContains(t, template, "# big (big-model-9) or quick (small-model-9).")
			if regexp.MustCompile(`(?i)zai|glm-5\.3`).MatchString(template) {
				t.Fatalf("template names zai or glm-5.3: %q", template)
			}
		})
	}
}

func TestBriefMeansWhatTheCatalogAndTermsSay(t *testing.T) {
	parsed := func(frontMatter string, ctx BriefContext) (Brief, []BriefError) {
		return ParseBrief("---\ntitle: t\n"+frontMatter+"\n---\nDo it.\n", ctx)
	}

	t.Run("names a tier by itself or by the catalog's model id, never by another provider's id", func(t *testing.T) {
		brief, errs := parsed("model: big-model-9", acmeCtx)
		if errs != nil {
			t.Fatalf("model: big-model-9 must parse, got %s", mustJSON(errs))
		}
		if brief.Model != ModelTierMain {
			t.Fatalf("model: big-model-9 = %q, want main", brief.Model)
		}
		brief, errs = parsed("model: small-model-9", acmeCtx)
		if errs != nil {
			t.Fatalf("model: small-model-9 must parse, got %s", mustJSON(errs))
		}
		if brief.Model != ModelTierFlash {
			t.Fatalf("model: small-model-9 = %q, want flash", brief.Model)
		}
		_, errs = parsed("model: glm-5.3", acmeCtx)
		requireDeepEqual(t, "errors", errs, []BriefError{
			{Kind: BriefErrorField, Field: "model", Message: "must be one of big, big-model-9, quick, small-model-9"},
		})
	})

	t.Run("takes each mode's default tier from the provider", func(t *testing.T) {
		flashFirst := acmeProvider
		flashFirst.DefaultTier = map[Mode]ModelTier{ModeEdit: ModelTierFlash, ModeExec: ModelTierMain, ModeReadonly: ModelTierMain}
		ctx := BriefContext{DefaultCwd: "/work/repo", Provider: flashFirst, Worker: acmeWorker}

		brief, errs := parsed("mode: edit", ctx)
		if errs != nil {
			t.Fatalf("mode: edit must parse, got %s", mustJSON(errs))
		}
		if brief.Model != ModelTierFlash {
			t.Fatalf("mode: edit defaults to %q, want flash", brief.Model)
		}
		brief, errs = parsed("mode: exec", ctx)
		if errs != nil {
			t.Fatalf("mode: exec must parse, got %s", mustJSON(errs))
		}
		if brief.Model != ModelTierMain {
			t.Fatalf("mode: exec defaults to %q, want main", brief.Model)
		}
	})

	t.Run("accepts the worker's efforts only", func(t *testing.T) {
		brief, errs := parsed("effort: fierce", acmeCtx)
		if errs != nil {
			t.Fatalf("effort: fierce must parse, got %s", mustJSON(errs))
		}
		if brief.Effort == nil || *brief.Effort != "fierce" {
			t.Fatalf("effort: fierce = %s, want fierce", mustJSON(brief.Effort))
		}
		_, errs = parsed("effort: medium", acmeCtx)
		requireDeepEqual(t, "errors", errs, []BriefError{
			{Kind: BriefErrorField, Field: "effort", Message: "must be one of gentle, firm, fierce"},
		})
	})

	t.Run("refuses budgetUsd when the worker has no spending cap", func(t *testing.T) {
		_, errs := parsed("budgetUsd: 2", acmeCtx)
		requireDeepEqual(t, "errors", errs, []BriefError{
			{Kind: BriefErrorField, Field: "budgetUsd", Message: "the worker has no spending cap; use timeout"},
		})
	})

	t.Run("the template lists the worker's efforts and how it takes them, and each mode's default tier", func(t *testing.T) {
		allDifferent := acmeProvider
		allDifferent.DefaultTier = map[Mode]ModelTier{ModeEdit: ModelTierMain, ModeExec: ModelTierFlash, ModeReadonly: ModelTierMain}
		template := BriefTemplate("t", ModeExec, allDifferent, acmeWorker)

		requireContains(t, template,
			"# big (big-model-9) or quick (small-model-9). Default: big for edit, quick for exec,")
		requireContains(t, template, "big for readonly.\nmodel: quick\n")
		requireContains(t, template, "# gentle | firm | fierce, sent as acmebot --zeal. Default: unset.\n# effort: firm\n")
		requireContains(t, template, "# Extra readable paths, mounted read-only.")
		requireContains(t, template, "# Spending cap in USD, refused: acmebot has no spending cap. Default: unset.")
		if regexp.MustCompile(`(?i)claude`).MatchString(template) {
			t.Fatalf("template names claude: %q", template)
		}
	})

	t.Run("takes the readonly note from the worker's terms, not from a fixed plan-mode wording", func(t *testing.T) {
		worker := acmeWorker
		worker.BriefNotes.Readonly = "acme answers questions without changing anything"
		template := BriefTemplate("t", ModeReadonly, acmeProvider, worker)

		requireContains(t, template, "# readonly: acme answers questions without changing anything.")
		if regexp.MustCompile(`(?i)plan mode`).MatchString(template) {
			t.Fatalf("template says plan mode: %q", template)
		}
	})
}
