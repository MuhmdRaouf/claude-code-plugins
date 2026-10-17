package omprpc

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

// chunkLines splits text's UTF-8 bytes into rpc_chunk lines the way omp does.
func chunkLines(text string, chunkBytes int, chunkID ...string) []string {
	id := "c1"
	if len(chunkID) > 0 {
		id = chunkID[0]
	}
	data := []byte(text)
	count := (len(data) + chunkBytes - 1) / chunkBytes
	var out []string
	for index := 0; index < count; index++ {
		end := min((index+1)*chunkBytes, len(data))
		out = append(out, string(object(
			fStr("type", "rpc_chunk"),
			fStr("chunkId", id),
			fInt("index", index),
			fInt("count", count),
			fInt("byteLength", len(data)),
			fStr("data", base64.StdEncoding.EncodeToString(data[index*chunkBytes:end])),
		)))
	}
	return out
}

// bigFrame is a response frame of roughly bytes JSON bytes ("é" is two bytes per character).
func bigFrame(bytes int) string {
	return string(object(
		fStr("id", "e1"),
		fStr("type", "response"),
		fStr("command", "get_entries"),
		fBool("success", true),
		fStr("data", strings.Repeat("é", bytes/2)),
	))
}

// chunkedDecoder is a decoder past the negotiation step, as the client hands it after
// ready + negotiate_protocol.
func chunkedDecoder(maxFrameBytes ...float64) *FrameDecoder {
	decoder := CreateFrameDecoder()
	if len(maxFrameBytes) > 0 {
		value := maxFrameBytes[0]
		decoder.Negotiated(&value)
	} else {
		decoder.Negotiated(nil)
	}
	return decoder
}

func isKind(t *testing.T, name string, decoded Decoded, want DecodedKind) {
	t.Helper()
	if decoded.Kind != want {
		t.Errorf("%s: kind = %q, want %q", name, decoded.Kind, want)
	}
}

func TestCreateFrameDecoder(t *testing.T) {
	t.Run("decodes a v1 line into its frame and keeps the exact text", func(t *testing.T) {
		decoder := CreateFrameDecoder()
		line := `{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2]}`
		decoded := decoder.Push(line)
		isKind(t, "ready line", decoded, DecodedFrame)
		if decoded.Text != line {
			t.Errorf("text = %q, want the line itself", decoded.Text)
		}
		if rawString(decoded.Frame["type"]) != "ready" ||
			rawNumber(decoded.Frame["protocolVersion"]) != 1 {
			t.Errorf("frame = %v, want the ready frame", decoded.Frame)
		}
		var versions []float64
		if err := json.Unmarshal(decoded.Frame["supportedProtocolVersions"], &versions); err != nil ||
			len(versions) != 2 || versions[0] != 1 || versions[1] != 2 {
			t.Errorf("supportedProtocolVersions = %s, want [1 2]", decoded.Frame["supportedProtocolVersions"])
		}
	})

	t.Run("tolerates a trailing carriage return", func(t *testing.T) {
		decoded := CreateFrameDecoder().Push(`{"type":"session_settled"}` + "\r")
		isKind(t, "crlf line", decoded, DecodedFrame)
		if decoded.Text != `{"type":"session_settled"}` {
			t.Errorf("text = %q, want the line without the carriage return", decoded.Text)
		}
	})

	t.Run("reports %s as malformed instead of throwing", func(t *testing.T) {
		cases := []struct{ name, line string }{
			{"not json", "Still starting"},
			{"a JSON array", "[1,2]"},
			{"a frame without a type", `{"id":"x"}`},
			{"a JSON string", `"ready"`},
		}
		for _, c := range cases {
			t.Run(c.name, func(t *testing.T) {
				decoded := CreateFrameDecoder().Push(c.line)
				if decoded.Kind != DecodedMalformed || decoded.Line != c.line {
					t.Errorf("push = (%q, %q), want malformed %q", decoded.Kind, decoded.Line, c.line)
				}
			})
		}
	})

	t.Run("skips blank lines", func(t *testing.T) {
		isKind(t, "blank line", CreateFrameDecoder().Push(""), DecodedPartial)
	})

	t.Run("rejects rpc_chunk before protocol 2 has been negotiated", func(t *testing.T) {
		decoder := CreateFrameDecoder()
		for _, line := range chunkLines(bigFrame(int(MaxFrameBytes)+2_000), 512*1024) {
			decoded := decoder.Push(line)
			if decoded.Kind != DecodedError || decoded.Reason != "rpc chunk before protocol negotiation" {
				t.Errorf("push = (%q, %q), want rpc chunk before protocol negotiation", decoded.Kind, decoded.Reason)
			}
		}
	})

	t.Run("honours the peer's ready.maxFrameBytes as the chunk threshold", func(t *testing.T) {
		decoder := chunkedDecoder(64 * 1024)
		text := bigFrame(100 * 1024)
		lines := chunkLines(text, 32*1024)
		if len(lines) <= 2 {
			t.Fatalf("chunked into %d lines, want more than 2", len(lines))
		}
		for _, line := range lines[:len(lines)-1] {
			isKind(t, "partial chunk", decoder.Push(line), DecodedPartial)
		}
		decoded := decoder.Push(lines[len(lines)-1])
		if decoded.Kind != DecodedFrame || decoded.Text != text {
			t.Errorf("last chunk = (%q, %q), want the reassembled frame", decoded.Kind, decoded.Text)
		}
	})

	t.Run("reassembles a v2 rpc_chunk sequence (chunks carry no id) and checks byteLength", func(t *testing.T) {
		text := bigFrame(int(MaxFrameBytes) + 10_000)
		decoder := chunkedDecoder()
		lines := chunkLines(text, 256*1024)
		if len(lines) <= 4 {
			t.Fatalf("chunked into %d lines, want more than 4", len(lines))
		}
		for _, line := range lines[:len(lines)-1] {
			isKind(t, "partial chunk", decoder.Push(line), DecodedPartial)
		}
		decoded := decoder.Push(lines[len(lines)-1])
		if decoded.Kind != DecodedFrame || decoded.Text != text ||
			rawString(decoded.Frame["id"]) != "e1" || rawString(decoded.Frame["command"]) != "get_entries" {
			t.Errorf("last chunk = (%q, %q, %v), want the reassembled e1 response", decoded.Kind, decoded.Text, decoded.Frame)
		}
	})

	t.Run("round-trips its own encoder", func(t *testing.T) {
		text := bigFrame(int(MaxFrameBytes) * 3)
		decoder := chunkedDecoder()
		encoded := EncodeChunks(text, "x9")
		var decoded Decoded
		for _, line := range encoded {
			decoded = decoder.Push(line)
		}
		if decoded.Kind != DecodedFrame || decoded.Text != text {
			t.Errorf("round trip = (%q, %q), want the reassembled frame", decoded.Kind, decoded.Text)
		}
	})

	t.Run("encodes a frame within the limit as one line", func(t *testing.T) {
		encoded := EncodeChunks(`{"type":"session_settled"}`, "x")
		if len(encoded) != 1 || encoded[0] != `{"type":"session_settled"}` {
			t.Errorf("EncodeChunks() = %q, want the one line", encoded)
		}
	})

	t.Run("ignores a maxFrameBytes that is not a positive integer", func(t *testing.T) {
		for _, value := range []float64{0, -1024, 64.5} {
			decoder := chunkedDecoder(value)
			// A frame under the default 1 MiB limit is still under it: chunking it stays invalid.
			decoded := decoder.Push(chunkLines(bigFrame(100*1024), 64*1024)[0])
			if decoded.Kind != DecodedError {
				t.Errorf("maxFrameBytes %v: a small frame chunked = %q, want an error", value, decoded.Kind)
			}
		}
	})
}

func TestChunkSequenceViolations(t *testing.T) {
	text := bigFrame(int(MaxFrameBytes) + 2_000)
	lines := func() []string { return chunkLines(text, 256*1024) }

	t.Run("a sequence that does not start at index 0", func(t *testing.T) {
		decoded := chunkedDecoder().Push(lines()[1])
		if decoded.Kind != DecodedError || decoded.Reason != "rpc chunk sequence must start at index 0" {
			t.Errorf("push = (%q, %q), want must start at index 0", decoded.Kind, decoded.Reason)
		}
	})

	t.Run("a frame interrupting a sequence", func(t *testing.T) {
		decoder := chunkedDecoder()
		decoder.Push(lines()[0])
		decoded := decoder.Push(`{"type":"session_settled"}`)
		if decoded.Kind != DecodedError || decoded.Reason != "rpc chunk sequence interrupted" {
			t.Errorf("push = (%q, %q), want sequence interrupted", decoded.Kind, decoded.Reason)
		}
	})

	t.Run("a chunk from another sequence", func(t *testing.T) {
		decoder := chunkedDecoder()
		decoder.Push(lines()[0])
		other := chunkLines(text, 256*1024, "other")[1]
		decoded := decoder.Push(other)
		if decoded.Kind != DecodedError || decoded.Reason != "rpc chunk sequence mismatch" {
			t.Errorf("push = (%q, %q), want sequence mismatch", decoded.Kind, decoded.Reason)
		}
	})

	t.Run("a chunk that skips an index (0 then 2, with 1 still missing)", func(t *testing.T) {
		decoder := chunkedDecoder()
		isKind(t, "first chunk", decoder.Push(lines()[0]), DecodedPartial)
		decoded := decoder.Push(lines()[2])
		if decoded.Kind != DecodedError || decoded.Reason != "rpc chunk sequence mismatch" {
			t.Errorf("skipped chunk = (%q, %q), want sequence mismatch", decoded.Kind, decoded.Reason)
		}
		// The skipped chunk cannot be joined in late either: the sequence failed, not paused.
		late := decoder.Push(lines()[1])
		if late.Kind != DecodedError || late.Reason != "rpc chunk sequence must start at index 0" {
			t.Errorf("late chunk = (%q, %q), want must start at index 0", late.Kind, late.Reason)
		}
	})

	t.Run("a repeated index", func(t *testing.T) {
		decoder := chunkedDecoder()
		isKind(t, "first chunk", decoder.Push(lines()[0]), DecodedPartial)
		decoded := decoder.Push(lines()[0])
		if decoded.Kind != DecodedError || decoded.Reason != "rpc chunk sequence mismatch" {
			t.Errorf("repeated chunk = (%q, %q), want sequence mismatch", decoded.Kind, decoded.Reason)
		}
	})

	t.Run("a byteLength that does not match the data", func(t *testing.T) {
		decoder := chunkedDecoder()
		var all []string
		for _, line := range lines() {
			var members map[string]json.RawMessage
			if json.Unmarshal([]byte(line), &members) != nil {
				t.Fatal("chunk does not parse")
			}
			all = append(all, string(object(
				fStr("type", "rpc_chunk"),
				fStr("chunkId", "c1"),
				fRaw("index", members["index"]),
				fRaw("count", members["count"]),
				fInt("byteLength", int(MaxFrameBytes)),
				fRaw("data", members["data"]),
			)))
		}
		for _, chunk := range all[:len(all)-1] {
			decoder.Push(chunk)
		}
		decoded := decoder.Push(all[len(all)-1])
		if decoded.Kind != DecodedError || decoded.Reason != "rpc chunk sequence exceeds declared length" {
			t.Errorf("last chunk = (%q, %q), want exceeds declared length", decoded.Kind, decoded.Reason)
		}
	})

	t.Run("data shorter than byteLength", func(t *testing.T) {
		decoder := chunkedDecoder()
		var big []string
		for _, line := range lines() {
			var members map[string]json.RawMessage
			if json.Unmarshal([]byte(line), &members) != nil {
				t.Fatal("chunk does not parse")
			}
			big = append(big, string(object(
				fStr("type", "rpc_chunk"),
				fStr("chunkId", "c1"),
				fRaw("index", members["index"]),
				fRaw("count", members["count"]),
				fInt("byteLength", 9_000_000),
				fRaw("data", members["data"]),
			)))
		}
		for _, chunk := range big[:len(big)-1] {
			decoder.Push(chunk)
		}
		decoded := decoder.Push(big[len(big)-1])
		if decoded.Kind != DecodedError || decoded.Reason != "rpc chunk sequence length mismatch" {
			t.Errorf("last chunk = (%q, %q), want length mismatch", decoded.Kind, decoded.Reason)
		}
	})

	t.Run("bad metadata", func(t *testing.T) {
		cases := []struct {
			name  string
			patch func(fields []fld) []fld
		}{
			{"missing chunkId", func(fields []fld) []fld {
				return replaceField(fields, fStr("chunkId", ""))
			}},
			{"a chunkId over 128 chars", func(fields []fld) []fld {
				return replaceField(fields, fStr("chunkId", strings.Repeat("c", 129)))
			}},
			{"a count below 2", func(fields []fld) []fld {
				return replaceField(fields, fInt("count", 1))
			}},
			{"a count over 256", func(fields []fld) []fld {
				return replaceField(fields, fInt("count", 257))
			}},
			{"an index past count", func(fields []fld) []fld {
				return replaceField(fields, fInt("index", 7))
			}},
			{"a byteLength under the frame limit", func(fields []fld) []fld {
				return replaceField(fields, fInt("byteLength", 10))
			}},
			{"a byteLength over the reassembly limit", func(fields []fld) []fld {
				return replaceField(fields, fInt("byteLength", 65*1024*1024))
			}},
			{"data that is not base64", func(fields []fld) []fld {
				return replaceField(fields, fStr("data", "not base64!"))
			}},
			{"data that is not canonical base64", func(fields []fld) []fld {
				return replaceField(fields, fStr("data", "QQ"))
			}},
		}
		for _, c := range cases {
			var members map[string]json.RawMessage
			if json.Unmarshal([]byte(lines()[0]), &members) != nil {
				t.Fatal("chunk does not parse")
			}
			fields := []fld{
				fStr("type", "rpc_chunk"),
				fStr("chunkId", "c1"),
				fRaw("index", members["index"]),
				fRaw("count", members["count"]),
				fRaw("byteLength", members["byteLength"]),
				fRaw("data", members["data"]),
			}
			decoded := chunkedDecoder().Push(string(object(c.patch(fields)...)))
			if decoded.Kind != DecodedError {
				t.Errorf("bad metadata (%s): kind = %q, want an error", c.name, decoded.Kind)
			}
		}
	})

	t.Run("a single chunk over omp's 256 KiB slice size", func(t *testing.T) {
		decoder := chunkedDecoder()
		oversized := chunkLines(bigFrame(int(MaxFrameBytes)+100_000), 600*1024)
		decoded := decoder.Push(oversized[0])
		if decoded.Kind != DecodedError || decoded.Reason != "rpc chunk data exceeds the slice size" {
			t.Errorf("oversized chunk = (%q, %q), want exceeds the slice size", decoded.Kind, decoded.Reason)
		}
	})

	t.Run("a reassembled payload that is not a JSON object", func(t *testing.T) {
		decoder := chunkedDecoder()
		var decoded Decoded
		for _, line := range chunkLines(`[`+strings.Repeat(" ", int(MaxFrameBytes))+`]`, 256*1024) {
			decoded = decoder.Push(line)
		}
		if decoded.Kind != DecodedError || decoded.Reason != "rpc frame must be an object" {
			t.Errorf("reassembled = (%q, %q), want must be an object", decoded.Kind, decoded.Reason)
		}
	})

	t.Run("a reassembled payload that is not UTF-8", func(t *testing.T) {
		decoder := chunkedDecoder()
		data := make([]byte, int(MaxFrameBytes)+10)
		for i := range data {
			data[i] = 0xff
		}
		slice := 220 * 1024
		count := (len(data) + slice - 1) / slice
		chunk := func(index int) string {
			end := min((index+1)*slice, len(data))
			return string(object(
				fStr("type", "rpc_chunk"),
				fStr("chunkId", "u"),
				fInt("index", index),
				fInt("count", count),
				fInt("byteLength", len(data)),
				fStr("data", base64.StdEncoding.EncodeToString(data[index*slice:end])),
			))
		}
		var decoded Decoded
		for index := 0; index < count; index++ {
			decoded = decoder.Push(chunk(index))
		}
		if decoded.Kind != DecodedError {
			t.Errorf("reassembled = (%q, %q), want an error", decoded.Kind, decoded.Reason)
		}
	})

	t.Run("recovers after an error: the next sequence decodes", func(t *testing.T) {
		decoder := chunkedDecoder()
		decoder.Push(lines()[1])
		var decoded Decoded
		for _, line := range lines() {
			decoded = decoder.Push(line)
		}
		if decoded.Kind != DecodedFrame || decoded.Text != text {
			t.Errorf("after an error = (%q, %q), want the reassembled frame", decoded.Kind, decoded.Text)
		}
	})
}

// replaceField swaps the one field named like the replacement in an ordered field list.
func replaceField(fields []fld, replacement fld) []fld {
	out := append([]fld(nil), fields...)
	for i, field := range out {
		if field.name == replacement.name {
			out[i] = replacement
			return out
		}
	}
	return append(out, replacement)
}

func TestFrameHelpers(t *testing.T) {
	t.Run("EncodeChunks escapes what JSON.stringify escapes in a chunk id", func(t *testing.T) {
		text := bigFrame(int(MaxFrameBytes) + 100)
		id := "x\"9\\\n\b\f\r\t\x01"
		lines := EncodeChunks(text, id)
		if len(lines) < 2 {
			t.Fatalf("chunked into %d lines, want several", len(lines))
		}
		if !strings.Contains(lines[0], `"chunkId":"x\"9\\\n\b\f\r\t\u0001"`) {
			t.Errorf("chunk id = %.60s, want the escaped id", lines[0])
		}
	})

	t.Run("a chunk with data that is empty, null, a number or not canonical is not base64", func(t *testing.T) {
		for _, data := range []string{`""`, `null`, `42`, `"QR=="`} {
			chunk := string(object(
				fStr("type", "rpc_chunk"),
				fStr("chunkId", "c1"),
				fInt("index", 0),
				fInt("count", 2),
				fInt("byteLength", int(MaxFrameBytes)+8),
				fRaw("data", json.RawMessage(data)),
			))
			if decoded := chunkedDecoder().Push(chunk); decoded.Kind != DecodedError {
				t.Errorf("data %s: kind = %q, want an error", data, decoded.Kind)
			}
		}
	})

	t.Run("counts must be non-negative integers", func(t *testing.T) {
		for _, index := range []string{`null`, `"0"`, `1.5`, `-1`, `9007199254740992`} {
			chunk := string(object(
				fStr("type", "rpc_chunk"),
				fStr("chunkId", "c1"),
				fRaw("index", json.RawMessage(index)),
				fInt("count", 2),
				fInt("byteLength", int(MaxFrameBytes)+8),
				fStr("data", "QUFB"),
			))
			if decoded := chunkedDecoder().Push(chunk); decoded.Kind != DecodedError {
				t.Errorf("index %s: kind = %q, want an error", index, decoded.Kind)
			}
		}
	})

	t.Run("a chunk id that is a number is not a string member", func(t *testing.T) {
		chunk := string(object(
			fStr("type", "rpc_chunk"),
			fInt("chunkId", 7),
			fInt("index", 0),
			fInt("count", 2),
			fInt("byteLength", int(MaxFrameBytes)+8),
			fStr("data", "QUFB"),
		))
		if decoded := chunkedDecoder().Push(chunk); decoded.Kind != DecodedError {
			t.Errorf("kind = %q, want an error", decoded.Kind)
		}
	})

	t.Run("a missing chunk id is not a string member", func(t *testing.T) {
		chunk := string(object(
			fStr("type", "rpc_chunk"),
			fRaw("chunkId", json.RawMessage(`null`)),
			fInt("index", 0),
			fInt("count", 2),
			fInt("byteLength", int(MaxFrameBytes)+8),
			fStr("data", "QUFB"),
		))
		if decoded := chunkedDecoder().Push(chunk); decoded.Kind != DecodedError {
			t.Errorf("kind = %q, want an error", decoded.Kind)
		}
	})
}
