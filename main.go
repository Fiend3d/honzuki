package main

import (
	"embed"
	"log"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// Wails embeds the built frontend (frontend/dist) into the binary so the
// packaged exe is self-contained.
//
//go:embed all:frontend/dist
var assets embed.FS

// Window/taskbar icon. The exe file icon itself comes from rsrc.syso
// (regenerate with: go run ./tools/genicon && wails3 generate syso -icon
// assets/app.ico -manifest build/windows/wails.exe.manifest -out rsrc.syso
// -arch amd64).
//
//go:embed assets/icon_1024.png
var windowIcon []byte

func main() {
	store := NewPositionStore()

	// The service instance is created before application.New so the menu can
	// close over it; its app pointer is injected right after.
	books := &BookService{positions: store}

	// A path given on the command line (file association, or `honzuki.exe
	// book.txt`) opens once the frontend asks for it via PendingFile. Emitting
	// from the WindowRuntimeReady event would race the frontend's own event
	// listeners, which register only after the runtime announces itself.
	pendingPath := ""
	if len(os.Args) > 1 {
		if info, err := os.Stat(os.Args[1]); err == nil && !info.IsDir() {
			pendingPath = os.Args[1]
		}
	}

	app := application.New(application.Options{
		Name:        "honzuki",
		Description: "日本語縦書きテキストリーダー",
		Icon:        windowIcon,
		Services: []application.Service{
			application.NewService(books),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		FileAssociations: []string{".txt"},
		Windows: application.WindowsOptions{
			// An empty path makes WebView2 write its profile to
			// %APPDATA%\<exe name>\EBWebView, which reads as a stray
			// "honzuki.exe" folder. Name the folder after the app instead.
			WebviewUserDataPath: webviewDataPath(),
		},
		Mac: application.MacOptions{
			ApplicationShouldTerminateAfterLastWindowClosed: true,
		},
	})
	books.app = app
	books.pendingPath = &pendingPath

	// Decide the opening size before the window is created.
	windowWidth, windowHeight := initialWindowSize()

	app.Menu.SetApplicationMenu(buildMenu(app, books))

	app.Window.OnCreate(func(window application.Window) {
		window.OnWindowEvent(events.Common.WindowRuntimeReady, func(event *application.WindowEvent) {
			clampWindowToScreen(app, window)
		})
		window.OnWindowEvent(events.Common.WindowFilesDropped, func(event *application.WindowEvent) {
			files := event.Context().DroppedFiles()
			if len(files) == 0 {
				return
			}
			// The first dropped file wins; dropping several at once is rare and
			// opening them all would only jump past the one the user aimed at.
			// The frontend opens it through openPath so the saved position is
			// restored, then reports the book back to Go.
			emit(app, "honzuki:filesdropped", files)
		})
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "honzuki",
		// A book page is taller than wide, so the window leans tall - but
		// clamped to the desktop, or the status bar starts off-screen.
		Width:     windowWidth,
		Height:    windowHeight,
		MinWidth:  480,
		MinHeight: 400,
		// Washi-paper background so the first paint matches the page colour.
		BackgroundColour: application.NewRGB(250, 247, 240),
		// Lets the webview hand dropped file paths to Go. The frontend marks the
		// page as a drop target with data-file-drop-target.
		EnableFileDrop: true,
		// On Windows the application menu is only attached (and its Ctrl
		// accelerators registered) when each window opts in explicitly.
		UseApplicationMenu: true,
		URL:                "/",
	})

	// Run the open dialog from Go so the native menu and Ctrl+O share one path.
	app.KeyBinding.Add("CmdOrCtrl+O", func(window application.Window) {
		openFileAndNotify(app, books)
	})

	// Double-clicking a .txt in Explorer launches us with the path as argv;
	// the frontend picks it up via BookService.PendingFile (see above), so
	// there is nothing to do for ApplicationOpenedWithFile here.

	err := app.Run()
	if err != nil {
		log.Fatal(err)
	}
}

// buildMenu builds the native application menu. Menu callbacks run on the Go
// side and drive the same code paths the frontend uses, then push the result
// into the webview with an event.
func buildMenu(app *application.App, books *BookService) *application.Menu {
	menu := app.NewMenu()

	file := menu.AddSubmenu("ファイル")
	file.Add("開く…").SetAccelerator("CmdOrCtrl+O").OnClick(func(ctx *application.Context) {
		openFileAndNotify(app, books)
	})
	file.AddSeparator()
	// The recent list is rebuilt whenever a file is opened, since Wails v3 has
	// no menu-open callback on Windows.
	recent := file.AddSubmenu("最近使ったファイル")
	books.recentMenu = recent
	rebuildRecent(recent, books)
	file.AddSeparator()
	file.Add("終了").SetAccelerator("CmdOrCtrl+Q").OnClick(func(ctx *application.Context) {
		app.Quit()
	})

	view := menu.AddSubmenu("表示")
	font := view.AddSubmenu("文字サイズ")
	for _, item := range []struct {
		label string
		size  float64
		accel string
	}{
		{"小", 16, "CmdOrCtrl+1"},
		{"中", 20, "CmdOrCtrl+2"},
		{"大", 26, "CmdOrCtrl+3"},
	} {
		size := item.size
		font.Add(item.label).SetAccelerator(item.accel).OnClick(func(ctx *application.Context) {
			emit(app, "honzuki:fontsize", size)
		})
	}
	view.AddSeparator()
	view.Add("縦書き / 横書き を切り替え").SetAccelerator("CmdOrCtrl+M").OnClick(func(ctx *application.Context) {
		emit(app, "honzuki:toggleorientation", nil)
	})
	view.AddSeparator()
	view.Add("ページ設定…").SetAccelerator("CmdOrCtrl+,").OnClick(func(ctx *application.Context) {
		emit(app, "honzuki:settings", nil)
	})

	help := menu.AddSubmenu("ヘルプ")
	help.Add("honzuki について").OnClick(func(ctx *application.Context) {
		app.Dialog.Info().
			SetTitle("honzuki").
			SetMessage("日本語のテキストファイルを、本と同じ縦書き（右から左へ）で読むリーダーです。\n\nWails v3 + Go").
			Show()
	})

	return menu
}

// openFileAndNotify runs the native open dialog and hands the result to the
// frontend. Errors are reported in a native dialog so a failure is never
// silent.
func openFileAndNotify(app *application.App, books *BookService) {
	result, err := books.OpenDialog()
	if err != nil {
		app.Dialog.Error().
			SetTitle("開けませんでした").
			SetMessage(err.Error()).
			Show()
		return
	}
	if result == nil {
		return // cancelled
	}
	rebuildRecent(books.recentMenu, books)
	emit(app, "honzuki:book", result.Book)
}

// loadAndNotify opens a known path, for menu picks from the recent list.
func loadAndNotify(app *application.App, books *BookService, path string) {
	book, err := books.Load(path)
	if err != nil {
		app.Dialog.Error().
			SetTitle("開けませんでした").
			SetMessage(err.Error()).
			Show()
		return
	}
	rebuildRecent(books.recentMenu, books)
	emit(app, "honzuki:book", book)
}

// rebuildRecent fills the recent-files submenu from the store. Menu items close
// over the service, so the list is rebuilt rather than patched.
func rebuildRecent(menu *application.Menu, books *BookService) {
	if menu == nil {
		return
	}
	menu.Clear()
	entries := books.Recent()
	if len(entries) == 0 {
		menu.Add("（まだありません）").SetEnabled(false)
		return
	}
	for _, entry := range entries {
		path := entry.Path
		title := entry.Title
		if runes := []rune(title); len(runes) > 40 {
			title = string(runes[:40]) + "…"
		}
		menu.Add(title).OnClick(func(ctx *application.Context) {
			loadAndNotify(books.app, books, path)
		})
	}
}

// emit sends a named event to every window.
func emit(app *application.App, name string, data any) {
	app.Event.Emit(name, data)
}

// initialWindowSize picks the opening window size: wide enough for a full-size
// two-page spread of the default page (2 x 560 + gap), tall enough for one -
// clamped to the primary screen's work area so the whole window -
// title bar, frames and status bar included - is visible on first launch.
//
// app.Screen cannot be used here: it is populated during app.Run, after the
// window options have been read. Query the OS instead; a WindowLoaded safety
// net below catches platforms this cannot answer.
func initialWindowSize() (int, int) {
	width, height := 1160, 940
	if w, h, ok := primaryWorkArea(); ok {
		if height > h-8 {
			height = h - 8
		}
		if width > w-8 {
			width = w - 8
		}
	}
	return width, height
}

// clampWindowToScreen re-checks the window against app.Screen once the
// runtime is ready (screens are populated by then) and shrinks it if the
// pre-run clamp could not run.
func clampWindowToScreen(app *application.App, window application.Window) {
	primary := app.Screen.GetPrimary()
	if primary == nil {
		return
	}
	maxW, maxH := primary.WorkArea.Width-8, primary.WorkArea.Height-8
	if maxW <= 0 || maxH <= 0 {
		return
	}
	w, h := window.Size()
	if w > maxW || h > maxH {
		window.SetSize(min(w, maxW), min(h, maxH))
		window.Center()
	}
}

// webviewDataPath returns the WebView2 user-data folder. It mirrors the
// location PositionStore uses so all of honzuki's state lives in one place.
//
// The WebView2 runtime always creates its own "EBWebView" subfolder inside
// whatever folder it is given, and Wails' default (when this option is empty)
// is %APPDATA%\<exe name> - hence the stray "honzuki.exe" folder. Passing the
// app folder itself lands the profile at %APPDATA%\honzuki\EBWebView.
func webviewDataPath() string {
	dir := os.Getenv("APPDATA")
	if dir == "" {
		if xdg := os.Getenv("XDG_DATA_HOME"); xdg != "" {
			dir = xdg
		} else if home, err := os.UserHomeDir(); err == nil {
			dir = filepath.Join(home, ".local", "share")
		} else {
			dir = os.TempDir()
		}
	}
	return filepath.Join(dir, "honzuki")
}
