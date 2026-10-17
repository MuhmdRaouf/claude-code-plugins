package domain

import "regexp"

// FrontMatterDocument is a leading `---` fenced YAML block split from the markdown body.
type FrontMatterDocument struct {
	FrontMatter string
	// Everything after the newline that ends the closing fence, byte-exact.
	Body string
}

var frontMatterPattern = regexp.MustCompile(`^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)`)

// SplitFrontMatter splits a leading `---` fenced YAML block from the markdown body; false when
// the document does not start with one.
func SplitFrontMatter(text string) (FrontMatterDocument, bool) {
	match := frontMatterPattern.FindStringSubmatch(text)
	if match == nil {
		return FrontMatterDocument{}, false
	}
	return FrontMatterDocument{FrontMatter: match[1], Body: text[len(match[0]):]}, true
}
