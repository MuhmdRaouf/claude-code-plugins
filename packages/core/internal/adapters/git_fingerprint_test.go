package adapters

import (
	"os"
	"path/filepath"
	"testing"
)

// The direct tests of the git fingerprint. The three fixed vectors cover exactly this layout:
// a 0644 "a.txt" holding "hello\n", a symlink "link" -> a.txt, and a missing "gone.txt".

const (
	// head "0123456789abcdef", status " M a.txt\n", paths [a.txt link gone.txt].
	goldenFingerprintWorld = "2a5ad927174716b97ffc4443d44eb2b92cc4aeef96563f1496e3dd6266dea261"
	// the same file chmod 0600, paths [a.txt].
	goldenFingerprintMode = "948ec04dd1711c22471ff5da3d72b7442db100b2e30896b217880c0d39819f4c"
	// head "h", status "s", no paths.
	goldenFingerprintBare = "90ff532f62e8ec9a95eebf8ebf8ea620974cc15bd2c5c80fff217933513ca2d9"
)

// fingerprintWorld seeds the fixed layout the golden vectors were generated over.
func fingerprintWorld(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello\n"), 0o644); err != nil {
		t.Fatalf("seed a.txt: %v", err)
	}
	// The umask may have narrowed the create's mode; the vector pins 0644.
	if err := os.Chmod(filepath.Join(dir, "a.txt"), 0o644); err != nil {
		t.Fatalf("chmod a.txt: %v", err)
	}
	if err := os.Symlink("a.txt", filepath.Join(dir, "link")); err != nil {
		t.Fatalf("symlink link: %v", err)
	}
	return dir
}

func TestFingerprint(t *testing.T) {
	t.Run("equals the golden digest over the same world", func(t *testing.T) {
		dir := fingerprintWorld(t)
		paths := []string{"a.txt", "link", "gone.txt"}
		if got := Fingerprint(t.Context(), dir, "0123456789abcdef", " M a.txt\n", paths); got != goldenFingerprintWorld {
			t.Fatalf("fingerprint = %s, want %s", got, goldenFingerprintWorld)
		}
	})

	t.Run("counts the mode: a chmod changes the digest", func(t *testing.T) {
		dir := fingerprintWorld(t)
		if err := os.Chmod(filepath.Join(dir, "a.txt"), 0o600); err != nil {
			t.Fatalf("chmod a.txt: %v", err)
		}
		if got := Fingerprint(t.Context(), dir, "0123456789abcdef", " M a.txt\n", []string{"a.txt"}); got != goldenFingerprintMode {
			t.Fatalf("fingerprint = %s, want %s", got, goldenFingerprintMode)
		}
	})

	t.Run("hashes head and status alone when no path is listed", func(t *testing.T) {
		if got := Fingerprint(t.Context(), t.TempDir(), "h", "s", nil); got != goldenFingerprintBare {
			t.Fatalf("fingerprint = %s, want %s", got, goldenFingerprintBare)
		}
	})

	t.Run("is stable while nothing changes", func(t *testing.T) {
		dir := fingerprintWorld(t)
		paths := []string{"a.txt", "link", "gone.txt"}
		before := Fingerprint(t.Context(), dir, "0123456789abcdef", " M a.txt\n", paths)
		if after := Fingerprint(t.Context(), dir, "0123456789abcdef", " M a.txt\n", paths); after != before {
			t.Fatalf("fingerprint drifted: %s then %s", before, after)
		}
	})

	t.Run("changes when a listed file's content changes", func(t *testing.T) {
		dir := fingerprintWorld(t)
		paths := []string{"a.txt"}
		before := Fingerprint(t.Context(), dir, "0123456789abcdef", " M a.txt\n", paths)
		if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello!\n"), 0o644); err != nil {
			t.Fatalf("edit a.txt: %v", err)
		}
		if after := Fingerprint(t.Context(), dir, "0123456789abcdef", " M a.txt\n", paths); after == before {
			t.Fatal("fingerprint ignored a content change")
		}
	})

	t.Run("follows a symlink's target, not its name", func(t *testing.T) {
		dir := fingerprintWorld(t)
		if err := os.WriteFile(filepath.Join(dir, "b.txt"), []byte("other\n"), 0o644); err != nil {
			t.Fatalf("seed b.txt: %v", err)
		}
		paths := []string{"link"}
		before := Fingerprint(t.Context(), dir, "0123456789abcdef", " M a.txt\n", paths)
		if err := os.Remove(filepath.Join(dir, "link")); err != nil {
			t.Fatalf("unlink link: %v", err)
		}
		if err := os.Symlink("b.txt", filepath.Join(dir, "link")); err != nil {
			t.Fatalf("relink link: %v", err)
		}
		if after := Fingerprint(t.Context(), dir, "0123456789abcdef", " M a.txt\n", paths); after == before {
			t.Fatal("fingerprint ignored a relink")
		}
	})

	t.Run("counts the order of the paths", func(t *testing.T) {
		dir := fingerprintWorld(t)
		head, status := "0123456789abcdef", " M a.txt\n"
		forward := Fingerprint(t.Context(), dir, head, status, []string{"a.txt", "link"})
		backward := Fingerprint(t.Context(), dir, head, status, []string{"link", "a.txt"})
		if forward == backward {
			t.Fatal("fingerprint ignored the path order")
		}
	})

	t.Run("digests an unreadable file like a missing one", func(t *testing.T) {
		if os.Geteuid() == 0 {
			t.Skip("root bypasses permission bits")
		}
		// The path names match, so only the digest can differ: present-but-unreadable folds into
		// the same "unreadable" as absent.
		withFile := t.TempDir()
		if err := os.WriteFile(filepath.Join(withFile, "a"), []byte("x\n"), 0o600); err != nil {
			t.Fatalf("seed a: %v", err)
		}
		if err := os.Chmod(filepath.Join(withFile, "a"), 0o000); err != nil {
			t.Fatalf("chmod a: %v", err)
		}
		head, status := "0123456789abcdef", " M a.txt\n"
		unreadable := Fingerprint(t.Context(), withFile, head, status, []string{"a"})
		missing := Fingerprint(t.Context(), t.TempDir(), head, status, []string{"a"})
		if unreadable != missing {
			t.Fatalf("digest of an unreadable file = %s, want the unreadable digest %s", unreadable, missing)
		}
	})
}
