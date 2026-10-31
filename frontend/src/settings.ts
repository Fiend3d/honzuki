// Reading settings: font size, line height, column margins, orientation.
//
// Settings live in CSS custom properties so that changing one reflows the page
// without any layout logic in TypeScript. The pager re-measures afterwards.

export type Orientation = "vertical" | "horizontal";

export interface Settings {
    fontSize: number;      // px
    lineHeight: number;    // unitless multiplier of fontSize
    letterSpacing: number; // em
    margin: number;        // px, page padding
    orientation: Orientation;
}

export const DEFAULT_SETTINGS: Settings = {
    fontSize: 20,
    lineHeight: 1.9,
    letterSpacing: 0.03,
    margin: 40,
    orientation: "vertical",
};

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

export function toggleOrientation(s: Settings): Settings {
    s.orientation = s.orientation === "vertical" ? "horizontal" : "vertical";
    applySettings(s);
    saveSettings(s);
    return s;
}
