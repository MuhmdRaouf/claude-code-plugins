package domain

// ModelTier is the two model tiers every provider's catalog fills: the brief's `model`, the
// `--flash` override and the dispatcher agents name these, so one brief means the same on every
// worker.
type ModelTier string

const (
	ModelTierMain  ModelTier = "main"
	ModelTierFlash ModelTier = "flash"
)

// EffortLevel is the effort setup makes a model's default in the Claude settings: high or xhigh.
type EffortLevel string

const (
	EffortLevelHigh  EffortLevel = "high"
	EffortLevelXhigh EffortLevel = "xhigh"
)

// ModelRef is a catalog model as people see it: the tier a brief picks, the provider's model id
// (trailer, usage, renderers) and the label `/model` shows once setup has added the model to it.
type ModelRef struct {
	Tier ModelTier `json:"tier"`
	ID   string    `json:"id"`
	// The label `/model` shows once setup has added the model to it.
	Label string `json:"label"`
	// The Claude model id the `/model` entry says it `behavesAs`, so Claude Code applies that known
	// model's window, thinking and effort defaults to an id it does not know. Nil when the provider
	// is one Claude Code already knows. The label and the id sent in requests stay the provider's own.
	BehavesAs *string `json:"behavesAs,omitempty"`
	// The most output tokens the provider accepts for this model: `max_tokens` above it is answered
	// 400 before a token is generated. Nil when the router leaves `max_tokens` as the request
	// carried it.
	MaxOutputTokens *int64 `json:"maxOutputTokens,omitempty"`
	// The effort level setup makes this model's default in the Claude settings
	// (`modelSettings.<id>.effortLevel`), when the user has none: `behavesAs` carries the known
	// model's own default effort, which on this provider thinks too little. Nil when setup leaves
	// the effort settings alone.
	DefaultEffort *EffortLevel `json:"defaultEffort,omitempty"`
	// True when the provider takes this model's requests as text only and refuses image blocks.
	// Nil means images are accepted.
	TextOnly *bool `json:"textOnly,omitempty"`
}
