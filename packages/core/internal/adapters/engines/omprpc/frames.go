// omp's RPC framing (protocol v1 and v2). Every frame is one JSON object per line. Under v2 a
// frame over MaxFrameBytes arrives as a run of rpc_chunk lines carrying base64 slices of its
// UTF-8 bytes; the chunks have no id, so correlation happens on the reassembled frame. The rules
// mirror omp 18.6.1's own decoder.
package omprpc

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"sync"
	"unicode/utf16"
	"unicode/utf8"
)

// Frame is a decoded frame: an object with a string type, otherwise opaque here.
type Frame map[string]json.RawMessage

// MaxFrameBytes is the longest line that travels as one frame (newline included).
const MaxFrameBytes int64 = 1024 * 1024

// maxReassembledBytes is what omp refuses to reassemble beyond.
const maxReassembledBytes int64 = 64 * 1024 * 1024

// chunkBytes is omp's slice size for rpc_chunk data.
const chunkBytes int64 = 256 * 1024

// omp's own decoder limits: ids and chunk counts it refuses outright.
const (
	maxChunkIDChars = 128
	maxChunks       = 256
)

// maxSafeInteger is the largest integer a JS number holds exactly, the bound on every count the
// protocol carries.
const maxSafeInteger = float64(1<<53 - 1)

// DecodedKind names what one pushed line turned out to be.
type DecodedKind string

const (
	// DecodedFrame is a frame; Text is its exact JSON text (the reassembled bytes for a chunked
	// frame).
	DecodedFrame DecodedKind = "frame"
	// DecodedPartial is a blank line, or a chunk of a frame still being reassembled.
	DecodedPartial DecodedKind = "partial"
	// DecodedMalformed is a line that is not a frame (stray output); callers log and skip it.
	DecodedMalformed DecodedKind = "malformed"
	// DecodedError is a broken chunk sequence: a frame was lost, so the stream can no longer be
	// trusted.
	DecodedError DecodedKind = "error"
)

// Decoded is one line's worth of decoding.
type Decoded struct {
	Kind DecodedKind
	// Frame and Text are set for DecodedFrame.
	Frame Frame
	Text  string
	// Line and Reason are set for DecodedMalformed; Reason alone for DecodedError.
	Line   string
	Reason string
}

// chunkMeta is one rpc_chunk's checked metadata.
type chunkMeta struct {
	chunkID    string
	index      int64
	count      int64
	byteLength int64
	data       []byte
}

// rpcSequence is a frame still being reassembled.
type rpcSequence struct {
	chunkID    string
	count      int64
	byteLength int64
	chunks     [][]byte
	received   int64
}

// FrameDecoder decodes one stream's lines, reassembling v2 rpc_chunk runs between them. The
// client's reader goroutine pushes lines while the handshake negotiates, so the decoder guards
// itself.
type FrameDecoder struct {
	mu             sync.Mutex
	sequence       *rpcSequence
	chunked        bool
	minChunkedByte int64
}

// CreateFrameDecoder builds a decoder for one stream.
func CreateFrameDecoder() *FrameDecoder {
	return &FrameDecoder{minChunkedByte: MaxFrameBytes}
}

// Push decodes one line of the peer's stdout.
func (d *FrameDecoder) Push(raw string) Decoded {
	d.mu.Lock()
	defer d.mu.Unlock()
	line := raw
	if strings.HasSuffix(line, "\r") {
		line = line[:len(line)-1]
	}
	if line == "" {
		return Decoded{Kind: DecodedPartial}
	}
	frame, reason := parseFrame(line)
	if reason != "" {
		return Decoded{Kind: DecodedMalformed, Line: line, Reason: reason}
	}
	if frameType(frame) == "rpc_chunk" {
		return d.chunk(frame)
	}
	if d.sequence != nil {
		return d.fail("rpc chunk sequence interrupted")
	}
	return Decoded{Kind: DecodedFrame, Frame: frame, Text: line}
}

// Negotiated marks protocol 2 as agreed: rpc_chunk lines become legal, and maxFrameBytes (from the
// peer's ready frame) sets the size a frame must exceed to arrive chunked. A peer that does not
// send one keeps MaxFrameBytes.
func (d *FrameDecoder) Negotiated(maxFrameBytes *float64) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.chunked = true
	if maxFrameBytes != nil && *maxFrameBytes == math.Trunc(*maxFrameBytes) &&
		math.Abs(*maxFrameBytes) <= maxSafeInteger && *maxFrameBytes > 0 {
		d.minChunkedByte = int64(*maxFrameBytes)
	}
}

// EncodeChunks splits a frame's JSON text into lines the way omp does: one line when it fits,
// rpc_chunks otherwise.
func EncodeChunks(text, chunkID string) []string {
	data := []byte(text)
	if int64(len(data))+1 <= MaxFrameBytes {
		return []string{text}
	}
	count := int64(len(data)+int(chunkBytes)-1) / chunkBytes
	out := make([]string, 0, count)
	for index := int64(0); index < count; index++ {
		end := min((index+1)*chunkBytes, int64(len(data)))
		var buf bytes.Buffer
		buf.WriteString(`{"type":"rpc_chunk","chunkId":`)
		appendJSONString(&buf, chunkID)
		buf.WriteString(`,"index":`)
		buf.WriteString(strconv.FormatInt(index, 10))
		buf.WriteString(`,"count":`)
		buf.WriteString(strconv.FormatInt(count, 10))
		buf.WriteString(`,"byteLength":`)
		buf.WriteString(strconv.FormatInt(int64(len(data)), 10))
		buf.WriteString(`,"data":`)
		appendJSONString(&buf, base64.StdEncoding.EncodeToString(data[index*chunkBytes:end]))
		buf.WriteByte('}')
		out = append(out, buf.String())
	}
	return out
}

// fail ends the stream with a protocol error; the sequence, if any, is dropped.
func (d *FrameDecoder) fail(reason string) Decoded {
	d.sequence = nil
	return Decoded{Kind: DecodedError, Reason: reason}
}

// chunk folds one rpc_chunk line into the sequence under way.
func (d *FrameDecoder) chunk(frame Frame) Decoded {
	if !d.chunked {
		return d.fail("rpc chunk before protocol negotiation")
	}
	meta, problem := chunkMetaOf(frame, d.minChunkedByte)
	if problem != "" {
		return d.fail(problem)
	}
	if d.sequence == nil && meta.index != 0 {
		return d.fail("rpc chunk sequence must start at index 0")
	}
	if d.sequence == nil {
		d.sequence = &rpcSequence{
			chunkID:    meta.chunkID,
			count:      meta.count,
			byteLength: meta.byteLength,
		}
	}
	if problem := appendChunk(d.sequence, meta); problem != "" {
		return d.fail(problem)
	}
	if int64(len(d.sequence.chunks)) < d.sequence.count {
		return Decoded{Kind: DecodedPartial}
	}
	done := d.sequence
	d.sequence = nil
	return finishSequence(done)
}

// appendChunk adds a chunk to its sequence, or says why it does not belong there.
func appendChunk(at *rpcSequence, meta chunkMeta) string {
	matches := at.chunkID == meta.chunkID &&
		at.count == meta.count &&
		at.byteLength == meta.byteLength &&
		int64(len(at.chunks)) == meta.index
	if !matches {
		return "rpc chunk sequence mismatch"
	}
	at.chunks = append(at.chunks, meta.data)
	at.received += int64(len(meta.data))
	if at.received > at.byteLength {
		return "rpc chunk sequence exceeds declared length"
	}
	return ""
}

// finishSequence decodes a sequence that just received its last chunk; the bytes must add up to
// the declared length.
func finishSequence(done *rpcSequence) Decoded {
	if done.received != done.byteLength {
		return Decoded{Kind: DecodedError, Reason: "rpc chunk sequence length mismatch"}
	}
	return reassemble(joinChunks(done.chunks))
}

// joinChunks concatenates a sequence's slices.
func joinChunks(chunks [][]byte) []byte {
	size := 0
	for _, chunk := range chunks {
		size += len(chunk)
	}
	joined := make([]byte, 0, size)
	for _, chunk := range chunks {
		joined = append(joined, chunk...)
	}
	return joined
}

// reassemble turns a sequence's bytes back into a frame.
func reassemble(bytes []byte) Decoded {
	if !utf8.Valid(bytes) {
		return Decoded{Kind: DecodedError, Reason: "rpc chunk data is not UTF-8"}
	}
	text := string(bytes)
	frame, reason := parseFrame(text)
	if reason != "" {
		return Decoded{Kind: DecodedError, Reason: "rpc frame must be an object"}
	}
	return Decoded{Kind: DecodedFrame, Frame: frame, Text: text}
}

// parseFrame decodes text as a frame; the returned reason says why it is not one.
func parseFrame(text string) (Frame, string) {
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		return nil, "not JSON"
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, "not an RPC frame"
	}
	if _, ok := object["type"].(string); !ok {
		return nil, "not an RPC frame"
	}
	var frame Frame
	if err := json.Unmarshal([]byte(text), &frame); err != nil {
		return nil, "not JSON"
	}
	return frame, ""
}

// frameType reads a frame's type member, "" when it is not a string.
func frameType(frame Frame) string {
	text, _ := memberString(frame, "type")
	return text
}

// chunkMetaOf checks one rpc_chunk's metadata against the negotiated limits.
func chunkMetaOf(frame Frame, minChunkedBytes int64) (chunkMeta, string) {
	chunkID, idOK := memberString(frame, "chunkId")
	index, indexOK := memberCount(frame, "index")
	count, countOK := memberCount(frame, "count")
	byteLength, lengthOK := memberCount(frame, "byteLength")
	data, dataOK := frame["data"]
	valid := idOK && chunkID != "" && memberIDLength(chunkID) <= maxChunkIDChars &&
		indexOK && countOK && lengthOK && dataOK &&
		count <= maxChunks &&
		count >= 2 &&
		index < count &&
		byteLength >= minChunkedBytes &&
		byteLength <= maxReassembledBytes
	if !valid {
		return chunkMeta{}, "invalid rpc chunk metadata"
	}
	decoded, ok := decodeBase64(data)
	if !ok {
		return chunkMeta{}, "invalid rpc chunk data"
	}
	if int64(len(decoded)) > chunkBytes {
		return chunkMeta{}, "rpc chunk data exceeds the slice size"
	}
	return chunkMeta{
		chunkID:    chunkID,
		index:      index,
		count:      count,
		byteLength: byteLength,
		data:       decoded,
	}, ""
}

// memberString reads a member as a string; ok is false for any other JSON value.
func memberString(frame Frame, key string) (string, bool) {
	raw, ok := frame[key]
	if !ok || raw == nil || string(raw) == "null" {
		return "", false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", false
	}
	return text, true
}

// memberCount reads a member as a non-negative safe integer, the counts the protocol carries.
func memberCount(frame Frame, key string) (int64, bool) {
	raw, ok := frame[key]
	if !ok {
		return 0, false
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return 0, false
	}
	number, ok := value.(float64)
	if !ok || number != math.Trunc(number) || number < 0 || number > maxSafeInteger {
		return 0, false
	}
	return int64(number), true
}

// memberIDLength counts a chunk id's UTF-16 code units, the units a JS string's length counts.
func memberIDLength(text string) int {
	return len(utf16.Encode([]rune(text)))
}

// decodeBase64 accepts only canonical base64, as omp does: anything else means the line was
// mangled.
func decodeBase64(raw json.RawMessage) ([]byte, bool) {
	var text string
	if err := json.Unmarshal(raw, &text); err != nil || text == "" {
		return nil, false
	}
	decoded, err := base64.StdEncoding.DecodeString(text)
	if err != nil {
		return nil, false
	}
	if base64.StdEncoding.EncodeToString(decoded) != text {
		return nil, false
	}
	return decoded, true
}

// appendJSONString writes text as a JSON string the way JSON.stringify does: the short escapes
// for \b \t \n \f \r, \u00xx for the other control characters.
func appendJSONString(out *bytes.Buffer, text string) {
	out.WriteByte('"')
	for i := 0; i < len(text); i++ {
		c := text[i]
		switch {
		case c == '"':
			out.WriteString(`\"`)
		case c == '\\':
			out.WriteString(`\\`)
		case c == '\b':
			out.WriteString(`\b`)
		case c == '\f':
			out.WriteString(`\f`)
		case c == '\n':
			out.WriteString(`\n`)
		case c == '\r':
			out.WriteString(`\r`)
		case c == '\t':
			out.WriteString(`\t`)
		case c < 0x20:
			out.WriteString(`\u00`)
			const hex = "0123456789abcdef"
			out.WriteByte(hex[c>>4])
			out.WriteByte(hex[c&0xf])
		default:
			out.WriteByte(c)
		}
	}
	out.WriteByte('"')
}
