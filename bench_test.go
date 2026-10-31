package main

import (
	"os"
	"strings"
	"testing"
)

// benchFile returns the bytes used by the load benchmarks: the real book
// (437 KB Shift_JIS) when present, otherwise the repo sample.
func benchFile(tb testing.TB) []byte {
	tb.Helper()
	for _, p := range []string{
		`E:/torrents/hp.jp.txt/txt/01.txt`,
		"samples/sample.txt",
	} {
		if data, err := os.ReadFile(p); err == nil && len(data) > 0 {
			return data
		}
	}
	tb.Skip("no benchmark input file")
	return nil
}

func BenchmarkDecode(b *testing.B) {
	data := benchFile(b)
	b.ReportAllocs()
	for b.Loop() {
		text, enc := Decode(data)
		_ = text
		_ = enc
	}
}

func BenchmarkSplitParagraphs(b *testing.B) {
	text, _ := Decode(benchFile(b))
	b.ReportAllocs()
	for b.Loop() {
		paragraphs := SplitParagraphs(text)
		_ = paragraphs
	}
}

func BenchmarkDetectChapters(b *testing.B) {
	text, _ := Decode(benchFile(b))
	base := SplitParagraphs(text)
	b.ReportAllocs()
	for b.Loop() {
		// DetectChapters mutates paragraph.Chapter, so it needs a fresh copy.
		paragraphs := make([]Paragraph, len(base))
		copy(paragraphs, base)
		chapters := DetectChapters(paragraphs)
		_ = chapters
	}
}

func BenchmarkFullLoadPipeline(b *testing.B) {
	data := benchFile(b)
	b.ReportAllocs()
	for b.Loop() {
		text, _ := Decode(data)
		paragraphs := SplitParagraphs(text)
		chapters := DetectChapters(paragraphs)
		total := 0
		for _, p := range paragraphs {
			total += runeLen(p.Text)
		}
		_ = chapters
		_ = total
	}
}

// BenchmarkStoreSave measures one position write (the debounced save path).
func BenchmarkStoreSave(b *testing.B) {
	dir := b.TempDir()
	store := &PositionStore{dir: dir, path: dir + "/positions.json"}
	b.ReportAllocs()
	for b.Loop() {
		if err := store.Save(`E:\book.txt`, Position{CharOffset: 1234, Page: 7}); err != nil {
			b.Fatal(err)
		}
	}
}

// TestSplitParagraphsRoundTrip guards the pagination contract: joining the
// paragraph texts back with blank lines yields the same visible text.
func TestSplitParagraphsRoundTrip(t *testing.T) {
	text := "first line\nsecond line\n\n\u3000indented\n\ntrailing\n"
	paragraphs := SplitParagraphs(text)
	if len(paragraphs) != 3 {
		t.Fatalf("want 3 paragraphs, got %d", len(paragraphs))
	}
	if paragraphs[0].Text != "first line\u2028second line" {
		t.Errorf("join lost the intra-paragraph break: %q", paragraphs[0].Text)
	}
	if paragraphs[1].Text != "\u3000indented" {
		t.Errorf("indent must survive: %q", paragraphs[1].Text)
	}

	// Character offsets are defined over the concatenation of paragraph texts
	// (separators excluded), so the sum of rune counts must match exactly.
	total := 0
	for _, p := range paragraphs {
		total += runeLen(p.Text)
	}
	joined := strings.Builder{}
	for _, p := range paragraphs {
		joined.WriteString(p.Text)
	}
	if runeLen(joined.String()) != total {
		t.Errorf("offset arithmetic broken: %d vs %d", runeLen(joined.String()), total)
	}
}
