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

async function openBook(next: Book): Promise<void> {
    book = next;
    headings = headingMap(next);
    showBook();
    await relayout(true);
    updateStatus();
}

/**
 * Re-run pagination. `restore` keeps the reader on the same text rather than the
 * same page index, which is what makes resizing and font changes harmless.
 */
async function relayout(restore: boolean): Promise<void> {
    if (!book) return;

    const resumeAt = restore ? laidOut?.pages[current]?.startOffset ?? 0 : 0;

    laidOut = layoutBook(book, host);
    if (laidOut.pages.length === 0) {
        toast("表示できるテキストがありません");
        showWelcome();
        book = null;
        return;
    }

    current = pageForOffset(laidOut.pages, restore ? resumeAt : 0);
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

        // PositionFor returns [position, found]; the saved offset decides where
        // the reader lands after pagination.
        const [saved, found] = await BookService.PositionFor(path);
        await openBook(next);

        if (found && saved && saved.charOffset > 0) {
            current = pageForOffset(laidOut!.pages, saved.charOffset);
            renderCurrentPage();
            toast(`${saved.charOffset} 字目から再開`);
        }
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
        await openBook(next);
        current = pageForOffset(laidOut!.pages, resumeAt);
        renderCurrentPage();
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
}

void start();
