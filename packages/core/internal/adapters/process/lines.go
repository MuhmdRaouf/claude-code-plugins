// Stream plumbing for child processes: a byte stream cut into lines, and the queue that turns stream
// callbacks into a channel a consumer drains at its own pace.
package process

import (
	"bytes"
	"io"
	"sync"
)

// DefaultMaxLineBytes is the default line budget: one MiB, omp's longest single frame.
const DefaultMaxLineBytes int64 = 1024 * 1024

// EachLine calls onLine per line (complete unless it is the unterminated last one) and onEnd once, at
// EOF, when the read fails, or when the line budget is passed. A line that passes maxLineBytes with no
// newline is dropped rather than buffered: onOverflow fires and the reader is closed, so a blocked read
// ends too. Splitting happens on "\n" alone; a "\r\n" line keeps its "\r".
func EachLine(r io.Reader, onLine func(line string, complete bool), onEnd func(), onOverflow func(), maxLineBytes int64) {
	var partial []byte
	ended := false
	// end flushes the unterminated last line; the overflow path passes false so the oversized line
	// never surfaces.
	end := func(flush bool) {
		if ended {
			return
		}
		ended = true
		if flush && len(partial) > 0 {
			onLine(string(partial), false)
		}
		partial = nil
		onEnd()
	}
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			partial = append(partial, buf[:n]...)
			if cut := bytes.LastIndexByte(partial, '\n'); cut >= 0 {
				region := partial[:cut+1]
				for {
					i := bytes.IndexByte(region, '\n')
					if i < 0 {
						break
					}
					onLine(string(region[:i]), true)
					region = region[i+1:]
				}
				partial = append(partial[:0], partial[cut+1:]...)
			}
			if int64(len(partial)) > maxLineBytes {
				end(false)
				if onOverflow != nil {
					onOverflow()
				}
				if closer, ok := r.(io.Closer); ok {
					closer.Close()
				}
				return
			}
		}
		if err != nil {
			end(true)
			return
		}
	}
}

// Queue is the single-consumer queue bridging a producer to a channel. Items are held until read, so a
// consumer that stops receiving lets memory grow without bound — keep receiving until Close ends the
// stream.
type Queue[T any] struct {
	mu     sync.Mutex
	cond   *sync.Cond
	buffer []T
	head   int
	closed bool
	items  chan T
}

// compactAfter: consumed items are compacted away in batches, so a long run does not keep its whole
// history in memory.
const compactAfter = 1024

// CreateQueue builds a queue whose pump goroutine moves buffered items to the Items channel until
// Close ends it.
func CreateQueue[T any]() *Queue[T] {
	q := &Queue[T]{items: make(chan T)}
	q.cond = sync.NewCond(&q.mu)
	go q.pump()
	return q
}

// Push adds one item; dropped when the queue is closed.
func (q *Queue[T]) Push(item T) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return
	}
	q.buffer = append(q.buffer, item)
	q.cond.Signal()
}

// Close ends the stream: items still buffered are delivered first, then the Items channel closes.
func (q *Queue[T]) Close() {
	q.mu.Lock()
	q.closed = true
	q.mu.Unlock()
	q.cond.Signal()
}

// Items is the one consumer channel.
func (q *Queue[T]) Items() <-chan T {
	return q.items
}

// pump delivers buffered items in order, in FIFO, until the queue is closed and drained.
func (q *Queue[T]) pump() {
	defer close(q.items)
	for {
		q.mu.Lock()
		for q.head >= len(q.buffer) && !q.closed {
			q.cond.Wait()
		}
		if q.head >= len(q.buffer) {
			q.mu.Unlock()
			return
		}
		item := q.buffer[q.head]
		q.head++
		if q.head >= compactAfter {
			q.buffer = q.buffer[q.head:]
			q.head = 0
		}
		q.mu.Unlock()
		q.items <- item
	}
}
