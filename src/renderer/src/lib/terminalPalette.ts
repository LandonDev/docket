/**
 * The terminal's sixteen ANSI colours per theme (docs/DESIGN.md "The light
 * theme"), apart from xterm so the contrast contract can read them
 * (lib/tokenContrast.test.ts). Each of light's reaches 4.5:1 on white, the
 * two whites as grays: a program that prints "white" on a light pane still
 * prints something. Dark's black and bright black sit under that on purpose
 * (a program's black on a dark pane); xterm lifts whatever a program prints
 * to `minimumContrastRatio` as it draws.
 */
export const ANSI = {
  dark: {
    black: "#1d2428",
    red: "#f87171",
    green: "#4ade80",
    yellow: "#fbbf24",
    blue: "#60a5fa",
    magenta: "#c084fc",
    cyan: "#22d3ee",
    white: "#e8eef2",
    brightBlack: "#64748b",
    brightRed: "#fca5a5",
    brightGreen: "#86efac",
    brightYellow: "#fde68a",
    brightBlue: "#93c5fd",
    brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9",
    brightWhite: "#f8fafc",
  },
  light: {
    black: "#383a42",
    red: "#c3362d",
    green: "#257927",
    yellow: "#975d00",
    blue: "#2d62da",
    magenta: "#a626a4",
    cyan: "#0070a7",
    white: "#666a74",
    brightBlack: "#6d7682",
    brightRed: "#c25148",
    brightGreen: "#378438",
    brightYellow: "#9f6a00",
    brightBlue: "#456fd9",
    brightMagenta: "#b44ab2",
    brightCyan: "#007eaa",
    brightWhite: "#70757e",
  },
} as const;

/** The chrome's colours are the tokens'; these are their values for a page without the stylesheet. */
export const TERMINAL_FALLBACK = {
  dark: { foreground: "#e7e8ea", background: "#141516", accent: "#459bf7" },
  light: { foreground: "#13161c", background: "#ffffff", accent: "#0d63d3" },
} as const;

/** What every terminal is built with: a pane that shows through, and text a program colours held to 4.5:1 on it. */
export const TERMINAL_OPTIONS = { allowTransparency: true, minimumContrastRatio: 4.5, smoothScrollDuration: 0 } as const;
