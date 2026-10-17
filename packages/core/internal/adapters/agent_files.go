// An agent file's `model:` line: what setup rewrites so `/model`-less dispatch picks the provider's
// model, and what remove and the router's uninstall cleanup put back. Atomic writes: a hook killed
// mid-write never leaves a truncated agent file.
package adapters

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
)

// modelLine matches the `model:` line's text: the class stops at every line terminator (\n,
// \r, U+2028, U+2029 alike), so a CRLF file's \r stays out of the match and survives a rewrite.
var modelLine = regexp.MustCompile(`(?m)^model:[^\n\r\x{2028}\x{2029}]*`)

// modelLineValue is the same line with its value captured, only spaces and tabs padding the
// colon.
var modelLineValue = regexp.MustCompile(`(?m)^model:[ \t]*([^\n\r\x{2028}\x{2029}]*)`)

// modelLineWhole is the whole line a removal takes out, CRLF and all.
var modelLineWhole = regexp.MustCompile(`(?m)^model:[^\n\r\x{2028}\x{2029}]*\r?\n`)

// ReadModelLine is the file's first `model:` value: found says the file carries such a line, read
// says the file could be read at all.
func ReadModelLine(file string) (model string, found, read bool) {
	data, err := os.ReadFile(file)
	if err != nil {
		return "", false, false
	}
	match := modelLineValue.FindStringSubmatch(string(data))
	if match == nil {
		return "", false, true
	}
	return strings.TrimSpace(match[1]), true, true
}

// WriteModelLine sets the first `model:` line to model, or takes it out for nil; the bool says
// whether the file changed. A file with no `model:` line gets none added: the frontmatter is the
// plugin's, only that one line is setup's.
func WriteModelLine(ctx context.Context, file string, model *string) (bool, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return false, fmt.Errorf("%s: not found", file)
	}
	text := string(data)
	if !modelLine.MatchString(text) {
		if model == nil {
			return false, nil
		}
		return false, fmt.Errorf("%s: no model: line", file)
	}
	var next string
	if model == nil {
		next = removeFirst(text, modelLineWhole)
	} else {
		next = replaceFirst(text, modelLine, "model: "+*model)
	}
	if next == text {
		return false, nil
	}
	if _, err := fsutil.WriteFileAtomic(ctx, file, []byte(next), fsutil.WriteOptions{Mode: fsutil.Preserve}); err != nil {
		return false, err
	}
	return true, nil
}

// replaceFirst splices replacement over the pattern's first match, as a JS replace without /g.
func replaceFirst(text string, pattern *regexp.Regexp, replacement string) string {
	location := pattern.FindStringIndex(text)
	if location == nil {
		return text
	}
	return text[:location[0]] + replacement + text[location[1]:]
}

func removeFirst(text string, pattern *regexp.Regexp) string {
	return replaceFirst(text, pattern, "")
}
