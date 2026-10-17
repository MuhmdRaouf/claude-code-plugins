package testkit

import (
	"context"
	"fmt"
	"slices"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// TEST_KEY is a key no real provider issues; tests grep their own output for it.
const TEST_KEY = "zt-SECRET.key_0123456789abcdef"

// RunCall is one tool run a FakeRunner recorded.
type RunCall struct {
	Cmd   string
	Args  []string
	Stdin *string
}

// RunResult is what a platform tool returned. Missing means the tool itself could not be started;
// a nil Code is a signal.
type RunResult struct {
	Code    *int
	Stdout  string
	Stderr  string
	Missing bool
}

// Runner runs one tool without a shell; stdin, when given, is written and closed. Tests pass a
// fake.
type Runner func(ctx context.Context, cmd string, args []string, stdin *string) RunResult

// FakeRunner is a Runner that records every call and answers through Answer (default: exit 0, no
// output).
type FakeRunner struct {
	Calls  []RunCall
	Answer func(call RunCall) RunResult
}

// NewFakeRunner returns a runner answering exit 0, no output, recording every call.
func NewFakeRunner() *FakeRunner {
	return &FakeRunner{}
}

// Run records the call and answers it.
func (f *FakeRunner) Run(ctx context.Context, cmd string, args []string, stdin *string) RunResult {
	call := RunCall{Cmd: cmd, Args: slices.Clone(args), Stdin: stdin}
	f.Calls = append(f.Calls, call)
	if f.Answer == nil {
		code := 0
		return RunResult{Code: &code, Stdout: "", Stderr: ""}
	}
	return f.Answer(call)
}

// Argv is every argv element of every call, the command included.
func (f *FakeRunner) Argv() []string {
	var argv []string
	for _, call := range f.Calls {
		argv = append(argv, call.Cmd)
		argv = append(argv, call.Args...)
	}
	return argv
}

// MemoryKeyStore is an in-memory store: what a fake page fills and setup polls. Value is "" for no
// key, which no real key ever is (they are 16-512 characters).
type MemoryKeyStore struct {
	Value   string
	Sets    int
	Removes int
	FailSet bool

	kind  ports.KeyStoreKind
	label string
}

var _ ports.KeyStore = (*MemoryKeyStore)(nil)

// NewMemoryKeyStore returns an in-memory store; an empty kind or label means the defaults
// (macOS Keychain).
func NewMemoryKeyStore(kind ports.KeyStoreKind, label string, value string) *MemoryKeyStore {
	if kind == "" {
		kind = ports.KeyStoreMacOS
	}
	if label == "" {
		label = "macOS Keychain"
	}
	return &MemoryKeyStore{kind: kind, label: label, Value: value}
}

// Kind is which store the key lives in at rest.
func (s *MemoryKeyStore) Kind() ports.KeyStoreKind {
	return s.kind
}

// Label is how setup and status lines name the store.
func (s *MemoryKeyStore) Label() string {
	return s.label
}

// Available is always true.
func (s *MemoryKeyStore) Available(ctx context.Context) bool {
	return true
}

// Get is the stored key, false when there is none.
func (s *MemoryKeyStore) Get(ctx context.Context) (string, bool) {
	return s.Value, s.Value != ""
}

// Set stores the key. FailSet refuses it the way a failing store tool would.
func (s *MemoryKeyStore) Set(ctx context.Context, key string) error {
	if s.FailSet {
		return fmt.Errorf("could not store the key in %s (exit 1)", s.label)
	}
	s.Sets++
	s.Value = key
	return nil
}

// Remove forgets the key.
func (s *MemoryKeyStore) Remove(ctx context.Context) error {
	s.Removes++
	s.Value = ""
	return nil
}
