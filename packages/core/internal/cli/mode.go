package cli

import (
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// modeModes are the modes --mode may name.
var modeModes = []domain.Mode{domain.ModeEdit, domain.ModeExec, domain.ModeReadonly}

// ModeOption is --mode, when given: it must name a mode. ok is false with an empty error when the
// option is absent, false with the message when it names no mode.
func ModeOption(call Invocation) (mode domain.Mode, ok bool, usage string) {
	text := call.Text("mode")
	if text == nil {
		return "", false, ""
	}
	for _, candidate := range modeModes {
		if candidate == domain.Mode(*text) {
			return candidate, true, ""
		}
	}
	return "", false, "--mode must be edit, exec or readonly"
}
