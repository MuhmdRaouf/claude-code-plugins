package pirpc

// Typed views of the RPC frames pi 1.0.4 answers. pi is looser than omp: it sends no ready frame,
// only ever echoes the response envelope, and ends each turn with a bare agent_settled that
// carries no fields worth typing. What the fold reads off the event stream (message ends, tool
// executions, retries) is untyped there: pi shapes it like a transcript, so the worker picks those
// frames apart field by field instead of narrowing whole frames here.

import "encoding/json"

// RpcResponse is pi's answer to a command: success plus whatever the command reports under data.
type RpcResponse struct {
	// Id is the id the commanding side sent; empty when pi answers a line it could not parse.
	Id      string
	Command string
	Success bool
	// Error is pi's refusal text; empty when it sent none.
	Error string
	// Data is the answer's data object; nil when pi sent none.
	Data map[string]json.RawMessage
}

// IsResponse tells whether frame is pi's answer to a command and hands back its typed view: a
// response envelope with a string command and a boolean success.
func IsResponse(frame Frame) (RpcResponse, bool) {
	command, hasCommand := frameStringOk(frame, "command")
	success, hasSuccess := frameBool(frame, "success")
	if frameString(frame, "type") != "response" || !hasCommand || !hasSuccess {
		return RpcResponse{}, false
	}
	return RpcResponse{
		Id:      frameString(frame, "id"),
		Command: command,
		Success: success,
		Error:   frameString(frame, "error"),
		Data:    frameObject(frame, "data"),
	}, true
}
