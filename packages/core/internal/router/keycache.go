// The provider key as the router serves it: one shared, kept lookup per worker. The store is the
// expensive step (a keychain that hangs on an unlock prompt nobody answers), so it is read once at
// a time under the cache's own deadline — a share of the key budget — and the key file gets the
// rest of the budget when the store does not answer in its share.
package router

import (
	"context"
	"sync"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// keyAnswer is one lookup's outcome: the key with its source, why there is none, and whether the
// store's share of the budget ran out before any key was found (a request then answers the
// timeout, not "no key").
type keyAnswer struct {
	key      ports.ProviderKey
	err      *ports.WorkerError
	timedOut bool
}

// keyRun is the one shared lookup: its answer is written once, before done closes.
type keyRun struct {
	answer keyAnswer
	done   chan struct{}
}

// keyCache is the worker's provider key: one in-flight lookup every reader shares (provider
// requests, the warm read at start, the front's key checks), its answer kept until the provider
// refuses it. The lookup runs under the cache's own deadline and no caller's context, so one
// request's end never ends the shared read, and a hung store is asked once instead of once per
// request.
type keyCache struct {
	lookup func(ctx context.Context) (ports.ProviderKey, *ports.WorkerError)
	budget time.Duration
	mu     sync.Mutex
	held   bool
	answer keyAnswer
	// pending is the lookup in flight; nil when none is.
	pending *keyRun
}

func newKeyCache(lookup func(ctx context.Context) (ports.ProviderKey, *ports.WorkerError), budget time.Duration) *keyCache {
	return &keyCache{lookup: lookup, budget: budget}
}

// get is the key within ctx: the kept answer at once, else the outcome of the one lookup in
// flight (started by this call when none is). A caller whose context ends first sees a timeout —
// its request is answered by nobody anyway.
func (c *keyCache) get(ctx context.Context) keyAnswer {
	c.mu.Lock()
	if c.held {
		answer := c.answer
		c.mu.Unlock()
		return answer
	}
	if c.pending == nil {
		c.pending = &keyRun{done: make(chan struct{})}
		go c.run(c.pending)
	}
	pending := c.pending
	c.mu.Unlock()
	select {
	case <-pending.done:
		return pending.answer
	case <-ctx.Done():
		return keyAnswer{timedOut: true}
	}
}

// run performs one shared lookup: the store's share of the budget bounds it, and an answer that
// found a key is kept for every later reader.
func (c *keyCache) run(run *keyRun) {
	ctx, cancel := context.WithTimeout(context.Background(), c.budget)
	key, err := c.lookup(ctx)
	// The deadline is read before cancel: cancel would make it read Canceled.
	ranOut := ctx.Err() == context.DeadlineExceeded
	cancel()
	run.answer = keyAnswer{key: key, err: err, timedOut: key.Value == "" && ranOut}
	c.mu.Lock()
	if key.Value != "" {
		c.held = true
		c.answer = run.answer
	}
	if c.pending == run {
		c.pending = nil
	}
	c.mu.Unlock()
	close(run.done)
}

// clear forgets the kept answer: the provider refused the key (it may have been rotated), so the
// next read goes back to the store. A lookup already in flight keeps its place.
func (c *keyCache) clear() {
	c.mu.Lock()
	c.held = false
	c.answer = keyAnswer{}
	c.mu.Unlock()
}

// warm starts the first lookup now, so the first request normally finds the key ready.
func (c *keyCache) warm() {
	go func() { c.get(context.Background()) }()
}
