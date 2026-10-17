package cli

import (
	"testing"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/app"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// setupSilent drops both streams: the hook's repairs stay out of the session it starts, whatever a
// step under it tries to say.
func TestSetupSilent(t *testing.T) {
	var silent ports.Output = setupSilent{}
	silent.Line("a line")
	silent.Error("an error")
}

// The invocation's JSON write carries the error a value the encoder refuses.
func TestInvocationJSONError(t *testing.T) {
	call := invocation{deps: app.Deps{Out: &recordingOutput{}}}
	if err := call.JSON(make(chan int)); err == nil {
		t.Fatal("JSON accepted a channel")
	}
	if err := call.JSON(map[string]int{"a": 1}); err != nil {
		t.Fatalf("JSON refused a map: %v", err)
	}
}

// recordingOutput is the output the internal tests write to.
type recordingOutput struct {
	lines int
}

func (o *recordingOutput) Line(string)  { o.lines++ }
func (o *recordingOutput) Error(string) { o.lines++ }

// baseUrlOrUnset reads an absent base URL as "unset".
func TestBaseUrlOrUnset(t *testing.T) {
	if got := baseUrlOrUnset(""); got != "unset" {
		t.Fatalf("empty = %q", got)
	}
	if got := baseUrlOrUnset("http://proxy"); got != "http://proxy" {
		t.Fatalf("set = %q", got)
	}
}
