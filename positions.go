package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Position is the saved reading state for one file.
//
// Both CharOffset and Page are stored: Page is a fast resume when nothing has
// changed, while CharOffset is what actually survives a settings change
// (font size and column height change the page count, so a page index becomes
// meaningless). The frontend prefers CharOffset.
type Position struct {
	Path          string  `json:"path"`
	CharOffset    int     `json:"charOffset"`
	Page          int     `json:"page"`
	FontSize      float64 `json:"fontSize"`
	LineHeight    float64 `json:"lineHeight"`
	ColumnHeight  float64 `json:"columnHeight"`
	Margin        float64 `json:"margin"`
	LetterSpacing float64 `json:"letterSpacing"`
	Horizontal    bool    `json:"horizontal"`
	Encoding      string  `json:"encoding,omitempty"`
	OpenedAt      int64   `json:"openedAt"`
}

// RecentEntry is one item of the "recent files" list.
type RecentEntry struct {
	Path       string `json:"path"`
	Title      string `json:"title"`
	CharOffset int    `json:"charOffset"`
	OpenedAt   int64  `json:"openedAt"`
}

const (
	recentLimit   = 10
	appDataDir    = "honzuki"
	positionsFile = "positions.json"
)

// PositionStore persists reading positions keyed by absolute file path.
//
// Keys are normalised so that the same file opened via different spellings
// (case, slashes, a short name) maps to one entry. A single mutex guards every
// access: only BookService methods touch the store, so there is one writer.
type PositionStore struct {
	mu        sync.Mutex
	dir       string
	path      string
	positions map[string]Position
}

// NewPositionStore returns a store rooted at %APPDATA%\honzuki on Windows and
// the XDG data dir elsewhere. A missing, unreadable, or corrupt file yields an
// empty store rather than an error: losing a reading position must never stop
// the app from opening a book.
func NewPositionStore() *PositionStore {
	dir := appDataPath()
	s := &PositionStore{
		dir:       dir,
		path:      filepath.Join(dir, positionsFile),
		positions: make(map[string]Position),
	}
	s.load()
	return s
}

func appDataPath() string {
	if runtime.GOOS == "windows" {
		if base := os.Getenv("APPDATA"); base != "" {
			return filepath.Join(base, appDataDir)
		}
	}
	if base := os.Getenv("XDG_DATA_HOME"); base != "" {
		return filepath.Join(base, appDataDir)
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".local", "share", appDataDir)
	}
	return filepath.Join(os.TempDir(), appDataDir)
}

// StoreKey normalises a path into a map key. Windows paths are
// case-insensitive, so keys are lower-cased there; separators are unified.
func StoreKey(path string) string {
	key := filepath.ToSlash(path)
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	return key
}

func (s *PositionStore) load() {
	if s.positions == nil {
		s.positions = make(map[string]Position)
	}
	if s.path == "" {
		s.path = filepath.Join(s.dir, positionsFile)
	}

	data, err := os.ReadFile(s.path)
	if err != nil {
		return
	}
	var raw map[string]Position
	if err := json.Unmarshal(data, &raw); err != nil {
		// Corrupt file: start clean; the next save overwrites it.
		return
	}
	if raw != nil {
		s.positions = raw
	}
}

// ensureLocked lazily initialises the table so a store built by literal
// composition, not just NewPositionStore, is still usable.
func (s *PositionStore) ensureLocked() {
	if s.positions == nil {
		s.positions = make(map[string]Position)
	}
	if s.path == "" {
		s.path = filepath.Join(s.dir, positionsFile)
	}
}

// Save records pos for path and persists immediately.
func (s *PositionStore) Save(path string, pos Position) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.ensureLocked()

	pos.Path = path
	if pos.OpenedAt == 0 {
		pos.OpenedAt = time.Now().Unix()
	}
	s.positions[StoreKey(path)] = pos
	return s.flushLocked()
}

// Get returns the saved position for path, if any.
func (s *PositionStore) Get(path string) (Position, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.ensureLocked()

	pos, ok := s.positions[StoreKey(path)]
	return pos, ok
}

// Recent returns the most recently opened files, newest first. Entries whose
// file no longer exists are dropped and the pruned table is written back.
func (s *PositionStore) Recent() []RecentEntry {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.ensureLocked()

	entries := make([]RecentEntry, 0, len(s.positions))
	var missing []string

	for key, pos := range s.positions {
		path := pos.Path
		if path == "" {
			missing = append(missing, key)
			continue
		}
		if info, err := os.Stat(path); err != nil || info.IsDir() {
			missing = append(missing, key)
			continue
		}
		entries = append(entries, RecentEntry{
			Path:       path,
			Title:      BookTitle(path),
			CharOffset: pos.CharOffset,
			OpenedAt:   pos.OpenedAt,
		})
	}

	if len(missing) > 0 {
		for _, key := range missing {
			delete(s.positions, key)
		}
		_ = s.flushLocked()
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].OpenedAt != entries[j].OpenedAt {
			return entries[i].OpenedAt > entries[j].OpenedAt
		}
		return entries[i].Path < entries[j].Path
	})
	if len(entries) > recentLimit {
		entries = entries[:recentLimit]
	}
	return entries
}

// All returns every saved position keyed by path.
func (s *PositionStore) All() map[string]Position {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.ensureLocked()

	out := make(map[string]Position, len(s.positions))
	for _, pos := range s.positions {
		if pos.Path != "" {
			out[pos.Path] = pos
		}
	}
	return out
}

// flushLocked writes the table atomically: temp file, then rename over the
// target. A crash mid-write leaves either the old file or the new one.
func (s *PositionStore) flushLocked() error {
	// The directory that holds the file, not s.dir: a store may be pointed at a
	// file outside the directory it was given.
	fileDir := filepath.Dir(s.path)
	if err := os.MkdirAll(fileDir, 0o755); err != nil {
		return fmt.Errorf("positions dir: %w", err)
	}
	data, err := json.MarshalIndent(s.positions, "", "  ")
	if err != nil {
		return fmt.Errorf("encode positions: %w", err)
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("write positions: %w", err)
	}
	if err := os.Remove(s.path); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("replace positions: %w", err)
	}
	if err := os.Rename(tmp, s.path); err != nil {
		return fmt.Errorf("rename positions: %w", err)
	}
	return nil
}

// Path is exposed for tests.
func (s *PositionStore) Path() string { return s.path }

// BookTitle derives a display title from a file name.
func BookTitle(path string) string {
	name := filepath.Base(path)
	if ext := filepath.Ext(name); ext != "" {
		name = strings.TrimSuffix(name, ext)
	}
	if name == "" {
		return path
	}
	return name
}
