package main

import (
	"strings"
	"testing"
)

func TestSplitParagraphsBlankLineSeparates(t *testing.T) {
	text := "第一段落です。\n続きの行です。\n\n第二段落です。"
	got := SplitParagraphs(text)

	if len(got) != 2 {
		t.Fatalf("paragraphs = %d, want 2 (%#v)", len(got), got)
	}
	if want := "第一段落です。\u2028続きの行です。"; got[0].Text != want {
		t.Fatalf("para 0 = %q, want %q", got[0].Text, want)
	}
	if want := "第二段落です。"; got[1].Text != want {
		t.Fatalf("para 1 = %q, want %q", got[1].Text, want)
	}
	if got[0].Index != 0 || got[1].Index != 1 {
		t.Fatalf("indexes not sequential: %d, %d", got[0].Index, got[1].Index)
	}
}

func TestSplitParagraphsCRLFAndCR(t *testing.T) {
	for _, text := range []string{
		"一行目\r\n二行目\r\n\r\n別段落",
		"一行目\r二行目\r\r別段落",
	} {
		got := SplitParagraphs(text)
		if len(got) != 2 {
			t.Fatalf("%q: paragraphs = %d, want 2", text, len(got))
		}
		if strings.ContainsRune(got[0].Text, '\r') || strings.ContainsRune(got[1].Text, '\r') {
			t.Fatalf("%q: carriage return survived: %#v", text, got)
		}
	}
}

func TestSplitParagraphsKeepsFullWidthIndent(t *testing.T) {
	text := "\u3000インデント付きの段落。\n\n次の段落。"
	got := SplitParagraphs(text)
	if len(got) != 2 {
		t.Fatalf("paragraphs = %d, want 2", len(got))
	}
	if !strings.HasPrefix(got[0].Text, "\u3000") {
		t.Fatalf("indent lost: %q", got[0].Text)
	}
}

func TestSplitParagraphsWhitespaceOnlyLineIsABreak(t *testing.T) {
	text := "段落一\n   \n\t\n段落二"
	got := SplitParagraphs(text)
	if len(got) != 2 {
		t.Fatalf("paragraphs = %d, want 2 (%#v)", len(got), got)
	}
}

func TestSplitParagraphsDropsBlankEdgesAndBOM(t *testing.T) {
	text := "\uFEFF\n\n本文のみ。\n\n\n"
	got := SplitParagraphs(text)
	if len(got) != 1 {
		t.Fatalf("paragraphs = %d, want 1", len(got))
	}
	if got[0].Text != "本文のみ。" {
		t.Fatalf("text = %q, want %q", got[0].Text, "本文のみ。")
	}
}

func TestSplitParagraphsEmptyInput(t *testing.T) {
	for _, text := range []string{"", "\n\n\n", "   \n\t "} {
		if got := SplitParagraphs(text); len(got) != 0 {
			t.Fatalf("%q: paragraphs = %d, want 0", text, len(got))
		}
	}
}

func TestDetectChaptersRecognisesHeadings(t *testing.T) {
	// Each heading and each body block is its own paragraph (blank line between
	// them), which is how Japanese text files are laid out.
	text := strings.Join([]string{
		"第一章 はじまり",
		"",
		"\u3000本文です。",
		"",
		"第二章 進行",
		"",
		"\u3000続きの本文です。",
		"",
		"第三章 おわり",
		"",
		"\u3000最後の本文です。",
	}, "\n")

	paragraphs := SplitParagraphs(text)
	if len(paragraphs) != 6 {
		t.Fatalf("paragraphs = %d, want 6 (%#v)", len(paragraphs), paragraphs)
	}
	chapters := DetectChapters(paragraphs)

	if len(chapters) != 3 {
		t.Fatalf("chapters = %d, want 3 (%#v)", len(chapters), chapters)
	}
	want := []string{"第一章 はじまり", "第二章 進行", "第三章 おわり"}
	for i, c := range chapters {
		if c.Title != want[i] {
			t.Fatalf("chapter %d title = %q, want %q", i, c.Title, want[i])
		}
		if c.ParaIdx != 2*i {
			t.Fatalf("chapter %d ParaIdx = %d, want %d", i, c.ParaIdx, 2*i)
		}
	}

	// A heading belongs to the chapter it names; body text belongs to the most
	// recent heading.
	wantChapter := []int{0, 0, 1, 1, 2, 2}
	for i, p := range paragraphs {
		if p.Chapter != wantChapter[i] {
			t.Fatalf("paragraph %d (%q) chapter = %d, want %d", i, p.Text, p.Chapter, wantChapter[i])
		}
	}
}

func TestDetectChaptersTextBeforeFirstHeadingHasNoChapter(t *testing.T) {
	// 前書き is itself a recognised heading form, so the fixture opens with
	// prose that is not one.
	text := "この本について書く前に、少しだけ前置きを述べる。\n\n第一章 本題\n\n本文"
	paragraphs := SplitParagraphs(text)
	chapters := DetectChapters(paragraphs)
	if len(chapters) != 1 {
		t.Fatalf("chapters = %d, want 1 (%#v)", len(chapters), chapters)
	}
	if paragraphs[0].Chapter != -1 {
		t.Fatalf("pre-heading paragraph chapter = %d, want -1", paragraphs[0].Chapter)
	}
	if paragraphs[1].Chapter != 0 || paragraphs[2].Chapter != 0 {
		t.Fatalf("chapter paragraphs = %d/%d, want 0/0", paragraphs[1].Chapter, paragraphs[2].Chapter)
	}
}

func TestDetectChaptersNumericAndKanjiNumerals(t *testing.T) {
	for _, heading := range []string{
		"第12章", "第十二章", "第百章", "第3話", "第一節", "第五部",
		"序章", "終章", "プロローグ", "エピローグ", "あとがき",
	} {
		paragraphs := SplitParagraphs(heading + "\n本文")
		chapters := DetectChapters(paragraphs)
		if len(chapters) != 1 {
			t.Fatalf("%q: chapters = %d, want 1", heading, len(chapters))
		}
	}
}

func TestDetectChaptersIgnoresProseMentions(t *testing.T) {
	// A long sentence that merely contains 章 is not a heading.
	text := "彼は本の第一章について長く語ったが、それは章の話ではなかった。"
	paragraphs := SplitParagraphs(text)
	if chapters := DetectChapters(paragraphs); len(chapters) != 0 {
		t.Fatalf("chapters = %d, want 0 (%#v)", len(chapters), chapters)
	}
	if paragraphs[0].Chapter != -1 {
		t.Fatalf("paragraph attributed to chapter %d, want -1", paragraphs[0].Chapter)
	}
}

func TestDetectChaptersCharOffsetsAreRuneBased(t *testing.T) {
	text := "第一章\n\nあ\n\n第二章\n\nい"
	paragraphs := SplitParagraphs(text)
	chapters := DetectChapters(paragraphs)
	if len(chapters) != 2 {
		t.Fatalf("chapters = %d, want 2", len(chapters))
	}
	if chapters[0].CharOff != 0 {
		t.Fatalf("first chapter offset = %d, want 0", chapters[0].CharOff)
	}
	// "第一章" (3 runes) + "あ" (1) = 4 runes before the second heading.
	if chapters[1].CharOff != 4 {
		t.Fatalf("second chapter offset = %d, want 4", chapters[1].CharOff)
	}
}

func TestDetectChaptersCharOffsetsMatchParagraphText(t *testing.T) {
	// CharOff must equal the rune count of everything before the heading, which
	// is exactly what the frontend uses to resume a reading position.
	text := "第一章\n\n本文あいう\n\n第二章\n\n次"
	paragraphs := SplitParagraphs(text)
	chapters := DetectChapters(paragraphs)
	if len(chapters) != 2 {
		t.Fatalf("chapters = %d, want 2", len(chapters))
	}

	sum := 0
	for i := 0; i < chapters[1].ParaIdx; i++ {
		sum += runeLen(paragraphs[i].Text)
	}
	if chapters[1].CharOff != sum {
		t.Fatalf("CharOff = %d, want %d (rune count of preceding paragraphs)", chapters[1].CharOff, sum)
	}
}

func TestDetectChaptersCappedAtMaxChapters(t *testing.T) {
	var sb strings.Builder
	for i := 0; i < maxChapters+50; i++ {
		sb.WriteString("第1章\n本文\n\n")
	}
	paragraphs := SplitParagraphs(sb.String())
	chapters := DetectChapters(paragraphs)
	if len(chapters) != maxChapters {
		t.Fatalf("chapters = %d, want %d", len(chapters), maxChapters)
	}
}

func TestDetectChaptersHeadingInsideParagraphIsIgnored(t *testing.T) {
	// The heading appears after an explicit line break within one paragraph,
	// so it must not create a chapter.
	text := "前書き\n第二章 本題"
	paragraphs := SplitParagraphs(text)
	if len(paragraphs) != 1 {
		t.Fatalf("paragraphs = %d, want 1", len(paragraphs))
	}
	if chapters := DetectChapters(paragraphs); len(chapters) != 1 {
		t.Fatalf("chapters = %d, want 1 (%#v)", len(chapters), chapters)
	}
}
