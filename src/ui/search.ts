import stripAnsi from "strip-ansi";

import {
  searchStyleForTheme,
  type SearchAnsiStyle,
  type ThemePalette,
} from "../theme";

const ANSI_SEQUENCE = /^\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/;
const MAX_SEARCH_MATCHES = 10_000;

export interface SearchMatch {
  line: number;
  start: number;
  length: number;
  ordinal: number;
}

export interface SearchSnapshot {
  query: string;
  matches: SearchMatch[];
  current: number;
  truncated: boolean;
}

const DEFAULT_SEARCH_STYLE: SearchAnsiStyle = {
  matchOpen: "\u001b[4m",
  matchClose: "\u001b[24m",
  currentOpen: "\u001b[1;4;53;97m",
  currentClose: "\u001b[55;24;22;39m",
};

interface FoldedRange {
  start: number;
  end: number;
}

interface FoldedText {
  value: string;
  ranges: FoldedRange[];
}

const COMPLEX_GRAPHEME = /[\p{M}\u200d\ufe0f\u{1f1e6}-\u{1f1ff}\u{1f3fb}-\u{1f3ff}]/u;
const graphemeSegmenter = typeof Intl.Segmenter === "function"
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : undefined;

function graphemeParts(value: string): string[] {
  if (graphemeSegmenter && COMPLEX_GRAPHEME.test(value)) {
    return Array.from(graphemeSegmenter.segment(value), (part) => part.segment);
  }
  return Array.from(value);
}

function foldWithMap(value: string): FoldedText {
  const ranges: FoldedRange[] = [];
  let folded = "";
  let sourceOffset = 0;
  for (const part of graphemeParts(value)) {
    const sourceStart = sourceOffset;
    sourceOffset += part.length;
    const foldedPart = part.toLocaleLowerCase();
    folded += foldedPart;
    for (let index = 0; index < foldedPart.length; index += 1) {
      ranges.push({ start: sourceStart, end: sourceOffset });
    }
  }
  return { value: folded, ranges };
}

function foldedQuery(value: string): string {
  return value.toLocaleLowerCase();
}

function lineMatches(
  plain: string,
  query: string,
  ordinalOffset: number,
  remaining: number,
): { matches: SearchMatch[]; truncated: boolean } {
  const needle = foldedQuery(query);
  if (needle.length === 0 || remaining <= 0) return { matches: [], truncated: remaining <= 0 };
  const folded = foldWithMap(plain);
  const matches: SearchMatch[] = [];
  let start = 0;
  while (start <= folded.value.length - needle.length) {
    const found = folded.value.indexOf(needle, start);
    if (found < 0) break;
    const first = folded.ranges[found];
    const last = folded.ranges[found + needle.length - 1];
    if (!first || !last) break;
    if (matches.length >= remaining) return { matches, truncated: true };
    matches.push({
      line: 0,
      start: first.start,
      length: last.end - first.start,
      ordinal: ordinalOffset + matches.length,
    });
    start = found + Math.max(1, needle.length);
  }
  return { matches, truncated: false };
}

export class SearchModel {
  private snapshot: SearchSnapshot = { query: "", matches: [], current: -1, truncated: false };

  get state(): Readonly<SearchSnapshot> {
    return this.snapshot;
  }

  update(lines: readonly string[], query: string): Readonly<SearchSnapshot> {
    return this.commit(buildSearchSnapshot(lines, query));
  }

  async updateAsync(
    lines: readonly string[],
    query: string,
    isCancelled: () => boolean = () => false,
  ): Promise<Readonly<SearchSnapshot> | undefined> {
    if (query.length === 0) return buildSearchSnapshot(lines, query);

    const matches: SearchMatch[] = [];
    let truncated = false;
    for (let line = 0; line < lines.length; line += 1) {
      const plain = stripAnsi(lines[line] ?? "");
      const result = lineMatches(plain, query, matches.length, MAX_SEARCH_MATCHES - matches.length);
      for (const match of result.matches) matches.push({ ...match, line });
      truncated = result.truncated;
      if (truncated) break;
      if ((line + 1) % 128 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (isCancelled()) return undefined;
      }
    }
    if (isCancelled()) return undefined;
    return {
      query,
      matches,
      current: matches.length > 0 ? 0 : -1,
      truncated,
    };
  }

  commit(snapshot: SearchSnapshot): Readonly<SearchSnapshot> {
    this.snapshot = {
      query: snapshot.query,
      matches: snapshot.matches.map((match) => ({ ...match })),
      current: snapshot.current,
      truncated: snapshot.truncated,
    };
    return this.snapshot;
  }

  next(): SearchMatch | undefined {
    if (this.snapshot.matches.length === 0) return undefined;
    this.snapshot.current = (this.snapshot.current + 1) % this.snapshot.matches.length;
    return this.currentMatch();
  }

  previous(): SearchMatch | undefined {
    if (this.snapshot.matches.length === 0) return undefined;
    this.snapshot.current =
      (this.snapshot.current - 1 + this.snapshot.matches.length) % this.snapshot.matches.length;
    return this.currentMatch();
  }

  setCurrentOrdinal(ordinal: number): void {
    if (this.snapshot.matches.length === 0) {
      this.snapshot.current = -1;
      return;
    }
    this.snapshot.current = Math.max(0, Math.min(this.snapshot.matches.length - 1, Math.floor(ordinal)));
  }

  currentMatch(): SearchMatch | undefined {
    return this.snapshot.current >= 0 ? this.snapshot.matches[this.snapshot.current] : undefined;
  }

  clear(): Readonly<SearchSnapshot> {
    this.snapshot = { query: "", matches: [], current: -1, truncated: false };
    return this.snapshot;
  }

  status(): string {
    const { matches, current, truncated } = this.snapshot;
    if (this.snapshot.query.length === 0) return "";
    if (matches.length === 0) return "0/0";
    return `${current + 1}/${truncated ? "10000+" : matches.length}`;
  }
}

function buildSearchSnapshot(lines: readonly string[], query: string): SearchSnapshot {
  if (query.length === 0) return { query: "", matches: [], current: -1, truncated: false };

  const matches: SearchMatch[] = [];
  let truncated = false;
  searchLines:
  for (let line = 0; line < lines.length; line += 1) {
    const plain = stripAnsi(lines[line] ?? "");
    const result = lineMatches(plain, query, matches.length, MAX_SEARCH_MATCHES - matches.length);
    for (const match of result.matches) matches.push({ ...match, line });
    if (result.truncated) {
      truncated = true;
      break searchLines;
    }
  }
  return {
    query,
    matches,
    current: matches.length > 0 ? 0 : -1,
    truncated,
  };
}

interface BoundaryEvent {
  close: string;
  open: string;
}

type SgrState = Map<string, string>;

function updateSgrState(state: SgrState, sequence: string): void {
  const match = /^\u001b\[([0-9;]*)m$/u.exec(sequence);
  if (!match) return;
  const params = (match[1] ?? "") === "" ? [0] : (match[1] ?? "").split(";").map((part) => Number.parseInt(part || "0", 10));
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index] ?? 0;
    if (code === 0) state.clear();
    else if (code === 1) state.set("bold", "\u001b[1m");
    else if (code === 2) state.set("dim", "\u001b[2m");
    else if (code === 3) state.set("italic", "\u001b[3m");
    else if (code === 4 || code === 21) state.set("underline", `\u001b[${code}m`);
    else if (code === 5 || code === 6) state.set("blink", `\u001b[${code}m`);
    else if (code === 7) state.set("inverse", "\u001b[7m");
    else if (code === 8) state.set("hidden", "\u001b[8m");
    else if (code === 9) state.set("strike", "\u001b[9m");
    else if (code === 22) { state.delete("bold"); state.delete("dim"); }
    else if (code === 23) state.delete("italic");
    else if (code === 24) state.delete("underline");
    else if (code === 25) state.delete("blink");
    else if (code === 27) state.delete("inverse");
    else if (code === 28) state.delete("hidden");
    else if (code === 29) state.delete("strike");
    else if (code === 39) state.delete("foreground");
    else if (code === 49) state.delete("background");
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) state.set("foreground", `\u001b[${code}m`);
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) state.set("background", `\u001b[${code}m`);
    else if (code === 38 || code === 48) {
      const mode = params[index + 1];
      const length = mode === 2 ? 5 : mode === 5 ? 3 : 1;
      state.set(code === 38 ? "foreground" : "background", `\u001b[${params.slice(index, index + length).join(";")}m`);
      index += length - 1;
    } else if (code === 53) state.set("overline", "\u001b[53m");
    else if (code === 55) state.delete("overline");
  }
}

function replaySgrState(state: SgrState): string {
  return Array.from(state.values()).join("");
}

export function highlightSearchLine(
  raw: string,
  lineMatches: readonly SearchMatch[],
  currentOrdinal: number,
  style: SearchAnsiStyle = DEFAULT_SEARCH_STYLE,
): string {
  if (lineMatches.length === 0) return raw;

  const events = new Map<number, BoundaryEvent>();
  for (const match of lineMatches) {
    const current = match.ordinal === currentOrdinal;
    const opening = current ? style.currentOpen : style.matchOpen;
    const closing = current ? style.currentClose : style.matchClose;
    const startEvent = events.get(match.start) ?? { close: "", open: "" };
    startEvent.open += opening;
    events.set(match.start, startEvent);
    const end = match.start + match.length;
    const endEvent = events.get(end) ?? { close: "", open: "" };
    endEvent.close = `${closing}${endEvent.close}`;
    events.set(end, endEvent);
  }

  let result = "";
  let rawIndex = 0;
  let plainIndex = 0;
  let emittedBoundary = -1;
  const sgr: SgrState = new Map();
  const emitBoundary = (): void => {
    if (emittedBoundary === plainIndex) return;
    const event = events.get(plainIndex);
    if (event) result += `${event.close}${event.close ? replaySgrState(sgr) : ""}${event.open}`;
    emittedBoundary = plainIndex;
  };

  while (rawIndex < raw.length) {
    emitBoundary();
    const tail = raw.slice(rawIndex);
    const ansiMatch = ANSI_SEQUENCE.exec(tail);
    if (ansiMatch) {
      result += ansiMatch[0];
      updateSgrState(sgr, ansiMatch[0]);
      rawIndex += ansiMatch[0].length;
      continue;
    }

    const codePoint = raw.codePointAt(rawIndex);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    result += character;
    rawIndex += character.length;
    plainIndex += character.length;
    emittedBoundary = -1;
  }
  emitBoundary();
  return result;
}

export function applySearchHighlights(
  lines: readonly string[],
  snapshot: Readonly<SearchSnapshot>,
  theme?: ThemePalette,
): string[] {
  if (snapshot.matches.length === 0) return [...lines];

  const lowerBound = (line: number): number => {
    let low = 0;
    let high = snapshot.matches.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((snapshot.matches[middle]?.line ?? Number.POSITIVE_INFINITY) < line) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const matchesByLine = new Map<number, SearchMatch[]>();
  for (let line = 0; line < lines.length; line += 1) {
    const first = lowerBound(line);
    const last = lowerBound(line + 1);
    if (first < last) matchesByLine.set(line, snapshot.matches.slice(first, last));
  }

  const style = theme ? searchStyleForTheme(theme) : DEFAULT_SEARCH_STYLE;
  return lines.map((line, index) => highlightSearchLine(line, matchesByLine.get(index) ?? [], snapshot.current, style));
}

export function searchableText(lines: readonly string[]): string[] {
  return lines.map((line) => stripAnsi(line));
}
