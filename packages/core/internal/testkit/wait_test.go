// The ownership probe's direct tests: a process group needs Setpgid.

package testkit

import (
	"os"
	"os/exec"
	"syscall"
	"testing"
)

func TestPidInGroup(t *testing.T) {
	child := exec.Command("/bin/sleep", "5")
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = child.Process.Kill()
		_, _ = child.Process.Wait()
	})
	group := int64(child.Process.Pid)

	if !PidInGroup(group, group) {
		t.Fatal("the group leader was not reported in its own group")
	}
	if PidInGroup(int64(os.Getpid()), group) {
		t.Fatal("this process was reported in the child's group")
	}
	_ = child.Process.Kill()
	_, _ = child.Process.Wait()
	if PidInGroup(group, group) {
		t.Fatal("a reaped group leader was still reported in its group")
	}
}
