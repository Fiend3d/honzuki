// Reading settings: page size, font size, line height, column margins,
// orientation.
//
// Settings live in CSS custom properties so that changing one reflows the
// page without any layout logic in TypeScript. The page is a fixed sheet -
// its size is a setting, not the window size - so pagination depends only on
// these values and never changes when the window is resized.

export type Orientation = "vertical" | "horizontal";

export interface Settings {
    fontSize: number;      // px
    lineHeight: number;    // unitless multiplier of fontSize
    letterSpacing: number; // em
    margin: number;        // px, padding inside each page sheet
    orientation: Orientation;
    pageWidth: number;     // px, outer width of a page sheet
    pageHeight: number;    // px, outer height of a page sheet
}

export const DEFAULT_SETTINGS: Settings = {
    fontSize: 20,
    lineHeight: 1.9,
    letterSpacing: 0.03,
    margin: 40,
    orientation: "vertical",
    pageWidth: 560,   // 新書判, scaled for screens
    pageHeight: 820,
};

// Book-shape presets offered in the settings dialog. Sizes are screen px,
// roughly the printed sheet sizes they are named after.
export const PAGE_PRESETS: { name: string; width: number; height: number }[] = [
    { name: "文庫", width: 480, height: 700 },
    { name: "新書", width: 560, height: 820 },
    { name: "A5", width: 640, height: 920 },
    { name: "大判", width: 720, height: 1040 },
];

const STORAGE_KEY = "honzuki:settings";

export function loadSettings(): Settings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULT_SETTINGS };
        const parsed = JSON.parse(raw) as Partial<Settings>;
        return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export function saveSettings(s: Settings): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch {
        // Storage is unavailable; settings stay in memory for this session.
    }
}

export function applySettings(s: Settings): void {
    const root = document.documentElement.style;
    root.setProperty("--font-size", `${s.fontSize}px`);
    root.setProperty("--line-height", String(s.lineHeight));
    root.setProperty("--letter-spacing", `${s.letterSpacing}em`);
    root.setProperty("--margin", `${s.margin}px`);
    root.setProperty("--page-w", `${s.pageWidth}px`);
    root.setProperty("--page-h", `${s.pageHeight}px`);
    document.body.dataset.orientation = s.orientation;
}

// clamp keeps a value inside a range; NaN falls back to the default.
function clamp(value: number, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

export function setFontSize(s: Settings, size: number): Settings {
    s.fontSize = clamp(size, 12, 48, DEFAULT_SETTINGS.fontSize);
    // Line height in px grows with the font, so taller text keeps its air.
    applySettings(s);
    saveSettings(s);
    return s;
}

export function setPageSize(s: Settings, width: number, height: number): Settings {
    s.pageWidth = clamp(width, 300, 1400, DEFAULT_SETTINGS.pageWidth);
    s.pageHeight = clamp(height, 400, 1800, DEFAULT_SETTINGS.pageHeight);
    applySettings(s);
    saveSettings(s);
    return s;
}

export function setMargin(s: Settings, margin: number): Settings {
    s.margin = clamp(margin, 8, 140, DEFAULT_SETTINGS.margin);
    applySettings(s);
    saveSettings(s);
    return s;
}

export function toggleOrientation(s: Settings): Settings {
    s.orientation = s.orientation === "vertical" ? "horizontal" : "vertical";
    applySettings(s);
    saveSettings(s);
    return s;
}
