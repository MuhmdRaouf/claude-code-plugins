package authpage

import "syscall"

// launchAttr starts the page child in its own session, as Node's detached spawn does.
func launchAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}
