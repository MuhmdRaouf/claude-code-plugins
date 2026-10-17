package domain

import "encoding/json"

// ParseJSON decodes text as JSON; numbers decode to float64, as JavaScript's numbers are doubles.
// Any schema check happens by the caller decoding into a concrete type.
func ParseJSON(text string) (any, error) {
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		return nil, err
	}
	return value, nil
}
