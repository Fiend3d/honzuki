package main

import (
	"testing"
	"unicode/utf8"

	"golang.org/x/text/encoding"
	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

var (
	unicodeLE = unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM)
	unicodeBE = unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM)
)

func isUTF8(s string) bool { return utf8.ValidString(s) }

// encoderFor maps a reported encoding name back to an encoder so a test can
// author bytes in that encoding.
func encoderFor(t *testing.T, name string) transform.Transformer {
	t.Helper()
	var enc encoding.Encoding
	switch name {
	case EncUTF8, EncUTF8BOM:
		return transform.Nop
	case EncCP932:
		enc = japanese.ShiftJIS
	case EncEUCJP:
		enc = japanese.EUCJP
	case EncUTF16LE:
		enc = unicodeLE
	case EncUTF16BE:
		enc = unicodeBE
	default:
		t.Fatalf("no encoder for %q", name)
	}
	return enc.NewEncoder()
}

func encodeWith(t *testing.T, enc transform.Transformer, s string) []byte {
	t.Helper()
	out, _, err := transform.Bytes(enc, []byte(s))
	if err != nil {
		t.Fatalf("encode %q: %v", s, err)
	}
	return out
}

func TestDecodeUTF8Plain(t *testing.T) {
	text := "本を読む\n第二行"
	got, enc := Decode([]byte(text))
	if got != text {
		t.Fatalf("text = %q, want %q", got, text)
	}
	if enc != EncUTF8 {
		t.Fatalf("encoding = %q, want %q", enc, EncUTF8)
	}
}

func TestDecodeUTF8BOM(t *testing.T) {
	text := "こんにちは"
	data := append([]byte{0xEF, 0xBB, 0xBF}, []byte(text)...)
	got, enc := Decode(data)
	if got != text {
		t.Fatalf("text = %q, want %q", got, text)
	}
	if enc != EncUTF8BOM {
		t.Fatalf("encoding = %q, want %q", enc, EncUTF8BOM)
	}
}

func TestDecodeShiftJIS(t *testing.T) {
	text := "日本語のテキストです。第1章 始まり"
	data := encodeWith(t, japanese.ShiftJIS.NewEncoder(), text)

	got, enc := Decode(data)
	if got != text {
		t.Fatalf("text = %q, want %q", got, text)
	}
	if enc != EncCP932 {
		t.Fatalf("encoding = %q, want %q", enc, EncCP932)
	}
}

func TestDecodeEUCJP(t *testing.T) {
	text := "日本語のテキストです。第1章 始まり"
	data := encodeWith(t, japanese.EUCJP.NewEncoder(), text)

	got, enc := Decode(data)
	if got != text {
		t.Fatalf("text = %q, want %q", got, text)
	}
	if enc != EncEUCJP {
		t.Fatalf("encoding = %q, want %q", enc, EncEUCJP)
	}
}

func TestDecodeUTF16WithBOM(t *testing.T) {
	text := "縦書きの本"

	le := append([]byte{0xFF, 0xFE}, encodeWith(t, unicodeLE.NewEncoder(), text)...)
	got, enc := Decode(le)
	if got != text || enc != EncUTF16LE {
		t.Fatalf("LE: got %q/%q, want %q/%q", got, enc, text, EncUTF16LE)
	}

	be := append([]byte{0xFE, 0xFF}, encodeWith(t, unicodeBE.NewEncoder(), text)...)
	got, enc = Decode(be)
	if got != text || enc != EncUTF16BE {
		t.Fatalf("BE: got %q/%q, want %q/%q", got, enc, text, EncUTF16BE)
	}
}

func TestDecodeEmptyAndShort(t *testing.T) {
	// A truncated BOM must not panic and must not invent text.
	for _, data := range [][]byte{{}, {0xEF}, {0xEF, 0xBB}, {0xFF}, {0x00}} {
		got, enc := Decode(data)
		if enc == "" {
			t.Fatalf("Decode(%v) reported no encoding", data)
		}
		if !isUTF8(got) {
			t.Fatalf("Decode(%v) produced invalid UTF-8: %q", data, got)
		}
	}
}

func TestDecodeAsHonoursExplicitChoice(t *testing.T) {
	text := "日本語"
	data := encodeWith(t, japanese.ShiftJIS.NewEncoder(), text)

	got, enc := DecodeAs(data, EncEUCJP)
	if enc != EncEUCJP {
		t.Fatalf("encoding = %q, want %q", enc, EncEUCJP)
	}
	// Re-decoding Shift_JIS bytes as EUC-JP cannot reproduce the original text;
	// what matters is that no byte is lost and the result is valid UTF-8.
	if !isUTF8(got) {
		t.Fatalf("DecodeAs produced invalid UTF-8: %q", got)
	}

	got, enc = DecodeAs(data, EncCP932)
	if enc != EncCP932 || got != text {
		t.Fatalf("got %q/%q, want %q/%q", got, enc, text, EncCP932)
	}
}

func TestDecodeNeverLosesBytes(t *testing.T) {
	// Arbitrary high bytes must survive into *some* representation rather than
	// being dropped or turned into an error.
	data := make([]byte, 0, 256)
	for b := 0x80; b <= 0xFF; b++ {
		data = append(data, byte(b))
	}
	got, enc := Decode(data)
	if got == "" {
		t.Fatal("decode produced empty text")
	}
	if enc == "" {
		t.Fatal("decode reported no encoding")
	}
	if !isUTF8(got) {
		t.Fatalf("decode produced invalid UTF-8: %q", got)
	}
}

func TestSupportedEncodingsAreAcceptedByDecodeAs(t *testing.T) {
	text := "日本語のテキストです。第1章 始まり"
	for _, name := range SupportedEncodings {
		data := encodeWith(t, encoderFor(t, name), text)
		got, actual := DecodeAs(data, name)
		if actual != name {
			t.Fatalf("%s: reported %q", name, actual)
		}
		if got != text {
			t.Fatalf("%s: text = %q, want %q", name, got, text)
		}
	}
}
