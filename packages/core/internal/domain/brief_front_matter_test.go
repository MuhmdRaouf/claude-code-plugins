package domain

import "testing"

// The expected outputs of the front-matter split, byte for byte.
func TestSplitFrontMatter(t *testing.T) {
	cases := []struct {
		name string
		text string
		want FrontMatterDocument
		ok   bool
	}{
		{"splits the yaml block from the body", "---\na: 1\n---\nbody\n",
			FrontMatterDocument{FrontMatter: "a: 1", Body: "body\n"}, true},
		{"an empty front matter block", "---\n---\n",
			FrontMatterDocument{FrontMatter: "", Body: ""}, true},
		{"a body with no front matter", "text", FrontMatterDocument{}, false},
		{"trailing spaces after each fence", "--- \nx: 1\n--- \nbody",
			FrontMatterDocument{FrontMatter: "x: 1", Body: "body"}, true},
		{"crlf fences", "---\r\nx: 1\r\n---\r\nbody",
			FrontMatterDocument{FrontMatter: "x: 1", Body: "body"}, true},
		{"an unterminated fence", "---", FrontMatterDocument{}, false},
		{"a missing closing fence", "---\nx: 1", FrontMatterDocument{}, false},
		{"four dashes are not a fence", "----\nx\n---\n", FrontMatterDocument{}, false},
		{"a closing fence at end of input", "---\nx: 1\n---",
			FrontMatterDocument{FrontMatter: "x: 1", Body: ""}, true},
		{"a blank front matter block", "---\n\n---\nbody",
			FrontMatterDocument{FrontMatter: "", Body: "body"}, true},
		{"leading whitespace before the fence", "  ---\na: 1\n---\nb", FrontMatterDocument{}, false},
		{"text glued to the opening fence", "---noNewspace\nx: 1\n---\n", FrontMatterDocument{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := SplitFrontMatter(tc.text)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("splitFrontMatter(%q) = (%#v, %v), want (%#v, %v)", tc.text, got, ok, tc.want, tc.ok)
			}
		})
	}
}
