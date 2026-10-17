package shared

import "strings"

// ReportedModel is the model a tool says it ran on, as the tool names it: omp and pi stamp every
// assistant message with their own provider id and model id. It is the tool's own choice (its
// setup's default), reported back, never one the plugin picked.
func ReportedModel(message map[string]any) (string, bool) {
	model, ok := AsString(message["model"])
	if !ok || model == "" {
		return "", false
	}
	provider, ok := AsString(message["provider"])
	if !ok || provider == "" || strings.HasPrefix(model, provider+"/") {
		return model, true
	}
	return provider + "/" + model, true
}
