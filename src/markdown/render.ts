import { highlight, supportsLanguage } from "cli-highlight";
import { Marked, type MarkedExtension, type Token, type Tokens, type TokensList } from "marked";
import { markedTerminal } from "marked-terminal";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

import { messages, type Locale } from "../i18n";
import { ansi, ansiForTheme, type AnsiTheme, type ThemePalette } from "../theme";
import type { ParsedDocument } from "./parse";

const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;
const SGR_SEQUENCE = /^\u001b\[[0-9;]*m$/;
const LINK_MARKER = /\u001b\]999;mdterm-link:(\d+)(?:;end)?\u0007/g;
const CODE_MARKER = /\u001b\]998;mdterm-code:(\d+)(?:;end)?\u0007/g;
const RESET = "\u001b[0m";
const LARGE_TOKEN_SIZE = 256 * 1024;
const HIGHLIGHT_CODE_SIZE = 64 * 1024;

interface AnsiUnit {
  value: string;
  width: number;
  ansi: boolean;
}

interface ParserContext {
  parser: {
    parse(tokens: Token[]): string;
    parseInline(tokens: Token[]): string;
  };
}

type RegisterCodeBlock = (token: Tokens.Code) => number;

export interface RenderedDocument {
  lines: string[];
  headingLines: number[];
  width: number;
  codeBlocks: RenderedCodeBlock[];
  links: RenderedLink[];
}

export interface RenderedLink {
  href: string;
  segments: Array<{ line: number; startColumn: number; endColumn: number }>;
}

export interface RenderedCodeBlock {
  startLine: number;
  endLine: number;
  source: string;
  language: string;
}

export interface RenderOptions {
  isCancelled?: () => boolean;
  onProgress?: (completed: number, total: number) => void;
  yieldIntervalMs?: number;
  theme?: ThemePalette;
  locale?: Locale;
}

export function visibleWidth(value: string): number {
  return stringWidth(stripAnsi(value));
}

const GRAPHEME_SEGMENTER =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;
const GRAPHEME_CHUNK_SIZE = 4096;
const MAX_GRAPHEME_CARRY = 4096;

function* graphemes(value: string): Generator<string> {
  if (isPrintableAscii(value)) {
    for (const part of value) yield part;
    return;
  }
  // Segment every string, not only the clusters that happen to contain a
  // combining mark/ZWJ/variation selector. Regional-indicator flags and
  // emoji modifiers are grapheme clusters too (🇨🇳, 👍🏽), but neither matches
  // the old fast-path predicate.
  if (isSimpleHanText(value)) {
    for (const part of value) yield part;
    return;
  }
  if (GRAPHEME_SEGMENTER) {
    // Node 18's Intl.Segmenter becomes superlinear for a single very long
    // non-ASCII run. Segment bounded windows and carry the last cluster into
    // the next window so a boundary can never split a surrogate pair or a
    // combining/ZWJ/emoji cluster.
    let offset = 0;
    let carry = "";
    while (offset < value.length) {
      let end = Math.min(value.length, offset + GRAPHEME_CHUNK_SIZE);
      if (end < value.length && isLowSurrogate(value.charCodeAt(end))) end -= 1;
      const chunk = carry + value.slice(offset, end);
      const parts = Array.from(GRAPHEME_SEGMENTER.segment(chunk), (part) => part.segment);
      offset = end;
      if (offset < value.length) {
        carry = parts.pop() ?? "";
        for (const part of parts) yield part;
        if (carry.length > MAX_GRAPHEME_CARRY) {
          // A pathological unbounded ZWJ/Mark chain is a DoS input. Keep the
          // carry bounded; ordinary emoji, combining marks and RI clusters
          // are far below this cap and remain intact.
          let cut = MAX_GRAPHEME_CARRY;
          if (isLowSurrogate(carry.charCodeAt(cut))) cut -= 1;
          yield carry.slice(0, cut);
          carry = carry.slice(cut);
        }
      } else {
        for (const part of parts) yield* boundedGraphemeParts(part);
        carry = "";
      }
    }
    for (const part of boundedGraphemeParts(carry)) yield part;
    return;
  }
  for (const part of value) yield part;
}

function* boundedGraphemeParts(value: string): Generator<string> {
  let remaining = value;
  while (remaining.length > MAX_GRAPHEME_CARRY) {
    let cut = MAX_GRAPHEME_CARRY;
    if (isLowSurrogate(remaining.charCodeAt(cut))) cut -= 1;
    yield remaining.slice(0, cut);
    remaining = remaining.slice(cut);
  }
  if (remaining) yield remaining;
}

function isSimpleHanText(value: string): boolean {
  if (value.length === 0) return false;
  for (const part of value) {
    const code = part.codePointAt(0) ?? 0;
    if (!isBmpHanCodePoint(code)) return false;
  }
  return true;
}

function graphemeWidth(value: string): number {
  if (value.length === 1) {
    const code = value.charCodeAt(0);
    if (code >= 0x20 && code <= 0x7e) return 1;
  }
  return stringWidth(value);
}

function isPrintableAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function isPrintableAsciiAt(value: string, index: number): boolean {
  const code = value.charCodeAt(index);
  return code >= 0x20 && code <= 0x7e;
}

function isSimpleCjkText(value: string): boolean {
  if (value.length === 0) return false;
  for (const part of value) {
    const code = part.codePointAt(0) ?? 0;
    if (!isBmpHanCodePoint(code)) return false;
  }
  return true;
}

function isBmpHanCodePoint(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

function codePointLengthAt(value: string, index: number): number {
  return (value.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
}

interface MixedTextSegment {
  value: string;
  ascii: boolean;
}

function* splitOverwideGrapheme(value: string, width: number): Generator<string> {
  if (graphemeWidth(value) <= width) {
    yield value;
    return;
  }

  // The grapheme cap above deliberately permits a pathological cluster to
  // be cut. Once cut, keep each visual unit within the viewport as well. The
  // fallback iterates code points, never UTF-16 code units, so it cannot
  // create an isolated surrogate. Ordinary graphemes never take this path.
  let part = "";
  let partWidth = 0;
  for (const codePoint of value) {
    const codePointWidth = graphemeWidth(codePoint);
    if (part && partWidth + codePointWidth > width) {
      yield part;
      part = "";
      partWidth = 0;
    }
    part += codePoint;
    partWidth += codePointWidth;
  }
  if (part) yield part;
}

/**
 * Keep large printable-ASCII runs out of Intl.Segmenter while passing only
 * the small Unicode neighborhoods through it. The final ASCII base of a run
 * is included with the following non-ASCII run so e+combining marks, keycaps,
 * and similar clusters cannot be split at the fast-path boundary.
 */
function* mixedTextSegments(value: string, width: number): Generator<MixedTextSegment> {
  let cursor = 0;
  while (cursor < value.length) {
    const asciiStart = cursor;
    while (cursor < value.length && isPrintableAsciiAt(value, cursor)) cursor += 1;

    if (cursor > asciiStart) {
      if (cursor === value.length) {
        yield { value: value.slice(asciiStart), ascii: true };
        return;
      }

      const baseStart = cursor - 1;
      if (baseStart > asciiStart) {
        yield { value: value.slice(asciiStart, baseStart), ascii: true };
      }
      let unicodeEnd = cursor;
      while (unicodeEnd < value.length && !isPrintableAsciiAt(value, unicodeEnd)) {
        unicodeEnd += codePointLengthAt(value, unicodeEnd);
      }
      for (const part of graphemes(value.slice(baseStart, unicodeEnd))) {
        for (const safePart of splitOverwideGrapheme(part, width)) {
          yield { value: safePart, ascii: false };
        }
      }
      cursor = unicodeEnd;
      continue;
    }

    const unicodeStart = cursor;
    while (cursor < value.length && !isPrintableAsciiAt(value, cursor)) {
      cursor += codePointLengthAt(value, cursor);
    }
    for (const part of graphemes(value.slice(unicodeStart, cursor))) {
      for (const safePart of splitOverwideGrapheme(part, width)) {
        yield { value: safePart, ascii: false };
      }
    }
  }
}

function* ansiUnits(value: string): Generator<AnsiUnit> {
  let cursor = 0;
  const expression = new RegExp(ANSI_SEQUENCE.source, "g");

  for (let match = expression.exec(value); match; match = expression.exec(value)) {
    if (match.index > cursor) {
      for (const part of graphemes(value.slice(cursor, match.index))) {
        yield { value: part, width: graphemeWidth(part), ansi: false };
      }
    }
    yield { value: match[0], width: 0, ansi: true };
    cursor = match.index + match[0].length;
  }

  if (cursor < value.length) {
    for (const part of graphemes(value.slice(cursor))) {
      yield { value: part, width: graphemeWidth(part), ansi: false };
    }
  }
}

type SgrState = Map<string, string>;

function updateActiveStyles(active: SgrState, sequence: string): void {
  if (!SGR_SEQUENCE.test(sequence)) return;
  const body = sequence.slice(2, -1);
  const parameters = body === "" ? [0] : body.split(";").map((value) => Number.parseInt(value || "0", 10));

  for (let index = 0; index < parameters.length; index += 1) {
    const code = parameters[index] ?? 0;
    if (code === 0) active.clear();
    else if (code === 1) active.set("bold", "\u001b[1m");
    else if (code === 2) active.set("dim", "\u001b[2m");
    else if (code === 3) active.set("italic", "\u001b[3m");
    else if (code === 4 || code === 21) active.set("underline", `\u001b[${code}m`);
    else if (code === 5 || code === 6) active.set("blink", `\u001b[${code}m`);
    else if (code === 7) active.set("inverse", "\u001b[7m");
    else if (code === 8) active.set("hidden", "\u001b[8m");
    else if (code === 9) active.set("strike", "\u001b[9m");
    else if (code === 22) {
      active.delete("bold");
      active.delete("dim");
    } else if (code === 23) active.delete("italic");
    else if (code === 24) active.delete("underline");
    else if (code === 25) active.delete("blink");
    else if (code === 27) active.delete("inverse");
    else if (code === 28) active.delete("hidden");
    else if (code === 29) active.delete("strike");
    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      active.set("foreground", `\u001b[${code}m`);
    } else if (code === 39) active.delete("foreground");
    else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      active.set("background", `\u001b[${code}m`);
    } else if (code === 49) active.delete("background");
    else if (code === 38 || code === 48) {
      const mode = parameters[index + 1];
      const length = mode === 2 ? 5 : mode === 5 ? 3 : 1;
      const color = parameters.slice(index, index + length);
      active.set(code === 38 ? "foreground" : "background", `\u001b[${color.join(";")}m`);
      index += length - 1;
    } else if (code === 53) active.set("overline", "\u001b[53m");
    else if (code === 55) active.delete("overline");
  }
}

function activeStylePrefix(active: SgrState): string {
  return Array.from(active.values()).join("");
}

export function truncateAnsi(value: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(value) <= maxWidth) return value;

  const target = Math.max(0, maxWidth - 1);
  let used = 0;
  let result = "";
  for (const unit of ansiUnits(value)) {
    if (unit.ansi) {
      result += unit.value;
      continue;
    }
    if (used + unit.width > target) break;
    result += unit.value;
    used += unit.width;
  }
  // A private link marker can start before the clipped cell and end after it.
  // Close an active marker at the clipping point so the visible fragment stays
  // clickable. The marker is emitted before RESET and the ellipsis, therefore
  // neither the ellipsis nor a following table border/line can inherit it.
  let activeLink: number | undefined;
  for (const unit of ansiUnits(result)) {
    if (!unit.ansi) continue;
    const marker = /^\u001b\]999;mdterm-link:(\d+)(;end)?\u0007$/u.exec(unit.value);
    if (!marker) continue;
    activeLink = marker[2] ? undefined : Number.parseInt(marker[1] ?? "", 10);
  }
  if (activeLink !== undefined) result += `\u001b]999;mdterm-link:${activeLink};end\u0007`;
  return `${result}${RESET}…`;
}

export function wrapAnsiLine(value: string, maxWidth: number): string[] {
  const width = Math.max(1, maxWidth);
  const result: string[] = [];
  const active: SgrState = new Map();
  let line = "";
  let lineWidth = 0;
  let wrapped = false;

  for (const unit of ansiUnits(value)) {
    if (unit.ansi) {
      line += unit.value;
      updateActiveStyles(active, unit.value);
      continue;
    }

    const whitespaceWouldFillLine =
      lineWidth > 0 && lineWidth + unit.width === width && /^\s$/u.test(unit.value);
    if (lineWidth > 0 && (lineWidth + unit.width > width || whitespaceWouldFillLine)) {
      result.push(`${line}${RESET}`);
      line = activeStylePrefix(active);
      lineWidth = 0;
      wrapped = true;
    }
    line += unit.value;
    lineWidth += unit.width;
  }

  if (active.size > 0) line += RESET;
  result.push(line);
  return wrapped || active.size > 0 ? result : [value];
}

function padRight(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function cleanInline(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function safeUrl(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "�");
}

function unicodeStrike(value: string, palette: AnsiTheme = ansi): string {
  let struck = "";
  for (const unit of ansiUnits(value)) {
    struck += unit.ansi || /^\s+$/u.test(unit.value) ? unit.value : `${unit.value}\u0336`;
  }
  return palette.gray(struck);
}

function allocateColumnWidths(
  natural: number[],
  budget: number,
  minimums: readonly number[] = [],
): number[] {
  if (natural.length === 0) return [];

  const normalized = natural.map((width, index) =>
    Math.max(minimums[index] ?? 1, Math.max(1, width)),
  );
  const widths = normalized.map((_width, index) => minimums[index] ?? 1);
  let remaining = Math.max(0, budget - widths.reduce((total, width) => total + width, 0));

  while (remaining > 0) {
    let best = -1;
    let bestRatio = 0;
    for (let index = 0; index < normalized.length; index += 1) {
      const naturalWidth = normalized[index] ?? 1;
      const currentWidth = widths[index] ?? 1;
      if (currentWidth >= naturalWidth) continue;

      const ratio = naturalWidth / currentWidth;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = index;
      }
    }
    if (best < 0) break;
    widths[best] = (widths[best] ?? 1) + 1;
    remaining -= 1;
  }

  return widths;
}

function alignCell(value: string, width: number, alignment: string | null): string {
  const clipped = truncateAnsi(cleanInline(value), width);
  const padding = Math.max(0, width - visibleWidth(clipped));
  if (alignment === "right") return `${" ".repeat(padding)}${clipped}`;
  if (alignment === "center") {
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${clipped}${" ".repeat(padding - left)}`;
  }
  return padRight(clipped, width);
}

function renderTable(
  token: Tokens.Table,
  parser: ParserContext["parser"],
  maxWidth: number,
  palette: AnsiTheme = ansi,
): string {
  const originalColumns = token.header.length;
  if (originalColumns === 0) return "";

  const maximumRenderedColumns = Math.max(1, Math.floor((maxWidth - 1) / 4));
  // Four terminal cells keep a short Latin word or two CJK glyphs readable.
  // At widths where that is impossible, the column-reduction loop below
  // removes actual columns before allowing retained columns to collapse to
  // ellipsis-only cells.
  const minimumReadableWidth = Math.min(4, Math.max(3, Math.floor(maxWidth / 6)));
  const tableContentBudget = (columns: number): number =>
    Math.max(1, maxWidth - (columns + 1) - columns * 2);
  const canFitColumns = (columns: number): boolean => {
    const omitted = columns < originalColumns;
    const renderedColumns = columns + (omitted ? 1 : 0);
    const minimum = columns * minimumReadableWidth + (omitted ? 1 : 0);
    return tableContentBudget(renderedColumns) >= minimum;
  };

  let visibleColumns = Math.min(
    originalColumns,
    originalColumns > maximumRenderedColumns
      ? Math.max(1, maximumRenderedColumns - 1)
      : maximumRenderedColumns,
  );
  while (visibleColumns > 1 && !canFitColumns(visibleColumns)) visibleColumns -= 1;
  const omitted = visibleColumns < originalColumns;
  const header = token.header.slice(0, visibleColumns).map((cell) => parser.parseInline(cell.tokens));
  const rows = token.rows.map((row) =>
    row.slice(0, visibleColumns).map((cell) => parser.parseInline(cell.tokens)),
  );

  if (omitted) {
    header.push("…");
    for (const row of rows) row.push("…");
  }

  const natural = header.map((cell, column) => {
    let cellWidth = visibleWidth(cleanInline(cell));
    for (const row of rows) cellWidth = Math.max(cellWidth, visibleWidth(cleanInline(row[column] ?? "")));
    return Math.max(1, cellWidth);
  });
  const contentBudget = tableContentBudget(header.length);
  const minimums = natural.map((_cell, column) =>
    omitted && column === visibleColumns ? 1 : minimumReadableWidth,
  );
  const widths = allocateColumnWidths(natural, contentBudget, minimums);
  const horizontal = (left: string, join: string, right: string): string =>
      palette.cyanDim(
      left + widths.map((columnWidth) => "─".repeat(columnWidth + 2)).join(join) + right,
    );
  const rowLine = (cells: string[]): string =>
    palette.cyanDim("│") +
    cells
      .map((cell, column) => {
        const alignment = token.align[column] ?? null;
        return ` ${alignCell(cell ?? "", widths[column] ?? 1, alignment)} ${palette.cyanDim("│")}`;
      })
      .join("");

  const lines = [horizontal("┌", "┬", "┐"), rowLine(header), horizontal("├", "┼", "┤")];
  for (const row of rows) lines.push(rowLine(row));
  lines.push(horizontal("└", "┴", "┘"));
  return `\n${lines.join("\n")}\n`;
}

function renderCodeBlock(
  token: Tokens.Code,
  maxWidth: number,
  palette: AnsiTheme = ansi,
  locale: Locale = "en",
  registerCodeBlock?: RegisterCodeBlock,
): string {
  const innerWidth = Math.max(1, maxWidth - 2);
  const language = token.lang?.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  let failed = false;
  let rendered = token.text.replace(/\t/g, "    ");

  if (language && rendered.length > HIGHLIGHT_CODE_SIZE) {
    failed = true;
  } else if (language) {
    try {
      if (!supportsLanguage(language)) throw new Error("unsupported language");
      rendered = highlight(rendered, { language, ignoreIllegals: true });
    } catch {
      failed = true;
    }
  }

  const label = truncateAnsi(language || messages(locale).codePrefix, Math.max(1, innerWidth - 3));
  const topPrefix = `─ ${label} `;
  const top = `┌${topPrefix}${"─".repeat(Math.max(0, innerWidth - visibleWidth(topPrefix)))}┐`;
  const contentWidth = Math.max(1, innerWidth - 2);
  const body = rendered.split("\n").flatMap((line) =>
    wrapAnsiLine(line, contentWidth).map((fragment) => {
      let content = padRight(fragment, contentWidth);
      if (failed) content = palette.inverse(content);
      return `${palette.cyanDim("│")} ${content} ${palette.cyanDim("│")}`;
    }),
  );
  const bottom = `└${"─".repeat(innerWidth)}┘`;
  const block = `${palette.cyanDim(top)}\n${body.join("\n")}\n${palette.cyanDim(bottom)}`;
  if (!registerCodeBlock) return `\n${block}\n`;
  const id = registerCodeBlock(token);
  return `\n${codeStartMarker(id)}${block}${codeEndMarker(id)}\n`;
}

function inlineTokens(token: Token): Token[] | undefined {
  if (token.type !== "text" && token.type !== "paragraph") return undefined;
  return "tokens" in token && Array.isArray(token.tokens) ? token.tokens : undefined;
}

function wrapLogicalLines(value: string, width: number): string[] {
  return value.replace(/\r/g, "").split("\n").flatMap((line) => wrapAnsiLine(line, width));
}

function renderListToken(
  token: Tokens.List,
  parser: ParserContext["parser"],
  maxWidth: number,
  palette: AnsiTheme = ansi,
  locale: Locale = "en",
  registerCodeBlock?: RegisterCodeBlock,
): string[] {
  const lines: string[] = [];
  const start = typeof token.start === "number" ? token.start : 1;

  token.items.forEach((item, itemIndex) => {
    const marker = token.ordered ? `${start + itemIndex}.` : "•";
    const checkbox = item.task ? ` ${item.checked ? "[x]" : "[ ]"}` : "";
    const firstPrefix = `${marker}${checkbox} `;
    const continuationPrefix = " ".repeat(visibleWidth(firstPrefix));
    const contentWidth = Math.max(1, maxWidth - visibleWidth(continuationPrefix));
    const itemLines: string[] = [];
    let firstContent = true;
    let blankBeforeNextBlock = false;

    for (const child of item.tokens) {
      if (child.type === "space") {
        blankBeforeNextBlock = itemLines.length > 0;
        continue;
      }

      let childLines: string[];
      const childInlineTokens = inlineTokens(child);
      if (childInlineTokens) {
        childLines = wrapLogicalLines(parser.parseInline(childInlineTokens), contentWidth);
      } else if (child.type === "list") {
        childLines = renderListToken(child as Tokens.List, parser, contentWidth, palette, locale, registerCodeBlock);
      } else if (child.type === "code") {
        childLines = normalizeBlock(
          renderCodeBlock(child as Tokens.Code, contentWidth, palette, locale, registerCodeBlock),
          contentWidth,
        );
      } else if (child.type === "table") {
        childLines = normalizeBlock(
          renderTable(child as Tokens.Table, parser, contentWidth, palette),
          contentWidth,
        );
      } else {
        childLines = normalizeBlock(parser.parse([child]), contentWidth);
      }

      if (childLines.length === 0) continue;
      if (blankBeforeNextBlock && itemLines.at(-1) !== "") itemLines.push("");

      for (const childLine of childLines) {
        if (childLine === "") {
          if (itemLines.at(-1) !== "") itemLines.push("");
          continue;
        }
        const prefix = firstContent ? firstPrefix : continuationPrefix;
        itemLines.push(`${prefix}${childLine}`);
        firstContent = false;
      }
      blankBeforeNextBlock = false;
    }

    if (firstContent) itemLines.push(firstPrefix.trimEnd());
    lines.push(...itemLines);
    if (token.loose && itemIndex < token.items.length - 1 && lines.at(-1) !== "") lines.push("");
  });

  return lines;
}

function wrapWithHangingPrefix(
  value: string,
  firstPrefix: string,
  continuationPrefix: string,
  maxWidth: number,
): string[] {
  const result: string[] = [];
  let first = true;

  for (const logicalLine of value.split("\n")) {
    const initialPrefix = first ? firstPrefix : continuationPrefix;
    const available = Math.max(1, maxWidth - visibleWidth(initialPrefix));
    const fragments = wrapAnsiLine(logicalLine, available);
    for (let index = 0; index < fragments.length; index += 1) {
      const prefix = first && index === 0 ? firstPrefix : continuationPrefix;
      result.push(`${prefix}${fragments[index] ?? ""}`);
    }
    first = false;
  }

  return result;
}

function customRenderer(
  maxWidth: number,
  palette: AnsiTheme,
  linkHrefs: Map<number, string>,
  locale: Locale,
  registerCodeBlock: RegisterCodeBlock,
): MarkedExtension["renderer"] {
  let nextLinkId = 0;
  return {
    heading(this: ParserContext, token: Tokens.Heading): string {
      const inline = this.parser.parseInline(token.tokens);
      if (token.depth === 1) {
        const heading = wrapAnsiLine(palette.bold(palette.cyan(inline)), maxWidth).join("\n");
        return `\n${heading}\n${palette.cyanDim("─".repeat(maxWidth))}\n`;
      }
      if (token.depth === 2) {
        return `\n${wrapAnsiLine(palette.bold(palette.cyanDim(inline)), maxWidth).join("\n")}\n`;
      }
      const indentation = "  ".repeat(Math.max(1, token.depth - 2));
      const styled = token.depth === 3 ? palette.bold(palette.blue(inline)) : palette.bold(palette.gray(inline));
      const lines = wrapWithHangingPrefix(styled, indentation, indentation, maxWidth);
      return `\n${lines.join("\n")}\n`;
    },
    code(token: Tokens.Code): string {
      return renderCodeBlock(token, maxWidth, palette, locale, registerCodeBlock);
    },
    table(this: ParserContext, token: Tokens.Table): string {
      return renderTable(token, this.parser, maxWidth, palette);
    },
    blockquote(this: ParserContext, token: Tokens.Blockquote): string {
      const body = this.parser.parse(token.tokens).trim();
      const prefix = `${palette.cyanDim("▎")} `;
      const lines = body
        .split("\n")
        .flatMap((line) =>
          wrapWithHangingPrefix(palette.italic(palette.gray(line)), prefix, prefix, maxWidth),
        );
      return `\n${lines.join("\n")}\n`;
    },
    list(this: ParserContext, token: Tokens.List): string {
      return `\n${renderListToken(token, this.parser, maxWidth, palette, locale, registerCodeBlock).join("\n")}\n`;
    },
    hr(): string {
      return `\n${palette.gray("─".repeat(maxWidth))}\n`;
    },
    checkbox(token: { checked: boolean }): string {
      return token.checked ? "[x]" : "[ ]";
    },
    em(this: ParserContext, token: Tokens.Em): string {
      return palette.underline(palette.gray(this.parser.parseInline(token.tokens)));
    },
    del(this: ParserContext, token: Tokens.Del): string {
      return unicodeStrike(this.parser.parseInline(token.tokens), palette);
    },
    link(this: ParserContext, token: Tokens.Link): string {
      const text = this.parser.parseInline(token.tokens) || safeUrl(token.href);
      const href = safeUrl(token.href);
      const display = text === href ? href : `${text} (${href})`;
      const id = nextLinkId++;
      linkHrefs.set(id, href);
      return `${linkStartMarker(id)}${palette.underline(palette.blue(display))}${linkEndMarker(id)}`;
    },
    image(token: Tokens.Image): string {
      return palette.magenta(`🖼 [${token.text || messages(locale).imageAlt}] (${safeUrl(token.href)})`);
    },
    html(token: Tokens.HTML | Tokens.Tag): string {
      if (/^\s*<!--[^]*?-->\s*$/.test(token.text)) return "";
      return palette.gray(token.text);
    },
  } as MarkedExtension["renderer"];
}

function createEngine(
  maxWidth: number,
  palette: AnsiTheme,
  linkHrefs: Map<number, string>,
  locale: Locale,
  registerCodeBlock: RegisterCodeBlock,
): Marked {
  return new Marked(
    markedTerminal({
      width: maxWidth,
      reflowText: false,
      showSectionPrefix: false,
      emoji: false,
      tab: 2,
      code: palette.code,
      blockquote: (value) => palette.italic(palette.gray(value)),
      html: palette.gray,
      heading: (value) => palette.bold(palette.cyanDim(value)),
      firstHeading: (value) => palette.bold(palette.cyan(value)),
      hr: palette.gray,
      table: (value) => value,
      paragraph: (value) => value,
      strong: palette.bold,
      em: (value) => palette.underline(palette.gray(value)),
      codespan: palette.code,
      del: (value) => unicodeStrike(value, palette),
      link: (value) => value,
      href: (value) => palette.underline(palette.blue(value)),
      text: (value) => value,
    }),
    { renderer: customRenderer(maxWidth, palette, linkHrefs, locale, registerCodeBlock) },
  );
}

function normalizeBlock(raw: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of raw.replace(/\r/g, "").split("\n")) {
    const expanded = rawLine.replace(/\t/g, "    ");
    lines.push(...wrapAnsiLine(expanded, width));
  }
  while (lines[0] === "") lines.shift();
  while (lines.at(-1) === "") lines.pop();
  return lines;
}

function appendBlock(target: string[], block: string[]): number {
  if (block.length === 0) return target.length;
  if (target.length > 0 && target.at(-1) !== "") target.push("");
  const start = target.length;
  target.push(...block);
  return start;
}

function linkStartMarker(id: number): string {
  return `\u001b]999;mdterm-link:${id}\u0007`;
}

function linkEndMarker(id: number): string {
  return `\u001b]999;mdterm-link:${id};end\u0007`;
}

function codeStartMarker(id: number): string {
  return `\u001b]998;mdterm-code:${id}\u0007`;
}

function codeEndMarker(id: number): string {
  return `\u001b]998;mdterm-code:${id};end\u0007`;
}

function stripPrivateMarkers(value: string): string {
  return value.replace(LINK_MARKER, "").replace(CODE_MARKER, "");
}

function extractCodeBlocks(
  block: readonly string[],
  startLine: number,
  metadata: ReadonlyMap<number, RenderedCodeBlock>,
): RenderedCodeBlock[] {
  const result: RenderedCodeBlock[] = [];
  let active: { id: number; line: number } | undefined;
  for (let lineIndex = 0; lineIndex < block.length; lineIndex += 1) {
    for (const unit of ansiUnits(block[lineIndex] ?? "")) {
      if (!unit.ansi) continue;
      const marker = /^\u001b\]998;mdterm-code:(\d+)(;end)?\u0007$/u.exec(unit.value);
      if (!marker) continue;
      const id = Number.parseInt(marker[1] ?? "", 10);
      if (marker[2]) {
        if (active?.id === id) {
          const source = metadata.get(id);
          if (source) {
            result.push({
              ...source,
              startLine: startLine + active.line,
              endLine: startLine + lineIndex,
            });
          }
        }
        active = undefined;
      } else if (active === undefined) {
        active = { id, line: lineIndex };
      }
    }
  }
  return result;
}

function extractLinkSegments(
  block: readonly string[],
  startLine: number,
  hrefs: ReadonlyMap<number, string>,
): RenderedLink[] {
  const byId = new Map<number, Array<{ line: number; startColumn: number; endColumn: number }>>();
  let active: number | undefined;
  for (let lineIndex = 0; lineIndex < block.length; lineIndex += 1) {
    const line = block[lineIndex] ?? "";
    let column = 0;
    let segmentStart: number | undefined;
    const flush = (): void => {
      if (active === undefined || segmentStart === undefined || column <= segmentStart) return;
      const segments = byId.get(active) ?? [];
      segments.push({ line: startLine + lineIndex, startColumn: segmentStart, endColumn: column });
      byId.set(active, segments);
      segmentStart = undefined;
    };
    for (const unit of ansiUnits(line)) {
      if (unit.ansi) {
        const marker = /^\u001b\]999;mdterm-link:(\d+)(;end)?\u0007$/u.exec(unit.value);
        if (marker) {
          flush();
          const id = Number.parseInt(marker[1] ?? "", 10);
          active = marker[2] ? undefined : id;
        }
        continue;
      }
      if (active !== undefined && segmentStart === undefined) segmentStart = column;
      column += unit.width;
    }
    flush();
  }
  return Array.from(byId.entries())
    .sort(([left], [right]) => left - right)
    .flatMap(([id, segments]) => {
      const href = hrefs.get(id);
      return href ? [{ href, segments }] : [];
    });
}

function tokenList(token: Token, source: TokensList): TokensList {
  const list = [token] as TokensList;
  list.links = source.links;
  return list;
}

function renderLargeToken(token: Token, width: number): string[] {
  const raw = "raw" in token && typeof token.raw === "string" ? token.raw : "";
  const result: string[] = [];
  for (const line of raw.replace(/\r/g, "").split("\n")) {
    result.push(...wrapAnsiLine(line.replace(/\t/g, "    "), width));
  }
  return result;
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function renderPlainDocument(
  document: ParsedDocument,
  width: number,
  options: RenderOptions,
): Promise<RenderedDocument> {
  const palette = options.theme ? ansiForTheme(options.theme) : ansi;
  const copy = messages(options.locale ?? "en");
  const lines: string[] = [];
  const headingLines = document.toc.map(() => 0);
  const tocBySourceLine = new Map(
    document.toc.flatMap((entry, index) =>
      entry.sourceLine === undefined ? [] : [[entry.sourceLine, index] as const],
    ),
  );
  const total = document.source.length;
  const yieldInterval = options.yieldIntervalMs ?? 12;
  let lastYield = Date.now();

  const yieldNow = async (completed: number): Promise<void> => {
    options.onProgress?.(completed, total);
    await immediate();
    lastYield = Date.now();
  };

  let cursor = 0;
  let sourceLine = 0;
  while (cursor < total && !options.isCancelled?.()) {
    const newline = document.source.indexOf("\n", cursor);
    const end = newline === -1 ? total : newline;
    let rawLine = document.source.slice(cursor, end);
    if (rawLine.endsWith("\r")) rawLine = rawLine.slice(0, -1);
    const tocIndex = tocBySourceLine.get(sourceLine);
    if (tocIndex !== undefined) headingLines[tocIndex] = lines.length;

    const expanded = rawLine.replace(/\t/g, "    ");
    if (expanded.length === 0) {
      lines.push("");
    } else if (isPrintableAscii(expanded)) {
      let fragmentsSinceCheck = 0;
      for (let offset = 0; offset < expanded.length; offset += width) {
        lines.push(expanded.slice(offset, offset + width));
        fragmentsSinceCheck += 1;
        if (fragmentsSinceCheck >= 256) {
          fragmentsSinceCheck = 0;
          if (Date.now() - lastYield >= yieldInterval) {
            await yieldNow(cursor + Math.min(expanded.length, offset + width));
          }
          if (options.isCancelled?.()) break;
        }
      }
    } else if (isSimpleCjkText(expanded)) {
      // CJK ideographs are one two-cell grapheme each. Avoid a per-character
      // Intl.Segmenter/string-width call for the common large-plain-text path.
      const charactersPerLine = Math.max(1, Math.floor(width / 2));
      let fragmentsSinceCheck = 0;
      for (let offset = 0; offset < expanded.length; offset += charactersPerLine) {
        lines.push(expanded.slice(offset, offset + charactersPerLine));
        fragmentsSinceCheck += 1;
        if (fragmentsSinceCheck >= 256) {
          fragmentsSinceCheck = 0;
          if (Date.now() - lastYield >= yieldInterval) {
            await yieldNow(cursor + Math.min(expanded.length, offset + charactersPerLine));
          }
          if (options.isCancelled?.()) break;
        }
      }
    } else {
      let lineParts: string[] = [];
      let lineWidth = 0;
      let consumed = 0;
      let unitsSinceCheck = 0;
      mixedLine:
      for (const segment of mixedTextSegments(expanded, width)) {
        if (segment.ascii) {
          let segmentOffset = 0;
          while (segmentOffset < segment.value.length) {
            if (lineWidth === width) {
              lines.push(lineParts.join(""));
              lineParts = [];
              lineWidth = 0;
            }
            const available = width - lineWidth;
            const take = Math.min(available, segment.value.length - segmentOffset);
            lineParts.push(segment.value.slice(segmentOffset, segmentOffset + take));
            lineWidth += take;
            segmentOffset += take;
            consumed += take;
            unitsSinceCheck += 1;
            if (unitsSinceCheck >= 256) {
              unitsSinceCheck = 0;
              if (Date.now() - lastYield >= yieldInterval) await yieldNow(cursor + consumed);
              if (options.isCancelled?.()) break mixedLine;
            }
          }
          continue;
        }

        const partWidth = graphemeWidth(segment.value);
        if (lineWidth > 0 && lineWidth + partWidth > width) {
          lines.push(lineParts.join(""));
          lineParts = [];
          lineWidth = 0;
        }
        lineParts.push(segment.value);
        lineWidth += partWidth;
        consumed += segment.value.length;
        unitsSinceCheck += 1;
        if (unitsSinceCheck >= 256) {
          unitsSinceCheck = 0;
          if (Date.now() - lastYield >= yieldInterval) await yieldNow(cursor + consumed);
          if (options.isCancelled?.()) break mixedLine;
        }
      }
      if (lineParts.length > 0 || lineWidth === 0) lines.push(lineParts.join(""));
    }

    if (options.isCancelled?.()) break;
    if (newline === -1) {
      cursor = total;
    } else {
      cursor = newline + 1;
      sourceLine += 1;
    }
    if (Date.now() - lastYield >= yieldInterval) await yieldNow(cursor);
  }

  if (!options.isCancelled?.()) options.onProgress?.(total, total);
  while (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) lines.push(palette.gray(copy.noContent));
  return { lines, headingLines, width, codeBlocks: [], links: [] };
}

export async function renderDocument(
  document: ParsedDocument,
  requestedWidth: number,
  options: RenderOptions = {},
): Promise<RenderedDocument> {
  const width = Math.max(12, Math.floor(requestedWidth));
  const palette = options.theme ? ansiForTheme(options.theme) : ansi;
  const copy = messages(options.locale ?? "en");
  if (document.source.length === 0) {
    return { lines: [palette.gray(copy.noContent)], headingLines: [], width, codeBlocks: [], links: [] };
  }

  if (document.fallbackToPlainText) {
    return renderPlainDocument(document, width, options);
  }

  const linkHrefs = new Map<number, string>();
  const codeMetadata = new Map<number, RenderedCodeBlock>();
  let nextCodeId = 0;
  const registerCodeBlock: RegisterCodeBlock = (token) => {
    const id = nextCodeId++;
    codeMetadata.set(id, {
      startLine: 0,
      endLine: 0,
      source: token.text,
      language: token.lang?.trim().split(/\s+/u)[0]?.toLowerCase() ?? "",
    });
    return id;
  };
  const engine = createEngine(width, palette, linkHrefs, options.locale ?? "en", registerCodeBlock);
  const lines: string[] = [];
  const codeBlocks: RenderedCodeBlock[] = [];
  const links: RenderedLink[] = [];
  const headingLines = document.toc.map(() => 0);
  const tocByToken = new Map(document.toc.map((entry, index) => [entry.tokenIndex, index]));
  const total = document.tokens.length;
  const yieldInterval = options.yieldIntervalMs ?? 12;
  let lastYield = Date.now();

  for (let tokenIndex = 0; tokenIndex < total; tokenIndex += 1) {
    if (options.isCancelled?.()) break;
    const token = document.tokens[tokenIndex];
    if (!token) continue;

    let block: string[];
    try {
      const rawLength = "raw" in token && typeof token.raw === "string" ? token.raw.length : 0;
      if (rawLength > LARGE_TOKEN_SIZE && (token.type === "paragraph" || token.type === "text")) {
        block = renderLargeToken(token, width);
      } else {
        const rendered = engine.parser(tokenList(token, document.tokens));
        block = normalizeBlock(typeof rendered === "string" ? rendered : "", width);
      }
    } catch {
      block = renderLargeToken(token, width);
    }

    const blockStart = lines.length > 0 && lines.at(-1) !== "" ? lines.length + 1 : lines.length;
    const linkSegments = extractLinkSegments(block, blockStart, linkHrefs);
    const nestedCodeBlocks = extractCodeBlocks(block, blockStart, codeMetadata);
    const start = appendBlock(lines, block.map(stripPrivateMarkers));
    for (const link of linkSegments) links.push(link);
    codeBlocks.push(...nestedCodeBlocks);
    if (token.type === "code" && block.length > 0 && nestedCodeBlocks.length === 0) {
      const code = token as Tokens.Code;
      codeBlocks.push({
        startLine: start,
        endLine: start + block.length - 1,
        source: code.text,
        language: code.lang?.trim().split(/\s+/u)[0]?.toLowerCase() ?? "",
      });
    }
    const tocIndex = tocByToken.get(tokenIndex);
    if (tocIndex !== undefined) headingLines[tocIndex] = start;

    if (Date.now() - lastYield >= yieldInterval) {
      options.onProgress?.(tokenIndex + 1, total);
      await immediate();
      lastYield = Date.now();
    }
  }

  options.onProgress?.(total, total);
  while (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) lines.push(palette.gray(copy.noContent));
  return { lines, headingLines, width, codeBlocks, links };
}
