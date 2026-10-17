package fsutil

import (
	"errors"
	"syscall"
)

// ErrnoCode returns a filesystem error's errno name in Node's spelling ("ENOENT"), for the
// errnos the core's messages print; empty when err is nil or carries none of them.
func ErrnoCode(err error) string {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return ""
	}
	switch errno {
	case syscall.ENOENT:
		return "ENOENT"
	case syscall.EEXIST:
		return "EEXIST"
	case syscall.EACCES:
		return "EACCES"
	case syscall.EPERM:
		return "EPERM"
	case syscall.EISDIR:
		return "EISDIR"
	case syscall.ENOTDIR:
		return "ENOTDIR"
	case syscall.ENOTEMPTY:
		return "ENOTEMPTY"
	case syscall.EMFILE:
		return "EMFILE"
	case syscall.ENFILE:
		return "ENFILE"
	case syscall.ENOSPC:
		return "ENOSPC"
	case syscall.EROFS:
		return "EROFS"
	case syscall.EBUSY:
		return "EBUSY"
	case syscall.ETXTBSY:
		return "ETXTBSY"
	case syscall.EXDEV:
		return "EXDEV"
	case syscall.ELOOP:
		return "ELOOP"
	case syscall.ENAMETOOLONG:
		return "ENAMETOOLONG"
	default:
		return ""
	}
}

// ErrorMessage returns the error's message, or empty for nil.
func ErrorMessage(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// nodeErrnoDescriptions is libuv's own description of each errno ErrnoCode names: the words Node's
// error messages print, the same on every platform (libuv keeps its own table rather than the C
// library's locale-dependent one).
var nodeErrnoDescriptions = map[string]string{
	"ENOENT":       "no such file or directory",
	"EACCES":       "permission denied",
	"EPERM":        "operation not permitted",
	"EEXIST":       "file already exists",
	"EISDIR":       "illegal operation on a directory",
	"ENOTDIR":      "not a directory",
	"ENOTEMPTY":    "directory not empty",
	"EMFILE":       "too many open files",
	"ENFILE":       "file table overflow",
	"ENOSPC":       "no space left on device",
	"EROFS":        "read-only file system",
	"EBUSY":        "resource busy or locked",
	"ETXTBSY":      "text file is busy",
	"EXDEV":        "cross-device link not permitted",
	"ELOOP":        "too many symbolic links encountered",
	"ENAMETOOLONG": "name too long",
}

// NodeMessage is the message Node's fs promises print for err: "<CODE>: <description>, <syscall>
// '<path>'". An empty path prints nothing after the syscall (a read failure carries none, so
// reading a directory reads "EISDIR: illegal operation on a directory, read"); an errno with no
// description in the table keeps Go's own text.
func NodeMessage(err error, syscall string, path string) string {
	description, known := nodeErrnoDescriptions[ErrnoCode(err)]
	if !known {
		return ErrorMessage(err)
	}
	message := ErrnoCode(err) + ": " + description
	if syscall != "" {
		message += ", " + syscall
		if path != "" {
			message += " '" + path + "'"
		}
	}
	return message
}
