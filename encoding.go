package main

import (
	"bytes"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/japanese"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

// Encoding names reported to the frontend. These are also the labels offered
// by the manual "re-interpret" control, so they must match keys in
// frontend/src/encoding.ts.
const (
	EncUTF8       = "UTF-8"
	EncUTF8BOM    = "UTF-8 (BOM)"
	EncUTF16LE    = "UTF-16LE"
	EncUTF16BE    = "UTF-16BE"
	EncCP932      = "Shift_JIS"
	EncEUCJP      = "EUC-JP"
	EncWindows125 = "Windows-1252"
)

// SupportedEncodings is the manual override list, in the order shown in the UI.
var SupportedEncodings = []string{EncUTF8, EncCP932, EncEUCJP, EncUTF16LE, EncUTF16BE}

// Decode turns raw file bytes into a UTF-8 Go string, guessing the source
// encoding. Detection order is deliberately strict-first: an explicit BOM,
// then valid UTF-8, then the Japanese legacy encodings, then a last-resort
// single-byte fallback so the app never shows replacement glyphs for text it
// can at least represent.
//
// Ambiguity note: a byte sequence that is *also* valid UTF-8 is reported as
// UTF-8 even if it was authored in Shift_JIS. That is the only safe default
// (Shift_JIS almost never produces valid UTF-8 for real Japanese prose), and
// the UI exposes a manual re-decode control for the rare case.
func Decode(data []byte) (text string, encoding string) {
	// UTF-16 with BOM: detect before the UTF-8 BOM check.
	if len(data) >= 2 {
		if bytes.HasPrefix(data, []byte{0xFF, 0xFE}) {
			return decodeWith(data[2:], unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewDecoder()), EncUTF16LE
		}
		if bytes.HasPrefix(data, []byte{0xFE, 0xFF}) {
			return decodeWith(data[2:], unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM).NewDecoder()), EncUTF16BE
		}
	}

	// UTF-8 BOM.
	if bytes.HasPrefix(data, []byte{0xEF, 0xBB, 0xBF}) {
		return string(data[3:]), EncUTF8BOM
	}

	// Unmarked UTF-8.
	if utf8.Valid(data) {
		return string(data), EncUTF8
	}

	// Japanese legacy encodings.
	//
	// Shift_JIS and EUC-JP overlap badly — EUC-JP's 0xA1–0xFE lead range sits
	// inside Shift_JIS's lead range — so a permissive decode would happily
	// misread one as the other. Each candidate is therefore accepted only when
	// it decodes every byte into a *defined* character: no U+FFFD, no
	// undefined JIS row. That test separates the two cleanly.
	//
	// Shift_JIS is tried first because it is the dominant encoding for Japanese
	// text files on Windows. x/text's japanese.ShiftJIS is the JIS X 0208 half
	// of Windows CP932; the CP932-only bytes (0x80, 0xA0, the yen sign, the NEC
	// extensions) have no defined JIS character and fall through to the
	// single-byte fallback rather than being shown with replacement glyphs.
	if s, ok := decodeDefined(data, japanese.ShiftJIS.NewDecoder()); ok {
		return s, EncCP932
	}
	if s, ok := decodeDefined(data, japanese.EUCJP.NewDecoder()); ok {
		return s, EncEUCJP
	}

	// Last resort: a single-byte interpretation, so every byte survives.
	return decodeWith(data, charmap.Windows1252.NewDecoder()), EncWindows125
}

// DecodeAs decodes the same bytes using an explicitly requested encoding. This
// backs the manual override in the UI. Unknown names fall back to Decode.
func DecodeAs(data []byte, encoding string) (text string, actual string) {
	switch encoding {
	case EncUTF8, EncUTF8BOM:
		if bytes.HasPrefix(data, []byte{0xEF, 0xBB, 0xBF}) {
			return string(data[3:]), EncUTF8BOM
		}
		return string(data), EncUTF8
	case EncCP932:
		return decodeWith(data, japanese.ShiftJIS.NewDecoder()), EncCP932
	case EncEUCJP:
		return decodeWith(data, japanese.EUCJP.NewDecoder()), EncEUCJP
	case EncUTF16LE:
		return decodeWith(stripUTF16BOM(data), unicode.UTF16(unicode.LittleEndian, unicode.IgnoreBOM).NewDecoder()), EncUTF16LE
	case EncUTF16BE:
		return decodeWith(stripUTF16BOM(data), unicode.UTF16(unicode.BigEndian, unicode.IgnoreBOM).NewDecoder()), EncUTF16BE
	default:
		return Decode(data)
	}
}

func stripUTF16BOM(data []byte) []byte {
	if bytes.HasPrefix(data, []byte{0xFF, 0xFE}) || bytes.HasPrefix(data, []byte{0xFE, 0xFF}) {
		return data[2:]
	}
	return data
}

func decodeWith(data []byte, dec transform.Transformer) string {
	s, _, err := transform.String(dec, string(data))
	if err != nil {
		return string(data)
	}
	return s
}

// decodeLossless reports failure when the decoder had to substitute bytes,
// which is how an encoding guess gets rejected.
func decodeLossless(data []byte, dec transform.Transformer) (string, bool) {
	out, n, err := transform.Bytes(dec, data)
	if err != nil || n != len(data) {
		return "", false
	}
	return string(out), true
}

// decodeDefined reports failure when the decoder had to substitute bytes or
// produced a character that the encoding does not actually define.
//
// x/text maps an undefined JIS row to U+FFFD, but its Japanese decoders also
// accept a byte pair whose JIS row is empty and return U+0000. Checking for
// both is what makes Shift_JIS and EUC-JP distinguishable: a stream authored
// in one leaves undefined rows when read as the other.
func decodeDefined(data []byte, dec transform.Transformer) (string, bool) {
	s, ok := decodeLossless(data, dec)
	if !ok {
		return "", false
	}
	for _, r := range s {
		if r == '\uFFFD' || r == 0 {
			return "", false
		}
	}
	return s, true
}
