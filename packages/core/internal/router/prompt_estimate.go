// Estimates a provider conversation's prompt size for the `message_start` events that report none:
// Z.ai (and other providers) send `"usage":{"input_tokens":0,"output_tokens":0}` there and only the
// real numbers in the final `message_delta`, which left Claude Code showing "183 tokens" for a
// subagent holding a 150k-token context. A conversation is recognised by its `system` and first
// message — the parts every turn repeats — and what its last finished stream really cost feeds the
// next turn's estimate.
package router

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"math"
	"slices"
	"sync"
	"unicode/utf16"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// keyPartChars is how much of each part goes into a conversation key: enough to tell conversations
// apart, never the whole transcript.
const keyPartChars = 4096

// lruMax is the conversations remembered at most; the oldest falls out past this, so the map stays
// small forever.
const lruMax = 500

// bytesPerToken is how many body bytes a token is taken to be (the usual four-or-so characters per
// token).
const bytesPerToken = 4

// lastTurn is what one conversation remembers about its last finished stream: its real prompt size
// and how long the request body was, so the next turn's growth can be priced in bytes.
type lastTurn struct {
	promptTokens float64
	bodyChars    int64
}

// PromptEstimator is the conversations remembered. The router worker owns one, so nothing is
// shared behind the caller's back.
type PromptEstimator struct {
	mu sync.Mutex
	// turns maps a conversation key to its last turn; order is oldest first and newest last, which
	// is the LRU.
	turns map[string]lastTurn
	order []string
}

// NewPromptEstimator is an estimator that has seen no conversation yet.
func NewPromptEstimator() *PromptEstimator {
	return &PromptEstimator{turns: map[string]lastTurn{}}
}

// PromptHint is what the router needs to estimate one stream's prompt size: the conversation's key
// and the request body's length.
type PromptHint struct {
	Key       string
	BodyChars int64
}

// PromptKey is the conversation's key: a short hash of its `system` and first message, the parts of
// a request that never change from one turn to the next. Each part is its JSON (a string or a raw
// message — pass json.RawMessage for a decoded field, so the key stays byte-stable); a nil part and
// differences past the cut read the same.
func PromptKey(system, firstMessage any) string {
	sum := sha1.Sum([]byte(cutPart(system) + cutPart(firstMessage)))
	return hex.EncodeToString(sum[:])[:16]
}

// cutPart is a part's JSON cut to the key's budget; a missing part and differences past the cut
// read the same. The cut is at UTF-16 code-unit granularity, exactly JS String.slice: a surrogate
// pair the cut splits leaves one lone surrogate behind, which both sides hash as U+FFFD.
func cutPart(value any) string {
	if value == nil {
		return ""
	}
	if raw, ok := value.(json.RawMessage); ok && len(raw) == 0 {
		return ""
	}
	// A part off a decoded request body always encodes; a value the encoder refuses leaves no
	// bytes, which reads like an absent part.
	compact, _ := domain.MarshalCompactJSON(value)
	units := utf16.Encode([]rune(string(compact)))
	if len(units) > keyPartChars {
		units = units[:keyPartChars]
	}
	return string(utf16.Decode(units))
}

// utf16Len is the text's length in UTF-16 code units (a rune past the BMP is two; a byte that is
// not valid UTF-8 counts one, the U+FFFD `range` reads it as).
func utf16Len(text string) int64 {
	units := int64(0)
	for _, r := range text {
		// range never yields a surrogate or an out-of-range rune, so RuneLen is 1 or 2 here.
		units += int64(max(utf16.RuneLen(r), 1))
	}
	return units
}

// RecordPrompt remembers what a finished stream really cost, when its final usage carries a real
// prompt size — a zero or a missing input_tokens is the very lie this module exists to paper over,
// never a fact to remember.
func (e *PromptEstimator) RecordPrompt(key string, final domain.RouteUsage, bodyChars int64) {
	if final == nil {
		return
	}
	input, ok := usageNumber(final["input_tokens"])
	if !ok || input <= 0 {
		return
	}
	read, _ := usageNumber(final["cache_read_input_tokens"])
	created, _ := usageNumber(final["cache_creation_input_tokens"])
	e.mu.Lock()
	defer e.mu.Unlock()
	e.remember(key, lastTurn{promptTokens: input + read + created, bodyChars: bodyChars})
}

// EstimatePrompt is the prompt size to report for a stream of this conversation and body length:
// what its last turn cost plus the bytes added since, or a quarter token per byte for a
// conversation never seen before.
func (e *PromptEstimator) EstimatePrompt(key string, bodyChars int64) int64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	last, known := e.turns[key]
	if !known {
		return int64(math.Round(float64(bodyChars) / bytesPerToken))
	}
	e.remember(key, last)
	return int64(math.Round(last.promptTokens + math.Max(0, float64(bodyChars-last.bodyChars))/bytesPerToken))
}

// remember puts a conversation back at the newest end, dropping the oldest once the map is over
// the cap. The caller holds the lock.
func (e *PromptEstimator) remember(key string, last lastTurn) {
	if _, present := e.turns[key]; present {
		if at := slices.Index(e.order, key); at >= 0 {
			e.order = append(e.order[:at], e.order[at+1:]...)
		}
	}
	e.turns[key] = last
	e.order = append(e.order, key)
	for len(e.turns) > lruMax {
		oldest := e.order[0]
		e.order = e.order[1:]
		delete(e.turns, oldest)
	}
}

// usageNumber reads a usage counter that must be a number, whatever shape the caller decoded it
// into.
func usageNumber(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	default:
		return 0, false
	}
}
