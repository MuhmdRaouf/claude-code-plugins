package cli

// ExitCode is one of the CLI's fixed exit codes: the contract with the plugin launchers.
type ExitCode int

const (
	ExitOK         ExitCode = 0
	ExitUnexpected ExitCode = 1
	ExitUsage      ExitCode = 2
	ExitNotPass    ExitCode = 3
	ExitNotFound   ExitCode = 4
	ExitConflict   ExitCode = 5
	ExitNotReady   ExitCode = 6
	// ExitInterrupted: SIGINT/SIGTERM ended a follower (128 + SIGINT); the job keeps running.
	ExitInterrupted ExitCode = 130
)
