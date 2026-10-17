// `<state>/router.pid`: what the starter knows about the running router — its pid, port, the bundle
// version, the front protocol, whether it is the main router or the emergency passthrough, and the
// token its control endpoints require. Written 0600, atomically, only by the starter once the
// router answers health.
package router

import (
	"context"
	"os"

	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/adapters/fsutil"
	"github.com/MuhmdRaouf/claude-code-plugins/packages/core/internal/domain"
)

// PidMode is whether a record's router is the main router or the emergency passthrough.
type PidMode string

const (
	PidModeRouter    PidMode = "router"
	PidModeEmergency PidMode = "emergency"
)

// PidRecord is what the starter knows about the running router, in the order the file writes it.
type PidRecord struct {
	Pid          int64   `json:"pid"`
	Port         int64   `json:"port"`
	StartedAt    string  `json:"startedAt"`
	Node         string  `json:"node"`
	Version      string  `json:"version"`
	FrontVersion int64   `json:"frontVersion"`
	Mode         PidMode `json:"mode"`
	Token        string  `json:"token"`
}

// pidShape is only what every starter, old or new, relies on: a record an older version wrote still
// counts — pid and port numbers and a token string must be there, anything else rides along; a
// pointer's nil is the field the file did not carry.
type pidShape struct {
	Pid   *float64 `json:"pid"`
	Port  *float64 `json:"port"`
	Token *string  `json:"token"`
}

// WritePidFile writes the record, 0600 and atomically, as `JSON.stringify(record, null, 2)` plus a
// newline.
func WritePidFile(ctx context.Context, stateRoot string, record PidRecord) error {
	return writePidRecord(ctx, domain.NewStateLayout(stateRoot).RouterPid, record)
}

// ReadPidFile is the record, or false when there is none or it does not parse.
func ReadPidFile(ctx context.Context, stateRoot string) (PidRecord, bool) {
	return readPidRecord(ctx, domain.NewStateLayout(stateRoot).RouterPid)
}

// RemovePidFile drops the running router's record, there or not.
func RemovePidFile(stateRoot string) {
	_ = os.Remove(domain.NewStateLayout(stateRoot).RouterPid)
}

// ReadRetiredFile is the retired router's record (see RetirePidFile), or false when there is none.
func ReadRetiredFile(ctx context.Context, stateRoot string) (PidRecord, bool) {
	return readPidRecord(ctx, domain.NewStateLayout(stateRoot).RouterRetired)
}

// RetirePidFile moves the running router's record aside as the retired one.
func RetirePidFile(ctx context.Context, stateRoot string, record PidRecord) error {
	if err := writePidRecord(ctx, domain.NewStateLayout(stateRoot).RouterRetired, record); err != nil {
		return err
	}
	RemovePidFile(stateRoot)
	return nil
}

// RemoveRetiredFile drops the retired record, there or not.
func RemoveRetiredFile(stateRoot string) {
	_ = os.Remove(domain.NewStateLayout(stateRoot).RouterRetired)
}

// writePidRecord writes one pid-shaped file. A PidRecord's fields are plain numbers and strings,
// so it always marshals.
func writePidRecord(ctx context.Context, path string, record PidRecord) error {
	data, _ := fsutil.MarshalJSON(record)
	_, err := fsutil.WriteFileAtomic(ctx, path, data, fsutil.WriteOptions{})
	return err
}

// readPidRecord reads one pid-shaped file: the three fields every starter relies on must be there,
// and the record comes back whole.
func readPidRecord(ctx context.Context, path string) (PidRecord, bool) {
	shape, ok := fsutil.ReadJSONFile[pidShape](ctx, path)
	if !ok || shape.Pid == nil || shape.Port == nil || shape.Token == nil {
		return PidRecord{}, false
	}
	return fsutil.ReadJSONFile[PidRecord](ctx, path)
}
