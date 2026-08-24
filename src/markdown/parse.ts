import { Marked, Tokenizer, type Token, type Tokens, type TokensList } from "marked";
import { messages, type Locale } from "../i18n";

export const LARGE_DOCUMENT_THRESHOLD = 512 * 1024;
const MAX_TOC_ENTRIES = 2_000;

/**
 * Marked's native emStrong tokenizer already owns delimiter, escape, code,
 * link and HTML masking. The only extension we need is the narrow CJK case
 * where a valid closing `**` is followed immediately by Han text.
 */
const nativeEmStrong = Tokenizer.prototype.emStrong;
type MarkedTokenizer = InstanceType<typeof Tokenizer>;

function isHanCodePoint(value: string): boolean {
  return /^\p{Script=Han}$/u.test(value);
}

function cjkStrongEmStrong(
  this: MarkedTokenizer,
  source: string,
  maskedSource: string,
  prevChar = "",
): Tokens.Em | Tokens.Strong | false {
  if (this.lexer.state.inRawBlock) return false;
  if (!source.startsWith("**") || source[2] === "*") return false;

  const offset = maskedSource.length - source.length;
  if (offset < 0) return false;
  // Marked masks an escaped punctuation prefix as `++`. Do not let this
  // wrapper turn the following literal stars into a strong delimiter.
  if (prevChar === "" && offset >= 2 && maskedSource.slice(offset - 2, offset) === "++") return false;

  // Keep all lookups anchored in the original masked buffer. Slicing the
  // remaining tail here made every strong delimiter copy the whole suffix;
  // repeated CJK strong units therefore degraded to O(n²).
  const closeAbsolute = maskedSource.indexOf("**", offset + 2);
  if (closeAbsolute < 0) return false;
  const close = closeAbsolute - offset;
  if (close <= 2) return false;

  const body = source.slice(2, close);
  if (body.includes("\r") || body.includes("\n") || /^\s|\s$/u.test(body)) return false;
  if (!/\p{Script=Han}/u.test(body)) return false;
  if (body.at(-1) !== "）") return false;

  const followingCodePoint = source.codePointAt(close + 2);
  const following = followingCodePoint === undefined ? "" : String.fromCodePoint(followingCodePoint);
  if (!isHanCodePoint(following)) return false;

  // Native emStrong only needs the candidate through the first following
  // code point. Passing that bounded prefix avoids copying/scanning the whole
  // remaining paragraph while retaining native delimiter and child-token
  // semantics. The replacement preserves UTF-16 length for astral Han.
  const candidateLength = close + 2 + following.length;
  const candidateSource = source.slice(0, candidateLength);
  const candidateMaskedSource = maskedSource.slice(offset, offset + candidateLength);
  const followingOffset = close + 2;
  const patchedMaskedSource =
    candidateMaskedSource.slice(0, followingOffset) +
    " ".repeat(following.length) +
    candidateMaskedSource.slice(followingOffset + following.length);
  return nativeEmStrong.call(this, candidateSource, patchedMaskedSource, prevChar) ?? false;
}

const cjkMarkdown = new Marked({
  gfm: true,
  breaks: false,
  pedantic: false,
  tokenizer: { emStrong: cjkStrongEmStrong },
});

export interface TocEntry {
  id: string;
  title: string;
  level: 1 | 2 | 3;
  tokenIndex: number;
  sourceLine?: number;
}

export interface ParsedDocument {
  source: string;
  tokens: TokensList;
  toc: TocEntry[];
  fallbackToPlainText: boolean;
  largeDocument: boolean;
}

export function sanitizeTerminalInput(source: string): string {
  return source.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "�");
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => {
      const point = Number.parseInt(code, 10);
      return point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : "�";
    });
}

function inlineTokenText(token: Token): string {
  if (token.type === "br") return " ";
  if (token.type === "image") return token.text;
  if (token.type === "html") {
    if (/^\s*<!--[^]*?-->\s*$/u.test(token.text)) return "";
    return /^\s*<\/?[A-Za-z][^>]*>\s*$/u.test(token.text) ? "" : token.text;
  }
  if ("tokens" in token && Array.isArray(token.tokens) && token.tokens.length > 0) {
    return token.tokens.map(inlineTokenText).join("");
  }
  if ("text" in token && typeof token.text === "string") return token.text;
  return "raw" in token && typeof token.raw === "string" ? token.raw : "";
}

export function headingText(token: Tokens.Heading): string {
  const title = decodeEntities(token.tokens.map(inlineTokenText).join(""))
    .replace(/\s+/g, " ")
    .trim();
  return sanitizeTerminalInput(title);
}

function slugBase(title: string): string {
  const slug = title
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
  return slug || "section";
}

function appendTocEntry(
  toc: TocEntry[],
  counts: Map<string, number>,
  title: string,
  level: 1 | 2 | 3,
  tokenIndex: number,
  locale: Locale,
  sourceLine?: number,
): void {
  const base = slugBase(title);
  const occurrence = counts.get(base) ?? 0;
  counts.set(base, occurrence + 1);
  toc.push({
    id: occurrence === 0 ? base : `${base}-${occurrence}`,
    title: title || messages(locale).untitledHeading,
    level,
    tokenIndex,
    ...(sourceLine === undefined ? {} : { sourceLine }),
  });
}

function createToc(tokens: readonly Token[], locale: Locale): TocEntry[] {
  const counts = new Map<string, number>();
  const toc: TocEntry[] = [];

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
    if (toc.length >= MAX_TOC_ENTRIES) break;
    const token = tokens[tokenIndex];
    if (!token || token.type !== "heading" || token.depth < 1 || token.depth > 3) continue;

    const heading = token as Tokens.Heading;
    const title = headingText(heading);
    appendTocEntry(toc, counts, title, heading.depth as 1 | 2 | 3, tokenIndex, locale);
  }

  return toc;
}

function createLargeDocumentToc(source: string, locale: Locale): TocEntry[] {
  const toc: TocEntry[] = [];
  const counts = new Map<string, number>();
  let fence: { marker: string; length: number } | undefined;
  let cursor = 0;
  let sourceLine = 0;

  while (cursor < source.length && toc.length < MAX_TOC_ENTRIES) {
    const newline = source.indexOf("\n", cursor);
    const end = newline === -1 ? source.length : newline;
    const line = source.slice(cursor, end).replace(/\r$/, "");
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line);

    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1]?.[0] === fence.marker &&
        fenceMatch[1].length >= fence.length
      ) {
        fence = undefined;
      }
    } else if (fenceMatch?.[1]) {
      fence = { marker: fenceMatch[1][0] ?? "`", length: fenceMatch[1].length };
    } else {
      const atx = /^ {0,3}(#{1,3})(?:[ \t]+|$)/u.exec(line);
      if (atx?.[1]) {
        const candidate = line.slice(0, 8192);
        let title = candidate
          .slice(atx[0].length)
          .replace(/[ \t]+#+[ \t]*$/u, "")
          .replace(/[`*_~]/g, "")
          .trim();
        try {
          const token = cjkMarkdown
            .lexer(`${candidate}\n`)
            .find((item): item is Tokens.Heading => item.type === "heading");
          if (token) title = headingText(token);
        } catch {
          // The bounded raw title above is safe enough for the lightweight path.
        }
        appendTocEntry(
          toc,
          counts,
          sanitizeTerminalInput(title),
          atx[1].length as 1 | 2 | 3,
          -1,
          locale,
          sourceLine,
        );
      }
    }

    if (newline === -1) break;
    cursor = newline + 1;
    sourceLine += 1;
  }

  return toc;
}

export function parseMarkdown(source: string, locale: Locale = "en"): ParsedDocument {
  const safeSource = sanitizeTerminalInput(source);
  if (Buffer.byteLength(safeSource, "utf8") >= LARGE_DOCUMENT_THRESHOLD) {
    return {
      source: safeSource,
      tokens: [] as unknown as TokensList,
      toc: createLargeDocumentToc(safeSource, locale),
      fallbackToPlainText: true,
      largeDocument: true,
    };
  }
  try {
    const tokens = cjkMarkdown.lexer(safeSource);
    return {
      source: safeSource,
      tokens,
      toc: createToc(tokens, locale),
      fallbackToPlainText: false,
      largeDocument: false,
    };
  } catch {
    return {
      source: safeSource,
      tokens: [] as unknown as TokensList,
      toc: [],
      fallbackToPlainText: true,
      largeDocument: false,
    };
  }
}
