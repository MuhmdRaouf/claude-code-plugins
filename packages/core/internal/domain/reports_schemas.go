package domain

import (
	"encoding/json"
	"slices"
	"strconv"
	"strings"
)

// BuiltinReports is the single definition of each built-in report, as the JSON Schema the
// worker's `--json-schema` takes: the exact bytes JSON.stringify(z.toJSONSchema(...,
// { target: "draft-7" })) produces, key order included, because ReportInstructions re-indents the
// raw JSON without reordering it. Strict at every level, so validation rejects exactly what the
// schema's `additionalProperties: false` forbids.
var BuiltinReports = map[BuiltinReport]json.RawMessage{
	BuiltinReportChange: json.RawMessage(`{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"summary":{"type":"string"},"files":{"type":"array","items":{"type":"object","properties":{"path":{"type":"string"},"why":{"type":"string"}},"required":["path","why"],"additionalProperties":false}},"root_cause":{"type":"string"},"tests_added":{"type":"array","items":{"type":"string"}},"open_items":{"type":"array","items":{"type":"string"}}},"required":["summary","files","tests_added","open_items"],"additionalProperties":false}`),
	BuiltinReportSweep:  json.RawMessage(`{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"summary":{"type":"string"},"items":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"status":{"type":"string","enum":["ok","fail","gap"]},"detail":{"type":"string"}},"required":["id","status","detail"],"additionalProperties":false}},"open_items":{"type":"array","items":{"type":"string"}}},"required":["summary","items","open_items"],"additionalProperties":false}`),
	BuiltinReportNotes:  json.RawMessage(`{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","properties":{"summary":{"type":"string"},"findings":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"detail":{"type":"string"},"refs":{"type":"array","items":{"type":"string"}}},"required":["title","detail","refs"],"additionalProperties":false}},"open_items":{"type":"array","items":{"type":"string"}}},"required":["summary","findings","open_items"],"additionalProperties":false}`),
}

// reportNodeKind is one shape a report contract node can take.
type reportNodeKind string

const (
	reportObject reportNodeKind = "object"
	reportArray  reportNodeKind = "array"
	reportString reportNodeKind = "string"
	reportEnum   reportNodeKind = "enum"
)

// reportProp is one property of an object node, in the zod schema's declaration order (issues are
// reported in it).
type reportProp struct {
	name     string
	node     *reportNode
	required bool
}

// reportNode is one node of a built-in report contract, mirroring the schema it validates with.
type reportNode struct {
	kind   reportNodeKind
	props  []reportProp // object
	items  *reportNode  // array
	values []string     // enum
}

// stringsNode is z.array(z.string()).
func stringsNode() *reportNode {
	return &reportNode{kind: reportArray, items: &reportNode{kind: reportString}}
}

var changeReport = &reportNode{kind: reportObject, props: []reportProp{
	{name: "summary", node: &reportNode{kind: reportString}, required: true},
	{name: "files", node: &reportNode{kind: reportArray, items: &reportNode{kind: reportObject, props: []reportProp{
		{name: "path", node: &reportNode{kind: reportString}, required: true},
		{name: "why", node: &reportNode{kind: reportString}, required: true},
	}}}, required: true},
	{name: "root_cause", node: &reportNode{kind: reportString}},
	{name: "tests_added", node: stringsNode(), required: true},
	{name: "open_items", node: stringsNode(), required: true},
}}

var sweepReport = &reportNode{kind: reportObject, props: []reportProp{
	{name: "summary", node: &reportNode{kind: reportString}, required: true},
	{name: "items", node: &reportNode{kind: reportArray, items: &reportNode{kind: reportObject, props: []reportProp{
		{name: "id", node: &reportNode{kind: reportString}, required: true},
		{name: "status", node: &reportNode{kind: reportEnum, values: []string{"ok", "fail", "gap"}}, required: true},
		{name: "detail", node: &reportNode{kind: reportString}, required: true},
	}}}, required: true},
	{name: "open_items", node: stringsNode(), required: true},
}}

var notesReport = &reportNode{kind: reportObject, props: []reportProp{
	{name: "summary", node: &reportNode{kind: reportString}, required: true},
	{name: "findings", node: &reportNode{kind: reportArray, items: &reportNode{kind: reportObject, props: []reportProp{
		{name: "title", node: &reportNode{kind: reportString}, required: true},
		{name: "detail", node: &reportNode{kind: reportString}, required: true},
		{name: "refs", node: stringsNode(), required: true},
	}}}, required: true},
	{name: "open_items", node: stringsNode(), required: true},
}}

// builtinValidators is the schema each builtin report validates against.
var builtinValidators = map[BuiltinReport]*reportNode{
	BuiltinReportChange: changeReport,
	BuiltinReportSweep:  sweepReport,
	BuiltinReportNotes:  notesReport,
}

// validateReport walks a value against a contract node the way zod does: issues in the schema's
// declaration order, then one issue for the object's unrecognized keys.
func validateReport(node *reportNode, value any, path string, problems *[]string) {
	switch node.kind {
	case reportObject:
		object, ok := value.(jsonObject)
		if !ok {
			*problems = append(*problems, reportIssue(path, "Invalid input: expected object, received "+jsonTypeName(value)))
			return
		}
		for _, prop := range node.props {
			item, present := object.values[prop.name]
			if !present {
				if prop.required {
					*problems = append(*problems, missingKeyIssue(prop.node, joinPath(path, prop.name)))
				}
				continue
			}
			validateReport(prop.node, item, joinPath(path, prop.name), problems)
		}
		unknown := make([]string, 0)
		for _, key := range object.keys {
			if !node.hasProp(key) {
				unknown = append(unknown, key)
			}
		}
		if len(unknown) > 0 {
			*problems = append(*problems, reportIssue(path, unrecognizedKeysIssue(unknown)))
		}
	case reportArray:
		array, ok := value.([]any)
		if !ok {
			*problems = append(*problems, reportIssue(path, "Invalid input: expected array, received "+jsonTypeName(value)))
			return
		}
		for i, item := range array {
			validateReport(node.items, item, joinPath(path, strconv.Itoa(i)), problems)
		}
	case reportString:
		if _, ok := value.(string); !ok {
			*problems = append(*problems, reportIssue(path, "Invalid input: expected string, received "+jsonTypeName(value)))
		}
	case reportEnum:
		text, ok := value.(string)
		if !ok || !slices.Contains(node.values, text) {
			*problems = append(*problems, reportIssue(path, enumIssue(node.values)))
		}
	}
}

// hasProp reports whether the object node declares the property.
func (node *reportNode) hasProp(name string) bool {
	for _, prop := range node.props {
		if prop.name == name {
			return true
		}
	}
	return false
}

// joinPath extends a property path the way zod renders issue paths: dotted, with array indexes.
func joinPath(path, segment string) string {
	if path == "" {
		return segment
	}
	return path + "." + segment
}

// reportIssue renders one problem as "path: message", "(root)" at the top level.
func reportIssue(path, message string) string {
	if path == "" {
		return "(root): " + message
	}
	return path + ": " + message
}

// missingKeyIssue is the problem a required property's absence reports: the property's own type
// expectation, "received undefined" (an absent enum reports its options, as zod does).
func missingKeyIssue(node *reportNode, path string) string {
	if node.kind == reportEnum {
		return reportIssue(path, enumIssue(node.values))
	}
	return reportIssue(path, "Invalid input: expected "+node.kind.jsonTypeName()+", received undefined")
}

// unrecognizedKeysIssue is the problem an object's unrecognized keys report: one key named, or the
// list when there are several.
func unrecognizedKeysIssue(keys []string) string {
	quoted := make([]string, len(keys))
	for i, key := range keys {
		quoted[i] = strconv.Quote(key)
	}
	if len(keys) == 1 {
		return "Unrecognized key: " + quoted[0]
	}
	return "Unrecognized keys: " + strings.Join(quoted, ", ")
}

// enumIssue is the problem a value outside an enum's options reports.
func enumIssue(values []string) string {
	quoted := make([]string, len(values))
	for i, value := range values {
		quoted[i] = strconv.Quote(value)
	}
	return `Invalid option: expected one of ` + strings.Join(quoted, "|")
}

// jsonTypeName is the JSON type name of a schema node, for the messages a missing key reports.
func (kind reportNodeKind) jsonTypeName() string {
	if kind == reportArray {
		return "array"
	}
	return string(kind)
}

// jsonTypeName is the JS type name of a decoded JSON value, the name zod's messages quote.
func jsonTypeName(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case json.Number:
		return "number"
	case bool:
		return "boolean"
	case []any:
		return "array"
	case jsonObject:
		return "object"
	default:
		return "undefined"
	}
}
