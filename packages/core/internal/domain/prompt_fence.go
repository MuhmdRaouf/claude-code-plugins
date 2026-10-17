package domain

import "strings"

// Fenced wraps content in a markdown fenced block around arbitrary text. The fence is one
// backtick longer than the longest backtick run inside, so quoted output can never close it
// early.
func Fenced(content, info string) string {
	fenceLength := max(3, longestBacktickRun(content)+1)
	fence := strings.Repeat("`", fenceLength)
	body := content
	if !strings.HasSuffix(content, "\n") {
		body += "\n"
	}
	return fence + info + "\n" + body + fence
}

func longestBacktickRun(content string) int {
	longest, i := 0, 0
	for i < len(content) {
		if content[i] != '`' {
			i++
			continue
		}
		end := i
		for end < len(content) && content[end] == '`' {
			end++
		}
		longest = max(longest, end-i)
		i = end
	}
	return longest
}
