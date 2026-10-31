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

/**
 * Build the DOM for one candidate page and return it. The element is detached;
 * the caller appends it inside the styled container so measurement is exact.
 */
function buildPageElement(slices: ParagraphSlice[], headingByPara: Map<number, string>): HTMLElement {
    const column = document.createElement("div");
    column.className = "column";

    for (const slice of slices) {
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
        column.appendChild(p);
    }
    return column;
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

/**
 * Upper bound on how many characters can fit on one page, derived from the
 * live CSS (font size, letter spacing, line height, page box). Real text
 * only fits less than this - U+2028 breaks and kinsoku waste column tails -
 * so it is safe as a search bound: it prevents the pager from measuring
 * whole multi-page paragraphs one character-starved slice at a time.
 */
function estimateCapacity(host: MeasureHost): number {
    const cs = window.getComputedStyle(host.container);
    const fontSize = parseFloat(cs.fontSize) || 16;
    const letterSpacing = parseFloat(cs.letterSpacing) || 0;
    const lineHeight = parseFloat(cs.lineHeight) || fontSize * 1.2;
    const rect = host.container.getBoundingClientRect();
    const vertical = document.body.dataset.orientation === "vertical";
    const columnLength = vertical ? rect.height : rect.width;
    const pageBreadth = vertical ? rect.width : rect.height;
    const charsPerColumn = Math.floor(columnLength / (fontSize + letterSpacing));
    const columnsPerPage = Math.floor(pageBreadth / lineHeight);
    return Math.max(200, charsPerColumn * columnsPerPage);
}

/**
 * Cut a book into pages by measuring candidate pages against the live CSS.
 *
 * `startOffset` resumes at a character position, so a saved position lands on
 * the same text after any change to window size or font.
 */
export function layoutBook(
    book: Book,
    host: MeasureHost,
    onProgress?: (done: number, total: number) => void,
): LaidOutBook {
    const paragraphs = book.paragraphs ?? [];
    const headingByPara = new Map<number, string>();
    for (const c of book.chapters ?? []) {
        headingByPara.set(c.paraIdx, c.title);
    }

    const totalChars = paragraphs.reduce((sum, p) => sum + runeLen(p.text), 0);
    const pages: Page[] = [];

    const capacity = estimateCapacity(host);

    let paraIdx = 0;
    let paraOffset = 0;
    let globalOffset = 0;
    let done = 0;

    while (paraIdx < paragraphs.length) {
        const slices: ParagraphSlice[] = [];
        let candidatePara = paraIdx;
        let candidateOffset = paraOffset;
        let candidateGlobal = globalOffset;

        // Fill the page with whole paragraphs while it still fits.
        while (candidatePara < paragraphs.length) {
            const para = paragraphs[candidatePara];
            const remaining = runeLen(para.text) - candidateOffset;

            // A paragraph longer than a full page can never fit whole;
            // measuring it would build a multi-page DOM for nothing. Skip
            // straight to the character fit below.
            if (remaining > capacity) break;

            const trial = [...slices, {
                paragraph: para,
                from: candidateOffset,
                length: remaining,
                continued: candidateOffset > 0,
                continues: false,
            }];

            const el = buildPageElement(trial, headingByPara);
            host.container.replaceChildren(el);

            if (measureOverflow(el, host) <= 0) {
                slices.push(trial[trial.length - 1]);
                candidatePara += 1;
                candidateOffset = 0;
                candidateGlobal += remaining;
                continue;
            }
            break;
        }

        // The page stopped at a paragraph that does not fit whole. Fill the
        // leftover space with as much of that paragraph as fits: ending the
        // page here would leave a hole on the left of every page that
        // precedes a long paragraph, and the hole moves when the window is
        // resized, which reads as text disappearing.
        if (candidatePara < paragraphs.length) {
            const para = paragraphs[candidatePara];
            const remaining = runeLen(para.text) - candidateOffset;
            const taken = fitParagraphByCharacter(para, candidateOffset, host, capacity, headingByPara, slices);
            if (taken > 0) {
                slices.push({
                    paragraph: para,
                    from: candidateOffset,
                    length: taken,
                    continued: candidateOffset > 0,
                    continues: candidateOffset + taken < remaining,
                });
                candidateOffset += taken;
                candidateGlobal += taken;
                if (candidateOffset >= runeLen(para.text)) {
                    candidatePara += 1;
                    candidateOffset = 0;
                }
            } else if (slices.length === 0) {
                // Nothing fits at all (degenerate layout). Advance one character
                // so the loop always makes progress instead of spinning.
                slices.push({
                    paragraph: para,
                    from: candidateOffset,
                    length: 1,
                    continued: candidateOffset > 0,
                    continues: candidateOffset + 1 < runeLen(para.text),
                });
                candidatePara += candidateOffset + 1 >= runeLen(para.text) ? 1 : 0;
                candidateOffset = candidateOffset + 1 >= runeLen(para.text) ? 0 : candidateOffset + 1;
                candidateGlobal += 1;
            }
        }

        const startOffset = globalOffset;
        const endOffset = candidateGlobal;
        pages.push({
            startOffset,
            endOffset,
            number: pages.length + 1,
            slices,
        });

        paraIdx = candidatePara;
        paraOffset = candidateOffset;
        globalOffset = candidateGlobal;

        done = globalOffset;
        onProgress?.(done, totalChars);

        if (paraIdx >= paragraphs.length && paraOffset === 0) break;
    }

    // Leave the container empty; the pager renders pages from here.
    host.container.replaceChildren();

    return { pages, totalChars };
}

/**
 * Binary-search the largest prefix of a paragraph that fits one page.
 *
 * Binary search rather than character-by-character: a long paragraph would
 * otherwise need one DOM measurement per character.
 */
function fitParagraphByCharacter(
    para: Paragraph,
    from: number,
    host: MeasureHost,
    capacity: number,
    headingByPara: Map<number, string>,
    base: ParagraphSlice[] = [],
): number {
    const chars = runeLen(para.text);
    let lo = 1;
    // The page cannot hold more than the capacity estimate (with a 2x
    // allowance in case the estimate undercounts); searching further would
    // measure multi-page DOMs that are certain to overflow.
    let hi = Math.min(chars - from, capacity * 2);
    let best = 0;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const el = buildPageElement([...base, {
            paragraph: para,
            from,
            length: mid,
            continued: from > 0,
            continues: false,
        }], headingByPara);
        host.container.replaceChildren(el);

        if (measureOverflow(el, host) <= 0) {
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

/** Render a page's DOM into the container. */
export function renderPage(
    page: Page,
    host: MeasureHost,
    headingByPara: Map<number, string>,
): void {
    host.container.replaceChildren(buildPageElement(page.slices, headingByPara));
}

export function headingMap(book: Book): Map<number, string> {
    const map = new Map<number, string>();
    for (const c of book.chapters ?? []) map.set(c.paraIdx, c.title);
    return map;
}
