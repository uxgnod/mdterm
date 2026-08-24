import blessed = require("neo-blessed");
import stringWidth from "string-width";

import { messages, sanitizeProductText, type Locale } from "../i18n";
import { uiTheme, type ThemePalette } from "../theme";

function truncatePlain(value: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(value) <= width) return value;
  let result = "";
  for (const character of Array.from(value)) {
    if (stringWidth(result + character) > width - 1) break;
    result += character;
  }
  return `${result}…`;
}

export function formatStatusBar(
  fileName: string,
  scrollPercent: number,
  search: string,
  notice: string,
  selection: string,
  width: number,
  themeStatus = "",
  locale: Locale = "en",
): string {
  const parts = [sanitizeProductText(fileName), `${scrollPercent}%`];
  if (search) parts.push(`${messages(locale).searchPrefix} ${sanitizeProductText(search)}`);
  if (notice) parts.push(sanitizeProductText(notice));
  if (themeStatus) parts.push(sanitizeProductText(themeStatus));
  const left = parts.join("  |  ");
  const safeWidth = Math.max(1, width);
  const selectionWidth = stringWidth(selection);
  if (safeWidth === selectionWidth) return selection;
  if (safeWidth === selectionWidth + 1) return ` ${selection}`;
  const leftWidth = safeWidth - selectionWidth - 3;
  if (leftWidth >= 1) return ` ${truncatePlain(left, leftWidth)}  ${selection}`;
  return ` ${truncatePlain(selection, Math.max(1, safeWidth - 1))}`;
}

export interface SearchNavigationState {
  query: string;
  status: string;
}

export function formatMouseFallbackNotice(reason: "unavailable" | undefined, locale: Locale = "en"): string {
  return reason === "unavailable" ? messages(locale).mouseUnavailable : "";
}

function safeFooterQuery(query: string): string {
  return query.replace(/[\u0000-\u001f\u007f-\u009f]/g, "�").replace(/[\r\n]+/g, " ");
}

export function formatSearchNavigation(query: string, status: string, width: number, locale: Locale = "en"): string {
  const safeWidth = Math.max(1, width);
  const safeQuery = safeFooterQuery(query);
  const copy = messages(locale);
  const wide = copy.searchNavigation(safeQuery, status);
  if (stringWidth(wide) <= safeWidth) return wide;

  const mediumPrefix = copy.searchMediumPrefix;
  const mediumSuffix = copy.searchMediumSuffix(status);
  const mediumBudget = safeWidth - stringWidth(mediumPrefix + mediumSuffix);
  if (mediumBudget > 0) {
    const shortened = truncatePlain(safeQuery, mediumBudget);
    const medium = `${mediumPrefix}${shortened}${mediumSuffix}`;
    if (stringWidth(medium) <= safeWidth) return medium;
  }

  const narrow = copy.searchNarrow(status);
  if (stringWidth(narrow) <= safeWidth) return narrow;
  const compact = copy.searchCompact(status);
  if (stringWidth(compact) <= safeWidth) return compact;
  return truncatePlain(compact, safeWidth);
}

export function formatFooterBar(width: number, search?: SearchNavigationState, locale: Locale = "en", mouse = true): string {
  if (search) return formatSearchNavigation(search.query, search.status, width, locale);
  const safeWidth = Math.max(1, width);
  const copy = messages(locale);
  const medium = mouse ? copy.footerMedium : copy.footerMediumNoMouse;
  const narrow = mouse ? copy.footerNarrow : copy.footerNarrowNoMouse;
  for (const candidate of [mouse ? copy.footer : copy.footerNoMouse, medium, narrow]) {
    if (stringWidth(candidate) <= safeWidth) return candidate;
  }
  // Every candidate is ASCII/CJK complete. At very narrow widths keep only
  // complete key cells and never slice a CJK label in half.
  const compactParts: string[] = [];
  for (const part of narrow.split(" · ")) {
    const candidate = [...compactParts, part].join(" · ");
    if (stringWidth(candidate) > safeWidth) break;
    compactParts.push(part);
  }
  return compactParts.join(" · ") || truncatePlain(narrow, safeWidth);
}

export class StatusBar {
  readonly element: blessed.Widgets.BoxElement;
  private readonly fileName: string;
  private locale: Locale;
  private scrollPercent = 0;
  private search = "";
  private notice = "";
  private selection: string;
  private themeStatus = "";
  private theme: ThemePalette;

  constructor(
    screen: blessed.Widgets.Screen,
    fileName: string,
    theme: ThemePalette = uiTheme,
    locale: Locale = "en",
    initialSelection = messages(locale).selectionOff,
  ) {
    this.fileName = fileName;
    this.locale = locale;
    this.selection = initialSelection;
    this.theme = theme;
    this.element = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      right: 0,
      height: 1,
      tags: false,
      style: { fg: theme.chromeText, bg: theme.chromeBackground, bold: true, inverse: theme.inverseChrome },
    });
    this.update();
  }

  setTheme(theme: ThemePalette): void {
    this.theme = theme;
    this.element.style = { fg: theme.chromeText, bg: theme.chromeBackground, bold: true, inverse: theme.inverseChrome };
    this.update();
  }

  setLocale(locale: Locale): void {
    this.locale = locale;
    this.selection = messages(locale).selectionOff;
    this.update();
  }

  setScrollPercent(percent: number): void {
    this.scrollPercent = percent;
    this.update();
  }

  setSearch(status: string): void {
    this.search = status;
    this.update();
  }

  setNotice(notice: string): void {
    this.notice = notice;
    this.update();
  }

  setSelection(selection: string): void {
    this.selection = selection;
    this.update();
  }

  setThemeStatus(status: string): void {
    this.themeStatus = status;
    this.update();
  }

  private update(): void {
    const width = typeof this.element.width === "number" ? this.element.width : process.stdout.columns || 80;
    this.element.setContent(
      formatStatusBar(this.fileName, this.scrollPercent, this.search, this.notice, this.selection, width, this.themeStatus, this.locale),
    );
  }
}

export class FooterBar {
  readonly element: blessed.Widgets.BoxElement;
  private readonly screen: blessed.Widgets.Screen;
  private theme: ThemePalette;
  private locale: Locale;
  private mouseEnabled: boolean;
  private searchNavigation: SearchNavigationState | undefined;

  constructor(screen: blessed.Widgets.Screen, theme: ThemePalette = uiTheme, locale: Locale = "en", mouse = true) {
    this.screen = screen;
    this.theme = theme;
    this.locale = locale;
    this.mouseEnabled = mouse;
    this.element = blessed.box({
      parent: screen,
      bottom: 0,
      left: 0,
      right: 0,
      height: 1,
      align: "center",
      tags: false,
      style: { fg: theme.chromeText, bg: theme.chromeBackground, bold: true, inverse: theme.inverseChrome },
    });
    this.update();
    screen.on("resize", () => this.update());
  }

  setTheme(theme: ThemePalette): void {
    this.theme = theme;
    this.element.style = { fg: theme.chromeText, bg: theme.chromeBackground, bold: true, inverse: theme.inverseChrome };
    this.update();
  }

  setLocale(locale: Locale): void {
    this.locale = locale;
    this.update();
  }

  setMouseEnabled(enabled: boolean): void {
    this.mouseEnabled = enabled;
    this.update();
  }

  setSearchNavigation(query: string, status: string): void {
    this.searchNavigation = { query, status };
    this.update();
  }

  clearSearchNavigation(): void {
    this.searchNavigation = undefined;
    this.update();
  }

  private update(): void {
    const width = typeof this.screen.width === "number" ? this.screen.width : process.stdout.columns || 80;
    this.element.setContent(formatFooterBar(width, this.searchNavigation, this.locale, this.mouseEnabled));
  }
}
