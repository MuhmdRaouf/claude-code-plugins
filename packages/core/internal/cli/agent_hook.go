// The SubagentStop hook's own helpers: after one of the plugin's model agents finishes, tell the
// user (a systemMessage, never Claude's context) what it really ran on. The agent's own transcript
// is the ground truth: every assistant entry names the model that answered. On the provider's
// model it says so with the tokens and the estimated cost; on a Claude model the router was down
// or setup never ran, and the line says how to fix it. Any problem means silence.
package cli

import (
	"bytes"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/render"
)

// AgentStopInput is the part of Claude Code's SubagentStop input the hook reads; every field may
// be missing or of any JSON type.
type AgentStopInput struct {
	AgentType           any `json:"agent_type"`
	AgentID             any `json:"agent_id"`
	AgentTranscriptPath any `json:"agent_transcript_path"`
	TranscriptPath      any `json:"transcript_path"`
	SessionID           any `json:"session_id"`
}

// AgentRun is what one agent's transcript says it ran on: the models that answered and what they
// used.
type AgentRun struct {
	render.TokenCounts
	Models   []string
	Requests int64
}

// TranscriptTailBytes is the newest part of a transcript the hook reads: a long agent's file can
// be large, and the hook has under a second. Usage counted from the tail undercounts such a run,
// never overcounts it.
const TranscriptTailBytes = 4 * 1024 * 1024

// ModelAgentOf is the plugin model agent this input is about, or false for any other agent
// (another plugin's, a built-in).
func ModelAgentOf(provider domain.Provider, input AgentStopInput) (string, bool) {
	agentType, ok := input.AgentType.(string)
	if !ok {
		return "", false
	}
	name := strings.TrimPrefix(agentType, provider.AgentPrefix)
	for _, agent := range provider.Agents {
		if agent == name {
			return name, true
		}
	}
	return "", false
}

// TranscriptPathOf is the agent's transcript: the path Claude Code passes, else
// `<session dir>/subagents/agent-<id>.jsonl` beside the main transcript.
func TranscriptPathOf(input AgentStopInput) (string, bool) {
	if path, ok := input.AgentTranscriptPath.(string); ok && path != "" {
		return path, true
	}
	main, mainOK := input.TranscriptPath.(string)
	id, idOK := input.AgentID.(string)
	session, sessionOK := input.SessionID.(string)
	if !mainOK || !idOK || !sessionOK {
		return "", false
	}
	return filepath.Join(filepath.Dir(main), session, "subagents", "agent-"+id+".jsonl"), true
}

// agentMessage is one assistant entry of a transcript: the message id, the model that answered and
// the usage it reports.
type agentMessage struct {
	ID    *string
	Model string
	Usage any
}

// AgentRunOf folds transcript JSONL: one request per distinct assistant message id, usage taken
// once per message. The models keep first-seen order.
func AgentRunOf(jsonl string) AgentRun {
	run := AgentRun{Models: []string{}}
	seenIDs := map[string]bool{}
	seenModels := map[string]bool{}
	for _, line := range strings.Split(jsonl, "\n") {
		message, ok := assistantMessage(line)
		if !ok {
			continue
		}
		if message.Model == "<synthetic>" {
			continue
		}
		if !seenModels[message.Model] {
			seenModels[message.Model] = true
			run.Models = append(run.Models, message.Model)
		}
		if message.ID != nil {
			if seenIDs[*message.ID] {
				continue
			}
			seenIDs[*message.ID] = true
		}
		run.Requests++
		run.InputTokens += agentTokens(message.Usage, "input_tokens")
		run.OutputTokens += agentTokens(message.Usage, "output_tokens")
		run.CacheReadTokens += agentTokens(message.Usage, "cache_read_input_tokens")
		run.CacheWriteTokens += agentTokens(message.Usage, "cache_creation_input_tokens")
	}
	return run
}

// assistantMessage is the line's assistant entry, or false for anything else: not JSON, not an
// assistant entry, or no model named.
func assistantMessage(line string) (agentMessage, bool) {
	if !strings.Contains(line, `"assistant"`) {
		return agentMessage{}, false
	}
	entry, err := domain.ParseJSON(line)
	if err != nil {
		return agentMessage{}, false
	}
	record, ok := entry.(map[string]any)
	if !ok || record["type"] != "assistant" {
		return agentMessage{}, false
	}
	message, ok := record["message"].(map[string]any)
	if !ok {
		return agentMessage{}, false
	}
	model, ok := message["model"].(string)
	if !ok {
		return agentMessage{}, false
	}
	parsed := agentMessage{Model: model, Usage: message["usage"]}
	if id, ok := message["id"].(string); ok {
		parsed.ID = &id
	}
	return parsed, true
}

// agentTokens is one usage field as a count: only a positive finite number counts.
func agentTokens(usage any, key string) float64 {
	record, ok := usage.(map[string]any)
	if !ok {
		return 0
	}
	value, ok := record[key].(float64)
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 {
		return 0
	}
	return value
}

// isClaudeModel says whether a model id is Anthropic's (the Sonnet fallback) rather than the
// provider's.
func isClaudeModel(model string) bool {
	return strings.HasPrefix(model, "claude")
}

// AgentStopMessage is the user's line about one finished agent, or false when there is nothing
// worth saying.
func AgentStopMessage(provider domain.Provider, agent string, run AgentRun, setupDone bool) (string, bool) {
	if len(run.Models) == 0 {
		return "", false
	}
	label := provider.AgentPrefix + agent
	var own []string
	for _, model := range run.Models {
		if !isClaudeModel(model) {
			own = append(own, model)
		}
	}
	if len(own) == 0 {
		why := provider.Name + " is not set up yet; run " + provider.Slash + "setup"
		if setupDone {
			why = "the " + provider.Name + " router was down; run " + provider.Slash + "setup"
		}
		return label + " ran on Sonnet: " + why + ".", true
	}
	cost := float64(0)
	if len(own) == 1 {
		cost = render.CostUsdOf(own[0], run.TokenCounts)
	}
	priced := ""
	if cost > 0 {
		priced = ", est. " + render.Usd(cost)
	}
	mixed := ""
	if len(own) < len(run.Models) {
		mixed = " (part of it on Sonnet: the router dropped out)"
	}
	return label + " ran on " + strings.Join(own, ", ") + " via the " + provider.Name + " router: " +
		render.Plural(run.Requests, "request") + ", " +
		render.Count(run.InputTokens+run.CacheReadTokens+run.CacheWriteTokens) + " in / " +
		render.Count(run.OutputTokens) + " out" + priced + mixed + ".", true
}

// ReadTail is the newest max bytes of a file, from the first whole line; false when it cannot be
// read.
func ReadTail(path string, max int64) (string, bool) {
	file, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", false
	}
	start := info.Size() - max
	if start < 0 {
		start = 0
	}
	buffer := make([]byte, info.Size()-start)
	if _, err := file.ReadAt(buffer, start); err != nil && err != io.EOF {
		return "", false
	}
	text := lossyUTF8(buffer)
	if start == 0 {
		return text, true
	}
	if at := strings.IndexByte(text, '\n'); at >= 0 {
		return text[at+1:], true
	}
	return text, true
}

// ReadStdinWithin is stdin as text, or what arrived of it within ms: a hook never waits on a pipe
// that stays open.
func ReadStdinWithin(ms int64, stdin io.Reader) string {
	var mu sync.Mutex
	var arrived bytes.Buffer
	done := make(chan struct{})
	go func() {
		defer close(done)
		chunk := make([]byte, 32*1024)
		for {
			n, err := stdin.Read(chunk)
			if n > 0 {
				mu.Lock()
				arrived.Write(chunk[:n])
				mu.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	timer := time.NewTimer(time.Duration(ms) * time.Millisecond)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
	}
	mu.Lock()
	defer mu.Unlock()
	return lossyUTF8(arrived.Bytes())
}

// lossyUTF8 decodes bytes the way Node's Buffer.toString("utf8") does: every invalid byte becomes
// U+FFFD, so a tail cut mid-character renders the same as it does under Node.
func lossyUTF8(data []byte) string {
	if utf8.Valid(data) {
		return string(data)
	}
	var text strings.Builder
	for i := 0; i < len(data); {
		r, size := utf8.DecodeRune(data[i:])
		if r == utf8.RuneError && size == 1 {
			text.WriteRune(utf8.RuneError)
		} else {
			text.WriteRune(r)
		}
		i += size
	}
	return text.String()
}
