# honzuki

日本語縦書きテキストリーダー — a Japanese vertical-text (縦書き) reader for
plain-text books, built with [Wails v3](https://wails.io) (Go + WebView2).

Open a `.txt`, read it as real typeset vertical pages: right-to-left columns,
kinsoku line-breaking, fixed-size book pages, and a two-page spread when the
window is wide enough. Click any word to look it up in Yomichan-format
dictionaries, pitch accent included.

![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)

## Features

- **縦書き rendering** via CSS `writing-mode: vertical-rl` with proper
  kinsoku (禁則処理) — punctuation never starts or ends a line
- **Real book pages**: pages are fixed-size sheets (文庫 / 新書 / A5 / 大判
  presets, or custom size, margin, and font size in `Ctrl+,`), not
  window-sized. Resizing the window never re-paginates — it only shows one
  sheet or a two-page spread, scaled to fit
- **Dictionary lookup**: select a word to get its headword, reading, definitions,
  and pitch accent from [Yomichan dictionaries](https://github.com/SakiDailene/yomichan-dictionaries)
- **Encoding handling**: automatic detection with a manual override for
  Shift_JIS, EUC-JP, Windows-31J, UTF-8, and friends (Aozora Bunko files
  just work)
- **Reading position** saved per book, restored on reopen; recent-files list
- **Fast**: a 440 KB book paginates in about a second; pagination uses an
  analytic fit model instead of pure binary search
- Drag & drop, `.txt` file association, `honzuki.exe book.txt`, native
  Windows menu with shortcuts, custom app icon

## Dictionary setup

Dictionaries are **not** bundled with honzuki (licensing). Download
Yomichan/Yomitan-format dictionary packs (`.zip`) from
**[SakiDailene/yomichan-dictionaries](https://github.com/SakiDailene/yomichan-dictionaries)**
and drop them into a `dicts` folder:

| Location | When to use |
|---|---|
| `dicts/` next to `honzuki.exe` | portable setup, travels with the exe |
| `%APPDATA%\honzuki\dicts` | installed setup, shared between builds |

Good starting packs from the repo above:

- **新和英** (`[JA-EN]`) — Japanese → English translations
- **大辞泉** (`[Pitch]`) — pitch accent data (shows as `ピッチ …` in the popup)

Restart honzuki after adding dictionaries. The status bar shows `辞書 N` when
N packs are loaded. Then **select a word** in the text: a card appears with
the meaning of exactly what you selected (the lookup never reaches past the
selection). Clear the selection or press `Esc` to dismiss it.

honzuki accepts both JSONL and whole-array term banks, and keeps entries from
partially corrupt zips rather than skipping them.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `←` / `→` | page turn (direction follows the book: 縦書き = `←` advances, 横書き = `→`) |
| `Space` / `PageDown` / `PageUp` | advance / go back |
| `Home` / `End` | first / last page |
| `+` / `-`, `Ctrl+1/2/3` | font size |
| `Ctrl+,` | page settings (size presets, margin, font) |
| `Ctrl+M` | toggle 縦書き / 横書き |
| `Ctrl+O` | open file |
| `Esc` | close dictionary popup → close book |
| `Ctrl+Q` | quit |

## Building

Prerequisites: Go 1.26+, Node 22+, and the Wails v3 CLI
(`go install github.com/wailsapp/wails/v3/cmd/wails3@latest`).

```sh
# 1. Frontend
cd frontend && npm install && npm run build && cd ..

# 2. Go binary (Windows)
GOOS=windows CGO_ENABLED=0 go build -tags production -trimpath \
  -buildvcs=false -ldflags="-w -s -H windowsgui" -o honzuki.exe .
```

Optional regeneration steps:

```sh
# Service bindings (after changing Go service methods)
wails3 generate bindings -ts -clean=true

# App icon (exe + window icon) from assets/icon.svg
go run ./tools/genicon && wails3 generate syso \
  -icon assets/app.ico -manifest build/windows/wails.exe.manifest \
  -out rsrc.syso -arch amd64
```

## Where honzuki keeps its data

Everything lives in `%APPDATA%\honzuki\`:

- `positions.json` — reading positions and recent files
- `EBWebView\` — WebView2 profile
- `dicts\` — optional dictionary zips (the `dicts/` in this repo is
  gitignored for licensing reasons; keep yours out of git too)

## License

MIT — see [LICENSE](LICENSE). Dictionary packs downloaded separately remain
under their own licenses.
