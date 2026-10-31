package main

import (
	"os"
	"path/filepath"
	"testing"
)

// newTestStore returns a store backed by a fresh temp dir plus a real book file
// the store can stat.
func newTestStore(t *testing.T) (*PositionStore, string) {
	t.Helper()

	dir := t.TempDir()
	book := filepath.Join(dir, "book.txt")
	if err := os.WriteFile(book, []byte("第一章\n\n本文"), 0o644); err != nil {
		t.Fatalf("write book: %v", err)
	}

	store := &PositionStore{
		dir:  dir,
		path: filepath.Join(dir, positionsFile),
	}
	return store, book
}

func TestPositionStoreRoundTrip(t *testing.T) {
	store, book := newTestStore(t)

	pos := Position{
		CharOffset:     1234,
		Page:           7,
		FontSize:       20,
		LineHeight:     1.8,
		ColumnHeight:   900,
		Margin:         32,
		LetterSpacing:  0.05,
		Horizontal:     false,
		Encoding:       EncCP932,
		OpenedAt:       1_700_000_000,
	}
	if err := store.Save(book, pos); err != nil {
		t.Fatalf("Save: %v", err)
	}

	got, ok := store.Get(book)
	if !ok {
		t.Fatal("Get: not found after Save")
	}
	if got.CharOffset != pos.CharOffset || got.Page != pos.Page || got.FontSize != pos.FontSize {
		t.Fatalf("Get = %+v, want %+v", got, pos)
	}
	if got.Encoding != EncCP932 || got.Horizontal {
		t.Fatalf("Get encoding/horizontal = %q/%v", got.Encoding, got.Horizontal)
	}

	// A second store reading the same file must see the same position: this is
	// what makes reopening a book resume where the reader stopped.
	reopened := &PositionStore{dir: store.dir, path: store.path}
	reopened.load()
	got2, ok := reopened.Get(book)
	if !ok || got2.CharOffset != pos.CharOffset {
		t.Fatalf("after reopen: ok=%v %+v", ok, got2)
	}
}

func TestPositionStoreKeyIsCaseInsensitiveOnWindows(t *testing.T) {
	store, book := newTestStore(t)

	if err := store.Save(book, Position{CharOffset: 42, OpenedAt: 1}); err != nil {
		t.Fatalf("Save: %v", err)
	}

	other := filepath.Join(filepath.Dir(book), "BOOK.TXT")
	got, ok := store.Get(other)
	if !ok {
		t.Fatal("Get with different case: not found")
	}
	if got.CharOffset != 42 {
		t.Fatalf("CharOffset = %d, want 42", got.CharOffset)
	}
}

func TestPositionStoreSeparatesDifferentFiles(t *testing.T) {
	store, book := newTestStore(t)
	other := filepath.Join(filepath.Dir(book), "other.txt")
	if err := os.WriteFile(other, []byte("他の本"), 0o644); err != nil {
		t.Fatalf("write other: %v", err)
	}

	if err := store.Save(book, Position{CharOffset: 10, OpenedAt: 1}); err != nil {
		t.Fatalf("Save book: %v", err)
	}
	if err := store.Save(other, Position{CharOffset: 99, OpenedAt: 2}); err != nil {
		t.Fatalf("Save other: %v", err)
	}

	got, _ := store.Get(book)
	if got.CharOffset != 10 {
		t.Fatalf("book CharOffset = %d, want 10", got.CharOffset)
	}
	got, _ = store.Get(other)
	if got.CharOffset != 99 {
		t.Fatalf("other CharOffset = %d, want 99", got.CharOffset)
	}
}

func TestPositionStoreRecentSortedAndPruned(t *testing.T) {
	store, book := newTestStore(t)
	dir := filepath.Dir(book)

	ghost := filepath.Join(dir, "deleted.txt")
	if err := os.WriteFile(ghost, []byte("x"), 0o644); err != nil {
		t.Fatalf("write ghost: %v", err)
	}

	if err := store.Save(book, Position{CharOffset: 1, OpenedAt: 100}); err != nil {
		t.Fatalf("Save book: %v", err)
	}
	if err := store.Save(ghost, Position{CharOffset: 2, OpenedAt: 200}); err != nil {
		t.Fatalf("Save ghost: %v", err)
	}

	recent := store.Recent()
	if len(recent) != 2 {
		t.Fatalf("recent = %d, want 2", len(recent))
	}
	if recent[0].Path != ghost {
		t.Fatalf("most recent = %q, want %q (newest first)", recent[0].Path, ghost)
	}

	// A file that no longer exists must not be offered.
	if err := os.Remove(ghost); err != nil {
		t.Fatalf("remove ghost: %v", err)
	}
	recent = store.Recent()
	if len(recent) != 1 || recent[0].Path != book {
		t.Fatalf("recent after deletion = %+v, want only %q", recent, book)
	}
}

func TestPositionStoreRecentLimit(t *testing.T) {
	store, _ := newTestStore(t)
	dir := t.TempDir()

	for i := 0; i < recentLimit+5; i++ {
		name := filepath.Join(dir, string(rune('a'+i))+".txt")
		if err := os.WriteFile(name, []byte("x"), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
		if err := store.Save(name, Position{CharOffset: i, OpenedAt: int64(i)}); err != nil {
			t.Fatalf("Save %s: %v", name, err)
		}
	}

	if recent := store.Recent(); len(recent) != recentLimit {
		t.Fatalf("recent = %d, want %d", len(recent), recentLimit)
	}
}

func TestPositionStoreCorruptFileIsNotFatal(t *testing.T) {
	store, book := newTestStore(t)

	if err := os.WriteFile(store.path, []byte("{not json at all"), 0o644); err != nil {
		t.Fatalf("write corrupt: %v", err)
	}

	// Reading a corrupt store must degrade to "no saved position", not crash.
	if _, ok := store.Get(book); ok {
		t.Fatal("Get returned a position from a corrupt store")
	}
	if recent := store.Recent(); len(recent) != 0 {
		t.Fatalf("Recent = %+v, want empty", recent)
	}

	// And it must still be writable afterwards.
	if err := store.Save(book, Position{CharOffset: 5, OpenedAt: 1}); err != nil {
		t.Fatalf("Save after corruption: %v", err)
	}
	if got, ok := store.Get(book); !ok || got.CharOffset != 5 {
		t.Fatalf("Get after recovery = %+v ok=%v", got, ok)
	}
}

func TestPositionStoreMissingFileIsNotFatal(t *testing.T) {
	dir := t.TempDir()
	store := &PositionStore{dir: dir, path: filepath.Join(dir, "does-not-exist", positionsFile)}

	if _, ok := store.Get(filepath.Join(dir, "book.txt")); ok {
		t.Fatal("Get found a position with no store file")
	}
	if err := store.Save(filepath.Join(dir, "book.txt"), Position{CharOffset: 3, OpenedAt: 1}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if got, ok := store.Get(filepath.Join(dir, "book.txt")); !ok || got.CharOffset != 3 {
		t.Fatalf("Get = %+v ok=%v", got, ok)
	}
}

func TestPositionStoreSaveOverwrites(t *testing.T) {
	store, book := newTestStore(t)

	if err := store.Save(book, Position{CharOffset: 100, Page: 5, OpenedAt: 1}); err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := store.Save(book, Position{CharOffset: 250, Page: 12, OpenedAt: 2}); err != nil {
		t.Fatalf("Save 2: %v", err)
	}

	got, _ := store.Get(book)
	if got.CharOffset != 250 || got.Page != 12 {
		t.Fatalf("Get = %+v, want the second position", got)
	}
	if recent := store.Recent(); len(recent) != 1 {
		t.Fatalf("recent = %d, want 1 (no duplicate entries)", len(recent))
	}
}

func TestBookTitle(t *testing.T) {
	if got := BookTitle(`C:\books\吾輩は猫である.txt`); got != "吾輩は猫である" {
		t.Fatalf("BookTitle = %q, want %q", got, "吾輩は猫である")
	}
	if got := BookTitle("no-extension"); got != "no-extension" {
		t.Fatalf("BookTitle = %q, want %q", got, "no-extension")
	}
}
