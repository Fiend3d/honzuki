package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

func timeNow() int64 { return time.Now().Unix() }

// maxFileSize is the largest text file the reader will attempt to render.
// Beyond this the frontend pagination pass would stall the webview, so the
// request is refused with an explanation instead.
const maxFileSize = 20 * 1024 * 1024

// acceptedExtensions are the file types the open dialog offers and Load accepts.
var acceptedExtensions = map[string]bool{
	".txt":  true,
	".text": true,
	".md":   true,
}

// Paragraph, Chapter, Position, RecentEntry are defined in chapters.go and
// positions.go.

// Book is one opened file, ready to render.
type Book struct {
	Path       string      `json:"path"`
	Title      string      `json:"title"`
	Encoding   string      `json:"encoding"`
	Paragraphs []Paragraph `json:"paragraphs"`
	Chapters   []Chapter   `json:"chapters"`
	Size       int64       `json:"size"`
	// CharCount is the total rune count of the book, used for progress display.
	CharCount int `json:"charCount"`
}

// OpenedFile is what the open dialog returns to the frontend.
type OpenedFile struct {
	Path string `json:"path"`
	Book *Book  `json:"book"`
}

// BookService is the single service bound to the frontend.
type BookService struct {
	app       *application.App
	positions *PositionStore

	// recentMenu is the native submenu listing recent files. It is rebuilt
	// after each open so the list stays current.
	recentMenu *application.Menu

	// lastDir remembers where the file dialog last opened, so consecutive
	// opens start from a useful place.
	lastDir string
}

// NewBookService wires the service to the application. The app pointer is
// injected after application.New so the service can raise native dialogs.
func NewBookService(app *application.App, store *PositionStore) *BookService {
	return &BookService{app: app, positions: store}
}

// ServiceStartup satisfies application.ServiceStartup. The app pointer is set
// by main before app.Run, so there is nothing to fail here; it exists so the
// service is ready to gain startup work later without a signature change.
func (s *BookService) ServiceStartup(_ context.Context, _ application.ServiceOptions) error {
	return nil
}

// OpenDialog shows the native Windows file picker filtered to text files and
// loads the choice.
//
// A cancelled dialog returns (nil, nil): the frontend keeps the current book
// open. Errors are returned as errors so the frontend can show them.
func (s *BookService) OpenDialog() (*OpenedFile, error) {
	dlg := s.app.Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		CanChooseFiles:       true,
		CanChooseDirectories: false,
		AllowsOtherFileTypes: false,
		Title:                "本を開く",
		Message:              "テキストファイルを選択してください",
		ButtonText:           "開く",
		Filters: []application.FileFilter{
			{DisplayName: "テキストファイル (*.txt)", Pattern: "*.txt;*.text;*.md"},
		},
	})
	if s.lastDir != "" {
		dlg.SetDirectory(s.lastDir)
	}

	path, err := dlg.PromptForSingleSelection()
	if err != nil {
		return nil, fmt.Errorf("ファイル選択: %w", err)
	}
	if path == "" {
		// Cancelled.
		return nil, nil
	}

	book, err := s.Load(path)
	if err != nil {
		return nil, err
	}
	return &OpenedFile{Path: book.Path, Book: book}, nil
}

// Load reads, decodes, and structures a file.
func (s *BookService) Load(path string) (*Book, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("パス解決: %w", err)
	}

	info, err := os.Stat(abs)
	if err != nil {
		return nil, fmt.Errorf("ファイルが見つかりません: %s", abs)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("フォルダは開けません: %s", abs)
	}
	if !acceptedExtensions[filepath.Ext(strings.ToLower(abs))] {
		return nil, fmt.Errorf("対応していないファイル形式です: %s", filepath.Ext(abs))
	}
	if info.Size() > maxFileSize {
		return nil, fmt.Errorf("ファイルが大きすぎます (%d MB)。20 MB 以下でお試しください", info.Size()/(1024*1024))
	}

	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, fmt.Errorf("読み込みに失敗しました: %w", err)
	}
	if len(data) == 0 {
		return nil, errors.New("ファイルが空です")
	}

	text, encoding := Decode(data)
	paragraphs := SplitParagraphs(text)
	if len(paragraphs) == 0 {
		return nil, errors.New("表示できるテキストが見つかりません")
	}
	chapters := DetectChapters(paragraphs)

	total := 0
	for _, p := range paragraphs {
		total += runeLen(p.Text)
	}

	s.lastDir = filepath.Dir(abs)

	book := &Book{
		Path:       abs,
		Title:      BookTitle(abs),
		Encoding:   encoding,
		Paragraphs: paragraphs,
		Chapters:   chapters,
		Size:       info.Size(),
		CharCount:  total,
	}

	// Opening a file is itself worth recording, even before a position save.
	if pos, ok := s.positions.Get(abs); ok {
		pos.OpenedAt = timeNow()
		_ = s.positions.Save(abs, pos)
	} else {
		_ = s.positions.Save(abs, Position{CharOffset: 0, Page: 1, OpenedAt: timeNow()})
	}

	// The window names the book it is showing, like a document editor.
	if s.app != nil {
		for _, w := range s.app.Window.GetAll() {
			w.SetTitle(book.Title + " - honzuki")
		}
	}

	return book, nil
}

// Reinterpret decodes the same file again with an explicitly chosen encoding,
// for the rare case where auto-detection guessed wrong.
func (s *BookService) Reinterpret(path, encoding string) (*Book, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("パス解決: %w", err)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return nil, fmt.Errorf("読み込みに失敗しました: %w", err)
	}

	text, actual := DecodeAs(data, encoding)
	paragraphs := SplitParagraphs(text)
	if len(paragraphs) == 0 {
		return nil, errors.New("表示できるテキストが見つかりません")
	}
	chapters := DetectChapters(paragraphs)

	total := 0
	for _, p := range paragraphs {
		total += runeLen(p.Text)
	}

	return &Book{
		Path:       abs,
		Title:      BookTitle(abs),
		Encoding:   actual,
		Paragraphs: paragraphs,
		Chapters:   chapters,
		Size:       int64(len(data)),
		CharCount:  total,
	}, nil
}

// Encodings returns the manual override list for the UI dropdown.
func (s *BookService) Encodings() []string { return SupportedEncodings }

// Recent returns the recently opened files, newest first.
func (s *BookService) Recent() []RecentEntry { return s.positions.Recent() }

// PositionFor returns the saved reading position for a path.
func (s *BookService) PositionFor(path string) (Position, bool) {
	return s.positions.Get(path)
}

// SavePosition persists the reading position. Called from the frontend on
// navigation and settings changes (debounced there).
func (s *BookService) SavePosition(path string, pos Position) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("パス解決: %w", err)
	}
	if pos.CharOffset < 0 {
		pos.CharOffset = 0
	}
	if pos.Page < 0 {
		pos.Page = 0
	}
	return s.positions.Save(abs, pos)
}

// Quit closes the application; used by the in-app UI as well as the menu.
func (s *BookService) Quit() { s.app.Quit() }
