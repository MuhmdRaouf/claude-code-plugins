package spool

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// The spool's writing half, from the standard library alone so the emergency passthrough can
// report too: where the radar lives, the day's file, and the append that never lets a failing disk
// reach a client.

// stderrLog is the default log (stderr); internal/adapters has its own twin.
func stderrLog(line string) {
	fmt.Fprintln(os.Stderr, line)
}

// RadarHome is Radar's home: $RADAR_HOME, else ~/.agents/radar (an old ~/.local/state/radar moves
// over once).
func RadarHome(env domain.EnvLookup) string {
	if home, ok := env["RADAR_HOME"]; ok {
		return home
	}
	adapters.MigrateStateDir(context.Background(), "radar", env, stderrLog)
	return adapters.AgentsStateDir(env, "radar")
}

// SpoolFile is the day's spool file, named for the local date (the day the events happened where
// the router runs).
func SpoolFile(env domain.EnvLookup, now int64) string {
	local := time.UnixMilli(now)
	return filepath.Join(RadarHome(env), "spool", fmt.Sprintf("%d-%02d-%02d.jsonl",
		local.Year(), int(local.Month()), local.Day()))
}

// CreateSpoolWriter appends events to the spool in one write each; a failing write costs one line
// on the router's stderr and nothing else — the client's answer never waits on the spool. A nil
// warn logs to stderr and a nil now reads the wall clock (the defaults).
func CreateSpoolWriter(env domain.EnvLookup, warn func(line string), now func() int64) func(event domain.SpoolEvent) {
	if warn == nil {
		warn = stderrLog
	}
	if now == nil {
		now = func() int64 { return time.Now().UnixMilli() }
	}
	ensured := false
	appendLine := func(event domain.SpoolEvent) error {
		if !ensured {
			if err := os.MkdirAll(filepath.Join(RadarHome(env), "spool"), 0o700); err != nil {
				return err
			}
			ensured = true
		}
		line, err := marshalSpoolLine(event)
		if err != nil {
			return err
		}
		file, err := os.OpenFile(SpoolFile(env, now()), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		_, err = file.Write(append(line, '\n'))
		return errors.Join(err, file.Close())
	}
	return func(event domain.SpoolEvent) {
		err := appendLine(event)
		if err == nil {
			return
		}
		if !errors.Is(err, fs.ErrNotExist) {
			warn("route spool: " + err.Error())
			return
		}
		// Radar removed its tree under a running router: make the directory again, once.
		ensured = false
		if err := appendLine(event); err != nil {
			warn("route spool: " + err.Error())
		}
	}
}

// marshalSpoolLine encodes one event the way JSON.stringify does: one line, `<`, `>` and `&`
// alone, U+2028 and U+2029 raw.
func marshalSpoolLine(value any) ([]byte, error) {
	return domain.MarshalCompactJSON(value)
}
