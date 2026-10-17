package app

import (
	"bytes"
	"encoding/json"
	"strings"
)

// Facts is the summary, open items and added tests of a report of any shape; whatever is missing
// or malformed is left out.
type Facts struct {
	Summary *string
	// OpenItems and TestsAdded are never nil: absent fields read as none.
	OpenItems  []string
	TestsAdded []string
}

// ReportFacts reads the parts of a worker report every built-in contract shares; whatever is
// missing or malformed is left out, as the schema's .catch(undefined) leaves it.
func ReportFacts(report json.RawMessage) Facts {
	fields, ok := jsonObjectFields(report)
	if !ok {
		return Facts{OpenItems: []string{}, TestsAdded: []string{}}
	}
	facts := Facts{
		OpenItems:  stringList(fields["open_items"]),
		TestsAdded: stringList(fields["tests_added"]),
	}
	if raw, present := fields["summary"]; present {
		var summary string
		// A summary that is not a string (null reads as "") is caught to undefined, not fatal.
		if json.Unmarshal(raw, &summary) == nil {
			trimmed := strings.TrimSpace(summary)
			if trimmed != "" {
				facts.Summary = &trimmed
			}
		}
	}
	return facts
}

// SweepStatus is one sweep item's outcome.
type SweepStatus string

const (
	SweepStatusOK   SweepStatus = "ok"
	SweepStatusFail SweepStatus = "fail"
	SweepStatusGap  SweepStatus = "gap"
)

// SweepItem is one row of a sweep report.
type SweepItem struct {
	ID     string      `json:"id"`
	Status SweepStatus `json:"status"`
	Detail string      `json:"detail"`
}

// SweepItems reads the sweep items of a report of any shape; false when it has none (it is not a
// sweep report), as the items field's .catch(undefined) reads it.
func SweepItems(report json.RawMessage) ([]SweepItem, bool) {
	fields, ok := jsonObjectFields(report)
	if !ok {
		return nil, false
	}
	raw, present := fields["items"]
	if !present || isJSONNull(raw) {
		return nil, false
	}
	var rows []json.RawMessage
	if json.Unmarshal(raw, &rows) != nil {
		return nil, false
	}
	items := make([]SweepItem, 0, len(rows))
	for _, row := range rows {
		var item struct {
			ID     *string `json:"id"`
			Status *string `json:"status"`
			Detail *string `json:"detail"`
		}
		// One malformed row catches the whole field to undefined, as zod's catch does.
		if json.Unmarshal(row, &item) != nil || item.ID == nil || item.Status == nil || item.Detail == nil {
			return nil, false
		}
		var status SweepStatus
		switch *item.Status {
		case "ok":
			status = SweepStatusOK
		case "fail":
			status = SweepStatusFail
		case "gap":
			status = SweepStatusGap
		default:
			return nil, false
		}
		items = append(items, SweepItem{ID: *item.ID, Status: status, Detail: *item.Detail})
	}
	return items, true
}

// jsonObjectFields decodes raw JSON as an object (zod's z.record): its fields as raw JSON, or false
// when the value is not one (bad JSON, an array, a string, a number or null).
func jsonObjectFields(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	// JSON null unmarshals into a nil map without an error, so it is told apart here.
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, false
	}
	return fields, true
}

// stringList is a z.array(z.string()) read from raw JSON: absent, null or malformed reads as none.
func stringList(raw json.RawMessage) []string {
	if len(raw) == 0 || isJSONNull(raw) {
		return []string{}
	}
	var items []string
	if json.Unmarshal(raw, &items) != nil || items == nil {
		return []string{}
	}
	return items
}

// isJSONNull reports whether raw JSON holds a null.
func isJSONNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}
