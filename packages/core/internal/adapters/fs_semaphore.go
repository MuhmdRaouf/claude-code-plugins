package adapters

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// The file-backed slot semaphore. <root>/slots/<jobId>.slot is created exclusively (complete
// with its pid, or not at all); stale holders (dead pid) are reclaimed; polls every 2 s. A job
// waiting for a slot leaves <jobId>.ticket (its pid, priority and enqueue time) under the same
// mutex, so a freed slot goes to the oldest live ticket of the higher priority — a dead waiter's
// ticket is reclaimed like a dead holder's slot. Counting and creating slots and tickets happen
// under one mutex file, so processes racing for the last slot cannot both win.

const (
	// semPollMs is how often a waiter re-checks the slots and the tickets.
	semPollMs = 2_000
	// The mutex is held only to count and create slots and tickets; this long means its holder
	// is stuck, so retry next poll.
	semMutexTimeoutMs = 10_000
	semSlotSuffix     = ".slot"
	semTicketSuffix   = ".ticket"
	// jsMaxSafeInteger bounds a ticket's pid: the ticket files carry pids as
	// JSON numbers, exact only up to JS Number.MAX_SAFE_INTEGER.
	jsMaxSafeInteger = 9_007_199_254_740_991
)

// Capacity reads how many slots exist right now (the limiter's current cap).
type Capacity func(ctx context.Context) (int, error)

// Sleep waits for ms to pass, returning the context's error when it is cancelled first.
type Sleep func(ctx context.Context, ms int64) error

// Now is the epoch-ms clock the queue's waiting order is stamped with.
type Now func() int64

// semTicketBody is the JSON a ticket file carries; the fields a ticket body must carry to be one,
// anything else being nobody's.
type semTicketBody struct {
	Pid      *float64 `json:"pid"`
	Priority *string  `json:"priority"`
	QueuedAt *float64 `json:"queuedAt"`
}

// semSlot is one slot file: the job it belongs to and the pid holding it (nil: content nobody
// wrote, so nobody holds it).
type semSlot struct {
	JobID string
	Pid   *int64
}

// semTicket is one ticket file; a pid of nil is a ticket nobody can take a turn for.
type semTicket struct {
	JobID    string
	Pid      *int64
	Priority domain.Priority
	QueuedAt int64
}

type fsSemaphore struct {
	dir      string
	capacity Capacity
	isAlive  IsAlive
	sleep    Sleep
	now      Now
}

// CreateFsSemaphore is the slot queue jobs wait in before a worker starts, over <root>/slots.
func CreateFsSemaphore(root string, capacity Capacity, isAlive IsAlive, sleep Sleep, now Now) ports.Semaphore {
	return &fsSemaphore{
		dir:      domain.NewStateLayout(root).Slots,
		capacity: capacity,
		isAlive:  isAlive,
		sleep:    sleep,
		now:      now,
	}
}

func (s *fsSemaphore) slotPath(jobID string) string {
	return filepath.Join(s.dir, jobID+semSlotSuffix)
}

func (s *fsSemaphore) ticketPath(jobID string) string {
	return filepath.Join(s.dir, jobID+semTicketSuffix)
}

func (s *fsSemaphore) live(slot semSlot) bool {
	return slot.Pid != nil && s.isAlive(*slot.Pid)
}

func (s *fsSemaphore) waiting(ticket semTicket) bool {
	return ticket.Pid != nil && s.isAlive(*ticket.Pid)
}

// slots is every slot file, sorted by name; a file released between the readdir and the read is
// dropped, and content nobody wrote reads as nobody's.
func (s *fsSemaphore) slots(ctx context.Context) ([]semSlot, error) {
	names, err := s.slotNames(semSlotSuffix)
	if err != nil {
		return nil, err
	}
	found := make([]semSlot, 0, len(names))
	for _, name := range names {
		pid, exists, held, err := ReadHolder(ctx, filepath.Join(s.dir, name))
		if err != nil {
			return nil, err
		}
		if !exists {
			continue
		}
		slot := semSlot{JobID: strings.TrimSuffix(name, semSlotSuffix)}
		if held {
			slot.Pid = &pid
		}
		found = append(found, slot)
	}
	return found, nil
}

// tickets is every ticket file, sorted by name; a file removed between the readdir and the read
// is dropped, and a ticket we cannot read as one of ours is nobody's, exactly like a slot file
// nobody holds.
func (s *fsSemaphore) tickets(ctx context.Context) ([]semTicket, error) {
	names, err := s.slotNames(semTicketSuffix)
	if err != nil {
		return nil, err
	}
	found := make([]semTicket, 0, len(names))
	for _, name := range names {
		path := filepath.Join(s.dir, name)
		var text []byte
		err := retryBusy(func() error {
			var readErr error
			text, readErr = os.ReadFile(path)
			return readErr
		})
		if err != nil {
			if fsutil.ErrnoCode(err) == "ENOENT" {
				continue
			}
			return nil, err
		}
		found = append(found, parseTicket(strings.TrimSuffix(name, semTicketSuffix), string(text)))
	}
	return found, nil
}

func (s *fsSemaphore) slotNames(suffix string) ([]string, error) {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		if fsutil.ErrnoCode(err) == "ENOENT" {
			return nil, nil
		}
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), suffix) {
			names = append(names, entry.Name())
		}
	}
	slices.Sort(names)
	return names, nil
}

func parseTicket(jobID string, text string) semTicket {
	var body semTicketBody
	if err := json.Unmarshal([]byte(text), &body); err != nil {
		return nobodyTicket(jobID)
	}
	if body.Pid == nil || body.Priority == nil || body.QueuedAt == nil ||
		*body.Pid <= 0 || *body.Pid > jsMaxSafeInteger || *body.Pid != math.Trunc(*body.Pid) ||
		(*body.Priority != string(domain.PriorityHigh) && *body.Priority != string(domain.PriorityNormal)) {
		return nobodyTicket(jobID)
	}
	pid := int64(*body.Pid)
	return semTicket{
		JobID:    jobID,
		Pid:      &pid,
		Priority: domain.Priority(*body.Priority),
		QueuedAt: int64(*body.QueuedAt),
	}
}

func nobodyTicket(jobID string) semTicket {
	return semTicket{JobID: jobID, Priority: domain.PriorityNormal}
}

// byTurn orders the queue: the higher priority first, then the older ticket; the jobId breaks a
// tie so every waiter ranks the queue the same.
func byTurn(a, b semTicket) int {
	if rank(b.Priority) != rank(a.Priority) {
		return rank(b.Priority) - rank(a.Priority)
	}
	if a.QueuedAt != b.QueuedAt {
		return int(a.QueuedAt - b.QueuedAt)
	}
	if a.JobID < b.JobID {
		return -1
	}
	return 1
}

func rank(priority domain.Priority) int {
	if priority == domain.PriorityHigh {
		return 1
	}
	return 0
}

// reclaim puts dead holders' slots and dead waiters' tickets back in the pool for whoever waits
// next.
func (s *fsSemaphore) reclaim(ctx context.Context, current []semSlot, queued []semTicket) error {
	for _, slot := range current {
		if !s.live(slot) {
			if err := removeForce(s.slotPath(slot.JobID)); err != nil {
				return err
			}
		}
	}
	for _, ticket := range queued {
		if !s.waiting(ticket) {
			if err := removeForce(s.ticketPath(ticket.JobID)); err != nil {
				return err
			}
		}
	}
	return nil
}

// queueTicket leaves our ticket: the live one a previous round left, or a fresh one stamped with
// when we started waiting.
func (s *fsSemaphore) queueTicket(ctx context.Context, queued []semTicket, holder ports.SemaphoreHolder) (semTicket, error) {
	for _, ticket := range queued {
		if s.waiting(ticket) && ticket.JobID == holder.JobID {
			return ticket, nil
		}
	}
	// Floats and strings only: the body's marshal cannot fail.
	body, _ := json.Marshal(semTicketBody{
		Pid:      ptr(float64(holder.Pid)),
		Priority: ptr(string(holder.Priority)),
		QueuedAt: ptr(float64(s.now())),
	})
	created, err := CreateExclusive(ctx, s.ticketPath(holder.JobID), string(body))
	if err != nil || !created {
		return semTicket{}, err
	}
	return parseTicket(holder.JobID, string(body)), nil
}

// ourTurn says a slot is ours to take: one is free, and the queue's next turn is ours — a freed
// slot belongs to the oldest live ticket of the higher priority, and only its own round grants
// it.
func (s *fsSemaphore) ourTurn(ctx context.Context, current []semSlot, queued []semTicket, mine semTicket, jobID string) (bool, error) {
	held := 0
	for _, slot := range current {
		if s.live(slot) {
			held++
		}
	}
	capacity, err := s.capacity(ctx)
	if err != nil {
		return false, err
	}
	if held >= capacity {
		return false, nil
	}
	queue := make([]semTicket, 0, len(queued)+1)
	for _, ticket := range queued {
		if s.waiting(ticket) && ticket.JobID != jobID {
			queue = append(queue, ticket)
		}
	}
	queue = append(queue, mine)
	slices.SortFunc(queue, byTurn)
	return queue[0].JobID == jobID, nil
}

// tryAcquire is one round under the mutex: drop dead holders' slots and dead waiters' tickets,
// queue our ticket, then take a slot if the capacity allows and the next turn is ours. A nil
// release with no error just means "not this round".
func (s *fsSemaphore) tryAcquire(ctx context.Context, holder ports.SemaphoreHolder) (func(), error) {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return nil, err
	}
	mutex, err := WaitLock(ctx, filepath.Join(s.dir, ".mutex"), holder.Pid, s.isAlive, semMutexTimeoutMs)
	if err != nil {
		return nil, nil
	}
	defer func() { _ = mutex(ctx) }()

	current, err := s.slots(ctx)
	if err != nil {
		return nil, err
	}
	for _, slot := range current {
		if s.live(slot) && slot.JobID == holder.JobID {
			// This job already holds a slot; its re-drive waits for the old one to go.
			return nil, nil
		}
	}
	queued, err := s.tickets(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.reclaim(ctx, current, queued); err != nil {
		return nil, err
	}
	mine, err := s.queueTicket(ctx, queued, holder)
	if err != nil {
		return nil, err
	}
	if mine.Pid == nil {
		return nil, nil
	}
	turn, err := s.ourTurn(ctx, current, queued, mine, holder.JobID)
	if err != nil {
		return nil, err
	}
	if !turn {
		return nil, nil
	}
	created, err := CreateHolding(ctx, s.slotPath(holder.JobID), holder.Pid)
	if err != nil {
		return nil, err
	}
	if !created {
		return nil, nil
	}
	if err := removeForce(s.ticketPath(holder.JobID)); err != nil {
		return nil, err
	}
	return func() { _ = release(context.Background(), s.slotPath(holder.JobID), holder.Pid) }, nil
}

func (s *fsSemaphore) Acquire(ctx context.Context, holder ports.SemaphoreHolder) (func(), error) {
	// An acquire that gives up waiting leaves no ticket behind to keep its turn.
	defer func() { _ = removeForce(s.ticketPath(holder.JobID)) }()
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		slot, err := s.tryAcquire(ctx, holder)
		if err != nil {
			return nil, err
		}
		if slot != nil {
			if ctx.Err() == nil {
				return slot, nil
			}
			// Aborted while the round ran: give the slot straight back so an aborted acquire
			// holds nothing.
			slot()
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		if err := s.sleep(ctx, semPollMs); err != nil {
			// Reject with the caller's cancellation whatever the injected sleep returned.
			if ctxErr := ctx.Err(); ctxErr != nil {
				return nil, ctxErr
			}
			return nil, err
		}
	}
}

func (s *fsSemaphore) Held(ctx context.Context) []ports.HeldSlot {
	current, err := s.slots(ctx)
	if err != nil {
		return nil
	}
	held := make([]ports.HeldSlot, 0, len(current))
	for _, slot := range current {
		if s.live(slot) {
			held = append(held, ports.HeldSlot{JobID: slot.JobID, Pid: *slot.Pid})
		}
	}
	return held
}

// ptr returns a pointer to value, the shorthand the ticket body's float fields need.
func ptr[T any](value T) *T { return &value }
