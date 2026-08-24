import blessed = require("neo-blessed");

import type { TocEntry } from "../markdown/parse";
import { messages, type Locale } from "../i18n";
import { uiTheme, type ThemePalette } from "../theme";
import { listStyle } from "./list-style";

export interface TocViewOptions {
  screen: blessed.Widgets.Screen;
  mouse: boolean;
  visible: boolean;
  width: number;
  onJump: (index: number) => void;
  theme?: ThemePalette;
  locale?: Locale;
}

type RuntimeListElement = blessed.Widgets.ListElement & {
  items: blessed.Widgets.BlessedElement[];
  selected: number;
  mouse?: boolean;
};

export class TocView {
  readonly element: RuntimeListElement;
  private entries: readonly TocEntry[] = [];
  private headingLines: readonly number[] = [];
  private readonly onJump: (index: number) => void;
  private visible: boolean;
  private focused = false;
  private mouseEnabled: boolean;
  private theme: ThemePalette;
  private locale: Locale;

  constructor(options: TocViewOptions) {
    this.onJump = options.onJump;
    this.visible = options.visible;
    this.mouseEnabled = options.mouse;
    this.theme = options.theme ?? uiTheme;
    this.locale = options.locale ?? "en";
    this.element = blessed.list({
      parent: options.screen,
      label: ` ${messages(this.locale).tocLabel.trim()} `,
      top: 1,
      bottom: 1,
      left: 0,
      width: options.width,
      border: { type: "line" },
      padding: { left: 1, right: 1 },
      scrollable: true,
      alwaysScroll: true,
      keys: false,
      vi: false,
      mouse: options.mouse,
      tags: false,
      hidden: !options.visible,
      style: {
        ...listStyle(this.theme),
        fg: this.theme.muted,
        border: { fg: this.theme.muted },
      },
      scrollbar: {
        ch: "█",
        track: { ch: "░" },
      },
    }) as RuntimeListElement;

    this.element.on("focus", () => {
      this.focused = true;
    });
    this.element.on("blur", () => {
      this.focused = false;
    });
    this.element.on("action", (_item, index) => {
      if (!this.mouseEnabled && typeof index === "number") this.onJump(index);
    });

    if (options.mouse) {
      this.element.on("element click", (element: blessed.Widgets.BlessedElement) => {
        const index = this.element.items.indexOf(element);
        if (index >= 0) {
          this.element.select(index);
          this.onJump(index);
        }
      });
    }
  }

  setWidth(width: number): void {
    this.element.width = width;
  }

  setMouseEnabled(enabled: boolean): void {
    this.mouseEnabled = enabled;
    this.element.mouse = enabled;
  }

  setTheme(theme: ThemePalette): void {
    this.theme = theme;
    this.element.style = {
      ...listStyle(theme),
      fg: theme.muted,
      border: { fg: theme.muted },
    };
  }

  setLocale(locale: Locale, selectedIndex = this.getSelectedIndex()): void {
    this.locale = locale;
    this.element.setLabel(` ${messages(locale).tocLabel.trim()} `);
    this.setEntries(this.entries, this.headingLines, selectedIndex);
  }

  setEntries(entries: readonly TocEntry[], headingLines: readonly number[], selectedIndex = 0): void {
    this.entries = entries;
    this.headingLines = headingLines;
    const items = entries.map((entry) => {
      const indent = "  ".repeat(entry.level - 1);
      const marker = entry.level === 1 ? "◆" : entry.level === 2 ? "▪" : "·";
      return `${indent}${marker} ${entry.title}`;
    });
    this.element.setItems(items.length > 0 ? items : [messages(this.locale).noHeadings]);
    if (entries.length > 0) this.element.select(Math.max(0, Math.min(entries.length - 1, selectedIndex)));
  }

  setHeadingLines(lines: readonly number[]): void {
    this.headingLines = lines;
  }

  toggle(): boolean {
    this.visible = !this.visible;
    if (this.visible) this.element.show();
    else this.element.hide();
    return this.visible;
  }

  isVisible(): boolean {
    return this.visible;
  }

  isFocused(): boolean {
    return this.focused;
  }

  getSelectedIndex(): number {
    return Math.max(0, this.element.selected ?? 0);
  }

  select(index: number): void {
    if (this.entries.length === 0) return;
    this.element.select(Math.max(0, Math.min(this.entries.length - 1, index)));
  }

  focus(): void {
    if (this.visible) this.element.focus();
  }

  move(delta: number): void {
    if (this.entries.length === 0) return;
    const selected = this.getSelectedIndex();
    const next = Math.max(0, Math.min(this.entries.length - 1, selected + delta));
    this.element.select(next);
  }

  jumpSelected(): void {
    if (this.entries.length === 0) return;
    this.onJump(Math.max(0, this.element.selected ?? 0));
  }

  updateCurrent(scrollLine: number): number {
    if (this.entries.length === 0 || this.headingLines.length === 0) return -1;
    let current = 0;
    for (let index = 0; index < this.headingLines.length; index += 1) {
      if ((this.headingLines[index] ?? 0) <= scrollLine) current = index;
      else break;
    }
    if (!this.focused) this.element.select(current);
    return current;
  }

  lineFor(index: number): number {
    return this.headingLines[index] ?? 0;
  }
}
