// The peer registry: every provider plugin's router announces itself here, so one plugin's
// router can forward another plugin's model ids to it and all five can be set up at once. One JSON
// file per plugin in a shared state dir, written atomically; nothing here ever holds a key.
package router

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// RegisteredRouter is one plugin's announcement: where its router listens and which model ids it
// serves.
type RegisteredRouter struct {
	Name          string   `json:"name"`
	Port          int64    `json:"port"`
	ModelPrefixes []string `json:"modelPrefixes"`
	CatalogIds    []string `json:"catalogIds"`
	Pid           *int64   `json:"pid,omitempty"`
	UpdatedAt     string   `json:"updatedAt"`
}

// stderrLog is the router's default log line, on the process's stderr; adapters and the spool
// have their own twins.
func stderrLog(line string) {
	fmt.Fprintln(os.Stderr, line)
}

// peerHealthPath is where a peer router answers its health check: every plugin's is
// `/<name>-router/health`.
func peerHealthPath(name string) string {
	return "/" + name + "-router/health"
}

// RoutersHome is the shared dir: $PROVIDER_ROUTERS_HOME, else ~/.agents/provider-routers (an old
// XDG one moves over). A nil log is stderrLog.
func RoutersHome(env domain.EnvLookup, log func(line string)) string {
	if home, ok := env["PROVIDER_ROUTERS_HOME"]; ok {
		return home
	}
	if log == nil {
		log = stderrLog
	}
	adapters.MigrateStateDir(context.Background(), "provider-routers", env, log)
	return adapters.AgentsStateDir(env, "provider-routers")
}

func entryFile(env domain.EnvLookup, name string) string {
	return filepath.Join(RoutersHome(env, nil), name+".json")
}

// ReadRegistry is every valid entry, sorted by plugin name; unreadable files are skipped, not
// fatal.
func ReadRegistry(env domain.EnvLookup) []RegisteredRouter {
	names, err := os.ReadDir(RoutersHome(env, nil))
	if err != nil {
		return nil
	}
	var entries []RegisteredRouter
	for _, file := range names {
		if !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		text, err := os.ReadFile(filepath.Join(RoutersHome(env, nil), file.Name()))
		if err != nil {
			continue
		}
		if entry, ok := parseEntry(string(text)); ok {
			entries = append(entries, entry)
		}
	}
	slices.SortFunc(entries, func(a, b RegisteredRouter) int {
		return strings.Compare(a.Name, b.Name)
	})
	return entries
}

// entryShape is the fields parseEntry demands, as raw values so a missing one and a mistyped one
// are told apart. Pid stays raw: absent is fine, null is not.
type entryShape struct {
	Name          *string         `json:"name"`
	Port          *float64        `json:"port"`
	ModelPrefixes *[]string       `json:"modelPrefixes"`
	CatalogIds    *[]string       `json:"catalogIds"`
	Pid           json.RawMessage `json:"pid"`
	UpdatedAt     *string         `json:"updatedAt"`
}

// parseEntry is an entry any version wrote: extra keys are dropped, a missing or mistyped one
// discards the entry.
func parseEntry(text string) (RegisteredRouter, bool) {
	var shape entryShape
	if err := json.Unmarshal([]byte(text), &shape); err != nil {
		return RegisteredRouter{}, false
	}
	if shape.Name == nil || shape.Port == nil || shape.ModelPrefixes == nil ||
		shape.CatalogIds == nil || shape.UpdatedAt == nil {
		return RegisteredRouter{}, false
	}
	entry := RegisteredRouter{
		Name:          *shape.Name,
		Port:          int64(*shape.Port),
		ModelPrefixes: *shape.ModelPrefixes,
		CatalogIds:    *shape.CatalogIds,
		UpdatedAt:     *shape.UpdatedAt,
	}
	if len(shape.Pid) > 0 {
		if string(shape.Pid) == "null" {
			return RegisteredRouter{}, false
		}
		var pid float64
		if err := json.Unmarshal(shape.Pid, &pid); err != nil {
			return RegisteredRouter{}, false
		}
		asInt := int64(pid)
		entry.Pid = &asInt
	}
	return entry, true
}

// SaveRegistryEntry writes one plugin's entry atomically, keeping the recorded pid when the new
// entry carries none (setup writes without one; the router itself writes with its own).
func SaveRegistryEntry(ctx context.Context, env domain.EnvLookup, entry RegisteredRouter) error {
	var inherited *int64
	if entry.Pid == nil {
		for _, other := range ReadRegistry(env) {
			if other.Name == entry.Name && other.Pid != nil {
				pid := *other.Pid
				inherited = &pid
				break
			}
		}
	}
	var data []byte
	var err error
	if inherited != nil {
		// The inherited pid is written in last ({ ...entry, pid }), so the file carries it after
		// updatedAt; an entry's own pid sits where the record declares it.
		data, err = fsutil.MarshalJSON(inheritedPidEntry{
			Name:          entry.Name,
			Port:          entry.Port,
			ModelPrefixes: listOrEmpty(entry.ModelPrefixes),
			CatalogIds:    listOrEmpty(entry.CatalogIds),
			UpdatedAt:     entry.UpdatedAt,
			Pid:           *inherited,
		})
	} else {
		data, err = fsutil.MarshalJSON(registeredRouterJSON{
			Name:          entry.Name,
			Port:          entry.Port,
			ModelPrefixes: listOrEmpty(entry.ModelPrefixes),
			CatalogIds:    listOrEmpty(entry.CatalogIds),
			Pid:           entry.Pid,
			UpdatedAt:     entry.UpdatedAt,
		})
	}
	if err != nil {
		return err
	}
	_, err = fsutil.WriteFileAtomic(ctx, entryFile(env, entry.Name), data, fsutil.WriteOptions{Mkdir: true})
	return err
}

// registeredRouterJSON is the entry as the file writes it, in the registry file's key order.
type registeredRouterJSON struct {
	Name          string   `json:"name"`
	Port          int64    `json:"port"`
	ModelPrefixes []string `json:"modelPrefixes"`
	CatalogIds    []string `json:"catalogIds"`
	Pid           *int64   `json:"pid,omitempty"`
	UpdatedAt     string   `json:"updatedAt"`
}

// inheritedPidEntry is an entry whose pid came from the record it replaced, written after
// updatedAt.
type inheritedPidEntry struct {
	Name          string   `json:"name"`
	Port          int64    `json:"port"`
	ModelPrefixes []string `json:"modelPrefixes"`
	CatalogIds    []string `json:"catalogIds"`
	UpdatedAt     string   `json:"updatedAt"`
	Pid           int64    `json:"pid"`
}

// listOrEmpty is a nil list as the empty array the file always writes.
func listOrEmpty(list []string) []string {
	if list == nil {
		return []string{}
	}
	return list
}

// RemoveRegistryEntry takes one plugin's entry out; a missing entry is fine.
func RemoveRegistryEntry(env domain.EnvLookup, name string) {
	_ = os.Remove(entryFile(env, name))
}

// EntryClaim is the model claim a peer announced: its resolved catalog ids and its prefixes (the
// file keeps its historical keys).
func EntryClaim(entry RegisteredRouter) domain.ModelClaim {
	return domain.ModelClaim{IDs: entry.CatalogIds, Prefixes: entry.ModelPrefixes}
}

// PeerTarget is another plugin's router that serves the model, for the router to forward to.
type PeerTarget struct {
	Name string
	Port int64
}

// CreatePeerLookup looks up which peer serves a model, re-reading the registry at most every 5 s
// so forwarding stays cheap. A nil now is the wall clock.
func CreatePeerLookup(env domain.EnvLookup, self string, now func() int64) func(model string) (PeerTarget, bool) {
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	var entries []RegisteredRouter
	readAt := int64(-1) << 62 // -Infinity: the first lookup always reads
	return func(model string) (PeerTarget, bool) {
		if now()-readAt >= 5000 {
			entries = make([]RegisteredRouter, 0, len(ReadRegistry(env)))
			for _, entry := range ReadRegistry(env) {
				if entry.Name != self {
					entries = append(entries, entry)
				}
			}
			readAt = now()
		}
		for _, entry := range entries {
			if domain.Claims(EntryClaim(entry), model) {
				return PeerTarget{Name: entry.Name, Port: entry.Port}, true
			}
		}
		return PeerTarget{}, false
	}
}

// LiveRouters is the entries whose router answers its health check right now (used to decide where
// a removed plugin's base URL goes, and never to forward: a dead peer fails its forward with a 502
// that names /setup). A nil alive is the health check itself.
func LiveRouters(ctx context.Context, env domain.EnvLookup, exclude string, alive func(context.Context, RegisteredRouter) bool) []RegisteredRouter {
	if alive == nil {
		alive = healthCheck
	}
	var living []RegisteredRouter
	for _, entry := range ReadRegistry(env) {
		if entry.Name == exclude {
			continue
		}
		if alive(ctx, entry) {
			living = append(living, entry)
		}
	}
	return living
}

// healthCheck: live means the port answers that plugin's health path with its own name, not merely
// any 200.
func healthCheck(ctx context.Context, entry RegisteredRouter) bool {
	checkCtx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(checkCtx, http.MethodGet,
		"http://127.0.0.1:"+strconv.FormatInt(entry.Port, 10)+peerHealthPath(entry.Name), nil)
	if err != nil {
		return false
	}
	answer, err := http.DefaultClient.Do(request)
	if err != nil {
		return false
	}
	defer answer.Body.Close()
	if answer.StatusCode < 200 || answer.StatusCode >= 300 {
		return false
	}
	var body struct {
		OK   bool   `json:"ok"`
		Name string `json:"name"`
	}
	if err := json.NewDecoder(answer.Body).Decode(&body); err != nil {
		return false
	}
	return body.OK && body.Name == entry.Name
}
