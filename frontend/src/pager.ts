// Pagination for a vertical Japanese book.
//
// The page is a fixed box. CSS already knows how to set Japanese text in
// columns that run top-to-bottom and advance right-to-left, so pagination is
// done by measurement, not by arithmetic: put text in the box, ask the browser
// how far it overflowed, cut it there, and repeat.
//
// Positions are stored as character offsets into the book, never as page
// numbers. A page number is only valid for one window size and one font size;
// a character offset survives resizing, font changes, and reopening the app.

import type { Book, Paragraph } from "../bindings/github.com/vlad/honzuki/models";

/** One page: the character range it shows, plus the DOM that renders it. */
export interface Page {
    /** Index of the first character of this page, across the whole book. */
    startOffset: number;
    /** Index past the last character of this page. */
    endOffset: number;
    /** 1-based page number, for display only. */
    number: number;
    /** Paragraph indices this page covers, with the slice taken from each. */
    slices: ParagraphSlice[];
}

interface ParagraphSlice {
    paragraph: Paragraph;
    /** Character offset of this slice within the paragraph. */
    from: number;
    /** Character count taken from the paragraph. */
    length: number;
    /** True when this is the tail of a paragraph continued from the last page. */
    continued: boolean;
    /** True when the paragraph continues onto the next page. */
    continues: boolean;
}

/** A paragraph cut into page-sized pieces. */
export interface LaidOutBook {
    pages: Page[];
    /** Total characters, used to clamp offsets. */
    totalChars: number;
}

/** The element CSS measures against; it must carry the reading styles. */
export interface MeasureHost {
    container: HTMLElement;
}

const MIN_COLUMN_PX = 200;

function runeLen(s: string): number {
    // Array.from iterates code points, so surrogate pairs count once — matching
    // the rune counting the Go side uses for chapter offsets.
    return Array.from(s).length;
}

/** Rune offsets of every U+2028 (intra-paragraph line break) in the text. */
function breakOffsets(s: string): number[] {
    const offsets: number[] = [];
    let i = 0;
    for (const ch of s) {
        if (ch === "\u2028") offsets.push(i);
        i += 1;
    }
    return offsets;
}

// --------------------------------------------------------------------------
// Measurement
// --------------------------------------------------------------------------

/**
 * The length of one column in the current layout: the inline size, which is the
 * height in vertical mode and the width in horizontal mode.
 */
export function measureColumnLength(host: MeasureHost): number {
    const rect = host.container.getBoundingClientRect();
    const vertical = document.body.dataset.orientation === "vertical";
    const length = vertical ? rect.height : rect.width;
    // A tiny window would otherwise produce a page that holds almost nothing
    // and a pagination loop that never terminates.
    return Math.max(MIN_COLUMN_PX, Math.floor(length));
}

/** Build the <p> for one slice, honouring headings and U+2028 line breaks. */
function buildParaNode(slice: ParagraphSlice, headingByPara: Map<number, string>): HTMLElement {
    const isHeading = headingByPara.has(slice.paragraph.index) && slice.from === 0;
    const p = document.createElement("p");
    p.className = isHeading ? "para chapter-heading" : "para";
    if (slice.continued) p.classList.add("continuation");

    // U+2028 marks a line break inside a paragraph; render it as a real
    // break so intra-paragraph line structure survives pagination.
    const text = slice.paragraph.text.slice(slice.from, slice.from + slice.length);
    if (isHeading) {
        p.textContent = text;
    } else {
        const parts = text.split("\u2028");
        parts.forEach((part, i) => {
            if (i > 0) p.appendChild(document.createElement("br"));
            p.appendChild(document.createTextNode(part));
        });
    }
    return p;
}

/** How far an element's content overflows the page box, in pixels. */
function measureOverflow(el: HTMLElement, host: MeasureHost): number {
    // Overflow appears along the block axis, not the inline axis: in
    // vertical-rl the container height is fixed, so text that does not fit
    // wraps into new columns to the left and the content WIDTH is what
    // exceeds the box. In horizontal-tb lines wrap downward, so it is height.
    const vertical = document.body.dataset.orientation === "vertical";
    const rect = host.container.getBoundingClientRect();
    return vertical ? el.scrollWidth - rect.width : el.scrollHeight - rect.height;
}

// --------------------------------------------------------------------------
// Layout
// --------------------------------------------------------------------------

/** Page capacity derived from live CSS, in the three units the pager thinks in. */
interface Capacity {
    /** Upper bound on characters per page. */
    chars: number;
    /** Upper bound on characters in one column. */
    perColumn: number;
    /** Columns that fit across the page box. */
    columns: number;
}

/**
 * Upper bound on how many characters can fit on one page, derived from the
 * live CSS (font size, letter spacing, line height, page box). Real text
 * only fits less than this - U+2028 breaks and kinsoku waste column tails -
 * so it is safe as a search bound: it prevents the pager from measuring
 * whole multi-page paragraphs one character-starved slice at a time.
 */
function estimateCapacity(host: MeasureHost): Capacity {
    const cs = window.getComputedStyle(host.container);
    const fontSize = parseFloat(cs.fontSize) || 16;
    const letterSpacing = parseFloat(cs.letterSpacing) || 0;
    const lineHeight = parseFloat(cs.lineHeight) || fontSize * 1.2;
    const rect = host.container.getBoundingClientRect();
    const vertical = document.body.dataset.orientation === "vertical";
    const columnLength = vertical ? rect.height : rect.width;
    const pageBreadth = vertical ? rect.width : rect.height;
    const perColumn = Math.max(1, Math.floor(columnLength / (fontSize + letterSpacing)));
    const columns = Math.max(1, Math.floor(pageBreadth / lineHeight));
    return { chars: Math.max(200, perColumn * columns), perColumn, columns };
}

/**
 * Analytic guess at how many characters of a paragraph fit in `columns`
 * columns, accounting for U+2028 breaks: each break starts a new column and
 * wastes the tail of the old one. Kinsoku rules shift characters by one or
 * two columns, so the guess is verified (and corrected) by measurement -
 * but it is close enough to turn an 11-probe binary search into 2-4 probes.
 */
function estimateFit(
    from: number,
    limit: number,
    perColumn: number,
    columns: number,
    breaks: number[],
): number {
    const end = from + limit;
    let usedColumns = 0;
    let taken = 0;
    let segStart = from;
    for (const b of breaks) {
        if (b <= segStart) continue;
        if (b >= end) break;
        const segLen = b - segStart;
        const cols = Math.ceil(segLen / perColumn);
        if (usedColumns + cols > columns) {
            return taken + Math.max(0, (columns - usedColumns) * perColumn);
        }
        usedColumns += cols;
        taken += segLen;
        segStart = b + 1;
    }
    const segLen = end - segStart;
    if (usedColumns + Math.ceil(segLen / perColumn) > columns) {
        return taken + Math.max(0, (columns - usedColumns) * perColumn);
    }
    return limit;
}

/**
 * Cut a book into pages by measuring candidate pages against the live CSS.
 *
 * Measurement is incremental: each page keeps one live column element and
 * paragraphs are appended to it as they are accepted (and removed again when
 * rejected). Rebuilding the whole page for every trial made layout quadratic
 * in paragraphs-per-page.
 */
export function layoutBook(
    book: Book,
    host: MeasureHost,
    onProgress?: (done: number, total: number) => void,
): LaidOutBook {
    const paragraphs = book.paragraphs ?? [];
    const headingByPara = headingMap(book);

    // Rune lengths and U+2028 break positions are computed once per
    // paragraph. The fill loop asks for the same paragraph's data on every
    // trial; re-deriving it per trial dominated the layout time before.
    const lengths = paragraphs.map((p) => runeLen(p.text));
    const breaks = paragraphs.map((p) => breakOffsets(p.text));
    const totalChars = lengths.reduce((sum, n) => sum + n, 0);

    const pages: Page[] = [];
    const cap = estimateCapacity(host);

    let paraIdx = 0;
    let paraOffset = 0;
    let globalOffset = 0;
    let acceptedChars = 0;

    while (paraIdx < paragraphs.length) {
        const startOffset = globalOffset;
        const slices: ParagraphSlice[] = [];
        acceptedChars = 0;
        const column = document.createElement("div");
        column.className = "column";
        host.container.replaceChildren(column);

        // Fill the page with whole paragraphs while it still fits.
        while (paraIdx < paragraphs.length) {
            const remaining = lengths[paraIdx] - paraOffset;

            // A paragraph longer than a full page can never fit whole;
            // measuring it would grow a multi-page DOM for nothing. Skip
            // straight to the character fit below.
            if (remaining > cap.chars) break;

            const slice: ParagraphSlice = {
                paragraph: paragraphs[paraIdx],
                from: paraOffset,
                length: remaining,
                continued: paraOffset > 0,
                continues: false,
            };
            const node = buildParaNode(slice, headingByPara);
            column.appendChild(node);

            if (measureOverflow(column, host) > 0) {
                column.removeChild(node);
                break;
            }
            slices.push(slice);
            acceptedChars += remaining;
            globalOffset += remaining;
            paraIdx += 1;
            paraOffset = 0;
        }

        // The page stopped at a paragraph that does not fit whole. Fill the
        // leftover space with as much of that paragraph as fits: ending the
        // page here would leave a hole on the left of every page that
        // precedes a long paragraph, and the hole moves when the window is
        // resized, which reads as text disappearing.
        if (paraIdx < paragraphs.length) {
            const remaining = lengths[paraIdx] - paraOffset;
            const taken = fitParagraphByCharacter(
                paragraphs[paraIdx], paraOffset, host, column, cap, headingByPara,
                breaks[paraIdx], acceptedChars,
            );
            if (taken > 0) {
                const slice: ParagraphSlice = {
                    paragraph: paragraphs[paraIdx],
                    from: paraOffset,
                    length: taken,
                    continued: paraOffset > 0,
                    continues: paraOffset + taken < remaining,
                };
                column.appendChild(buildParaNode(slice, headingByPara));
                slices.push(slice);
                globalOffset += taken;
                paraOffset += taken;
                if (paraOffset >= lengths[paraIdx]) {
                    paraIdx += 1;
                    paraOffset = 0;
                }
            } else if (slices.length === 0) {
                // Nothing fits at all (degenerate layout). Advance one
                // character so the loop always makes progress instead of
                // spinning.
                const last = paraOffset + 1 >= lengths[paraIdx];
                slices.push({
                    paragraph: paragraphs[paraIdx],
                    from: paraOffset,
                    length: 1,
                    continued: paraOffset > 0,
                    continues: !last,
                });
                column.appendChild(buildParaNode(slices[0], headingByPara));
                globalOffset += 1;
                paraOffset += 1;
                if (last) {
                    paraIdx += 1;
                    paraOffset = 0;
                }
            }
        }

        pages.push({
            startOffset,
            endOffset: globalOffset,
            number: pages.length + 1,
            slices,
        });

        onProgress?.(globalOffset, totalChars);
    }

    // Leave the container empty; the pager renders pages from here.
    host.container.replaceChildren();

    return { pages, totalChars };
}

/**
 * Binary-search the largest prefix of a paragraph that fits the space left in
 * `column` (which already holds the page's accepted slices).
 *
 * The trial node is appended to the live column and removed again, so each
 * step measures once without rebuilding what is already accepted.
 */
/**
 * Find the largest prefix of a paragraph that fits the space left in
 * `column` (which already holds the page's accepted slices).
 *
 * The search is seeded by an analytic estimate (columns minus U+2028 waste)
 * and verified by measurement; the estimate is usually within a character or
 * two, so a page that used to cost ~11 forced layouts costs 2-4.
 */
function fitParagraphByCharacter(
    para: Paragraph,
    from: number,
    host: MeasureHost,
    column: HTMLElement,
    cap: Capacity,
    headingByPara: Map<number, string>,
    breaks: number[],
    acceptedChars: number,
): number {
    const chars = runeLen(para.text);
    let lo = 1;
    // The page cannot hold more than the capacity estimate minus what the
    // accepted slices already consumed; searching beyond it would measure
    // multi-page DOMs that are certain to overflow.
    let hi = Math.min(chars - from, Math.max(1, cap.chars + cap.perColumn - acceptedChars));
    let best = 0;

    const fits = (n: number): boolean => {
        const node = buildParaNode({
            paragraph: para,
            from,
            length: n,
            continued: from > 0,
            continues: false,
        }, headingByPara);
        column.appendChild(node);
        const ok = measureOverflow(column, host) <= 0;
        column.removeChild(node);
        return ok;
    };

    // Seed: analytic estimate on an empty page; the previous fit is a decent
    // fallback otherwise (same geometry, same paragraph).
    const seed = acceptedChars === 0
        ? estimateFit(from, hi, cap.perColumn, cap.columns, breaks)
        : Math.min(hi, Math.max(1, cap.chars - acceptedChars));

    if (seed >= 1 && seed <= hi && fits(seed)) {
        best = seed;
        if (seed + 1 > hi || !fits(seed + 1)) return best;
        // More fits than estimated (kinsoku pulled text up): expand.
        let n = seed + 1;
        best = n;
        let step = Math.max(8, seed >> 4);
        while (n + step <= hi && fits(n + step)) {
            n += step;
            best = n;
        }
        lo = n + 1;
        hi = Math.min(hi, n + step - 1);
    } else {
        // The seed overflowed (usually kinsoku pushing text a column or two
        // early). Descend by whole columns until something fits, then
        // binary-search the bracket around it.
        let n = seed - cap.perColumn;
        let found = false;
        while (n >= lo) {
            if (fits(n)) {
                found = true;
                break;
            }
            n -= cap.perColumn;
        }
        if (found) {
            best = n;
            lo = n + 1;
            hi = Math.min(hi, n + cap.perColumn - 1);
        }
        // If nothing fit, the plain binary search below covers [lo, hi].
    }

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (fits(mid)) {
            best = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best;
}

// --------------------------------------------------------------------------
// Page lookup
// --------------------------------------------------------------------------

/** The page index that contains a character offset. */
export function pageForOffset(pages: Page[], offset: number): number {
    if (pages.length === 0) return 0;
    let lo = 0;
    let hi = pages.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (pages[mid].endOffset <= offset) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** Build the column DOM for one stored page (the caller wraps it in a sheet). */
export function buildPageElement(page: Page, headingByPara: Map<number, string>): HTMLElement {
    const column = document.createElement("div");
    column.className = "column";
    for (const slice of page.slices) {
        column.appendChild(buildParaNode(slice, headingByPara));
    }
    return column;
}

export function headingMap(book: Book): Map<number, string> {
    const map = new Map<number, string>();
    for (const c of book.chapters ?? []) map.set(c.paraIdx, c.title);
    return map;
}
