package adapters

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strconv"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// The file-backed job store. Layout: <root>/jobs/<id>/{job.json, brief.md, attempt-<n>.jsonl,
// gate-<n>-<i>.log, artifacts/, driver.lock, stop}. job.json writes are atomic (write tmp +
// rename) under a short lock; the version is checked before the rename.

// job.json writes hold this lock only for read-compare-rename; waiting longer means something is
// wrong.
const writeLockTimeoutMs = 10_000

// safeID: ids become directory names, so no separators and no dot-dirs.
var safeID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// jobStates is the state half of the stored-job shape check.
var jobStates = []domain.JobState{
	domain.JobStateQueued, domain.JobStateRunning, domain.JobStateVerifying,
	domain.JobStateAwaitingReview, domain.JobStateAccepted, domain.JobStateDiscarded,
}

// storedJobShape is the shallow shape check of a stored job: enough to tell our file from a
// foreign or truncated one. A pointer nils exactly where the zod schema required the key, so a
// missing or mis-typed field reads as unreadable the way zod's safeParse fails.
type storedJobShape struct {
	ID        *string `json:"id"`
	Version   *int64  `json:"version"`
	State     *string `json:"state"`
	CreatedAt *string `json:"createdAt"`
	UpdatedAt *string `json:"updatedAt"`
	Brief     *struct {
		Title *string `json:"title"`
	} `json:"brief"`
	Workspace *struct {
		RepoRoot *string `json:"repoRoot"`
	} `json:"workspace"`
	Attempts *json.RawMessage `json:"attempts"`
	Origin   json.RawMessage  `json:"origin"`
}

// parseJob turns a job.json's text into a Job: the shape was validated by the caller, and the
// stored file is written only by this store. A job naming zai's main tier "glm" (the tiers are
// main and flash) reads as "main"; an origin that is not a session id is dropped rather than
// surviving the read into later writes.
func parseJob(text string) (domain.Job, error) {
	var shape storedJobShape
	if err := json.Unmarshal([]byte(text), &shape); err != nil {
		return domain.Job{}, err
	}
	if shape.ID == nil || shape.Version == nil || *shape.Version < 0 || shape.State == nil ||
		shape.CreatedAt == nil || shape.UpdatedAt == nil ||
		shape.Brief == nil || shape.Brief.Title == nil ||
		shape.Workspace == nil || shape.Workspace.RepoRoot == nil ||
		shape.Attempts == nil || len(*shape.Attempts) == 0 || (*shape.Attempts)[0] != '[' {
		return domain.Job{}, errors.New("not a stored job")
	}
	if !slices.Contains(jobStates, domain.JobState(*shape.State)) {
		return domain.Job{}, errors.New("unknown state " + strconv.Quote(*shape.State))
	}

	// The origin is read from the raw value the way the zod loose object kept it: anything that
	// is not a session id reads as no origin at all, so it must not reach the Job's own decode.
	// The fragment and the re-marshalled map are valid JSON by construction, so neither decode
	// can fail here.
	stored := text
	if len(shape.Origin) > 0 {
		var raw any
		_ = json.Unmarshal(shape.Origin, &raw)
		if domain.StoredOrigin(raw) == nil {
			var fields map[string]json.RawMessage
			_ = json.Unmarshal([]byte(text), &fields)
			delete(fields, "origin")
			without, _ := json.Marshal(fields)
			stored = string(without)
		}
	}

	var job domain.Job
	if err := json.Unmarshal([]byte(stored), &job); err != nil {
		return domain.Job{}, err
	}
	if job.Brief.Model == "glm" {
		job.Brief.Model = domain.ModelTierMain
	}
	return job, nil
}

// newestFirst orders a listing: the newest createdAt first, ties by id (code-unit order; ISO
// timestamps and ids sort correctly, locale collation is not guaranteed to).
func newestFirst(a, b domain.Job) int {
	if a.CreatedAt != b.CreatedAt {
		if b.CreatedAt < a.CreatedAt {
			return -1
		}
		return 1
	}
	if a.ID != b.ID {
		if b.ID < a.ID {
			return -1
		}
		return 1
	}
	return 0
}

// storeIO keeps an unexpected filesystem failure from escaping the port: the store's own errors
// pass through, everything else becomes io.
func storeIO(err error) error {
	var storeErr *ports.StoreError
	if errors.As(err, &storeErr) {
		return storeErr
	}
	return &ports.StoreError{Kind: ports.StoreErrorIO, Message: fsutil.ErrorMessage(err)}
}

type fsStore struct {
	layout  domain.StateLayout
	isAlive IsAlive
}

// CreateFsStore is the job records under root, with optimistic concurrency and the driver lock.
func CreateFsStore(root string, isAlive IsAlive) ports.JobStore {
	return &fsStore{layout: domain.NewStateLayout(root), isAlive: isAlive}
}

func (s *fsStore) jobFile(id string) string { return s.layout.Job(id).Record }

// ids is every job directory under jobs/ with a name fit to be one.
func (s *fsStore) ids() ([]string, error) {
	entries, err := os.ReadDir(s.layout.Jobs)
	if err != nil {
		if fsutil.ErrnoCode(err) == "ENOENT" {
			return nil, nil
		}
		return nil, err
	}
	ids := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() && safeID.MatchString(entry.Name()) {
			ids = append(ids, entry.Name())
		}
	}
	return ids, nil
}

// read is one job's record; unreadable content is io, a missing job is not_found.
func (s *fsStore) read(ctx context.Context, id string) (domain.Job, error) {
	if !safeID.MatchString(id) {
		return domain.Job{}, &ports.StoreError{Kind: ports.StoreErrorNotFound, ID: id}
	}
	text, err := os.ReadFile(s.jobFile(id))
	if err != nil {
		if fsutil.ErrnoCode(err) == "ENOENT" {
			return domain.Job{}, &ports.StoreError{Kind: ports.StoreErrorNotFound, ID: id}
		}
		return domain.Job{}, err
	}
	job, err := parseJob(string(text))
	if err != nil {
		return domain.Job{}, fmt.Errorf("job %s: unreadable job.json: %w", id, err)
	}
	return job, nil
}

// exclusively runs fn holding the job's write lock, so read-compare-write sequences of
// concurrent writers never interleave.
func (s *fsStore) exclusively(ctx context.Context, id string, fn func() (domain.Job, error)) (domain.Job, error) {
	lock, err := WaitLock(ctx, s.jobFile(id)+".lock", int64(os.Getpid()), s.isAlive, writeLockTimeoutMs)
	var held *HeldError
	if errors.As(err, &held) {
		return domain.Job{}, fmt.Errorf("job %s: write lock still held by pid %d", id, held.HolderPid)
	}
	if err != nil {
		return domain.Job{}, err
	}
	defer func() { _ = lock(ctx) }()
	return fn()
}

// write bumps the version and stores the job atomically.
func (s *fsStore) write(ctx context.Context, job domain.Job) (domain.Job, error) {
	job.Version++
	data, err := fsutil.MarshalJSON(job)
	if err != nil {
		return domain.Job{}, err
	}
	if _, err := fsutil.WriteFileAtomic(ctx, s.jobFile(job.ID), data, fsutil.WriteOptions{}); err != nil {
		return domain.Job{}, err
	}
	return job, nil
}

func (s *fsStore) Create(ctx context.Context, job domain.Job) (domain.Job, error) {
	created, err := s.create(ctx, job)
	if err != nil {
		return domain.Job{}, storeIO(err)
	}
	return created, nil
}

func (s *fsStore) create(ctx context.Context, job domain.Job) (domain.Job, error) {
	if !safeID.MatchString(job.ID) {
		return domain.Job{}, fmt.Errorf("invalid job id %s", strconv.Quote(job.ID))
	}
	if err := os.MkdirAll(s.layout.Job(job.ID).Artifacts, 0o755); err != nil {
		return domain.Job{}, err
	}
	return s.exclusively(ctx, job.ID, func() (domain.Job, error) {
		if _, err := os.Stat(s.jobFile(job.ID)); err == nil {
			return domain.Job{}, fmt.Errorf("job %s already exists", job.ID)
		}
		return s.write(ctx, job)
	})
}

func (s *fsStore) Get(ctx context.Context, id string) (domain.Job, error) {
	job, err := s.read(ctx, id)
	if err != nil {
		return domain.Job{}, storeIO(err)
	}
	return job, nil
}

func (s *fsStore) Find(ctx context.Context, idOrPrefix string) (domain.Job, error) {
	job, err := s.find(ctx, idOrPrefix)
	if err != nil {
		return domain.Job{}, storeIO(err)
	}
	return job, nil
}

func (s *fsStore) find(ctx context.Context, idOrPrefix string) (domain.Job, error) {
	all, err := s.ids()
	if err != nil {
		return domain.Job{}, err
	}
	if slices.Contains(all, idOrPrefix) {
		return s.read(ctx, idOrPrefix)
	}
	matches := []string{}
	if idOrPrefix != "" {
		for _, id := range all {
			if len(id) >= len(idOrPrefix) && id[:len(idOrPrefix)] == idOrPrefix {
				matches = append(matches, id)
			}
		}
	}
	if len(matches) == 1 {
		return s.read(ctx, matches[0])
	}
	return domain.Job{}, &ports.StoreError{Kind: ports.StoreErrorNotFound, ID: idOrPrefix}
}

func (s *fsStore) Update(ctx context.Context, job domain.Job) (domain.Job, error) {
	updated, err := s.update(ctx, job)
	if err != nil {
		return domain.Job{}, storeIO(err)
	}
	return updated, nil
}

func (s *fsStore) update(ctx context.Context, job domain.Job) (domain.Job, error) {
	// Checked before locking too: the lock file lives in the job's directory.
	if _, err := s.read(ctx, job.ID); err != nil {
		return domain.Job{}, err
	}
	return s.exclusively(ctx, job.ID, func() (domain.Job, error) {
		current, err := s.read(ctx, job.ID)
		if err != nil {
			return domain.Job{}, err
		}
		if current.Version != job.Version {
			return domain.Job{}, &ports.StoreError{
				Kind: ports.StoreErrorVersionConflict, ID: job.ID,
				Expected: job.Version, Actual: current.Version,
			}
		}
		return s.write(ctx, job)
	})
}

func (s *fsStore) List(ctx context.Context, filter ports.ListFilter) []domain.Job {
	ids, err := s.ids()
	if err != nil {
		// The find and get paths report their damage; the port's listing cannot, and one broken
		// root must not panic the caller.
		return nil
	}
	jobs := make([]domain.Job, 0, len(ids))
	for _, id := range ids {
		// Half-created or corrupt entries are skipped: one bad directory must not hide every
		// other job.
		if job, err := s.read(ctx, id); err == nil &&
			(filter.RepoRoot == "" || job.Workspace.RepoRoot == filter.RepoRoot) {
			jobs = append(jobs, job)
		}
	}
	slices.SortFunc(jobs, newestFirst)
	return jobs
}

func (s *fsStore) Paths(id string) domain.JobPaths { return s.layout.Job(id) }

func (s *fsStore) Lock(ctx context.Context, id string, pid int64) (func(), error) {
	release, err := s.lock(ctx, id, pid)
	if err != nil {
		return nil, storeIO(err)
	}
	return release, nil
}

func (s *fsStore) lock(ctx context.Context, id string, pid int64) (func(), error) {
	if _, err := s.read(ctx, id); err != nil {
		return nil, err
	}
	lock, err := TryLock(ctx, s.layout.Job(id).DriverLock, pid, s.isAlive)
	var held *HeldError
	if errors.As(err, &held) {
		return nil, &ports.StoreError{Kind: ports.StoreErrorLocked, ID: id, HolderPid: held.HolderPid}
	}
	if err != nil {
		return nil, err
	}
	return func() { _ = lock(context.Background()) }, nil
}
