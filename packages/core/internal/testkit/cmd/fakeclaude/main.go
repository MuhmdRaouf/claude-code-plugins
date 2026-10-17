// Command fakeclaude is the Go stand-in for `claude -p --output-format stream-json` in worker
// and end-to-end tests, byte-for-byte compatible with the fake `claude` script the zai plugin's
// tests run (the two must stay identical, so this one program serves both). It reads the prompt
// from stdin, then plays a
// scenario, emitting events shaped like the live stream (see testdata/stream/).
//
// Environment, the contract both fakes keep:
//   - FAKE_CLAUDE_SCENARIO  ok (default) | sleep | crash | echo-prompt | edit-file | no-session
//   - FAKE_CLAUDE_FIXTURE   NDJSON file replayed verbatim instead of a scenario
//   - FAKE_CLAUDE_EDIT      `path:content` written relative to the cwd by edit-file
//   - FAKE_CLAUDE_EDIT_ON_RESUME  used instead of FAKE_CLAUDE_EDIT when the run resumes a session
//   - FAKE_CLAUDE_REPORT    JSON for the result's structured_output (default {"summary":"fake run"})
//   - FAKE_CLAUDE_DUMP      file receiving {argv, envNames, authTokenSha256}
//   - FAKE_CLAUDE_PIDFILE   start a grandchild that holds stdout open and outlives this process;
//     "<own pid> <grandchild pid>" is written here once it runs
//
// An unparsable report, an unwritable edit target or a missing fixture exits 1 with the same
// stdout already written and nothing on stderr.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

// grandchildArg re-executes this binary as the FAKE_CLAUDE_PIDFILE grandchild: a process that
// only holds stdout open.
const grandchildArg = "--fake-grandchild"

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(argv []string) int {
	if len(argv) == 1 && argv[0] == grandchildArg {
		linger()
	}
	// --version prints and exits before the stdin read.
	if slices.Contains(argv, "--version") {
		os.Stdout.WriteString("2.1.289 (Claude Code, fake)\n")
		return 0
	}
	prompt, err := io.ReadAll(os.Stdin)
	if err != nil {
		return 1
	}
	if path, ok := os.LookupEnv("FAKE_CLAUDE_DUMP"); ok {
		if err := dump(path, argv); err != nil {
			return 1
		}
	}
	if path, ok := os.LookupEnv("FAKE_CLAUDE_PIDFILE"); ok {
		if err := startGrandchild(path); err != nil {
			return 1
		}
	}
	scenario, ok := os.LookupEnv("FAKE_CLAUDE_SCENARIO")
	if !ok {
		scenario = "ok"
	}
	return play(scenario, string(prompt), argv)
}

func play(scenario, prompt string, argv []string) int {
	if fixture, ok := os.LookupEnv("FAKE_CLAUDE_FIXTURE"); ok {
		data, err := os.ReadFile(fixture)
		if err != nil {
			return 1
		}
		os.Stdout.Write(data)
		return 0
	}
	if scenario == "no-session" {
		fmt.Fprintf(os.Stderr, "No conversation found with session ID: %s\n", sessionID(argv))
		return 1
	}
	if err := emitInit(argv); err != nil {
		return 1
	}
	switch scenario {
	case "ok":
		say(argv, "done")
		return result(argv, "done")
	case "echo-prompt":
		say(argv, prompt)
		return result(argv, "echoed")
	case "edit-file":
		path, err := editFile(editSpec(argv))
		if err != nil {
			return 1
		}
		say(argv, "edited "+path)
		return result(argv, "edited")
	case "sleep":
		linger()
		return 0
	case "crash":
		fmt.Fprint(os.Stderr, "fake claude: simulated crash\n")
		return 3
	default:
		fmt.Fprintf(os.Stderr, "fake claude: unknown scenario %s\n", scenario)
		return 2
	}
}

// linger blocks forever, like a Node process kept alive by setInterval.
func linger() {
	for {
		time.Sleep(time.Hour)
	}
}

// flag returns the argument after name in argv (a missing value counts as no flag).
func flag(argv []string, name string) (string, bool) {
	for i, a := range argv {
		if a == name && i+1 < len(argv) {
			return argv[i+1], true
		}
	}
	return "", false
}

func sessionID(argv []string) string {
	if v, ok := flag(argv, "--session-id"); ok {
		return v
	}
	if v, ok := flag(argv, "--resume"); ok {
		return v
	}
	return "fake-session"
}

func model(argv []string) string {
	alias := "sonnet"
	if v, ok := flag(argv, "--model"); ok {
		alias = v
	}
	if v, ok := os.LookupEnv("ANTHROPIC_DEFAULT_" + strings.ToUpper(alias) + "_MODEL"); ok {
		return v
	}
	return alias
}

func emitInit(argv []string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	permissionMode := "default"
	if v, ok := flag(argv, "--permission-mode"); ok {
		permissionMode = v
	}
	emit(sessionID(argv),
		jf("type", jstr("system")),
		jf("subtype", jstr("init")),
		jf("cwd", jstr(cwd)),
		jf("model", jstr(model(argv))),
		jf("permissionMode", jstr(permissionMode)),
		jf("apiKeySource", jstr("ANTHROPIC_AUTH_TOKEN")),
	)
	return nil
}

func say(argv []string, message string) {
	emit(sessionID(argv),
		jf("type", jstr("assistant")),
		jf("message", jobj(
			jf("role", jstr("assistant")),
			jf("content", jarr(jobj(
				jf("type", jstr("text")),
				jf("text", jstr(message)),
			))),
		)),
	)
}

func result(argv []string, message string) int {
	report := `{"summary":"fake run"}`
	if v, ok := os.LookupEnv("FAKE_CLAUDE_REPORT"); ok {
		report = v
	}
	structured, err := parseJSON(report)
	if err != nil {
		return 1
	}
	emit(sessionID(argv),
		jf("type", jstr("result")),
		jf("subtype", jstr("success")),
		jf("is_error", jbool(false)),
		jf("result", jstr(message)),
		jf("structured_output", structured),
		jf("num_turns", jnum(1)),
		jf("duration_ms", jnum(12)),
		jf("total_cost_usd", jnum(0.0012)),
		jf("usage", jobj(
			jf("input_tokens", jnum(100)),
			jf("output_tokens", jnum(20)),
			jf("cache_read_input_tokens", jnum(50)),
			jf("cache_creation_input_tokens", jnum(10)),
		)),
	)
	return 0
}

// emit writes one stream-json line: the event fields with session_id appended last.
func emit(sid string, fields ...jfield) {
	fields = append(fields, jf("session_id", jstr(sid)))
	os.Stdout.WriteString(marshal(jobj(fields...)) + "\n")
}

// dump writes {argv, envNames, authTokenSha256}: env NAMES only, the token only hashed.
// envNames sorts by UTF-16 code units, like JavaScript's default Array sort.
func dump(path string, argv []string) error {
	names := make([]string, 0, 16)
	for _, kv := range os.Environ() {
		key, _, _ := strings.Cut(kv, "=")
		names = append(names, key)
	}
	sort.Slice(names, func(i, j int) bool {
		return slices.Compare(utf16.Encode([]rune(names[i])), utf16.Encode([]rune(names[j]))) < 0
	})
	argvVals := make([]jval, len(argv))
	for i, a := range argv {
		argvVals[i] = jstr(a)
	}
	nameVals := make([]jval, len(names))
	for i, n := range names {
		nameVals[i] = jstr(n)
	}
	var sha jval = jnull()
	if token, ok := os.LookupEnv("ANTHROPIC_AUTH_TOKEN"); ok {
		sum := sha256.Sum256([]byte(token))
		sha = jstr(hex.EncodeToString(sum[:]))
	}
	return os.WriteFile(path, []byte(marshal(jobj(
		jf("argv", jarr(argvVals...)),
		jf("envNames", jarr(nameVals...)),
		jf("authTokenSha256", sha),
	))), 0o644)
}

// startGrandchild spawns the linger process with stdout and stderr inherited, releases it, and
// writes "<own pid> <grandchild pid>" with no trailing newline. The pid is read
// before Release, which retires it in the os.Process bookkeeping.
func startGrandchild(pidFile string) error {
	self, err := os.Executable()
	if err != nil {
		self = os.Args[0]
	}
	child := exec.Command(self, grandchildArg)
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	if err := child.Start(); err != nil {
		return err
	}
	pid := child.Process.Pid
	if err := child.Process.Release(); err != nil {
		return err
	}
	return os.WriteFile(pidFile, []byte(fmt.Sprintf("%d %d", os.Getpid(), pid)), 0o644)
}

// editSpec picks the edit instructions: FAKE_CLAUDE_EDIT_ON_RESUME while resuming a session,
// FAKE_CLAUDE_EDIT otherwise.
func editSpec(argv []string) string {
	if slices.Contains(argv, "--resume") {
		if v, ok := os.LookupEnv("FAKE_CLAUDE_EDIT_ON_RESUME"); ok {
			return v
		}
	}
	if v, ok := os.LookupEnv("FAKE_CLAUDE_EDIT"); ok {
		return v
	}
	return ""
}

// editFile writes `path:content` relative to the cwd, creating parent directories, and returns
// the path as the fake reports it (relative, as written in the spec). A spec with no colon
// splits at its last character: the path is the spec without it and the content is all of it.
func editFile(spec string) (string, error) {
	path, content := spec[:max(len(spec)-1, 0)], spec
	if colon := strings.Index(spec, ":"); colon >= 0 {
		path, content = spec[:colon], spec[colon+1:]
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	target := path
	if !filepath.IsAbs(target) {
		target = filepath.Join(cwd, target)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(target, []byte(content), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// jval is a JSON value whose objects keep their keys in insertion order, and marshal serialises
// it the way JavaScript's JSON.stringify does: no spaces, no HTML escaping, U+2028 and U+2029
// raw (Go's encoding/json escapes both), and numbers in their shortest round-trip form.
type jval struct {
	kind byte // s string, n number, b bool, z null, a array, o object
	str  string
	num  float64
	bol  bool
	arr  []jval
	obj  []jfield
}

type jfield struct {
	key string
	val jval
}

func jstr(s string) jval      { return jval{kind: 's', str: s} }
func jnum(n float64) jval     { return jval{kind: 'n', num: n} }
func jbool(b bool) jval       { return jval{kind: 'b', bol: b} }
func jnull() jval             { return jval{kind: 'z'} }
func jarr(items ...jval) jval { return jval{kind: 'a', arr: items} }
func jobj(fields ...jfield) jval {
	return jval{kind: 'o', obj: fields}
}
func jf(key string, val jval) jfield { return jfield{key: key, val: val} }

func marshal(v jval) string {
	var b strings.Builder
	appendVal(&b, v)
	return b.String()
}

func appendVal(b *strings.Builder, v jval) {
	switch v.kind {
	case 's':
		b.WriteByte('"')
		appendJSStr(b, v.str)
		b.WriteByte('"')
	case 'n':
		b.WriteString(jsNumber(v.num))
	case 'b':
		b.WriteString(strconv.FormatBool(v.bol))
	case 'z':
		b.WriteString("null")
	case 'a':
		b.WriteByte('[')
		for i, item := range v.arr {
			if i > 0 {
				b.WriteByte(',')
			}
			appendVal(b, item)
		}
		b.WriteByte(']')
	case 'o':
		b.WriteByte('{')
		for i, f := range v.obj {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteByte('"')
			appendJSStr(b, f.key)
			b.WriteString("\":")
			appendVal(b, f.val)
		}
		b.WriteByte('}')
	}
}

// appendJSStr escapes exactly like JSON.stringify: only ", \ and the C0 controls (with the
// two-character forms for \b \f \n \r \t); invalid UTF-8 becomes U+FFFD, which is how Node
// decodes argv and the environment.
func appendJSStr(b *strings.Builder, s string) {
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
				continue
			}
			b.WriteRune(r)
		}
	}
}

// jsNumber formats a float the way JavaScript's Number::toString (and so JSON.stringify) does:
// plain decimal notation between 1e-6 and 1e21, exponent notation outside it, and -0 prints
// as 0. The exponent drops its leading zero (e-07 becomes e-7).
func jsNumber(f float64) string {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "null"
	}
	if f == 0 {
		return "0"
	}
	format := byte('f')
	if abs := math.Abs(f); abs < 1e-6 || abs >= 1e21 {
		format = 'e'
	}
	b := strconv.AppendFloat(make([]byte, 0, 32), f, format, -1, 64)
	if format == 'e' {
		if n := len(b); n >= 4 && b[n-4] == 'e' && b[n-3] == '-' && b[n-2] == '0' {
			b[n-2] = b[n-1]
			b = b[:n-1]
		}
	}
	return string(b)
}

// parseJSON parses report JSON the way JSON.parse does, keeping object keys in their written
// order (a repeated key keeps its first position and takes the last value, like a JavaScript
// object) so the re-serialised structured_output matches JSON.stringify's byte for byte.
func parseJSON(text string) (jval, error) {
	p := &jparser{src: text}
	p.ws()
	v, err := p.value()
	if err != nil {
		return jval{}, err
	}
	p.ws()
	if p.pos != len(p.src) {
		return jval{}, fmt.Errorf("unexpected %q after the JSON value", p.src[p.pos:])
	}
	return v, nil
}

type jparser struct {
	src string
	pos int
}

func (p *jparser) ws() {
	for p.pos < len(p.src) {
		switch p.src[p.pos] {
		case ' ', '\t', '\n', '\r':
			p.pos++
		default:
			return
		}
	}
}

func (p *jparser) value() (jval, error) {
	if p.pos >= len(p.src) {
		return jval{}, fmt.Errorf("unexpected end of JSON")
	}
	switch c := p.src[p.pos]; {
	case c == '{':
		return p.object()
	case c == '[':
		return p.array()
	case c == '"':
		s, err := p.str()
		if err != nil {
			return jval{}, err
		}
		return jstr(s), nil
	case c == 't':
		return p.literal("true", jbool(true))
	case c == 'f':
		return p.literal("false", jbool(false))
	case c == 'n':
		return p.literal("null", jnull())
	default:
		return p.number()
	}
}

func (p *jparser) object() (jval, error) {
	p.pos++ // {
	v := jobj()
	p.ws()
	if p.pos < len(p.src) && p.src[p.pos] == '}' {
		p.pos++
		return v, nil
	}
	for {
		p.ws()
		if p.pos >= len(p.src) || p.src[p.pos] != '"' {
			return jval{}, fmt.Errorf("expected a key at %d", p.pos)
		}
		key, err := p.str()
		if err != nil {
			return jval{}, err
		}
		p.ws()
		if p.pos >= len(p.src) || p.src[p.pos] != ':' {
			return jval{}, fmt.Errorf("expected : at %d", p.pos)
		}
		p.pos++
		p.ws()
		val, err := p.value()
		if err != nil {
			return jval{}, err
		}
		replaced := false
		for i := range v.obj {
			if v.obj[i].key == key {
				v.obj[i].val = val
				replaced = true
				break
			}
		}
		if !replaced {
			v.obj = append(v.obj, jf(key, val))
		}
		p.ws()
		if p.pos >= len(p.src) {
			return jval{}, fmt.Errorf("unterminated object")
		}
		switch p.src[p.pos] {
		case ',':
			p.pos++
		case '}':
			p.pos++
			return v, nil
		default:
			return jval{}, fmt.Errorf("expected , or } at %d", p.pos)
		}
	}
}

func (p *jparser) array() (jval, error) {
	p.pos++ // [
	v := jarr()
	p.ws()
	if p.pos < len(p.src) && p.src[p.pos] == ']' {
		p.pos++
		return v, nil
	}
	for {
		p.ws()
		item, err := p.value()
		if err != nil {
			return jval{}, err
		}
		v.arr = append(v.arr, item)
		p.ws()
		if p.pos >= len(p.src) {
			return jval{}, fmt.Errorf("unterminated array")
		}
		switch p.src[p.pos] {
		case ',':
			p.pos++
		case ']':
			p.pos++
			return v, nil
		default:
			return jval{}, fmt.Errorf("expected , or ] at %d", p.pos)
		}
	}
}

func (p *jparser) literal(word string, v jval) (jval, error) {
	if strings.HasPrefix(p.src[p.pos:], word) {
		p.pos += len(word)
		return v, nil
	}
	return jval{}, fmt.Errorf("expected %s at %d", word, p.pos)
}

func (p *jparser) str() (string, error) {
	p.pos++ // opening quote
	var b strings.Builder
	for p.pos < len(p.src) {
		switch c := p.src[p.pos]; {
		case c == '"':
			p.pos++
			return b.String(), nil
		case c == '\\':
			p.pos++
			if p.pos >= len(p.src) {
				return "", fmt.Errorf("unterminated escape")
			}
			if err := p.escape(&b); err != nil {
				return "", err
			}
		case c < 0x20:
			return "", fmt.Errorf("raw control character in a string")
		default:
			b.WriteByte(c)
			p.pos++
		}
	}
	return "", fmt.Errorf("unterminated string")
}

func (p *jparser) escape(b *strings.Builder) error {
	switch e := p.src[p.pos]; e {
	case '"', '\\', '/':
		b.WriteByte(e)
		p.pos++
	case 'b':
		b.WriteByte('\b')
		p.pos++
	case 'f':
		b.WriteByte('\f')
		p.pos++
	case 'n':
		b.WriteByte('\n')
		p.pos++
	case 'r':
		b.WriteByte('\r')
		p.pos++
	case 't':
		b.WriteByte('\t')
		p.pos++
	case 'u':
		p.pos++
		r, err := p.hex4()
		if err != nil {
			return err
		}
		// a leading surrogate only counts with its trailing half
		if utf16.IsSurrogate(rune(r)) && p.pos+1 < len(p.src) && p.src[p.pos] == '\\' && p.src[p.pos+1] == 'u' {
			saved := p.pos
			p.pos += 2
			second, err := p.hex4()
			if err == nil {
				if combined := utf16.DecodeRune(rune(r), rune(second)); combined != utf8.RuneError {
					b.WriteRune(combined)
					return nil
				}
			}
			p.pos = saved
		}
		if r < 0x20 {
			// the round trip keeps C0 controls escaped
			fmt.Fprintf(b, `\u%04x`, r)
			return nil
		}
		b.WriteRune(rune(r))
	default:
		return fmt.Errorf("bad escape \\%c", e)
	}
	return nil
}

func (p *jparser) hex4() (int, error) {
	if p.pos+4 > len(p.src) {
		return 0, fmt.Errorf("truncated \\u escape")
	}
	v, err := strconv.ParseUint(p.src[p.pos:p.pos+4], 16, 32)
	if err != nil {
		return 0, fmt.Errorf("bad \\u escape at %d", p.pos)
	}
	p.pos += 4
	return int(v), nil
}

func (p *jparser) number() (jval, error) {
	start := p.pos
	for p.pos < len(p.src) && strings.IndexByte("-+.eE0123456789", p.src[p.pos]) >= 0 {
		p.pos++
	}
	lexeme := p.src[start:p.pos]
	if !validJSONNumber(lexeme) {
		return jval{}, fmt.Errorf("bad number %q at %d", lexeme, start)
	}
	f, err := strconv.ParseFloat(lexeme, 64)
	if err != nil {
		return jval{}, fmt.Errorf("bad number %q at %d", lexeme, start)
	}
	return jnum(f), nil
}

// validJSONNumber enforces the JSON grammar, which strconv.ParseFloat alone does not ("+1",
// "1.", ".5", "Infinity" and hex all parse there but JSON.parse rejects them).
func validJSONNumber(s string) bool {
	i := 0
	if i < len(s) && s[i] == '-' {
		i++
	}
	digits := func() int {
		start := i
		for i < len(s) && s[i] >= '0' && s[i] <= '9' {
			i++
		}
		return i - start
	}
	ints := digits()
	if ints == 0 {
		return false
	}
	if ints > 1 && s[i-ints] == '0' {
		return false
	}
	if i < len(s) && s[i] == '.' {
		i++
		if digits() == 0 {
			return false
		}
	}
	if i < len(s) && (s[i] == 'e' || s[i] == 'E') {
		i++
		if i < len(s) && (s[i] == '+' || s[i] == '-') {
			i++
		}
		if digits() == 0 {
			return false
		}
	}
	return i == len(s)
}
