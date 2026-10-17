//go:build race

package testkit

// RaceEnabled is true when the test binary was built with the race detector. The detector
// slows the same work 5-20x, so scale tests read this to shrink their sizes and drop only
// their wall-clock limit under it, keeping every correctness assertion.
const RaceEnabled = true
