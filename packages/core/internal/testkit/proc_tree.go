package testkit

import (
	"fmt"
	"os/exec"
	"slices"
	"strings"
)

// The process tree, from ps.

// ParentTable is pid → ppid for every process, from one `ps -A -o pid=,ppid=` snapshot. A line
// that is not two numbers (the blank last line, a mangled pid) is skipped.
func ParentTable() (map[int]int, error) {
	ps, err := exec.Command("ps", "-A", "-o", "pid=,ppid=").Output()
	if err != nil {
		return nil, err
	}
	table := make(map[int]int)
	for _, line := range strings.Split(string(ps), "\n") {
		var pid, ppid int
		if n, _ := fmt.Sscanf(line, "%d %d", &pid, &ppid); n != 2 {
			continue
		}
		table[pid] = ppid
	}
	return table, nil
}

// Descendants is every process whose ppid chain reaches root (root excluded): what a tree-kill of
// root signals. Sorted by pid, because a Go map forgets the ps listing's order.
func Descendants(root int, table map[int]int) []int {
	var found []int
	for pid := range table {
		if slices.Contains(ancestors(pid, table), root) {
			found = append(found, pid)
		}
	}
	slices.Sort(found)
	return found
}

// ancestors is pid's ppid chain, stopping at a root (ppid 0) or a cycle.
func ancestors(pid int, table map[int]int) []int {
	var chain []int
	for at, ok := table[pid]; ok && at > 0 && !slices.Contains(chain, at); at, ok = table[at] {
		chain = append(chain, at)
	}
	return chain
}
