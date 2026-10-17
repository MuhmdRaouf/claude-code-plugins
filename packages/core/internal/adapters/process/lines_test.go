package process

import (
	"io"
	"strings"
	"testing"
	"time"
)

func TestEachLine(t *testing.T) {
	t.Run("splits on newlines and flushes the last line at EOF", func(t *testing.T) {
		// Two readers, two reads: the boundary between them is the chunk boundary.
		stream := io.MultiReader(strings.NewReader("one\ntw"), strings.NewReader("o\nthree"))
		var lines []string
		ended := 0
		EachLine(stream, func(line string, _ bool) { lines = append(lines, line) }, func() { ended++ }, nil, DefaultMaxLineBytes)
		if strings.Join(lines, "\x00") != "one\x00two\x00three" {
			t.Fatalf("lines = %q, want [one two three]", lines)
		}
		if ended != 1 {
			t.Fatalf("ended = %d, want 1", ended)
		}
	})

	t.Run("ends and destroys the stream when a line passes the byte limit without a newline", func(t *testing.T) {
		// A small limit keeps the test cheap; the real one is omp's one-MiB frame budget.
		reader, writer := io.Pipe()
		var lines []string
		ended := 0
		overflowed := 0
		done := make(chan struct{})
		go func() {
			defer close(done)
			EachLine(reader, func(line string, _ bool) { lines = append(lines, line) },
				func() { ended++ }, func() { overflowed++ }, 16)
		}()
		_, _ = writer.Write([]byte("kept\n"))
		_, _ = writer.Write([]byte(strings.Repeat("x", 17)))
		<-done
		if len(lines) != 1 || lines[0] != "kept" {
			t.Fatalf("lines = %q, want [kept]", lines)
		}
		if ended != 1 {
			t.Fatalf("ended = %d, want 1", ended)
		}
		if overflowed != 1 {
			t.Fatalf("overflowed = %d, want 1", overflowed)
		}
	})

	t.Run("overflows past the default one-MiB budget when no limit is given", func(t *testing.T) {
		stream := io.MultiReader(strings.NewReader("kept\n"),
			strings.NewReader(strings.Repeat("x", int(DefaultMaxLineBytes)+1)))
		var lines []string
		overflowed := 0
		EachLine(stream, func(line string, _ bool) { lines = append(lines, line) }, func() {},
			func() { overflowed++ }, DefaultMaxLineBytes)
		if len(lines) != 1 || lines[0] != "kept" {
			t.Fatalf("lines = %q, want [kept]", lines)
		}
		if overflowed != 1 {
			t.Fatalf("overflowed = %d, want 1", overflowed)
		}
	})
}

func TestCreateQueue(t *testing.T) {
	t.Run("yields items in order across compactions, waits for more, and ends on close", func(t *testing.T) {
		queue := CreateQueue[int]()
		for i := 0; i < 2_500; i++ {
			queue.Push(i)
		}
		seen := make([]int, 0, 3_000)
		done := make(chan struct{})
		go func() {
			defer close(done)
			for item := range queue.Items() {
				seen = append(seen, item)
			}
		}()
		time.Sleep(10 * time.Millisecond) // the reader drains the 2,500 and parks waiting for more
		queue.Push(2_500)
		queue.Close()
		queue.Push(9_999)
		<-done
		if len(seen) != 2_501 {
			t.Fatalf("received %d items, want 2501", len(seen))
		}
		for i, item := range seen {
			if item != i {
				t.Fatalf("seen[%d] = %d, want %d", i, item, i)
			}
		}
	})
}
