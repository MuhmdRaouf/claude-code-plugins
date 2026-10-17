package app

import (
	"gopkg.in/yaml.v3"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// BriefOverrides is the CLI's overrides of a brief's front matter.
type BriefOverrides struct {
	Model *domain.ModelTier
	Mode  *domain.Mode
	// Engine is `run --engine`: it wins over the brief's `engine:` and the configured default.
	Engine *domain.Engine
}

// WithOverrides returns the brief text with the CLI overrides written into its front matter, so
// ParseBrief derives the mode-dependent defaults (model, scope, report) from the overridden values.
// A document that does not parse is returned unchanged for ParseBrief to report. A tier is written
// under the name the provider's briefs use for it.
func WithOverrides(text string, overrides BriefOverrides, provider domain.Provider) string {
	type entry struct{ key, value string }
	var entries []entry
	if overrides.Model != nil {
		entries = append(entries, entry{"model", provider.TierNames[*overrides.Model]})
	}
	if overrides.Mode != nil {
		entries = append(entries, entry{"mode", string(*overrides.Mode)})
	}
	if overrides.Engine != nil {
		entries = append(entries, entry{"engine", string(*overrides.Engine)})
	}
	if len(entries) == 0 {
		return text
	}
	document, ok := domain.SplitFrontMatter(text)
	if !ok {
		return text
	}
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(document.FrontMatter), &doc); err != nil {
		return text
	}
	if doc.Kind != yaml.DocumentNode || len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return text
	}
	root := doc.Content[0]
	for _, set := range entries {
		setFrontMatterField(root, set.key, set.value)
	}
	rendered, err := yaml.Marshal(&doc)
	if err != nil {
		// Re-rendering a document the parser produced cannot fail.
		panic(err)
	}
	return "---\n" + string(rendered) + "---\n" + document.Body
}

// setFrontMatterField writes key: value into the front matter mapping, replacing the value where
// the key stood and appending new keys at the end.
func setFrontMatterField(root *yaml.Node, key, value string) {
	for i := 0; i+1 < len(root.Content); i += 2 {
		if root.Content[i].Value == key {
			root.Content[i+1] = &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value}
			return
		}
	}
	root.Content = append(root.Content,
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key},
		&yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: value})
}
