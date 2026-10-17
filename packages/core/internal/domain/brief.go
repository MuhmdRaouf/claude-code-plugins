package domain

import (
	"bytes"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// Mode is what a brief's job may do to the repository.
type Mode string

const (
	ModeEdit     Mode = "edit"
	ModeExec     Mode = "exec"
	ModeReadonly Mode = "readonly"
)

// BuiltinReport is a report contract the plugin knows without a schema file.
type BuiltinReport string

const (
	BuiltinReportChange BuiltinReport = "change"
	BuiltinReportSweep  BuiltinReport = "sweep"
	BuiltinReportNotes  BuiltinReport = "notes"
)

// Priority is where a job waits among other jobs competing for the same worker slots.
type Priority string

const (
	PriorityHigh   Priority = "high"
	PriorityNormal Priority = "normal"
)

// Gate is a shell command the plugin runs after the worker, with its own deadline.
type Gate struct {
	Run string `json:"run"`
	// Milliseconds; default 10 minutes.
	TimeoutMs int64 `json:"timeoutMs"`
}

// regenerateRule is a generated file the plugin recreates instead of merging as text when
// landing.
type regenerateRule struct {
	// Globs (picomatch, dotfiles included) naming the files Run recreates.
	Paths []string `json:"paths"`
	Run   string   `json:"run"`
}

// ReportKind says whether a brief's report contract is a builtin or a JSON schema file.
type ReportKind string

const (
	ReportKindBuiltin ReportKind = "builtin"
	ReportKindFile    ReportKind = "file"
)

// Report is a brief's report contract: a builtin name or a path to a .json schema.
type Report struct {
	Kind ReportKind    `json:"kind"`
	Name BuiltinReport `json:"name,omitempty"`
	Path string        `json:"path,omitempty"`
}

// Retries is a brief's retry counts.
type Retries struct {
	// Auto-fix rounds after a failed verdict.
	Fix int64 `json:"fix"`
	// Re-runs after infrastructure errors.
	Infra int64 `json:"infra"`
}

// Brief is a parsed brief document with its defaults applied.
type Brief struct {
	Title string    `json:"title"`
	Body  string    `json:"body"`
	Model ModelTier `json:"model"`
	// One of the worker's efforts.
	Effort *string `json:"effort,omitempty"`
	Mode   Mode    `json:"mode"`
	// Slot-queue priority; unset means the submitting command's default (high for run, normal
	// for batch).
	Priority *Priority `json:"priority,omitempty"`
	// Absolute repository path (resolved by the caller from `cwd` or the current git root).
	Cwd    string   `json:"cwd"`
	Base   string   `json:"base"`
	Scope  []string `json:"scope"`
	Forbid []string `json:"forbid"`
	Gates  []Gate   `json:"gates"`
	// Commands run in order before the gates in every checkout the plugin verifies in (e.g.
	// `npm ci`).
	Setup *[]string `json:"setup,omitempty"`
	// Generated files the plugin recreates (by running Run) instead of merging as text when
	// landing.
	Regenerate *[]regenerateRule `json:"regenerate,omitempty"`
	TimeoutMs  int64             `json:"timeoutMs"`
	Retries    Retries           `json:"retries"`
	Report     Report            `json:"report"`
	AddDirs    []string          `json:"addDirs"`
	// Names only. Values are read from the orchestrator's environment at run time and never
	// persisted.
	Env       []string `json:"env"`
	BudgetUSD *float64 `json:"budgetUsd,omitempty"`
	Tags      []string `json:"tags"`
	// The delegation engine the job runs on; absent means claude (headless Claude Code).
	Engine *EngineTool `json:"engine,omitempty"`
	// priorityAppended says the priority was defaulted at submission: a defaulted priority sits
	// after every field the brief carried, while a priority the brief carried keeps its schema
	// place; MarshalJSON writes both that way. Never serialized.
	priorityAppended bool
}

// DefaultPriorityTo gives the brief the submitting command's default priority, filed at the end:
// after every field the brief itself carried.
func (b *Brief) DefaultPriorityTo(priority Priority) {
	b.Priority = &priority
	b.priorityAppended = true
}

// MarshalJSON keeps job.json's key order: a priority the brief carried sits at its schema place,
// one the submitter defaulted comes last.
func (b Brief) MarshalJSON() ([]byte, error) {
	type briefFields Brief
	if !b.priorityAppended {
		return MarshalCompactJSON(briefFields(b))
	}
	without := b
	without.Priority = nil
	head, err := MarshalCompactJSON(briefFields(without))
	if err != nil || b.Priority == nil {
		return head, err
	}
	value, err := MarshalCompactJSON(*b.Priority)
	if err != nil {
		return nil, err
	}
	// The marshaler ends its output with the newline the state files carry; the splice is inside
	// one object, so both newline tails come off.
	value = bytes.TrimSuffix(value, []byte("\n"))
	spliced := make([]byte, 0, len(head)+len(value)+14)
	spliced = append(spliced, head[:len(head)-1]...)
	spliced = append(spliced, `,"priority":`...)
	spliced = append(spliced, value...)
	return append(spliced, '}'), nil
}

// IsSweepBrief says whether a brief reports in sweep items (ok/fail/gap), whose counts the
// compact output shows instead of gates.
func IsSweepBrief(brief Brief) bool {
	return brief.Report.Kind == ReportKindBuiltin && brief.Report.Name == BuiltinReportSweep
}

// BriefNotes is how the worker takes effort, addDirs, budgetUsd and readonly work, as the
// template explains each.
type BriefNotes struct {
	Effort    string `json:"effort"`
	AddDirs   string `json:"addDirs"`
	BudgetUSD string `json:"budgetUsd"`
	Readonly  string `json:"readonly"`
}

// WorkerTerms is what a worker accepts from a brief; its capabilities carry these, and brief
// parsing and the template read them.
type WorkerTerms struct {
	// The `effort` values, lowest first.
	Efforts []string `json:"efforts"`
	// BudgetUSD is honoured; a brief that sets it is refused otherwise.
	Budget bool `json:"budget"`
	// How the worker takes effort, addDirs, budgetUsd and readonly work.
	BriefNotes BriefNotes `json:"briefNotes"`
}

// BriefContext is everything brief parsing needs from the caller.
type BriefContext struct {
	// Absolute path used when the front matter has no `cwd`, and to resolve a relative one.
	DefaultCwd string `json:"defaultCwd"`
	// The tiers a brief may name (by tier name or model id) and the one it gets by default.
	Provider Provider    `json:"provider"`
	Worker   WorkerTerms `json:"worker"`
}

// BriefErrorKind is which of the four ways a brief document can fail.
type BriefErrorKind string

const (
	BriefErrorNoFrontMatter BriefErrorKind = "no_front_matter"
	BriefErrorYaml          BriefErrorKind = "yaml"
	BriefErrorField         BriefErrorKind = "field"
	BriefErrorEmptyBody     BriefErrorKind = "empty_body"
)

// BriefError is one way a brief document failed. A yaml error carries only Message; a field
// error carries Field and Message.
type BriefError struct {
	Kind BriefErrorKind `json:"kind"`
	// Yaml: the parser message.
	Message string `json:"message,omitempty"`
	// Field: the dotted path into the front matter.
	Field string `json:"field,omitempty"`
}

func (e BriefError) Error() string { return string(e.Kind) }

// ParseBrief parses a brief document (YAML front matter + markdown body) and applies
// mode-dependent defaults. A non-nil error list is the failure; every field error is reported at
// once, not just the first.
func ParseBrief(text string, ctx BriefContext) (Brief, []BriefError) {
	document, ok := SplitFrontMatter(text)
	if !ok {
		return Brief{}, []BriefError{{Kind: BriefErrorNoFrontMatter}}
	}
	data, yamlMessages := parseYamlFrontMatter(document.FrontMatter)
	if len(yamlMessages) > 0 {
		yamlErrors := make([]BriefError, 0, len(yamlMessages))
		for _, message := range yamlMessages {
			yamlErrors = append(yamlErrors, BriefError{Kind: BriefErrorYaml, Message: message})
		}
		return Brief{}, yamlErrors
	}
	if data == nil {
		data = yamlMap{values: map[string]any{}}
	}
	fields, fieldErrors := ParseFrontMatter(data, ctx)
	errors := fieldErrors
	if strings.TrimSpace(document.Body) == "" {
		errors = append(errors, BriefError{Kind: BriefErrorEmptyBody})
	}
	if len(errors) > 0 {
		return Brief{}, errors
	}
	return WithDefaults(fields, document.Body, ctx), nil
}

// BriefTemplate is a front-matter template for `brief new`, with every field documented as a
// comment.
func BriefTemplate(title string, mode Mode, provider Provider, worker WorkerTerms) string {
	return RenderBriefTemplate(title, mode, provider, worker)
}

// ── the yaml front matter, read under the YAML 1.2 core schema ────────────────────────────────

// yamlMap is a YAML mapping that keeps the document's key order, which the unknown-field errors
// and zod's issue order depend on.
type yamlMap struct {
	keys   []string
	values map[string]any
}

func (m yamlMap) get(key string) (any, bool) {
	value, ok := m.values[key]
	return value, ok
}

// parseYamlFrontMatter parses the front matter block and converts it to plain values under the
// YAML 1.2 core schema: `yes` and `on` are strings, dates are strings, ints with `_` or a `0b`
// prefix are strings. Go-yaml's own messages differ from the wording the brief errors pin, so
// parse errors are translated to those texts and duplicate keys (which go-yaml only rejects when
// decoding into maps) are detected here.
func parseYamlFrontMatter(source string) (any, []string) {
	var document yaml.Node
	if err := yaml.Unmarshal([]byte(source), &document); err != nil {
		return nil, translateYamlError(err.Error(), source)
	}
	if document.Kind != yaml.DocumentNode || len(document.Content) == 0 {
		return nil, nil
	}
	root := document.Content[0]
	var messages []string
	findDuplicateKeys(root, source, &messages)
	return nodeToValue(root), messages
}

// findDuplicateKeys reports every mapping key that already appeared in the same mapping, comparing
// scalar values whatever their tags.
func findDuplicateKeys(node *yaml.Node, source string, messages *[]string) {
	if node.Kind == yaml.AliasNode {
		findDuplicateKeys(node.Alias, source, messages)
		return
	}
	if node.Kind != yaml.MappingNode {
		for _, child := range node.Content {
			findDuplicateKeys(child, source, messages)
		}
		return
	}
	seen := make(map[string]bool, len(node.Content)/2)
	for i := 0; i+1 < len(node.Content); i += 2 {
		key := node.Content[i]
		if key.Kind == yaml.ScalarNode {
			if seen[key.Value] {
				*messages = append(*messages,
					prettifyYamlError(source, "Map keys must be unique", key.Line, key.Column))
			} else {
				seen[key.Value] = true
			}
		}
		findDuplicateKeys(node.Content[i+1], source, messages)
	}
}

// nodeToValue converts a yaml node to the plain value the front-matter schema reads.
func nodeToValue(node *yaml.Node) any {
	switch node.Kind {
	case yaml.AliasNode:
		return nodeToValue(node.Alias)
	case yaml.MappingNode:
		mapping := yamlMap{values: make(map[string]any, len(node.Content)/2)}
		for i := 0; i+1 < len(node.Content); i += 2 {
			key := jsKeyName(node.Content[i])
			if _, exists := mapping.values[key]; !exists {
				mapping.keys = append(mapping.keys, key)
			}
			mapping.values[key] = nodeToValue(node.Content[i+1])
		}
		return mapping
	case yaml.SequenceNode:
		items := make([]any, 0, len(node.Content))
		for _, item := range node.Content {
			items = append(items, nodeToValue(item))
		}
		return items
	default:
		return scalarValue(node)
	}
}

// jsKeyName is the string a plain JS object uses for the key: scalars render as JS String()
// would, so `1`, `true` and `null` keys become "1", "true" and "null".
func jsKeyName(key *yaml.Node) string {
	switch typed := nodeToValue(key).(type) {
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case nil:
		return "null"
	case int64:
		return strconv.FormatInt(typed, 10)
	case float64:
		return formatDurationNumber(typed)
	default:
		return key.Value
	}
}

// scalarValue resolves a scalar node the way the YAML 1.2 core schema does.
func scalarValue(node *yaml.Node) any {
	switch node.Tag {
	case "!!null":
		return nil
	case "!!bool":
		return strings.EqualFold(node.Value, "true")
	case "!!int":
		return parseIntScalar(node.Value)
	case "!!float":
		return parseFloatScalar(node.Value)
	default:
		// !!str, !!timestamp (the core schema has no timestamps) and anything else a brief
		// writer can type: the raw string.
		return node.Value
	}
}

func parseIntScalar(text string) any {
	// The core schema has no underscore separators and no binary prefix; go-yaml resolves both
	// to !!int, so they are kept as the strings they are.
	if strings.Contains(text, "_") || strings.HasPrefix(text, "0b") || strings.HasPrefix(text, "0B") {
		return text
	}
	base := 10
	if strings.HasPrefix(text, "0x") || strings.HasPrefix(text, "0X") ||
		strings.HasPrefix(text, "0o") || strings.HasPrefix(text, "0O") {
		base = 0
	}
	if value, err := strconv.ParseInt(text, base, 64); err == nil {
		return value
	}
	// An int too large for int64 is still a JS number.
	if value, err := strconv.ParseFloat(text, 64); err == nil {
		return value
	}
	return text
}

func parseFloatScalar(text string) any {
	switch strings.ToLower(text) {
	case ".inf", "+.inf":
		return math.Inf(1)
	case "-.inf":
		return math.Inf(-1)
	case ".nan":
		return math.NaN()
	}
	if strings.Contains(text, "_") {
		return text
	}
	if value, err := strconv.ParseFloat(text, 64); err == nil {
		return value
	}
	return text
}

// jsTypeName is the type name zod's messages quote for a converted value.
func jsTypeName(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case int64, float64:
		return "number"
	case bool:
		return "boolean"
	case yamlMap:
		return "object"
	case []any:
		return "array"
	default:
		return "undefined"
	}
}

// ── go-yaml error messages mapped to the brief errors' pinned texts ───────────────────────────

var yamlErrorLine = regexp.MustCompile(`^yaml: (?:line (\d+): )?(.*)$`)

func translateYamlError(message, source string) []string {
	match := yamlErrorLine.FindStringSubmatch(message)
	if match == nil {
		return []string{message}
	}
	line := 0
	if match[1] != "" {
		line, _ = strconv.Atoi(match[1])
	}
	switch match[2] {
	case "did not find expected ',' or ']'":
		if found := flowDedentErrors(source,
			"Flow sequence in block collection must be sufficiently indented and end with a ]"); len(found) > 0 {
			return found
		}
	case "did not find expected ',' or '}'":
		if found := flowDedentErrors(source,
			"Flow map in block collection must be sufficiently indented and end with a }"); len(found) > 0 {
			return found
		}
	case "mapping values are not allowed in this context":
		// The pinned texts blame the value of the line above the colon go-yaml blames, twice:
		// once for the compact mapping, once for its implicit key.
		if line >= 2 {
			atLine, atColumn := line-1, valueColumn(source, line-1)
			return []string{
				prettifyYamlError(source, "Nested mappings are not allowed in compact mappings", atLine, atColumn),
				prettifyYamlError(source, "Implicit keys need to be on a single line", atLine, atColumn),
			}
		}
		return []string{prettifyYamlError(source, "Nested mappings are not allowed in compact mappings",
			1, valueColumn(source, 1))}
	case "found a tab character that violates indentation":
		return []string{prettifyYamlError(source, "Tabs are not allowed as indentation", line, 1)}
	}
	// Any other go-yaml message has no mapped text here; the raw text stands.
	return []string{message}
}

// flowDedentErrors finds where an unclosed flow collection meets a block-level key (a line
// starting at column 1) or the end of input, the position the error text names; go-yaml only
// says which flow never closed.
func flowDedentErrors(source, message string) []string {
	depth := 0
	lineNo := 1
	lineStart := 0
	var quote byte
	for i := 0; i < len(source); i++ {
		ch := source[i]
		if quote != 0 {
			if quote == '"' && ch == '\\' {
				i++
			} else if ch == quote {
				if quote == '\'' && i+1 < len(source) && source[i+1] == '\'' {
					i++
				} else {
					quote = 0
				}
			} else if ch == '\n' {
				lineNo++
				lineStart = i + 1
			}
			continue
		}
		switch {
		case ch == '\'' || ch == '"':
			quote = ch
		case ch == '\n':
			lineNo++
			lineStart = i + 1
		case ch == '[' || ch == '{':
			depth++
		case ch == ']' || ch == '}':
			if depth > 0 {
				depth--
			}
		case (ch == ' ' || ch == '\t' || ch == '\r') && i > lineStart:
			// spacing inside the line
		case ch == '#' && i == lineStart:
			// a whole-line comment
		case i == lineStart && depth > 0:
			// a block-level key while a flow collection is still open
			messages := make([]string, depth)
			for j := range messages {
				messages[j] = prettifyYamlError(source, message, lineNo, 1)
			}
			return messages
		}
	}
	if depth == 0 {
		return nil
	}
	messages := make([]string, depth)
	column := len(source) - lineStart + 1
	for j := range messages {
		messages[j] = prettifyYamlError(source, message, lineNo, column)
	}
	return messages
}

// valueColumn is the column the value of a `key: value` line starts at, 1-based.
func valueColumn(source string, lineNo int) int {
	lines := strings.Split(source, "\n")
	if lineNo < 1 || lineNo > len(lines) {
		return 1
	}
	line := lines[lineNo-1]
	index := strings.Index(line, ": ")
	if index < 0 {
		return 1
	}
	value := index + 2
	for value < len(line) && (line[value] == ' ' || line[value] == '\t') {
		value++
	}
	return value + 1
}

// prettifyYamlError renders a parser message: position, the offending line (trimmed to 80
// columns, the previous line when the caret points into indentation) and a caret under the
// column. Every length and slice counts UTF-16 code units, as JavaScript measures strings.
func prettifyYamlError(source, message string, line, column int) string {
	header := fmt.Sprintf("%s at line %d, column %d", message, line, column)
	starts := lineStartsOf(source)
	lineStr := ""
	if line >= 1 && line <= len(starts) {
		end := len(source)
		if line < len(starts) {
			end = starts[line]
		}
		lineStr = strings.TrimRight(source[starts[line-1]:end], "\r\n")
	}
	ci := column - 1
	width := utf16Len(lineStr)
	if ci > width {
		ci = width
	}
	if ci >= 60 && width > 80 {
		trimStart := ci - 39
		if excess := width - 79; excess < trimStart {
			trimStart = excess
		}
		if trimStart < 0 {
			trimStart = 0
		}
		lineStr = "…" + utf16Slice(lineStr, trimStart, width)
		ci -= trimStart - 1
	}
	if utf16Len(lineStr) > 80 {
		lineStr = utf16Slice(lineStr, 0, 79) + "…"
	}
	if line > 1 && strings.Trim(utf16Slice(lineStr, 0, ci), " ") == "" {
		prev := ""
		if line >= 2 && line-1 <= len(starts) {
			prevEnd := len(source)
			if line-1 < len(starts) {
				prevEnd = starts[line-1]
			}
			prev = source[starts[line-2]:prevEnd]
			if utf16Len(prev) > 80 {
				prev = utf16Slice(prev, 0, 79) + "…\n"
			}
		}
		lineStr = prev + lineStr
	}
	if !hasNonSpace(lineStr) {
		return header
	}
	return header + ":\n\n" + lineStr + "\n" + strings.Repeat(" ", ci) + "^\n"
}

// utf16Len is a string's length in UTF-16 code units, the unit JS string lengths count.
func utf16Len(text string) int {
	units := 0
	for _, r := range text {
		if r > 0xFFFF {
			units += 2
		} else {
			units++
		}
	}
	return units
}

// utf16Slice slices text by UTF-16 code units, the way JS String.prototype.substring does.
func utf16Slice(text string, start, end int) string {
	if start < 0 {
		start = 0
	}
	if end > utf16Len(text) {
		end = utf16Len(text)
	}
	var out strings.Builder
	units := 0
	for _, r := range text {
		size := 1
		if r > 0xFFFF {
			size = 2
		}
		if units >= start && units+size <= end {
			out.WriteRune(r)
		}
		units += size
	}
	return out.String()
}

func hasNonSpace(text string) bool {
	for _, ch := range text {
		if ch != ' ' {
			return true
		}
	}
	return false
}

func lineStartsOf(source string) []int {
	starts := []int{0}
	for i := 0; i < len(source); i++ {
		if source[i] == '\n' {
			starts = append(starts, i+1)
		}
	}
	return starts
}
