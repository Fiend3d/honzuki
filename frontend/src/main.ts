// The reading view: owns the current book, its pages, and the current page.
//
// Navigation follows the book's flow. Vertical-rl runs right-to-left, so
// ArrowLeft advances there; horizontal-tb runs left-to-right, so ArrowRight
// advances. PageDown/Space always advance, PageUp always goes back.
//
// Pages are fixed-size sheets (settings), not window-sized. The window shows
// one sheet, or two side by side when it is wide enough - then a page turn
// flips a whole spread, like a real book. Resizing never re-paginates.

import { Events } from "@wailsio/runtime";

import { BookService, DictionaryService } from "../bindings/github.com/vlad/honzuki";
import type { Book, DictEntry, Position, RecentEntry } from "../bindings/github.com/vlad/honzuki/models";

import {
    buildPageElement,
    headingMap,
    layoutBook,
    pageForOffset,
    measureColumnLength,
    type LaidOutBook,
    type Page,
} from "./pager";
import {
    applySettings,
    loadSettings,
    saveSettings,
    setFontSize,
    setMargin,
    setPageSize,
    toggleOrientation,
    PAGE_PRESETS,
    type Settings,
} from "./settings";

const els = {
    page: document.getElementById("page") as HTMLElement,
    spread: document.getElementById("spread") as HTMLElement,
    measure: document.getElementById("measure") as HTMLElement,
    welcome: document.getElementById("welcome") as HTMLElement,
    welcomeOpen: document.getElementById("welcome-open") as HTMLButtonElement,
    recent: document.getElementById("recent") as HTMLElement,
    status: document.getElementById("status") as HTMLElement,
    statusTitle: document.getElementById("status-title") as HTMLElement,
    statusPos: document.getElementById("status-pos") as HTMLElement,
    encoding: document.getElementById("encoding") as HTMLSelectElement,
    toast: document.getElementById("toast") as HTMLElement,
    statusDict: document.getElementById("status-dict") as HTMLElement,
    settings: document.getElementById("settings") as HTMLElement,
    settingsPresets: document.getElementById("settings-presets") as HTMLElement,
    settingsClose: document.getElementById("settings-close") as HTMLButtonElement,
    pageW: document.getElementById("page-w") as HTMLInputElement,
    pageH: document.getElementById("page-h") as HTMLInputElement,
    pageMargin: document.getElementById("page-margin") as HTMLInputElement,
    pageFont: document.getElementById("page-font") as HTMLInputElement,
};

// The pager measures against the off-screen box, which CSS sizes to the
// sheet's text area (page size minus margins). Window size is irrelevant.
const host = { container: els.measure };

// Keep in sync with --spread-gap in style.css.
const SPREAD_GAP = 18;
// Keep in sync with --desk-pad in style.css: the desk margin the spread must
// clear, on each side.
const DESK_PAD = 28;

let settings: Settings = loadSettings();
let book: Book | null = null;
let laidOut: LaidOutBook | null = null;
let headings = new Map<number, string>();
let current = 0;
let saveTimer: number | null = null;
let toastTimer: number | null = null;

// Fingerprint of everything pagination depends on - all of it settings.
// Window size is deliberately absent: resizing must never re-paginate.
let layoutKey = "";

function currentLayoutKey(): string {
    return [
        settings.pageWidth, settings.pageHeight, settings.margin,
        settings.orientation, settings.fontSize,
        settings.lineHeight, settings.letterSpacing,
    ].join("|");
}

// ------------------------------------------------------------------- toast ---

function toast(message: string): void {
    els.toast.textContent = message;
    els.toast.hidden = false;
    // Force a reflow so the transition runs even for back-to-back toasts.
    void els.toast.offsetWidth;
    els.toast.classList.add("visible");
    if (toastTimer !== null) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
        els.toast.classList.remove("visible");
    }, 2600);
}

// --------------------------------------------------------------- positions ---

function currentPosition(): Position {
    const page: Page | undefined = laidOut?.pages[current];
    return {
        path: book?.path ?? "",
        charOffset: page?.startOffset ?? 0,
        page: page?.number ?? 1,
        fontSize: settings.fontSize,
        lineHeight: settings.lineHeight,
        columnHeight: laidOut ? measureColumnLength(host) : 0,
        margin: settings.margin,
        letterSpacing: settings.letterSpacing,
        horizontal: settings.orientation === "horizontal",
        encoding: book?.encoding ?? "",
        openedAt: Math.floor(Date.now() / 1000),
    } as Position;
}

/** Debounced so rapid page turns do not hammer the store. */
function schedulePositionSave(): void {
    if (!book) return;
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
        const pos = currentPosition();
        BookService.SavePosition(book!.path, pos).catch((err) => {
            console.error("SavePosition failed:", err);
        });
    }, 400);
}

// --------------------------------------------------------------- display ---

/** Usable viewport area. The status bar sits in its own flex row, so the
 *  page area already excludes it. */
function availArea(): { w: number; h: number } {
    const rect = els.page.getBoundingClientRect();
    return { w: rect.width, h: rect.height };
}

/** 2 when the window is wide enough for a full-size spread (including the
 *  desk padding on both sides), else 1. */
function spreadCount(): number {
    return availArea().w >= settings.pageWidth * 2 + SPREAD_GAP + 2 * DESK_PAD ? 2 : 1;
}

function updateStatus(visiblePages: number): void {
    if (!book || !laidOut) return;
    const page = laidOut.pages[current];
    if (!page) return;
    const last = laidOut.pages[Math.min(current + visiblePages - 1, laidOut.pages.length - 1)];
    if (!last) return;

    els.statusTitle.textContent = book.title;
    const pct = laidOut.totalChars > 0
        ? Math.round((page.startOffset / laidOut.totalChars) * 100)
        : 0;
    const range = last.number > page.number ? `${page.number}–${last.number}` : `${page.number}`;
    els.statusPos.textContent =
        `${range} / ${laidOut.pages.length} 頁 · ${pct}% · ${page.startOffset} 字`;
    els.encoding.value = book.encoding;
    els.statusDict.textContent = dictNames.length > 0 ? `辞書 ${dictNames.length}` : "";
}

/**
 * Render the current spread: one or two fixed-size sheets, scaled down (never
 * up) so they fit the window. Cheap - safe to call on every resize.
 */
function renderSpread(): void {
    if (!laidOut || !book) {
        els.spread.replaceChildren();
        return;
    }
    const page = laidOut.pages[current];
    if (!page) return;

    const count = Math.min(spreadCount(), laidOut.pages.length - current);
    const pages = laidOut.pages.slice(current, current + Math.max(1, count));

    // Vertical books read right to left: the right sheet is the earlier
    // page. DOM order is left to right, so reverse the pair.
    const ordered = settings.orientation === "vertical" && pages.length === 2
        ? [pages[1], pages[0]]
        : pages;

    const sheets = ordered.map((p) => {
        const sheet = document.createElement("div");
        sheet.className = "sheet";
        const columns = document.createElement("div");
        columns.className = "columns";
        columns.appendChild(buildPageElement(p, headings));
        sheet.appendChild(columns);

        // Printed page number, like a real book: bottom center, in the
        // sheet's bottom margin band.
        const num = document.createElement("div");
        num.className = "page-number";
        num.textContent = String(p.number);
        sheet.appendChild(num);

        return sheet;
    });
    const row = document.createElement("div");
    row.className = "sheets";
    row.append(...sheets);
    els.spread.replaceChildren(row);

    // Fit the spread inside the viewport, keeping at least the desk padding
    // clear on every side. The spread box is sized to the SCALED size so it
    // always fits and centers cleanly; the sheet row is centered inside it
    // with absolute positioning and scaled about its center.
    const avail = availArea();
    const neededW = pages.length * settings.pageWidth + (pages.length - 1) * SPREAD_GAP;
    const neededH = settings.pageHeight;
    const scale = Math.min(
        1,
        (avail.w - 2 * DESK_PAD) / neededW,
        (avail.h - 2 * DESK_PAD) / neededH,
    );
    els.spread.style.width = `${Math.round(neededW * scale)}px`;
    els.spread.style.height = `${Math.round(neededH * scale)}px`;
    row.style.transform = `translate(-50%, -50%) scale(${scale})`;

    updateStatus(pages.length);
}

function showWelcome(): void {
    els.welcome.hidden = false;
    els.status.hidden = true;
    els.page.hidden = true;
    void refreshRecent();
}

function showBook(): void {
    els.welcome.hidden = true;
    els.status.hidden = false;
    els.page.hidden = false;
}

/** Close the book and return to the start screen, keeping the read position. */
function closeBook(): void {
    if (!book) return;
    closeDictPopup();
    clearSelection();
    const path = book.path;
    const pos = currentPosition();
    BookService.SavePosition(path, pos).catch((err) => {
        console.error("SavePosition failed:", err);
    });
    book = null;
    laidOut = null;
    els.spread.replaceChildren();
    showWelcome();
}

async function refreshRecent(): Promise<void> {
    let entries: RecentEntry[] = [];
    try {
        entries = (await BookService.Recent()) ?? [];
    } catch (err) {
        console.error("Recent failed:", err);
        return;
    }

    els.recent.replaceChildren();
    for (const entry of entries) {
        const li = document.createElement("li");
        li.dataset.path = entry.path;

        const title = document.createElement("span");
        title.className = "recent-title";
        title.textContent = entry.title;

        const where = document.createElement("span");
        where.className = "recent-where";
        where.textContent = entry.charOffset > 0 ? `${entry.charOffset} 字から` : "最初から";

        li.append(title, where);
        li.addEventListener("click", () => void openPath(entry.path));
        els.recent.appendChild(li);
    }
}

// ------------------------------------------------------------------- open ---

async function openBook(next: Book, resumeAt?: number): Promise<void> {
    book = next;
    headings = headingMap(next);
    // A new book starts from its own saved position, never from wherever the
    // previous book happened to be showing.
    laidOut = null;
    current = 0;
    showBook();

    let at = resumeAt ?? 0;
    if (resumeAt === undefined) {
        try {
            const [saved, found] = await BookService.PositionFor(next.path);
            if (found && saved && saved.charOffset > 0) at = saved.charOffset;
        } catch {
            // A failed lookup just means the book opens from the start.
        }
    }

    await relayout(false, at, true);
    if (at > 0) toast(`${at} 字目から再開`);
}

/**
 * Re-run pagination. `restore` keeps the reader on the same text rather than
 * the same page index, which is what makes font and page-size changes
 * harmless. An explicit `resumeAt` overrides the lookup (used when opening).
 */
async function relayout(restore: boolean, resumeAt?: number, force = false): Promise<void> {
    if (!book) return;
    closeDictPopup();
    clearSelection();

    const key = currentLayoutKey();
    if (!force && laidOut && key === layoutKey) {
        // Nothing pagination depends on has changed; just re-show the pages.
        renderSpread();
        return;
    }
    layoutKey = key;

    const at = resumeAt ?? (restore ? laidOut?.pages[current]?.startOffset ?? 0 : 0);

    const t0 = performance.now();
    laidOut = layoutBook(book, host);
    const layoutMs = Math.round(performance.now() - t0);
    // WebView2 does not forward console.log to Go, so timings go through the
    // service and land in the Go log (benchmarking and bug reports both use it).
    BookService.Report(`layout: ${laidOut.pages.length} pages in ${layoutMs} ms`).catch(() => {});

    if (laidOut.pages.length === 0) {
        laidOut = null;
        toast("表示できるテキストがありません");
        showWelcome();
        book = null;
        return;
    }

    current = pageForOffset(laidOut.pages, at);
    renderSpread();
    schedulePositionSave();
}

async function openPath(path: string): Promise<void> {
    try {
        const next = await BookService.Load(path);
        if (!next) return;
        // openBook restores the saved position itself, so dropped files,
        // menu picks, and the start screen all resume the same way.
        await openBook(next);
    } catch (err) {
        toast(errorMessage(err));
    }
}

async function openViaDialog(): Promise<void> {
    try {
        const opened = await BookService.OpenDialog();
        if (!opened || !opened.book) return; // cancelled
        await openBook(opened.book);
    } catch (err) {
        toast(errorMessage(err));
    }
}

function errorMessage(err: unknown): string {
    if (typeof err === "string") return err;
    if (err instanceof Error) return err.message;
    return "開けませんでした";
}

// ------------------------------------------------------------ navigation ---

function goTo(index: number): void {
    if (!laidOut) return;
    closeDictPopup();
    clearSelection();
    const clamped = Math.max(0, Math.min(laidOut.pages.length - 1, index));
    if (clamped === current) return;
    current = clamped;
    renderSpread();
    schedulePositionSave();
}

/** Right-to-left flow: the next page is to the left. In a spread, a turn
 *  moves a whole spread - two pages - like flipping a real book page. */
function nextPage(): void { goTo(current + spreadCount()); }
function prevPage(): void { goTo(current - spreadCount()); }

function firstPage(): void { goTo(0); }
function lastPage(): void { if (laidOut) goTo(laidOut.pages.length - 1); }

// -------------------------------------------------------------- settings ---

function renderPresetButtons(): void {
    els.settingsPresets.replaceChildren();
    for (const preset of PAGE_PRESETS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = preset.name;
        btn.classList.toggle("active",
            preset.width === settings.pageWidth && preset.height === settings.pageHeight);
        btn.addEventListener("click", () => {
            setPageSize(settings, preset.width, preset.height);
            els.pageW.value = String(settings.pageWidth);
            els.pageH.value = String(settings.pageHeight);
            renderPresetButtons();
            void relayout(true);
        });
        els.settingsPresets.appendChild(btn);
    }
}

function openSettings(): void {
    els.pageW.value = String(settings.pageWidth);
    els.pageH.value = String(settings.pageHeight);
    els.pageMargin.value = String(settings.margin);
    els.pageFont.value = String(settings.fontSize);
    renderPresetButtons();
    els.settings.hidden = false;
    els.pageW.focus();
}

function closeSettings(): void {
    els.settings.hidden = true;
}

// Typing a number fires per keystroke; re-paginating a whole book each time
// would be silly, so changes are applied after a short pause.
let settingsTimer: number | null = null;

function onSettingsInput(): void {
    if (settingsTimer !== null) window.clearTimeout(settingsTimer);
    settingsTimer = window.setTimeout(() => {
        setPageSize(settings, Number(els.pageW.value), Number(els.pageH.value));
        setMargin(settings, Number(els.pageMargin.value));
        setFontSize(settings, Number(els.pageFont.value));
        els.pageW.value = String(settings.pageWidth);
        els.pageH.value = String(settings.pageHeight);
        renderPresetButtons();
        void relayout(true);
    }, 350);
}

// ---------------------------------------------------------------- events ---

async function applyFont(size: number): Promise<void> {
    setFontSize(settings, size);
    els.pageFont.value = String(settings.fontSize);
    await relayout(true);
}

async function applyOrientation(): Promise<void> {
    toggleOrientation(settings);
    saveSettings(settings);
    await relayout(true);
}

// Menu actions come from Go.
Events.On("honzuki:book", (ev: { data?: unknown }) => {
    const book = ev.data as Book | null;
    if (book) void openBook(book);
});

Events.On("honzuki:fontsize", (ev: { data?: unknown }) => {
    const size = Number(ev.data);
    if (Number.isFinite(size)) void applyFont(size);
});

Events.On("honzuki:toggleorientation", () => {
    void applyOrientation();
});

Events.On("honzuki:settings", () => {
    openSettings();
});

// Files dropped on the page. The runtime posts the drop to Go, which hands the
// paths to this window's OnWindowEvent listener; that listener re-emits them as
// a custom event so opening a dropped file follows the same path as the menu.
Events.On("honzuki:filesdropped", (ev: { data?: unknown }) => {
    const files = ev.data as string[] | undefined;
    const path = files?.[0];
    if (path) void openPath(path);
});
// ------------------------------------------------------------- bindings ---

els.welcomeOpen.addEventListener("click", () => void openViaDialog());
els.settingsClose.addEventListener("click", closeSettings);
for (const input of [els.pageW, els.pageH, els.pageMargin, els.pageFont]) {
    input.addEventListener("input", onSettingsInput);
}

els.encoding.addEventListener("change", async () => {
    if (!book) return;
    const chosen = els.encoding.value;
    try {
        const next = await BookService.Reinterpret(book.path, chosen);
        if (!next) return;
        const resumeAt = laidOut?.pages[current]?.startOffset ?? 0;
        // Re-decoding the same file must land on the same text, not on the
        // saved position, which may be older than what is on screen now.
        await openBook(next, resumeAt);
        toast(`文字コードを ${next.encoding} で読み直しました`);
    } catch (err) {
        toast(errorMessage(err));
    }
});

window.addEventListener("keydown", (ev: KeyboardEvent) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

    // The settings dialog owns the keyboard while it is open.
    if (!els.settings.hidden) {
        if (ev.key === "Escape") {
            ev.preventDefault();
            closeSettings();
        }
        return;
    }

    const tag = (ev.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "SELECT") return;

    switch (ev.key) {
        // Direction follows the book: vertical flow runs right-to-left, so
        // left advances; horizontal flow runs left-to-right, so right does.
        case "ArrowLeft":
            ev.preventDefault();
            if (settings.orientation === "vertical") nextPage();
            else prevPage();
            break;
        case "ArrowRight":
            ev.preventDefault();
            if (settings.orientation === "vertical") prevPage();
            else nextPage();
            break;
        // These always advance/go back, whichever way the book runs.
        case "PageDown":
        case " ":
            ev.preventDefault();
            nextPage();
            break;
        case "PageUp":
            ev.preventDefault();
            prevPage();
            break;
        case "Home":
            ev.preventDefault();
            firstPage();
            break;
        case "End":
            ev.preventDefault();
            lastPage();
            break;
        case "Escape":
            ev.preventDefault();
            if (dictPopup) {
                closeDictPopup();
                clearSelection();
                break;
            }
            closeBook();
            break;
        case "+":
        case "=":
            ev.preventDefault();
            void applyFont(settings.fontSize + 2);
            break;
        case "-":
        case "_":
            ev.preventDefault();
            void applyFont(settings.fontSize - 2);
            break;
        default:
            break;
    }
});

// Resizing changes only the display - how many sheets fit and whether they
// need scaling. Pagination is fixed by settings and stays untouched.
window.addEventListener("resize", () => {
    if (book) renderSpread();
});

// ------------------------------------------------------------------ start ---

// ---------------------------------------------------------------------------
// Dictionary lookup. Selection-driven: select text and the popup appears
// with the meaning of exactly what was selected - the lookup never reaches
// past the selection. Selecting nothing shows nothing.
// ---------------------------------------------------------------------------

let dictPopup: HTMLElement | null = null;
let dictNames: string[] = [];
let selectionTimer: number | null = null;

const DICT_MAX_SELECT = 16; // matches the Go-side prefix bound

function closeDictPopup(): void {
    if (dictPopup) {
        dictPopup.remove();
        dictPopup = null;
    }
}

function clearSelection(): void {
    document.getSelection()?.removeAllRanges();
}

function pitchLabel(entry: DictEntry): string {
    if (!entry.pitch || entry.pitch.length === 0) return "";
    return `ピッチ ${entry.pitch.map((p) => (p === 0 ? "0(平板)" : String(p))).join(" · ")}`;
}

// Count morae in a kana reading: small kana (っャュョぁぃぅぇぉ…) merge into
// the preceding mora, everything else - including ー and long vowels - is one.
// Returns -1 when the string is not pure kana (kanji headword with no
// reading), in which case a diagram cannot be drawn.
function moraCount(kana: string): number {
    let n = 0;
    for (const ch of kana) {
        if ("ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ".includes(ch)) continue;
        if (/[\u3041-\u309f\u30a1-\u30ff]/.test(ch)) {
            n++;
            continue;
        }
        return -1;
    }
    return n;
}

// The classic pitch contour: a line over the morae that drops at the accent
// position. 0 = 平板 (flat, no drop); N = drop after mora N; N = mora count
// = 尾高 (first mora low, drop after the word).
function pitchDiagram(entry: DictEntry): Element | null {
    if (!entry.pitch || entry.pitch.length === 0) return null;
    const kana = entry.reading || entry.expression;
    const morae = moraCount(kana);
    if (morae < 2) return null;
    const pos = Math.min(entry.pitch[0], morae);

    const w = Math.max(34, morae * 15);
    const hi = 3;
    const lo = 13;
    const x = (i: number) => ((i - 0.5) * w) / morae;

    const pts: [number, number][] = [];
    for (let i = 1; i <= morae; i++) {
        let high: boolean;
        if (pos === 0) high = true;                    // heiban: flat high
        else if (pos === morae) high = i !== 1;        // odaka: first mora low
        else high = i <= pos;                          // ataka / nakadaka
        pts.push([x(i), high ? hi : lo]);
    }
    // Non-heiban patterns show the drop past the end of the word too.
    if (pos === morae) pts.push([w + 7, lo]);

    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", String(w + 10));
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", `0 0 ${w + 10} 16`);
    svg.setAttribute("class", "dict-pitch-line");

    const line = document.createElementNS(ns, "polyline");
    line.setAttribute("points", pts.map(([px, py]) => `${px},${py}`).join(" "));
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "1.6");
    svg.appendChild(line);

    for (const [px, py] of pts) {
        const dot = document.createElementNS(ns, "circle");
        dot.setAttribute("cx", String(px));
        dot.setAttribute("cy", String(py));
        dot.setAttribute("r", "1.8");
        dot.setAttribute("fill", "currentColor");
        svg.appendChild(dot);
    }
    return svg;
}

function showDictPopup(x: number, y: number, entries: DictEntry[]): void {
    closeDictPopup();
    const box = document.createElement("div");
    box.className = "dict-popup";

    for (const entry of entries.slice(0, 6)) {
        const item = document.createElement("div");
        item.className = "dict-entry";

        const head = document.createElement("div");
        head.className = "dict-head";
        const term = document.createElement("b");
        term.textContent = entry.expression;

        // Pitch contour line floating above the headword, like a dictionary
        // diagram; the numeric badge stays for the exact position.
        const termWrap = document.createElement("span");
        termWrap.className = "dict-term";
        if (entry.pitch && entry.pitch.length > 0) {
            const diagram = pitchDiagram(entry);
            if (diagram) termWrap.appendChild(diagram);
        }
        termWrap.appendChild(term);
        head.appendChild(termWrap);

        if (entry.reading && entry.reading !== entry.expression) {
            const read = document.createElement("span");
            read.className = "dict-reading";
            read.textContent = entry.reading;
            head.appendChild(read);
        }
        // Pitch rides along as a small badge on the headword line rather
        // than as its own entry.
        if (entry.kind !== "pitch" && entry.pitch && entry.pitch.length > 0) {
            const badge = document.createElement("span");
            badge.className = "dict-pitch";
            badge.textContent = pitchLabel(entry);
            head.appendChild(badge);
        }
        const src = document.createElement("span");
        src.className = "dict-source";
        src.textContent = entry.source;
        head.appendChild(src);
        item.appendChild(head);

        if (entry.kind === "pitch") {
            const line = document.createElement("div");
            line.className = "dict-def";
            line.textContent = pitchLabel(entry);
            item.appendChild(line);
        } else {
            for (const def of entry.definitions.slice(0, 3)) {
                for (const rawLine of def.split("\n").slice(0, 3)) {
                    const line = document.createElement("div");
                    line.className = "dict-def";
                    line.textContent = rawLine.trim();
                    item.appendChild(line);
                }
            }
        }
        box.appendChild(item);
    }

    document.body.appendChild(box);
    dictPopup = box;

    // Clamp inside the viewport.
    const rect = box.getBoundingClientRect();
    const px = Math.max(8, Math.min(x + 12, window.innerWidth - rect.width - 8));
    const py = Math.max(8, Math.min(y + 12, window.innerHeight - rect.height - 8));
    box.style.left = `${px}px`;
    box.style.top = `${py}px`;
}

async function lookupSelection(): Promise<void> {
    if (dictNames.length === 0) return;
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        closeDictPopup();
        return;
    }
    // Japanese has no word boundaries; whitespace from line breaks is noise.
    const text = sel.toString().replace(/\s+/g, "").slice(0, DICT_MAX_SELECT);
    if (text.length === 0) {
        closeDictPopup();
        return;
    }
    try {
        // LookupPrefix tries the whole selection first, then shorter prefixes
        // of it - never anything beyond the selection.
        const hits = await DictionaryService.LookupPrefix(text);
        if (hits && hits.length > 0) {
            const rect = sel.getRangeAt(0).getBoundingClientRect();
            showDictPopup(rect.right, rect.bottom, hits);
        } else {
            closeDictPopup();
        }
    } catch {
        // Lookup failures stay silent; the reader must keep working.
    }
}

document.addEventListener("selectionchange", () => {
    // Debounce: dragging a selection fires this per glyph; one lookup once
    // the selection settles is enough.
    if (selectionTimer !== null) window.clearTimeout(selectionTimer);
    selectionTimer = window.setTimeout(() => {
        selectionTimer = null;
        void lookupSelection();
    }, 150);
});

Events.On("honzuki:dictready", (ev: { data?: unknown }) => {
    const data = ev.data as { dictionaries?: string[] } | undefined;
    dictNames = data?.dictionaries ?? [];
    if (dictNames.length > 0) {
        dictNames = dictNames.map((n) => n.replace(/^\[.*?\]\s*/, "").replace(/\.zip$/, ""));
    }
});

async function start(): Promise<void> {
    applySettings(settings);

    const encodings = (await BookService.Encodings()) ?? [];
    els.encoding.replaceChildren();
    for (const enc of encodings) {
        const opt = document.createElement("option");
        opt.value = enc;
        opt.textContent = enc;
        els.encoding.appendChild(opt);
    }

    showWelcome();

    // Dictionaries may already be loaded (or load a moment later); the
    // dictready event covers the slow case.
    try {
        const status = await DictionaryService.Status();
        if (status && status.length > 0) {
            dictNames = status.map((n) => n.replace(/^\[.*?\]\s*/, "").replace(/\.zip$/, ""));
        }
    } catch {
        // no dictionaries
    }

    // A file passed on the command line opens after listeners exist, so the
    // handoff never races the event system.
    try {
        const pending = await BookService.PendingFile();
        if (pending) await openPath(pending);
    } catch (err) {
        toast(errorMessage(err));
    }
}

void start();
