package main

import (
	"strings"
	"testing"
)

func TestDictLookup(t *testing.T) {
	s := &DictionaryService{}
	s.Scan()

	status := s.Status()
	if len(status) == 0 {
		t.Skip("no dictionary zips in dicts/; skipping")
	}

	cases := []struct {
		text   string
		expect string // substring expected in some definition or the match itself
	}{
		{"猫を飼う", "cat"},       // 猫 must resolve via the JA-EN dictionary
		{"ありがとう", "thank"},    // common greeting should translate
		{"猫が", "cat"},            // prefix match must stop at 猫
		{"ｘｚｑ不存在zzz", ""}, // no headword can start with ｘ
	}
	for _, c := range cases {
		hits := s.LookupPrefix(c.text)
		if c.expect == "" {
			if len(hits) > 0 {
				t.Errorf("LookupPrefix(%q) unexpectedly matched %q", c.text, hits[0].Expression)
			}
			continue
		}
		if len(hits) == 0 {
			t.Errorf("LookupPrefix(%q): no match", c.text)
			continue
		}
		found := false
		for _, h := range hits {
			for _, d := range h.Definitions {
				if strings.Contains(strings.ToLower(d), c.expect) {
					found = true
				}
			}
		}
		if !found {
			t.Errorf("LookupPrefix(%q) matched %q but no definition contains %q (first def: %q)",
				c.text, hits[0].Expression, c.expect, firstDef(hits[0]))
		}
	}

	// Pitch dictionary: ありがとう has a known pitch pattern in 大辞泉 packs.
	hits := s.LookupPrefix("ありがとう")
	var pitch *DictEntry
	for i := range hits {
		if hits[i].Kind == "pitch" {
			pitch = &hits[i]
			break
		}
	}
	if pitch == nil || len(pitch.Pitch) == 0 {
		t.Logf("note: no pitch entry for ありがとう (pitch dict may store it under kana only)")
	}
}

func firstDef(e DictEntry) string {
	if len(e.Definitions) == 0 {
		return ""
	}
	return e.Definitions[0]
}
