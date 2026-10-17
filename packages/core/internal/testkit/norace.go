//go:build !race

package testkit

// RaceEnabled is false in ordinary builds: sizes and wall-clock limits hold as written.
const RaceEnabled = false
