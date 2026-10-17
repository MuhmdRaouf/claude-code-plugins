// Route events for Radar: one JSON line per forwarded request, one per router start/stop and one
// per health event (kind "router.event"), appended to a local spool Radar drains. Metadata only —
// model, route, status, latency, usage, the three ids Claude Code sends — never another header
// value, never a byte of any body. Every plugin's router appends to the same dated files, so a
// reader filters by the `plugin` field.
package spool

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/ports"
)

// SpoolVersion is the spool schema's version, stamped on every router start/stop event.
const SpoolVersion = 1

// dateFile is a spool file's name: the local day it holds, .jsonl.
var dateFile = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}\.jsonl$`)

// ListSpoolFiles lists the spool files of the last days local days, today's included, oldest
// first: the board reads two, usage thirty. A missing directory (no router has run yet) yields
// nothing.
func ListSpoolFiles(env domain.EnvLookup, now int64, days int) []string {
	dir := filepath.Join(RadarHome(env), "spool")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	local := time.UnixMilli(now)
	first := time.Date(local.Year(), local.Month(), local.Day()-(days-1), 0, 0, 0, 0, time.Local).UnixMilli()
	type dayFile struct {
		name string
		day  int64
	}
	var found []dayFile
	for _, entry := range entries {
		name := entry.Name()
		if !dateFile.MatchString(name) {
			continue
		}
		day, ok := localMidnight(name)
		if !ok || day < first || day > now {
			continue
		}
		found = append(found, dayFile{name: name, day: day})
	}
	sort.Slice(found, func(i, j int) bool {
		if found[i].day != found[j].day {
			return found[i].day < found[j].day
		}
		return found[i].name < found[j].name
	})
	files := make([]string, 0, len(found))
	for _, f := range found {
		files = append(files, filepath.Join(dir, f.name))
	}
	return files
}

// localMidnight is the local midnight of a spool file's date, in epoch ms; false when the name is
// not a real calendar date (and a date that is not real never makes the window).
func localMidnight(name string) (int64, bool) {
	year, _ := strconv.Atoi(name[0:4])
	month, _ := strconv.Atoi(name[5:7])
	day, _ := strconv.Atoi(name[8:10])
	midnight := time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.Local)
	if midnight.Year() != year || int(midnight.Month()) != month || midnight.Day() != day {
		return 0, false
	}
	return midnight.UnixMilli(), true
}

// ReadSpoolEvents returns every parseable event in the given files, in file order: the spool is
// append-only, so a malformed line is skipped, never fatal, and an unreadable file yields nothing.
func ReadSpoolEvents(files []string) []domain.SpoolEvent {
	var events []domain.SpoolEvent
	for _, file := range files {
		data, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			if event, ok := parseEvent(line); ok {
				events = append(events, event)
			}
		}
	}
	return events
}

// parseEvent reads one spool line as an event, else nothing. What a line must carry to be an
// event is a timestamp and an event name (the rest is read as written); a health line that does
// not hold up is skipped, never read as a route event.
func parseEvent(line string) (domain.SpoolEvent, bool) {
	value, err := domain.ParseJSON(line)
	if err != nil {
		return nil, false
	}
	if health, ok := parseHealthEvent(value); ok {
		return health, true
	}
	object, _ := value.(map[string]any)
	if object == nil {
		return nil, false
	}
	if kind, _ := object["kind"].(string); kind == domain.HealthEventKind {
		return nil, false
	}
	if _, ok := object["ts"].(string); !ok {
		return nil, false
	}
	event, ok := object["event"].(string)
	if !ok {
		return nil, false
	}
	return decodeEvent(event, line)
}

// parseHealthEvent reads a router health line: its kind, the plugin, a known event and an
// epoch-millisecond ts; reason and model fall back ("", none) when they are missing or typed
// other than the shape wants.
func parseHealthEvent(value any) (domain.RouterHealthEvent, bool) {
	object, _ := value.(map[string]any)
	if object == nil {
		return domain.RouterHealthEvent{}, false
	}
	if kind, _ := object["kind"].(string); kind != domain.HealthEventKind {
		return domain.RouterHealthEvent{}, false
	}
	plugin, ok := object["plugin"].(string)
	if !ok {
		return domain.RouterHealthEvent{}, false
	}
	name, ok := object["event"].(string)
	if !ok || !slices.Contains(domain.RouterHealthEvents, domain.RouterHealth(name)) {
		return domain.RouterHealthEvent{}, false
	}
	ts, ok := object["ts"].(float64)
	if !ok {
		return domain.RouterHealthEvent{}, false
	}
	reason, _ := object["reason"].(string)
	health := domain.RouterHealthEvent{
		Kind:   domain.HealthEventKind,
		Plugin: plugin,
		Event:  domain.RouterHealth(name),
		Reason: reason,
		Ts:     int64(ts),
	}
	if model, ok := object["model"].(string); ok {
		health.Model = &model
	}
	return health, true
}

// decodeEvent reads a line that carries a string ts and a string event name as the event its name
// says: a field typed other than the event's own shape reads as its zero value, never as a
// failure.
func decodeEvent(event string, line string) (domain.SpoolEvent, bool) {
	switch event {
	case domain.EventRoute:
		var parsed domain.RouteEvent
		_ = json.Unmarshal([]byte(line), &parsed)
		return parsed, true
	case domain.EventCapture:
		var parsed domain.CaptureEvent
		_ = json.Unmarshal([]byte(line), &parsed)
		return parsed, true
	case domain.EventRouter:
		var parsed domain.RouterEvent
		_ = json.Unmarshal([]byte(line), &parsed)
		return parsed, true
	}
	return nil, false
}

// spoolReader is the spool as the board and the usage windows read it.
type spoolReader struct {
	env domain.EnvLookup
}

// Events returns what the routers wrote to Radar's spool over the last days calendar days up to
// now.
func (r spoolReader) Events(now int64, days int) []domain.SpoolEvent {
	return ReadSpoolEvents(ListSpoolFiles(r.env, now, days))
}

// CreateSpoolReader is the spool as the board and the usage windows read it.
func CreateSpoolReader(env domain.EnvLookup) ports.RouteSpool {
	return spoolReader{env: env}
}
