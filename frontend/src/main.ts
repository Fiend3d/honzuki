// The reading view: owns the current book, its pages, and the current page.
//
// Navigation is inverted on purpose. In vertical-rl the next page appears to the
// LEFT, so ArrowLeft/PageDown/Space advance and ArrowRight/PageUp go back.

import { Events } from "@wailsio/runtime";

import { BookService } from "../bindings/github.com/vlad/honzuki";
import type { Book, Position, RecentEntry } from "../bindings/github.com/vlad/honzuki/models";

import {
    headingMap,
    layoutBook,
    pageForOffset,
    measureColumnLength,
    renderPage,
    type LaidOutBook,
    type Page,
} from "./pager";
import {
    applySettings,
    loadSettings,
    saveSettings,
    setFontSize,
    toggleOrientation,
    type Settings,
} from "./settings";

const els = {
    page: document.getElementById("page") as HTMLElement,
    columns: document.getElementById("columns") as HTMLElement,
    welcome: document.getElementById("welcome") as HTMLElement,
    welcomeOpen: document.getElementById("welcome-open") as HTMLButtonElement,
    recent: document.getElementById("recent") as HTMLElement,
    status: document.getElementById("status") as HTMLElement,
    statusTitle: document.getElementById("status-title") as HTMLElement,
    statusPos: document.getElementById("status-pos") as HTMLElement,
    encoding: document.getElementById("encoding") as HTMLSelectElement,
    toast: document.getElementById("toast") as HTMLElement,
};

const host = { container: els.columns };

let settings: Settings = loadSettings();
let book: Book | null = null;
let laidOut: LaidOutBook | null = null;
let headings = new Map<number, string>();
let current = 0;
let saveTimer: number | null = null;
let toastTimer: number | null = null;

// Fingerprint of everything pagination depends on. Startup produces a burst
// of resize events (frame, menu bar, DPI) that would each re-paginate the
// whole book for no reason; a relayout only runs when this key changes.
let layoutKey = "";

function currentLayoutKey(): string {
    const rect = host.container.getBoundingClientRect();
    return [
        Math.round(rect.width), Math.round(rect.height),
        settings.orientation, settings.fontSize,
        settings.lineHeight, settings.letterSpacing, settings.margin,
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

// ----------------------------------------------------------------- display ---

function updateStatus(): void {
    if (!book || !laidOut) return;
    const page = laidOut.pages[current];
    if (!page) return;

    els.statusTitle.textContent = book.title;
    const pct = laidOut.totalChars > 0
        ? Math.round((page.startOffset / laidOut.totalChars) * 100)
        : 0;
    els.statusPos.textContent =
        `${page.number} / ${laidOut.pages.length} 頁 · ${pct}% · ${page.startOffset} 字`;
    els.encoding.value = book.encoding;
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
    const path = book.path;
    const pos = currentPosition();
    BookService.SavePosition(path, pos).catch((err) => {
        console.error("SavePosition failed:", err);
    });
    book = null;
    laidOut = null;
    host.container.replaceChildren();
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

/**
 * Wait until the reader container stops changing size. Right after launch,
 * the frame, menu bar, and DPI settle in a burst of resizes; laying out
 * before they settle means paginating twice.
 */
async function waitForStableContainer(maxWaitMs = 800): Promise<void> {
    const start = performance.now();
    let last = currentLayoutKey();
    let stableSince = performance.now();
    while (performance.now() - start < maxWaitMs) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        const key = currentLayoutKey();
        if (key !== last) {
            last = key;
            stableSince = performance.now();
        } else if (performance.now() - stableSince >= 160) {
            return;
        }
    }
}

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

    await waitForStableContainer();
    await relayout(false, at, true);
    if (at > 0) toast(`${at} 字目から再開`);
}

/**
 * Re-run pagination. `restore` keeps the reader on the same text rather than
 * the same page index, which is what makes resizing and font changes harmless.
 * An explicit `resumeAt` overrides the lookup (used when opening a book).
 */
async function relayout(restore: boolean, resumeAt?: number, force = false): Promise<void> {
    if (!book) return;

    const key = currentLayoutKey();
    if (!force && laidOut && key === layoutKey) {
        // Nothing that pagination depends on has changed; keep the pages.
        renderCurrentPage();
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
    renderCurrentPage();
    schedulePositionSave();
}

function renderCurrentPage(): void {
    if (!laidOut || !book) return;
    const page = laidOut.pages[current];
    if (!page) return;
    renderPage(page, host, headings);
    updateStatus();
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
    const clamped = Math.max(0, Math.min(laidOut.pages.length - 1, index));
    if (clamped === current) return;
    current = clamped;
    renderCurrentPage();
    schedulePositionSave();
}

/** Right-to-left flow: the next page is to the left. */
function nextPage(): void { goTo(current + 1); }
function prevPage(): void { goTo(current - 1); }

function firstPage(): void { goTo(0); }
function lastPage(): void { if (laidOut) goTo(laidOut.pages.length - 1); }

// ---------------------------------------------------------------- events ---

async function applyFont(size: number): Promise<void> {
    setFontSize(settings, size);
    await relayout(true);
    updateStatus();
}

async function applyOrientation(): Promise<void> {
    toggleOrientation(settings);
    saveSettings(settings);
    await relayout(true);
    updateStatus();
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
    if (els.encoding.matches(":focus") || (ev.target as HTMLElement)?.tagName === "SELECT") return;

    switch (ev.key) {
        // Next page: left, down-arrow direction, or space.
        case "ArrowLeft":
        case "PageDown":
        case " ":
            ev.preventDefault();
            nextPage();
            break;
        // Previous page: right.
        case "ArrowRight":
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

// Resizing changes the column length, so the whole book is re-paginated and the
// reader is put back on the same character.
let resizeTimer: number | null = null;
window.addEventListener("resize", () => {
    if (!book) return;
    if (resizeTimer !== null) window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => void relayout(true), 180);
});

// ------------------------------------------------------------------ start ---

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
