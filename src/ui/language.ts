import blessed = require("neo-blessed");

import { messages, type Locale } from "../i18n";
import { type ThemePalette } from "../theme";
import { listStyle } from "./list-style";

interface LanguageEntry {
  locale: Locale;
  english: string;
  native: string;
  aliases: readonly string[];
}

const LANGUAGE_ENTRIES: readonly LanguageEntry[] = [
  { locale: "en", english: "English", native: "English", aliases: ["en", "english"] },
  { locale: "zh-CN", english: "Simplified Chinese", native: "简体中文", aliases: ["zh", "zh-cn", "中文", "简体", "chinese"] },
];

export interface LanguageModalOptions {
  screen: blessed.Widgets.Screen;
  locale: Locale;
  theme: ThemePalette;
  mouse: boolean;
  onApply: (locale: Locale) => void;
  onClose?: () => void;
}

export class LanguageModal {
  private readonly screen: blessed.Widgets.Screen;
  private readonly onApply: (locale: Locale) => void;
  private readonly onClose?: () => void;
  private readonly dialog: blessed.Widgets.BoxElement;
  private readonly input: blessed.Widgets.TextboxElement;
  private readonly list: blessed.Widgets.ListElement;
  private locale: Locale;
  private theme: ThemePalette;
  private filtered: LanguageEntry[] = [];
  private closing = false;

  constructor(options: LanguageModalOptions) {
    this.screen = options.screen;
    this.onApply = options.onApply;
    this.onClose = options.onClose;
    this.locale = options.locale;
    this.theme = options.theme;
    this.dialog = blessed.box({
      parent: options.screen,
      top: "center",
      left: "center",
      width: "60%",
      height: 11,
      border: "line",
      padding: { top: 1, left: 2, right: 2 },
      hidden: true,
      tags: false,
      style: this.dialogStyle(),
      mouse: options.mouse,
      label: ` ${messages(this.locale).languageLabel.trim()} `,
    });
    this.input = blessed.textbox({
      parent: this.dialog,
      top: 0,
      left: 1,
      right: 1,
      height: 3,
      border: "line",
      padding: { left: 1, right: 1 },
      keys: true,
      inputOnFocus: true,
      mouse: false,
      tags: false,
      label: ` ${messages(this.locale).languageSearchPlaceholder} `,
      style: this.inputStyle(),
    });
    this.list = blessed.list({
      parent: this.dialog,
      top: 3,
      left: 1,
      right: 1,
      bottom: 1,
      keys: true,
      vi: true,
      mouse: options.mouse,
      tags: false,
      style: {
        ...listStyle(this.theme),
      },
    });
    this.input.on("keypress", (_character, key) => {
      if (key.name === "escape") {
        this.hide();
        return;
      }
      if (key.name === "enter" || key.name === "return") {
        this.applySelected();
        return;
      }
      if (key.name === "up" || key.name === "down") {
        const selected = (this.list as unknown as { selected?: number }).selected ?? 0;
        const delta = key.name === "up" ? -1 : 1;
        this.list.select(Math.max(0, Math.min(this.filtered.length - 1, selected + delta)));
        return;
      }
      setImmediate(() => this.filter(this.input.getValue()));
    });
    this.input.on("cancel", () => {
      // Textarea emits cancel from input.cancel(). The close guard prevents
      // that internal cleanup from recursively invoking the modal callback.
      if (!this.closing) this.hide();
    });
    this.list.on("action", (_item, index) => {
      if (!options.mouse && typeof index === "number") this.apply(index);
    });
    this.list.on("element click", (element: blessed.Widgets.BlessedElement) => {
      const items = (this.list as unknown as { items: blessed.Widgets.BlessedElement[] }).items;
      const index = items.indexOf(element);
      if (index >= 0) this.apply(index);
    });
    this.filter("");
  }

  private dialogStyle(): Record<string, unknown> {
    return {
      fg: this.theme.foreground,
      bg: this.theme.background,
      border: { fg: this.theme.accent },
      label: { fg: this.theme.accentBright, bold: true },
    };
  }

  private inputStyle(): Record<string, unknown> {
    return {
      fg: this.theme.foreground,
      bg: this.theme.background,
      border: { fg: this.theme.accent },
    };
  }

  private filter(query: string): void {
    const needle = query.trim().toLocaleLowerCase();
    this.filtered = LANGUAGE_ENTRIES.filter((entry) =>
      [entry.locale, entry.english, entry.native, ...entry.aliases]
        .some((value) => value.toLocaleLowerCase().includes(needle)),
    );
    const items = this.filtered.map((entry) => `${entry.native} — ${entry.english} (${entry.locale})`);
    this.list.setItems(items.length > 0 ? items : [messages(this.locale).languageEmpty]);
    this.list.select(0);
  }

  private applySelected(): void {
    if (this.filtered.length === 0) return;
    this.apply((this.list as unknown as { selected?: number }).selected ?? 0);
  }

  private apply(index: number): void {
    const entry = this.filtered[index];
    if (!entry) return;
    this.locale = entry.locale;
    this.close(false);
    this.onApply(entry.locale);
  }

  setLocale(locale: Locale): void {
    this.locale = locale;
    this.dialog.style = this.dialogStyle();
    this.input.style = this.inputStyle();
    this.dialog.setLabel(` ${messages(locale).languageLabel.trim()} `);
    this.input.setLabel(` ${messages(locale).languageSearchPlaceholder} `);
    this.filter(this.input.getValue());
  }

  setTheme(theme: ThemePalette): void {
    this.theme = theme;
    this.dialog.style = this.dialogStyle();
    this.input.style = this.inputStyle();
    this.list.style = listStyle(theme);
    this.filter(this.input.getValue());
  }

  show(): void {
    // The filter is modal-local state. Reopening after Esc should not append
    // to the previous query and leave the list empty on the next Enter.
    this.input.setValue("");
    this.filter("");
    this.dialog.show();
    this.dialog.setFront();
    this.input.focus();
    this.input.readInput();
    this.screen.render();
  }

  hide(): void {
    this.close(true);
  }

  private close(notifyClose: boolean): void {
    if (this.closing || this.dialog.hidden) return;
    this.closing = true;
    // End neo-blessed Textarea.readInput before hiding the owner. This
    // removes its keypress listener, releases grabKeys and restores focus;
    // the cancel event is intentionally ignored while this guard is active.
    this.input.cancel();
    this.dialog.hide();
    if (notifyClose) this.onClose?.();
    this.screen.render();
    this.closing = false;
  }

  isVisible(): boolean {
    return !this.dialog.hidden;
  }
}
