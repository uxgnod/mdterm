const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
// Selection deliberately uses a fixed blue background and bright-white
// foreground instead of inverse video. Search's current match uses a bright
// foreground with bold/underline/overline model styles, so this remains
// visibly distinct even when the matched text is bold.
// The reset/replay around each grapheme keeps the styles active before the
// selection intact.
const SELECTION_OPEN = "\u001b[0m\u001b[97;44;1m";
const SELECTION_CLOSE = "\u001b[0m";

export type SelectionMode = "off" | "manual" | "auto";

export interface SelectionPoint {
  line: number;
  column: number;
}

export interface SelectionRange {
  start: SelectionPoint;
  end: SelectionPoint;
}

interface VisualUnit {
  value: string;
  width: number;
  ansi: boolean;
}

function graphemes(value: string): string[] {
  if (/[^\u0000-\u007f]/u.test(value) && typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(segmenter.segment(value), (part) => part.segment);
  }
  return Array.from(value);
}

function graphemeWidth(value: string): number {
  if (/^[\u0000-\u007f]$/u.test(value)) return 1;
  return Math.max(1, stringWidth(value));
}

function visualUnits(value: string): VisualUnit[] {
  const result: VisualUnit[] = [];
  let cursor = 0;
  const expression = new RegExp(ANSI_SEQUENCE.source, "g");
  for (const match of value.matchAll(expression)) {
    const index = match.index ?? cursor;
    if (index > cursor) {
      for (const part of graphemes(value.slice(cursor, index))) {
        result.push({ value: part, width: graphemeWidth(part), ansi: false });
      }
    }
    result.push({ value: match[0], width: 0, ansi: true });
    cursor = index + match[0].length;
  }
  if (cursor < value.length) {
    for (const part of graphemes(value.slice(cursor))) {
      result.push({ value: part, width: graphemeWidth(part), ansi: false });
    }
  }
  return result;
}

function lineWidth(value: string): number {
  return visualUnits(value).reduce((total, unit) => total + (unit.ansi ? 0 : unit.width), 0);
}

type SgrState = Map<string, string>;

function updateSgrState(state: SgrState, sequence: string): void {
  const match = /^\u001b\[([0-9;]*)m$/u.exec(sequence);
  if (!match) return;
  const body = match[1] ?? "";
  const params = body === "" ? [0] : body.split(";").map((part) => Number.parseInt(part || "0", 10));
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index] ?? 0;
    if (code === 0) {
      state.clear();
    } else if (code === 1) {
      state.set("bold", "\u001b[1m");
    } else if (code === 2) {
      state.set("dim", "\u001b[2m");
    } else if (code === 3) {
      state.set("italic", "\u001b[3m");
    } else if (code === 4 || code === 21) {
      state.set("underline", `\u001b[${code}m`);
    } else if (code === 5 || code === 6) {
      state.set("blink", `\u001b[${code}m`);
    } else if (code === 7) {
      state.set("inverse", "\u001b[7m");
    } else if (code === 9) {
      state.set("strike", "\u001b[9m");
    } else if (code === 22) {
      state.delete("bold");
      state.delete("dim");
    } else if (code === 23) {
      state.delete("italic");
    } else if (code === 24) {
      state.delete("underline");
    } else if (code === 25) {
      state.delete("blink");
    } else if (code === 27) {
      state.delete("inverse");
    } else if (code === 29) {
      state.delete("strike");
    } else if (code === 39) {
      state.delete("foreground");
    } else if (code === 49) {
      state.delete("background");
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      state.set("foreground", `\u001b[${code}m`);
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      state.set("background", `\u001b[${code}m`);
    } else if (code === 38 || code === 48) {
      const key = code === 38 ? "foreground" : "background";
      const mode = params[index + 1];
      const length = mode === 2 ? 5 : mode === 5 ? 3 : 1;
      const end = Math.min(params.length, index + length);
      state.set(key, `\u001b[${params.slice(index, end).join(";")}m`);
      index = end - 1;
    }
  }
}

function replaySgrState(state: SgrState): string {
  return Array.from(state.values()).join("");
}

export function comparePoints(left: SelectionPoint, right: SelectionPoint): number {
  if (left.line !== right.line) return left.line - right.line;
  return left.column - right.column;
}

export function normalizeSelection(anchor: SelectionPoint, focus: SelectionPoint): SelectionRange {
  return comparePoints(anchor, focus) <= 0
    ? { start: { ...anchor }, end: { ...focus } }
    : { start: { ...focus }, end: { ...anchor } };
}

export function isSelectionEmpty(range: SelectionRange | undefined): boolean {
  return !range || comparePoints(range.start, range.end) === 0;
}

/** Map a terminal column to a whole-grapheme boundary without splitting CJK or emoji. */
export function pointAtColumn(value: string, column: number): number {
  const requested = Math.max(0, Math.floor(column));
  let current = 0;
  for (const unit of visualUnits(value)) {
    if (unit.ansi) continue;
    if (requested <= current) return current;
    if (requested < current + unit.width) {
      return requested - current < unit.width / 2 ? current : current + unit.width;
    }
    current += unit.width;
  }
  return current;
}

export function selectedColumns(
  range: SelectionRange | undefined,
  line: number,
  value: string,
): { start: number; end: number } | undefined {
  if (!range || isSelectionEmpty(range) || line < range.start.line || line > range.end.line) return undefined;
  const width = lineWidth(value);
  const start = line === range.start.line ? Math.min(width, range.start.column) : 0;
  const end = line === range.end.line ? Math.min(width, range.end.column) : width;
  return end > start ? { start, end } : undefined;
}

export function selectedText(lines: readonly string[], range: SelectionRange | undefined): string {
  if (!range || isSelectionEmpty(range)) return "";
  const parts: string[] = [];
  for (let line = range.start.line; line <= range.end.line; line += 1) {
    const value = lines[line] ?? "";
    const columns = selectedColumns(range, line, value);
    if (columns) {
      let current = 0;
      let plain = "";
      for (const unit of visualUnits(value)) {
        if (unit.ansi) continue;
        if (current < columns.end && current + unit.width > columns.start) plain += unit.value;
        current += unit.width;
      }
      parts.push(plain);
    } else {
      parts.push("");
    }
  }
  return parts.join("\n");
}

/** Paint selected graphemes with a fixed blue/bright-white overlay; SGR adds zero width. */
export function highlightSelection(value: string, columns: { start: number; end: number } | undefined): string {
  if (!columns || columns.end <= columns.start) return value;
  let current = 0;
  let result = "";
  const state: SgrState = new Map();
  for (const unit of visualUnits(value)) {
    if (unit.ansi) {
      result += unit.value;
      updateSgrState(state, unit.value);
      continue;
    }
    const selected = current < columns.end && current + unit.width > columns.start;
    if (selected) {
      result += `${SELECTION_OPEN}${unit.value}${SELECTION_CLOSE}${replaySgrState(state)}`;
    } else {
      result += unit.value;
    }
    current += unit.width;
  }
  return result;
}

export function selectionModeLabel(mode: SelectionMode, mouseEnabled = true, locale: Locale = "en"): string {
  const copy = messages(locale);
  if (!mouseEnabled) return copy.selectionTerminal;
  if (mode === "manual") return copy.selectionOn;
  if (mode === "auto") return copy.selectionAuto;
  return copy.selectionOff;
}
import stringWidth from "string-width";
import { messages, type Locale } from "../i18n";
