// How a worker that cannot enforce a JSON schema itself (omp, pi, opencode, zcode) still returns a checked report: the
// contract goes into the prompt in words, the report is read out of the final message, and a report that does not
// parse or does not check is sent back for correction a bounded number of times. Claude Code enforces the schema
// natively and needs none of this.
package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode"
)

// MaxReportCorrections is how many more turns a report that fails its check gets; the session is kept, so each fix
// lands in context.
const MaxReportCorrections = 2

// jsSpace is exactly what ECMAScript's \s matches. Go's \s is narrower (no \v, \p{Zs}, U+2028, U+2029 or U+FEFF), and
// the report prompts and parsers must keep matching JavaScript's, which the workers' text follows.
const jsSpace = `[\s\v\p{Zs}\x{2028}\x{2029}\x{feff}]`

// isJsSpace reports whether the rune is ECMAScript whitespace, the rune form of jsSpace.
func isJsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u2028', '\u2029', '\ufeff':
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

// ReportInstructions is the prompt with the report contract appended in words. The schema rides as raw JSON bytes:
// re-indenting them keeps the key order the schema was written in, which a decoded map would lose.
func ReportInstructions(prompt string, jsonSchema json.RawMessage) string {
	return strings.Join([]string{
		prompt,
		"",
		"## Final report",
		"",
		"Work unattended. Make reasonable task decisions within the brief; record blockers in the final report instead of asking for input.",
		"Your final message must contain only the report as one JSON object, and nothing else.",
		"The report must satisfy this JSON schema:",
		"",
		"```json",
		jsonTwoSpace(jsonSchema),
		"```",
	}, "\n")
}

// jsonTwoSpace renders raw JSON as JavaScript's JSON.stringify(v, null, 2): two-space indent, the bytes' own escaping
// (raw JSON never escapes `<`, `>` and `&`), and the bytes' own key order.
func jsonTwoSpace(value json.RawMessage) string {
	if len(value) == 0 {
		// JSON.stringify(undefined) is undefined, which the join renders as an empty line.
		return ""
	}
	var buf bytes.Buffer
	if err := json.Indent(&buf, value, "", "  "); err != nil {
		// JSON.stringify throws only on values no JSON schema can hold.
		panic(err)
	}
	return buf.String()
}

var reportFence = regexp.MustCompile("```[a-z]*" + jsSpace + `*([\s\S]*?)` + jsSpace + "*```")

var reportBraces = regexp.MustCompile(`\{[\s\S]*\}`)

// ExtractReport is the JSON object the final message carries: the whole text, a fenced block, or the outermost braces;
// nil when none of those is an object (an array or a scalar does not count). The object rides as raw
// JSON bytes, compacted the way JSON.stringify writes the parsed object: the key order the worker
// wrote survives, where a decoded map would re-render it sorted.
func ExtractReport(text string) json.RawMessage {
	if direct := reportAsRawObject(text); direct != nil {
		return direct
	}
	fenced := ""
	if match := reportFence.FindStringSubmatch(text); match != nil {
		fenced = match[1]
	}
	if inFence := reportAsRawObject(fenced); inFence != nil {
		return inFence
	}
	if braces := reportBraces.FindString(text); braces != "" {
		if object := reportAsRawObject(braces); object != nil {
			return object
		}
	}
	return nil
}

// CorrectionPrompt is the turn that asks for a corrected report.
func CorrectionPrompt(problems []string) string {
	return fmt.Sprintf(
		"Your report was invalid: %s. Reply with only the corrected JSON object.",
		strings.Join(problems, "; "),
	)
}

// reportAsRawObject is candidate as compact raw JSON when the whole of it parses as a JSON object; nil
// for anything else. Compaction drops the whitespace JSON.stringify drops and keeps the bytes'
// own key order.
func reportAsRawObject(candidate string) json.RawMessage {
	var value any
	if err := json.Unmarshal([]byte(candidate), &value); err != nil {
		return nil
	}
	if _, ok := value.(map[string]any); !ok {
		return nil
	}
	var buf bytes.Buffer
	// The candidate just parsed as JSON, so compaction cannot fail.
	_ = json.Compact(&buf, []byte(candidate))
	return buf.Bytes()
}
