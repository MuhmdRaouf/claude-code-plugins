package adapters

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAgentFileModelLine(t *testing.T) {
	t.Run("reads, rewrites and removes the first model: line", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "a.md")
		if err := os.WriteFile(file, []byte("---\nname: a\nmodel:  opus \n---\nmodel: body\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		model, found, read := ReadModelLine(file)
		if !read || !found || model != "opus" {
			t.Fatalf("readModelLine() = %q, %t, %t; want %q, true, true", model, found, read, "opus")
		}
		glm := "glm"
		changed, err := WriteModelLine(t.Context(), file, &glm)
		if err != nil || !changed {
			t.Fatalf("writeModelLine(file, glm) = %t, %v; want true, <nil>", changed, err)
		}
		if changed, err = WriteModelLine(t.Context(), file, &glm); err != nil || changed {
			t.Fatalf("writeModelLine(file, glm) again = %t, %v; want false, <nil>", changed, err)
		}
		if changed, err = WriteModelLine(t.Context(), file, nil); err != nil || !changed {
			t.Fatalf("writeModelLine(file, null) = %t, %v; want true, <nil>", changed, err)
		}
		got, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if want := "---\nname: a\n---\nmodel: body\n"; string(got) != want {
			t.Fatalf("file = %q; want %q", got, want)
		}
	})

	t.Run("adds no line where there is none, and says when the file is missing", func(t *testing.T) {
		dir := t.TempDir()
		file := filepath.Join(dir, "b.md")
		if err := os.WriteFile(file, []byte("---\nname: b\n---\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		model, found, read := ReadModelLine(file)
		if !read || found || model != "" {
			t.Fatalf("readModelLine() = %q, %t, %t; want %q, false, true", model, found, read, "")
		}
		if changed, err := WriteModelLine(t.Context(), file, nil); err != nil || changed {
			t.Fatalf("writeModelLine(file, null) = %t, %v; want false, <nil>", changed, err)
		}
		glm := "glm"
		if _, err := WriteModelLine(t.Context(), file, &glm); err == nil || err.Error() != file+": no model: line" {
			t.Fatalf("writeModelLine(file, glm) error = %v; want %q", err, file+": no model: line")
		}
		missing := filepath.Join(dir, "missing.md")
		if _, _, read := ReadModelLine(missing); read {
			t.Fatal("readModelLine(missing) says read; want unreadable")
		}
		if _, err := WriteModelLine(t.Context(), missing, &glm); err == nil || err.Error() != missing+": not found" {
			t.Fatalf("writeModelLine(missing, glm) error = %v; want %q", err, missing+": not found")
		}
	})

	t.Run("leaves a model line without a trailing newline in place on removal", func(t *testing.T) {
		file := filepath.Join(t.TempDir(), "c.md")
		if err := os.WriteFile(file, []byte("---\nmodel: x"), 0o644); err != nil {
			t.Fatal(err)
		}
		// The removal takes the whole line, newline and all; a last line without one stays.
		if changed, err := WriteModelLine(t.Context(), file, nil); err != nil || changed {
			t.Fatalf("writeModelLine(file, null) = %t, %v; want false, <nil>", changed, err)
		}
		assertAgentFile(t, file, "---\nmodel: x")
		glm := "glm"
		if changed, err := WriteModelLine(t.Context(), file, &glm); err != nil || !changed {
			t.Fatalf("writeModelLine(file, glm) = %t, %v; want true, <nil>", changed, err)
		}
		assertAgentFile(t, file, "---\nmodel: glm")
	})
}

func assertAgentFile(t *testing.T, path, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != want {
		t.Fatalf("file = %q; want %q", got, want)
	}
}
