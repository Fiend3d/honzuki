package main

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// Paragraph is one block of book text. In Japanese prose each paragraph
// normally starts on its own line, so a blank line terminates a paragraph and
// consecutive non-blank lines are joined into it.
type Paragraph struct {
	Index int    `json:"index"`
	Text  string `json:"text"`
	// Chapter is the index into Book.Chapters this paragraph belongs to, or -1.
	Chapter int `json:"chapter"`
}

// Chapter is a detected heading used for the table-of-contents control.
type Chapter struct {
	Title   string `json:"title"`
	ParaIdx int    `json:"paraIdx"`
	CharOff int    `json:"charOff"`
}

// maxChapters keeps a pathological file from producing a useless TOC.
const maxChapters = 500

// runeLen is the rune count of a string (pagination works in runes, not bytes).
func runeLen(s string) int { return utf8.RuneCountInString(s) }

// SplitParagraphs normalises line endings and splits text into paragraphs.
//
// Rules:
//   - \r\n and \r become \n
//   - a blank line (only whitespace) ends the current paragraph
//   - consecutive non-blank lines are joined into one paragraph
//   - a leading full-width space (U+3000) is kept: it is the paragraph indent
//   - a single newline inside a paragraph becomes U+2028 so the frontend can
//     honour an explicit line break without ending the paragraph
func SplitParagraphs(text string) []Paragraph {
	text = normalizeNewlines(text)

	// A byte-order mark that survived decoding would render as a stray glyph.
	text = strings.TrimPrefix(text, "\uFEFF")

	lines := strings.Split(text, "\n")
	paragraphs := make([]Paragraph, 0, len(lines))

	var buf []string
	flush := func() {
		if len(buf) == 0 {
			return
		}
		joined := strings.Join(buf, "\u2028")
		if strings.TrimSpace(joined) != "" {
			paragraphs = append(paragraphs, Paragraph{
				Index:   len(paragraphs),
				Text:    joined,
				Chapter: -1,
			})
		}
		buf = buf[:0]
	}

	for _, line := range lines {
		trimmed := strings.Trim(line, " \t\u3000")
		if trimmed == "" {
			flush()
			continue
		}
		buf = append(buf, line)
	}
	flush()

	return paragraphs
}

func normalizeNewlines(text string) string {
	if !strings.ContainsRune(text, '\r') {
		return text
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	return strings.ReplaceAll(text, "\r", "\n")
}

// chapterPattern matches the common Japanese heading forms, anchored at the
// start of a line and requiring the whole line to be one: 第一章, 第12章,
// 第 3 話, 序章, 終章, プロローグ, あとがき.
//
// The line must be *entirely* a heading. Allowing a bare 章 would turn a short
// body paragraph that merely opens with the word into a chapter, and the
// rune-length guard in DetectChapters cannot catch that on its own.
var chapterPattern = regexp.MustCompile(
	`^(?:第\s*[0-9〇一二三四五六七八九十百千万百千零〇]+\s*[章話節編部巻]` +
		`|(?:序|終|奥付)章` +
		`|プロローグ|エピローグ|序詞|前書き|後書き|あとがき|凡例)` +
		`[\s:：〜~—－-]*(.*)$`,
)

// maxChapterTitleLen is the longest a heading line may be (in runes).
const maxChapterTitleLen = 40

// DetectChapters scans paragraphs for headings and assigns each paragraph to
// the chapter it falls under. Headings that appear inside a paragraph (after
// U+2028) are ignored: only paragraph-initial headings count.
func DetectChapters(paragraphs []Paragraph) []Chapter {
	chapters := make([]Chapter, 0, 16)
	running := 0

	for i := range paragraphs {
		p := &paragraphs[i]
		// Only consider the first line of the paragraph.
		head := p.Text
		if idx := strings.IndexRune(head, '\u2028'); idx >= 0 {
			head = head[:idx]
		}
		head = strings.TrimSpace(head)

		isHeading := len(chapters) < maxChapters &&
			runeLen(head) <= maxChapterTitleLen &&
			chapterPattern.MatchString(head)

		if isHeading {
			chapters = append(chapters, Chapter{
				Title:   head,
				ParaIdx: p.Index,
				CharOff: running,
			})
		}
		// A heading names the chapter that follows it, so it is not part of the
		// previous one; body text belongs to the most recent heading, and to no
		// chapter (-1) before the first heading appears.
		p.Chapter = len(chapters) - 1

		running += runeLen(p.Text)
	}

	return chapters
}
