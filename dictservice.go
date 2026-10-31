package main

import (
	"archive/zip"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// DictionaryService loads Yomichan-format dictionary packs (.zip) from the
// dicts folder and answers word lookups for the reader.
//
// Supported packs are the ones published for Yomichan / Yomitan: a zip with
// index.json plus term_bank_*.json* (terms with inline definitions) and
// term_meta_bank_*.json* (extra per-term data such as pitch accent).
// Both JSONL (one entry per line) and whole-file JSON arrays are accepted.
//
// The dictionaries themselves are NOT distributed with honzuki; the user
// downloads them (see README) and drops the zips into dicts/.
type DictionaryService struct {
	app *application.App

	mu      sync.RWMutex
	entries map[string][]DictEntry // keyed by expression and by reading
	sources []string
	ready   bool
}

// DictEntry is one dictionary hit for a word.
type DictEntry struct {
	Expression  string   `json:"expression"`
	Reading     string   `json:"reading"`
	Definitions []string `json:"definitions"`
	Tags        []string `json:"tags"`
	Source      string   `json:"source"`
	Kind        string   `json:"kind"` // "term" or "pitch"
	Pitch       []int    `json:"pitch,omitempty"`
}

// maxWordLen bounds prefix matching; even long compound words stay under it.
const maxWordLen = 16

//wails:ignore
func (s *DictionaryService) SetApp(app *application.App) {
	s.app = app
}

// dictDirs returns the folders searched for dictionary zips: dicts/ next to
// the executable first (portable use), then the app data folder, then the
// current directory (development and tests).
func dictDirs() []string {
	var dirs []string
	if exe, err := os.Executable(); err == nil {
		dirs = append(dirs, filepath.Join(filepath.Dir(exe), "dicts"))
	}
	dirs = append(dirs, filepath.Join(appDataPath(), "dicts"))
	dirs = append(dirs, "dicts")
	return dirs
}

// Scan loads every dictionary zip found. Safe to call once at startup; it is
// meant to run in a goroutine because big dictionaries take a few seconds.
//wails:ignore
func (s *DictionaryService) Scan() {
	entries := map[string][]DictEntry{}
	var sources []string

	for _, dir := range dictDirs() {
		matches, _ := filepath.Glob(filepath.Join(dir, "*.zip"))
		sort.Strings(matches)
		for _, zpath := range matches {
			count, err := s.loadDict(entries, zpath)
			if err != nil {
				log.Printf("[dict] %s: %v", filepath.Base(zpath), err)
				continue
			}
			sources = append(sources, filepath.Base(zpath))
			log.Printf("[dict] loaded %s (%d entries)", filepath.Base(zpath), count)
		}
		// First directory that has dictionaries wins, so a portable dicts/
		// folder next to the exe shadows the app data one.
		if len(sources) > 0 {
			break
		}
	}

	s.mu.Lock()
	s.entries = entries
	s.sources = sources
	s.ready = true
	s.mu.Unlock()

	if s.app != nil {
		s.app.Event.Emit("honzuki:dictready", map[string]any{
			"dictionaries": sources,
			"words":        len(entries),
		})
	}
}

// Status reports what is loaded (used by the frontend status bar).
func (s *DictionaryService) Status() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.ready {
		return nil
	}
	return s.sources
}

// LookupPrefix finds the longest dictionary headword that is a prefix of
// text - the reader sends the characters from the clicked position onward.
func (s *DictionaryService) LookupPrefix(text string) []DictEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.ready || text == "" {
		return nil
	}
	runes := []rune(text)
	for n := len(runes); n >= 1; n-- {
		if n > maxWordLen {
			continue
		}
		key := string(runes[:n])
		if hits := s.entries[key]; len(hits) > 0 {
			return mergePitch(hits)
		}
	}
	return nil
}

// mergePitch folds pitch-accent entries into the term entries they belong to
// so the popup shows one line per word with a small pitch badge, instead of
// a separate entry that clutters the card. Pitch data for words with no
// translation entry is kept as its own entry.
func mergePitch(hits []DictEntry) []DictEntry {
	out := make([]DictEntry, 0, len(hits))

	for i := range hits {
		if hits[i].Kind != "term" {
			continue
		}
		term := hits[i]
		for j := range hits {
			if hits[j].Kind == "pitch" && pitchMatches(term, hits[j]) {
				term.Pitch = append(term.Pitch, hits[j].Pitch...)
			}
		}
		out = append(out, term)
	}

	for i := range hits {
		if hits[i].Kind == "pitch" && !pitchCovered(hits[i], out) {
			out = append(out, hits[i])
		}
	}

	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Kind < out[j].Kind
	})
	return out
}

func pitchMatches(term, pitch DictEntry) bool {
	return term.Expression == pitch.Expression ||
		(term.Reading != "" && term.Reading == pitch.Reading) ||
		term.Reading == pitch.Expression ||
		pitch.Reading == term.Expression
}

func pitchCovered(pitch DictEntry, terms []DictEntry) bool {
	for _, t := range terms {
		if t.Kind == "term" && pitchMatches(t, pitch) {
			return true
		}
	}
	return false
}

// loadDict reads one zip and adds its terms to the shared map.
func (s *DictionaryService) loadDict(entries map[string][]DictEntry, zpath string) (int, error) {
	r, err := zip.OpenReader(zpath)
	if err != nil {
		return 0, err
	}
	defer r.Close()

	title := filepath.Base(zpath)
	if idx, ok := findZipFile(&r.Reader, "index.json"); ok {
		var meta struct {
			Title string `json:"title"`
		}
		if f, err := idx.Open(); err == nil {
			json.NewDecoder(f).Decode(&meta)
			f.Close()
		}
		if meta.Title != "" {
			title = meta.Title
		}
	}

	count := 0
	for _, f := range r.File {
		name := f.Name
		isTermBank := strings.HasPrefix(name, "term_bank")
		isTermMeta := strings.HasPrefix(name, "term_meta_bank")
		if !isTermBank && !isTermMeta {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			continue
		}
		added := decodeTermFile(rc, entries, title, isTermMeta)
		rc.Close()
		count += added
		if added == 0 {
			log.Printf("[dict] %s: %s had no readable entries", title, name)
		}
	}
	return count, nil
}

// decodeTermFile streams a term bank. It accepts JSONL (one entry array per
// line) and a single JSON array of entry arrays, because different dictionary
// exporters produce both. A file with a broken CRC still contributes every
// entry decoded before the corruption, which is strictly better than skipping
// the whole bank.
func decodeTermFile(rc interface {
	Read([]byte) (int, error)
}, entries map[string][]DictEntry, title string, meta bool) int {
	dec := json.NewDecoder(rc)
	dec.UseNumber()
	added := 0
	for {
		var raw any
		err := dec.Decode(&raw)
		if err != nil {
			if err.Error() != "EOF" {
				// Corrupt tail: keep what decoded so far.
			}
			return added
		}
		arr, ok := raw.([]any)
		if !ok {
			continue
		}
		if len(arr) > 0 {
			if _, nested := arr[0].([]any); nested {
				// Whole-file array of entries.
				for _, e := range arr {
					if addEntry(entries, e, title, meta) {
						added++
					}
				}
				continue
			}
			if addEntry(entries, raw, title, meta) {
				added++
			}
		}
	}
}

func addEntry(entries map[string][]DictEntry, raw any, title string, meta bool) bool {
	arr, ok := raw.([]any)
	if !ok || len(arr) < 3 {
		return false
	}
	expr, _ := arr[0].(string)
	if expr == "" {
		return false
	}

	if meta {
		// term_meta_bank: [expression, mode, payload]
		mode, _ := arr[1].(string)
		payload, _ := arr[2].(map[string]any)
		if payload == nil {
			return false
		}
		switch mode {
		case "pitch":
			reading, _ := payload["reading"].(string)
			var pitches []int
			if ps, _ := payload["pitches"].([]any); ps != nil {
				for _, p := range ps {
					pm, _ := p.(map[string]any)
					if pm == nil {
						continue
					}
					if num, ok := pm["position"].(json.Number); ok {
						if v, err := num.Int64(); err == nil {
							pitches = append(pitches, int(v))
						}
					}
				}
			}
			if len(pitches) == 0 {
				return false
			}
			addDictEntry(entries, DictEntry{
				Expression: expr,
				Reading:    reading,
				Source:     title,
				Kind:       "pitch",
				Pitch:      pitches,
			})
			return true
		case "term":
			var defs []string
			switch d := payload["definitions"].(type) {
			case string:
				defs = []string{d}
			case []any:
				for _, v := range d {
					if str, ok := v.(string); ok {
						defs = append(defs, str)
					}
				}
			}
			if len(defs) == 0 {
				return false
			}
			reading, _ := arr[1].(string)
			_ = reading
			addDictEntry(entries, DictEntry{
				Expression:  expr,
				Definitions: defs,
				Source:      title,
				Kind:        "term",
			})
			return true
		}
		return false
	}

	// term_bank: [expression, reading, defidx, score, tags, definitions, ...]
	if len(arr) < 6 {
		return false
	}
	reading, _ := arr[1].(string)
	var tags []string
	if ts, _ := arr[4].([]any); ts != nil {
		for _, t := range ts {
			if str, ok := t.(string); ok {
				tags = append(tags, str)
			}
		}
	}
	var defs []string
	switch d := arr[5].(type) {
	case string:
		defs = []string{d}
	case []any:
		for _, v := range d {
			if str, ok := v.(string); ok {
				defs = append(defs, str)
			}
		}
	}
	if len(defs) == 0 {
		return false
	}
	addDictEntry(entries, DictEntry{
		Expression:  expr,
		Reading:     reading,
		Definitions: defs,
		Tags:        tags,
		Source:      title,
		Kind:        "term",
	})
	return true
}

func addDictEntry(entries map[string][]DictEntry, e DictEntry) {
	// Yomichan packs join variant spellings into one head expression,
	// e.g. "さようなら, さよなら". Index every variant so selecting either
	// one finds the entry.
	for _, variant := range strings.Split(e.Expression, ", ") {
		variant = strings.TrimSpace(variant)
		if variant == "" {
			continue
		}
		entries[variant] = append(entries[variant], e)
	}
	if e.Reading != "" && e.Reading != e.Expression {
		entries[e.Reading] = append(entries[e.Reading], e)
	}
}

func findZipFile(r *zip.Reader, name string) (*zip.File, bool) {
	for _, f := range r.File {
		if f.Name == name {
			return f, true
		}
	}
	return nil, false
}
