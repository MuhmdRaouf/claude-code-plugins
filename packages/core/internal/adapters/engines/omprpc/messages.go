// The omp RPC frames the client itself acts on (shapes from omp 18.6.1, see
// testdata/engines/omp-rpc). Everything else passes through as an opaque Frame for the event fold.
package omprpc

import "encoding/json"

// ReadyFrame is omp's first frame.
type ReadyFrame struct {
	ProtocolVersion           float64   `json:"protocolVersion"`
	SupportedProtocolVersions []float64 `json:"supportedProtocolVersions"`
	// MaxFrameBytes is the longest single line omp writes; longer frames arrive as rpc_chunk runs.
	MaxFrameBytes *float64 `json:"maxFrameBytes,omitempty"`
}

// RpcResponse is `{id, type:"response", command, success, data | error}`.
type RpcResponse struct {
	ID      *string
	Command string
	Success bool
	Data    json.RawMessage
	Error   *string
}

// PromptError is why a prompt failed.
type PromptError struct {
	Message    string  `json:"message"`
	Provider   *string `json:"provider,omitempty"`
	Model      *string `json:"model,omitempty"`
	HTTPStatus *int64  `json:"httpStatus,omitempty"`
	Retryable  *bool   `json:"retryable,omitempty"`
}

// PromptResult is exactly one per admitted prompt. AgentInvoked false (e.g. not authenticated) is
// never followed by session_settled, and SessionSettled true means none is needed.
type PromptResult struct {
	ID             string       `json:"id"`
	AgentInvoked   bool         `json:"agentInvoked"`
	Status         string       `json:"status"` // completed | aborted | error
	SessionSettled bool         `json:"sessionSettled"`
	Error          *PromptError `json:"error,omitempty"`
}

// HostToolCall is omp asking the host to run one of its host tools; it arrives before
// tool_execution_start for that call.
type HostToolCall struct {
	ID         string
	ToolCallID string
	ToolName   string
	Arguments  json.RawMessage
}

// IsReady guards and decodes a ready frame.
func IsReady(frame Frame) (ReadyFrame, bool) {
	if frameType(frame) != "ready" {
		return ReadyFrame{}, false
	}
	ready := ReadyFrame{}
	protocol, ok := memberNumber(frame, "protocolVersion")
	if !ok {
		return ReadyFrame{}, false
	}
	ready.ProtocolVersion = protocol
	raw, ok := frame["supportedProtocolVersions"]
	if !ok {
		return ReadyFrame{}, false
	}
	var versions []json.RawMessage
	if err := json.Unmarshal(raw, &versions); err != nil {
		return ReadyFrame{}, false
	}
	for _, version := range versions {
		number, ok := rawNumberValue(version)
		if !ok {
			return ReadyFrame{}, false
		}
		ready.SupportedProtocolVersions = append(ready.SupportedProtocolVersions, number)
	}
	if maxFrameBytes, ok := memberNumber(frame, "maxFrameBytes"); ok {
		ready.MaxFrameBytes = &maxFrameBytes
	}
	return ready, true
}

// IsResponse guards and decodes a response.
func IsResponse(frame Frame) (RpcResponse, bool) {
	if frameType(frame) != "response" {
		return RpcResponse{}, false
	}
	command, commandOK := memberString(frame, "command")
	success, successOK := memberBool(frame, "success")
	if !commandOK || !successOK {
		return RpcResponse{}, false
	}
	response := RpcResponse{Command: command, Success: success, Data: frame["data"]}
	if id, ok := memberString(frame, "id"); ok {
		response.ID = &id
	}
	if message, ok := memberString(frame, "error"); ok {
		response.Error = &message
	}
	return response, true
}

// IsPromptResult guards and decodes a prompt_result.
func IsPromptResult(frame Frame) (PromptResult, bool) {
	if frameType(frame) != "prompt_result" {
		return PromptResult{}, false
	}
	id, idOK := memberString(frame, "id")
	agentInvoked, agentOK := memberBool(frame, "agentInvoked")
	sessionSettled, settledOK := memberBool(frame, "sessionSettled")
	status, statusOK := memberString(frame, "status")
	if !idOK || !agentOK || !settledOK || !statusOK {
		return PromptResult{}, false
	}
	switch status {
	case "completed", "aborted", "error":
	default:
		return PromptResult{}, false
	}
	result := PromptResult{
		ID:             id,
		AgentInvoked:   agentInvoked,
		Status:         status,
		SessionSettled: sessionSettled,
	}
	// The error's shape is opaque here (the fold reads it); a non-object error is simply none.
	if raw, ok := frame["error"]; ok && len(raw) > 0 && raw[0] == '{' {
		var failure PromptError
		if err := json.Unmarshal(raw, &failure); err == nil {
			result.Error = &failure
		}
	}
	return result, true
}

// IsHostToolCall guards and decodes a host_tool_call.
func IsHostToolCall(frame Frame) (HostToolCall, bool) {
	if frameType(frame) != "host_tool_call" {
		return HostToolCall{}, false
	}
	id, idOK := memberString(frame, "id")
	toolCallID, callIDOK := memberString(frame, "toolCallId")
	toolName, nameOK := memberString(frame, "toolName")
	if !idOK || !callIDOK || !nameOK {
		return HostToolCall{}, false
	}
	arguments, ok := frame["arguments"]
	if !ok || len(arguments) == 0 || arguments[0] != '{' {
		return HostToolCall{}, false
	}
	return HostToolCall{
		ID:         id,
		ToolCallID: toolCallID,
		ToolName:   toolName,
		Arguments:  arguments,
	}, true
}

// IsHostToolCancel guards a host_tool_cancel and returns the cancelled call's id.
func IsHostToolCancel(frame Frame) (string, bool) {
	if frameType(frame) != "host_tool_cancel" {
		return "", false
	}
	_, idOK := memberString(frame, "id")
	targetID, targetOK := memberString(frame, "targetId")
	if !idOK || !targetOK {
		return "", false
	}
	return targetID, true
}

// memberBool reads a member as a boolean; ok is false for any other JSON value (null included,
// which unmarshals into a bool without error).
func memberBool(frame Frame, key string) (bool, bool) {
	raw, ok := frame[key]
	if !ok || len(raw) == 0 || string(raw) == "null" {
		return false, false
	}
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, false
	}
	return value, true
}

// memberNumber reads a member as a number; ok is false for any other JSON value.
func memberNumber(frame Frame, key string) (float64, bool) {
	raw, ok := frame[key]
	if !ok {
		return 0, false
	}
	return rawNumberValue(raw)
}

// rawNumberValue reads raw JSON as a number; ok is false for any other JSON value (null included).
func rawNumberValue(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, false
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	number, ok := value.(float64)
	return number, ok
}
