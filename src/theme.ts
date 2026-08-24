const ESC = "\u001b[";

export type BackgroundMode = "dark" | "terminal";
export type ReadingThemeMode = BackgroundMode;
export type ResolvedReadingTheme = BackgroundMode;

export interface ThemePalette {
  mode: BackgroundMode;
  resolved: ResolvedReadingTheme;
  label: string;
  background: string;
  foreground: string;
  chromeBackground: string;
  chromeText: string;
  muted: string;
  accent: string;
  accentBright: string;
  warning: string;
  error: string;
  selectedBackground: string;
  selectedForeground: string;
  scrollbar: string;
  scrollbarTrack: string;
  inverseChrome: boolean;
}

export interface AnsiTheme {
  reset: string;
  bold: (value: string) => string;
  dim: (value: string) => string;
  italic: (value: string) => string;
  underline: (value: string) => string;
  inverse: (value: string) => string;
  strike: (value: string) => string;
  gray: (value: string) => string;
  red: (value: string) => string;
  green: (value: string) => string;
  yellow: (value: string) => string;
  blue: (value: string) => string;
  magenta: (value: string) => string;
  cyan: (value: string) => string;
  cyanDim: (value: string) => string;
  code: (value: string) => string;
}

export interface SearchAnsiStyle {
  matchOpen: string;
  matchClose: string;
  currentOpen: string;
  currentClose: string;
}

const NAMED_RGB: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  gray: [128, 128, 128],
  "light-black": [85, 85, 85],
  blue: [0, 0, 187],
  cyan: [0, 187, 187],
};

function relativeLuminance(rgb: [number, number, number]): number {
  const linear = (value: number): number => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
}

export function contrastRatio(foreground: string, background: string): number | undefined {
  const fg = NAMED_RGB[foreground];
  const bg = NAMED_RGB[background];
  if (!fg || !bg) return undefined;
  const light = Math.max(relativeLuminance(fg), relativeLuminance(bg));
  const dark = Math.min(relativeLuminance(fg), relativeLuminance(bg));
  return (light + 0.05) / (dark + 0.05);
}

function sgr(open: string, close: string, value: string): string {
  return `${ESC}${open}m${value}${ESC}${close}m`;
}

function makeAnsiTheme(theme: ThemePalette): AnsiTheme {
  const terminal = theme.resolved === "terminal";
  const colors = terminal
    ? { gray: "", red: "91", green: "92", yellow: "93", blue: "94", magenta: "95", cyan: "96", cyanDim: "36", code: "" }
    : { gray: "90", red: "91", green: "92", yellow: "93", blue: "94", magenta: "95", cyan: "96", cyanDim: "96", code: "96" };
  const color = (code: string, value: string): string => (code.length === 0 ? value : sgr(code, "39", value));
  return {
    reset: `${ESC}0m`,
    bold: (value) => sgr("1", "22", value),
    dim: (value) => sgr("2", "22", value),
    italic: (value) => sgr("3", "23", value),
    underline: (value) => sgr("4", "24", value),
    inverse: (value) => sgr("7", "27", value),
    strike: (value) => sgr("9", "29", value),
    gray: (value) => color(colors.gray, value),
    red: (value) => color(colors.red, value),
    green: (value) => color(colors.green, value),
    yellow: (value) => color(colors.yellow, value),
    blue: (value) => color(colors.blue, value),
    magenta: (value) => color(colors.magenta, value),
    cyan: (value) => color(colors.cyan, value),
    cyanDim: (value) => color(colors.cyanDim, value),
    // Inline code has no background; bold is only a light additional cue.
    code: (value) => (colors.code.length > 0 ? sgr(`1;${colors.code}`, "39;22", value) : sgr("1", "22", value)),
  };
}

const DARK_PALETTE: ThemePalette = {
  mode: "dark", resolved: "dark", label: "Background: Dark", background: "black", foreground: "white",
  chromeBackground: "blue", chromeText: "white", muted: "light-black", accent: "cyan", accentBright: "light-cyan",
  warning: "yellow", error: "light-red", selectedBackground: "blue", selectedForeground: "white",
  scrollbar: "cyan", scrollbarTrack: "black", inverseChrome: false,
};

const TERMINAL_PALETTE: ThemePalette = {
  mode: "terminal", resolved: "terminal", label: "Background: Terminal", background: "default", foreground: "default",
  chromeBackground: "default", chromeText: "default", muted: "default", accent: "default", accentBright: "default",
  warning: "default", error: "default", selectedBackground: "default", selectedForeground: "default",
  scrollbar: "default", scrollbarTrack: "default", inverseChrome: true,
};

export const readingThemes: Record<BackgroundMode, ThemePalette> = {
  dark: DARK_PALETTE,
  terminal: TERMINAL_PALETTE,
};

export function resolveReadingTheme(mode: BackgroundMode): ThemePalette {
  return readingThemes[mode];
}

export function ansiForTheme(theme: ThemePalette): AnsiTheme {
  return makeAnsiTheme(theme);
}

export function searchStyleForTheme(theme: ThemePalette): SearchAnsiStyle {
  if (theme.resolved === "terminal") {
    return {
      matchOpen: "\u001b[4m",
      matchClose: "\u001b[24m",
      // Terminal background may be light or dark. Keep the terminal's own
      // foreground and distinguish the current match with attributes only.
      currentOpen: "\u001b[1;4;53m",
      currentClose: "\u001b[55;24;22m",
    };
  }
  return {
    matchOpen: "\u001b[4m",
    matchClose: "\u001b[24m",
    currentOpen: "\u001b[1;4;53;97m",
    currentClose: "\u001b[55;24;22;39m",
  };
}

export const ansi: AnsiTheme = makeAnsiTheme(DARK_PALETTE);
export const uiTheme: ThemePalette = DARK_PALETTE;

export const SEARCH_MATCH_OPEN = "\u001b[4m";
export const SEARCH_MATCH_CLOSE = "\u001b[24m";
export const SEARCH_CURRENT_OPEN = "\u001b[1;4;53;97m";
export const SEARCH_CURRENT_CLOSE = "\u001b[55;24;22;39m";
