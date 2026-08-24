import blessed = require("neo-blessed");
import stringWidth from "string-width";

import { messages, type Locale } from "../i18n";
import { truncateAnsi, visibleWidth, type RenderedCodeBlock, type RenderedDocument, type RenderedLink } from "../markdown/render";
import { ansiForTheme, uiTheme, type ThemePalette } from "../theme";
import { applySearchHighlights, type SearchSnapshot } from "./search";
import {
  highlightSelection,
  isSelectionEmpty,
  normalizeSelection,
  pointAtColumn,
  selectedColumns,
  selectedText,
  type SelectionMode,
  type SelectionPoint,
  type SelectionRange,
} from "./selection";

type MouseAction = "mousedown" | "mouseup" | "mousemove" | "wheelup" | "wheeldown";

type MouseData = Omit<blessed.Widgets.Events.IMouseEventArg, "action"> & {
  action: MouseAction;
  button?: string;
};

export type CodeCopyResultKind = "copied" | "request-sent" | "failed";
export interface CodeCopyFeedback {
  kind: CodeCopyResultKind;
}

interface CodeCopyHitbox {
  blockIndex: number;
  left: number;
  top: number;
  width: number;
}

interface LinkHitbox {
  href: string;
  left: number;
  top: number;
  width: number;
}

export interface ContentViewOptions {
  screen: blessed.Widgets.Screen;
  mouse: boolean;
  left: number | string;
  onSelectionStart?: () => void;
  onSelectionChange?: () => void;
  onSelectionComplete?: (text: string) => void;
  onCopyCode?: (text: string, blockIndex: number) => CodeCopyFeedback | Promise<CodeCopyFeedback | undefined> | void;
  onOpenLink?: (href: string) => void;
  theme?: ThemePalette;
  locale?: Locale;
}

export class ContentView {
  readonly element: blessed.Widgets.BoxElement;
  readonly scrollbar: blessed.Widgets.BoxElement;
  private lines: string[] = [];
  private offset = 0;
  private currentSearch: Readonly<SearchSnapshot> | undefined;
  private draggingScrollbar = false;
  private draggingSelection = false;
  private selectionAnchor: SelectionPoint | undefined;
  private selection: SelectionRange | undefined;
  private selectionMode: SelectionMode = "off";
  private onSelectionChange?: () => void;
  private onSelectionComplete?: (text: string) => void;
  private onSelectionStart?: () => void;
  private onCopyCode?: (text: string, blockIndex: number) => CodeCopyFeedback | Promise<CodeCopyFeedback | undefined> | void;
  private onOpenLink?: (href: string) => void;
  private readonly screen: blessed.Widgets.Screen;
  private theme: ThemePalette;
  private locale: Locale;
  private mouseEnabled: boolean;
  private codeBlocks: readonly RenderedCodeBlock[] = [];
  private readonly codeCopyButtons = new Map<number, blessed.Widgets.BoxElement>();
  private codeCopyHitboxes: CodeCopyHitbox[] = [];
  private links: readonly RenderedLink[] = [];
  private linkHitboxes: LinkHitbox[] = [];
  private pressedCodeBlock: number | undefined;
  private hoveredCodeBlock: number | undefined;
  private codeCopyStates = new Map<number, { kind: CodeCopyResultKind; timer: NodeJS.Timeout }>();
  private documentVersion = 0;
  private pressedLink: { href: string; left: number; top: number; width: number } | undefined;
  private viewportDirty = true;
  private disposed = false;

  constructor(options: ContentViewOptions) {
    this.screen = options.screen;
    this.onSelectionStart = options.onSelectionStart;
    this.onSelectionChange = options.onSelectionChange;
    this.onSelectionComplete = options.onSelectionComplete;
    this.onCopyCode = options.onCopyCode;
    this.onOpenLink = options.onOpenLink;
    this.theme = options.theme ?? uiTheme;
    this.locale = options.locale ?? "en";
    this.mouseEnabled = options.mouse;
    this.element = blessed.box({
      parent: options.screen,
      top: 1,
      bottom: 1,
      left: options.left,
      right: 1,
      padding: { left: 1, right: 1 },
      scrollable: false,
      keys: false,
      mouse: false,
      tags: false,
      wrap: false,
      fullUnicode: true,
      style: {
        fg: this.theme.foreground,
        bg: this.theme.background,
      },
    });

    this.scrollbar = blessed.box({
      parent: options.screen,
      top: 1,
      bottom: 1,
      right: 0,
      width: 1,
      tags: false,
      wrap: false,
      content: "",
      style: { bg: this.theme.background },
    });

    if (options.mouse) this.enableMouse();
    this.screen.on("prerender", () => this.renderViewport());
  }

  private enableMouse(): void {
    this.element.on("wheelup", () => {
      this.scrollBy(-3);
    });
    this.element.on("wheeldown", () => {
      this.scrollBy(3);
    });
      this.scrollbar.on("mousedown", (event: MouseData) => {
      if (this.disposed) return;
      this.draggingScrollbar = true;
      this.scrollFromMouseY(event.y);
    });
    this.screen.on("mouse", (event: MouseData) => {
      if (this.disposed) return;
      if (this.draggingScrollbar) {
        if (event.action === "mouseup") {
          this.draggingScrollbar = false;
          return;
        }
        if (event.action === "mousemove" || event.action === "mousedown") {
          this.scrollFromMouseY(event.y);
        }
        return;
      }

      if (!this.mouseEnabled) return;
      if (event.action === "mousemove") {
        const hovered = this.codeCopyHitboxAt(event.x, event.y)?.blockIndex;
        if (hovered !== this.hoveredCodeBlock) {
          this.hoveredCodeBlock = hovered;
          this.syncCodeCopyButtons();
          this.screen.render();
        }
        if (this.pressedLink) {
          const link = this.linkHitboxAt(event.x, event.y);
          if (!sameLinkHitbox(link, this.pressedLink)) this.pressedLink = undefined;
        }
      }
      if (event.action === "mousedown") {
        const hitbox = this.codeCopyHitboxAt(event.x, event.y);
        if (hitbox && isPrimaryButton(event)) {
          this.pressedCodeBlock = hitbox.blockIndex;
          this.syncCodeCopyButtons();
          this.screen.render();
          return;
        }
      }
      if (this.pressedCodeBlock !== undefined) {
        if (event.action === "mouseup") {
          const pressed = this.pressedCodeBlock;
          this.pressedCodeBlock = undefined;
          const hitbox = this.codeCopyHitboxAt(event.x, event.y);
          this.syncCodeCopyButtons();
          if (hitbox?.blockIndex === pressed) {
            const requestVersion = this.documentVersion;
            const feedback = this.onCopyCode?.(this.codeBlocks[pressed]?.source ?? "", pressed);
            if (feedback && typeof (feedback as { then?: unknown }).then === "function") {
              void Promise.resolve(feedback).then((result) => {
                if (result && requestVersion === this.documentVersion) this.showCodeCopyFeedback(pressed, result);
              }, () => undefined);
            } else if (feedback) {
              this.showCodeCopyFeedback(pressed, feedback as CodeCopyFeedback);
            }
          }
          this.screen.render();
        }
        return;
      }

      if (event.action === "mousedown" && isPrimaryButton(event) && hasModifier(event)) {
        const link = this.linkHitboxAt(event.x, event.y);
        if (link) {
          this.pressedLink = link;
          return;
        }
      }
      if (this.pressedLink) {
        if (
          event.action === "mousedown" &&
          event.button === "unknown" &&
          Boolean((event as MouseData & { ctrl?: boolean }).ctrl)
        ) {
          // neo-blessed's legacy X10 parser reports xterm's Ctrl-release
          // byte as an unknown mousedown. The original Ctrl-left down owns
          // the gesture, so accept only the same hitbox as its release.
          const link = this.linkHitboxAt(event.x, event.y);
          if (sameLinkHitbox(link, this.pressedLink)) this.onOpenLink?.(this.pressedLink.href);
          this.pressedLink = undefined;
          return;
        }
        if (event.action === "mouseup") {
          const pressed = this.pressedLink;
          this.pressedLink = undefined;
          const link = this.linkHitboxAt(event.x, event.y);
          const same = sameLinkHitbox(link, pressed);
          // A standard SGR release must remain a primary-button release with
          // the modifier still present. The legacy X10 parser compatibility
          // above is intentionally limited to its confirmed unknown Ctrl
          // release encoding; do not let Ctrl+right/middle release through.
          if (same && hasModifier(event) && isPrimaryButton(event)) this.onOpenLink?.(pressed.href);
        }
        return;
      }

      if (this.selectionMode === "off") return;
      if (
        event.action === "mousedown" &&
        !this.draggingSelection &&
        event.button !== "right" &&
        event.button !== "middle"
      ) {
        const point = this.pointFromMouse(event.x, event.y, false);
        if (!point) return;
        this.onSelectionStart?.();
        this.draggingSelection = true;
        this.selectionAnchor = point;
        this.selection = normalizeSelection(point, point);
        this.notifySelectionChange();
        return;
      }
      if (!this.draggingSelection) return;
      if (event.action === "mousemove" || event.action === "mousedown") {
        const point = this.pointFromMouse(event.x, event.y, true);
        if (point) this.updateSelection(point);
        return;
      }
      if (event.action === "mouseup") {
        const point = this.pointFromMouse(event.x, event.y, true);
        if (point) this.updateSelection(point);
        this.draggingSelection = false;
        this.selectionAnchor = undefined;
        if (!isSelectionEmpty(this.selection)) {
          this.onSelectionComplete?.(selectedText(this.lines, this.selection));
        }
      }
    });
  }

  setSelectionMode(mode: SelectionMode): void {
    this.selectionMode = mode;
    this.clearSelection();
  }

  setSelectionCallbacks(callbacks: {
    onSelectionChange?: () => void;
    onSelectionComplete?: (text: string) => void;
  }): void {
    this.onSelectionChange = callbacks.onSelectionChange;
    this.onSelectionComplete = callbacks.onSelectionComplete;
  }

  setCopyCodeCallback(callback: ((text: string, blockIndex: number) => CodeCopyFeedback | Promise<CodeCopyFeedback | undefined> | void) | undefined): void {
    this.onCopyCode = callback;
  }

  setOpenLinkCallback(callback: ((href: string) => void) | undefined): void {
    this.onOpenLink = callback;
  }

  setTheme(theme: ThemePalette): void {
    this.theme = theme;
    if (this.disposed) return;
    this.element.style = { fg: theme.foreground, bg: theme.background };
    this.scrollbar.style = { bg: theme.background };
    for (const [index, button] of this.codeCopyButtons) button.style = this.codeButtonStyle(index);
    this.viewportDirty = true;
    this.renderViewport();
  }

  setLocale(locale: Locale): void {
    if (this.disposed) return;
    this.locale = locale;
    this.viewportDirty = true;
    this.renderViewport();
  }

  setMouseEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.mouseEnabled = enabled;
    this.pressedCodeBlock = undefined;
    this.hoveredCodeBlock = undefined;
    if (!enabled) {
      this.clearCodeCopyButtons();
    } else {
      this.viewportDirty = true;
      this.renderViewport();
    }
  }

  getSelectionMode(): SelectionMode {
    return this.selectionMode;
  }

  getSelection(): SelectionRange | undefined {
    return this.selection ? { start: { ...this.selection.start }, end: { ...this.selection.end } } : undefined;
  }

  getSelectedText(): string {
    return selectedText(this.lines, this.selection);
  }

  clearSelection(): void {
    this.draggingSelection = false;
    this.selectionAnchor = undefined;
    if (!this.selection) return;
    this.selection = undefined;
    this.notifySelectionChange();
  }

  private notifySelectionChange(): void {
    this.viewportDirty = true;
    this.renderViewport();
    this.onSelectionChange?.();
  }

  private updateSelection(point: SelectionPoint): void {
    if (!this.selectionAnchor) return;
    this.selection = normalizeSelection(this.selectionAnchor, point);
    this.notifySelectionChange();
  }

  private pointFromMouse(x: number, y: number, clamp: boolean): SelectionPoint | undefined {
    const position = this.element.lpos;
    if (!position) return undefined;
    const elementWithPadding = this.element as unknown as { ileft?: number | string; itop?: number | string };
    const left = position.xi + numericDimension(elementWithPadding.ileft);
    const top = position.yi + numericDimension(elementWithPadding.itop);
    const width = this.viewportWidth();
    const height = this.visibleHeight();
    if (!clamp && (x < left || x >= left + width || y < top || y >= top + height)) return undefined;
    const localX = Math.max(0, Math.min(width, x - left));
    const localY = Math.max(0, Math.min(height - 1, y - top));
    const line = Math.max(0, Math.min(Math.max(0, this.lines.length - 1), this.offset + localY));
    return { line, column: pointAtColumn(this.lines[line] ?? "", localX) };
  }

  private scrollFromMouseY(y: number): void {
    const position = this.scrollbar.lpos;
    if (!position) return;
    const top = position.yi;
    const height = Math.max(1, position.yl - position.yi);
    const ratio = Math.max(0, Math.min(1, (y - top) / Math.max(1, height - 1)));
    this.setScrollPercent(ratio * 100);
  }

  setLeft(left: number | string): void {
    this.element.left = left;
    this.viewportDirty = true;
  }

  setDocument(document: RenderedDocument, search?: Readonly<SearchSnapshot>): void {
    this.documentVersion += 1;
    this.clearCodeCopyStates();
    this.draggingSelection = false;
    this.selectionAnchor = undefined;
    this.selection = undefined;
    this.pressedCodeBlock = undefined;
    this.hoveredCodeBlock = undefined;
    this.lines = document.lines;
    this.codeBlocks = document.codeBlocks;
    this.links = document.links;
    this.linkHitboxes = [];
    this.clampOffset();
    this.currentSearch = search;
    this.viewportDirty = true;
    this.renderViewport();
  }

  renderLines(search?: Readonly<SearchSnapshot>): void {
    this.currentSearch = search;
    this.pressedCodeBlock = undefined;
    this.hoveredCodeBlock = undefined;
    // A height-only resize changes maximumScroll without changing the
    // document. Clamp before painting so a former bottom offset cannot leave
    // blank rows or produce a percentage above 100.
    this.clampOffset();
    this.viewportDirty = true;
    this.renderViewport();
  }

  private renderViewport(): void {
    if (this.disposed) return;
    this.clampOffset();
    if (!this.viewportDirty) return;
    this.viewportDirty = false;
    const height = this.visibleHeight();
    const visible = this.lines.slice(this.offset, this.offset + height);
    const visibleMatchRange = (matches: readonly SearchSnapshot["matches"][number][]): [number, number] => {
      const lowerBound = (line: number): number => {
        let low = 0;
        let high = matches.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if ((matches[middle]?.line ?? Number.POSITIVE_INFINITY) < line) low = middle + 1;
          else high = middle;
        }
        return low;
      };
      return [lowerBound(this.offset), lowerBound(this.offset + height)];
    };
    const localizedSearch = this.currentSearch
      ? {
          ...this.currentSearch,
          matches: (() => {
            const matches = this.currentSearch?.matches ?? [];
            const [first, last] = visibleMatchRange(matches);
            return matches.slice(first, last).map((match) => ({ ...match, line: match.line - this.offset }));
          })(),
        }
      : undefined;
    const display = localizedSearch ? applySearchHighlights(visible, localizedSearch, this.theme) : visible;
    const width = this.viewportWidth();
    const painted = Array.from({ length: height }, (_value, index) => {
      const sourceLine = this.offset + index;
      const raw = display[index] ?? "";
      const selected = selectedColumns(this.selection, sourceLine, raw);
      const highlighted = highlightSelection(raw, selected);
      const line = visibleWidth(highlighted) > width ? truncateAnsi(highlighted, width) : highlighted;
      return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
    });
    this.element.setContent(painted.join("\n"));
    this.renderScrollbar();
    this.syncCodeCopyButtons();
    this.syncLinkHitboxes();
  }

  getLines(): readonly string[] {
    return this.lines;
  }

  scrollBy(amount: number): void {
    this.pressedCodeBlock = undefined;
    this.hoveredCodeBlock = undefined;
    this.offset = Math.max(0, Math.min(this.maximumScroll(), this.offset + Math.trunc(amount)));
    this.viewportDirty = true;
    this.renderViewport();
    this.element.emit("scroll");
  }

  scrollHalf(direction: -1 | 1): void {
    const amount = Math.max(1, Math.floor(this.visibleHeight() / 2));
    this.scrollBy(direction * amount);
  }

  scrollTo(line: number): void {
    this.pressedCodeBlock = undefined;
    this.hoveredCodeBlock = undefined;
    this.offset = Math.max(0, Math.min(this.maximumScroll(), Math.floor(line)));
    this.viewportDirty = true;
    this.renderViewport();
    this.element.emit("scroll");
  }

  scrollTop(): void {
    this.scrollTo(0);
  }

  scrollBottom(): void {
    this.scrollTo(this.maximumScroll());
  }

  getScroll(): number {
    this.clampOffset();
    return this.offset;
  }

  getScrollPercent(): number {
    this.clampOffset();
    const maximum = this.maximumScroll();
    return maximum === 0 ? 0 : Math.round((this.offset / maximum) * 100);
  }

  setScrollPercent(percent: number): void {
    this.pressedCodeBlock = undefined;
    this.hoveredCodeBlock = undefined;
    const bounded = Math.max(0, Math.min(100, percent));
    this.offset = Math.round((bounded / 100) * this.maximumScroll());
    this.viewportDirty = true;
    this.renderViewport();
    this.element.emit("scroll");
  }

  visibleHeight(): number {
    const height = typeof this.element.height === "number" ? this.element.height : 1;
    return Math.max(1, height - numericDimension(this.element.iheight));
  }

  private viewportWidth(): number {
    const outerWidth = Math.max(1, numericDimension(this.element.width));
    return Math.max(1, outerWidth - numericDimension(this.element.iwidth));
  }

  focus(): void {
    this.element.focus();
  }

  private maximumScroll(): number {
    return Math.max(0, this.lines.length - this.visibleHeight());
  }

  private clampOffset(): void {
    const clamped = Math.max(0, Math.min(this.maximumScroll(), this.offset));
    if (clamped !== this.offset) {
      this.offset = clamped;
      this.viewportDirty = true;
    }
  }

  private renderScrollbar(): void {
    const position = this.scrollbar.lpos;
    const height = position
      ? Math.max(1, position.yl - position.yi)
      : Math.max(1, numericDimension(this.screen.height) - 2);
    const total = Math.max(1, this.lines.length);
    const viewport = Math.min(total, this.visibleHeight());
    const thumbHeight = Math.max(1, Math.min(height, Math.round((viewport / total) * height)));
    const travel = Math.max(0, height - thumbHeight);
    const maximum = this.maximumScroll();
    const thumbTop = maximum === 0 ? 0 : Math.round((this.offset / maximum) * travel);
    const palette = ansiForTheme(this.theme);
    const cells = Array.from({ length: height }, (_value, index) =>
      index >= thumbTop && index < thumbTop + thumbHeight
        ? palette.cyan("█")
        : palette.gray("░"),
    );
    this.scrollbar.setContent(cells.join("\n"));
  }

  private codeButtonStyle(blockIndex?: number): Record<string, unknown> {
    const kind = blockIndex === undefined ? undefined : this.codeCopyStates.get(blockIndex)?.kind;
    const pressed = blockIndex !== undefined && this.pressedCodeBlock === blockIndex;
    const hovered = blockIndex !== undefined && this.hoveredCodeBlock === blockIndex;
    const resultColor = kind === "copied"
      ? "green"
      : kind === "request-sent"
        ? "yellow"
        : kind === "failed"
          ? "red"
          : undefined;
    return {
      fg: resultColor ?? (pressed || hovered ? this.theme.accentBright : this.theme.chromeText),
      bg: pressed ? this.theme.selectedBackground : this.theme.chromeBackground,
      bold: true,
      underline: !kind && (pressed || hovered),
      inverse: this.theme.inverseChrome,
    };
  }

  private codeButtonWidth(): number {
    const copy = messages(this.locale);
    return Math.max(
      stringWidth(`[${copy.copy}]`),
      stringWidth(`[${copy.copied}]`),
      stringWidth(`[${copy.sent}]`),
      stringWidth(`[${copy.failed}]`),
    );
  }

  private codeButtonContent(blockIndex: number): string {
    const copy = messages(this.locale);
    const kind = this.codeCopyStates.get(blockIndex)?.kind;
    const label = kind === "copied" ? copy.copied : kind === "request-sent" ? copy.sent : kind === "failed" ? copy.failed : copy.copy;
    return `[${label}]`;
  }

  private codeCopyHitboxAt(x: number, y: number): CodeCopyHitbox | undefined {
    return this.codeCopyHitboxes.find(
      (hitbox) => x >= hitbox.left && x < hitbox.left + hitbox.width && y === hitbox.top,
    );
  }

  private linkHitboxAt(x: number, y: number): LinkHitbox | undefined {
    return this.linkHitboxes.find(
      (hitbox) => x >= hitbox.left && x < hitbox.left + hitbox.width && y === hitbox.top,
    );
  }

  private clearCodeCopyButtons(): void {
    for (const button of this.codeCopyButtons.values()) button.destroy();
    this.codeCopyButtons.clear();
    this.codeCopyHitboxes = [];
  }

  private clearCodeCopyStates(): void {
    for (const state of this.codeCopyStates.values()) clearTimeout(state.timer);
    this.codeCopyStates.clear();
  }

  private showCodeCopyFeedback(blockIndex: number, feedback: CodeCopyFeedback): void {
    if (this.disposed) return;
    const version = this.documentVersion;
    const previous = this.codeCopyStates.get(blockIndex);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      if (version !== this.documentVersion) return;
      this.codeCopyStates.delete(blockIndex);
      this.viewportDirty = true;
      this.syncCodeCopyButtons();
      this.screen.render();
    }, 2_000).unref();
    this.codeCopyStates.set(blockIndex, { kind: feedback.kind, timer });
    this.viewportDirty = true;
    this.syncCodeCopyButtons();
    this.screen.render();
  }

  private firstVisibleCodeBlock(offset: number): number {
    let low = 0;
    let high = this.codeBlocks.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((this.codeBlocks[middle]?.startLine ?? Number.POSITIVE_INFINITY) < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private firstVisibleLinkSegment(offset: number): number {
    let low = 0;
    let high = this.links.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const lastLine = this.links[middle]?.segments.at(-1)?.line ?? Number.NEGATIVE_INFINITY;
      if (lastLine < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private syncLinkHitboxes(): void {
    this.linkHitboxes = [];
    if (!this.mouseEnabled || this.links.length === 0) return;
    const layout = this.element as unknown as {
      lpos?: { xi: number; yi: number };
      ileft?: number | string;
      itop?: number | string;
    };
    if (!layout.lpos) return;
    const originLeft = layout.lpos.xi + numericDimension(layout.ileft);
    const originTop = layout.lpos.yi + numericDimension(layout.itop);
    const first = this.firstVisibleLinkSegment(this.offset);
    const endLine = this.offset + this.visibleHeight();
    for (let linkIndex = first; linkIndex < this.links.length; linkIndex += 1) {
      const link = this.links[linkIndex];
      if (!link) continue;
      const firstLine = link.segments[0]?.line ?? Number.POSITIVE_INFINITY;
      if (firstLine >= endLine) break;
      for (const segment of link.segments) {
        if (segment.line < this.offset || segment.line >= endLine) continue;
        const left = originLeft + segment.startColumn;
        const width = Math.max(1, segment.endColumn - segment.startColumn);
        this.linkHitboxes.push({ href: link.href, left, top: originTop + segment.line - this.offset, width });
      }
    }
  }

  private syncCodeCopyButtons(): void {
    if (this.disposed) return;
    this.codeCopyHitboxes = [];
    const visibleBlocks = new Set<number>();
    if (!this.mouseEnabled || this.codeBlocks.length === 0) {
      this.clearCodeCopyButtons();
      return;
    }

    const layout = this.element as unknown as {
      lpos?: { xi: number; yi: number };
      ileft?: number | string;
      itop?: number | string;
    };
    if (!layout.lpos) {
      this.clearCodeCopyButtons();
      return;
    }
    const originLeft = layout.lpos.xi + numericDimension(layout.ileft);
    const originTop = layout.lpos.yi + numericDimension(layout.itop);
    const width = this.viewportWidth();
    const buttonWidth = this.codeButtonWidth();
    if (width < buttonWidth + 6) {
      this.clearCodeCopyButtons();
      return;
    }

    const first = this.firstVisibleCodeBlock(this.offset);
    for (let index = first; index < this.codeBlocks.length; index += 1) {
      const block = this.codeBlocks[index];
      if (!block || block.startLine >= this.offset + this.visibleHeight()) break;
      const left = originLeft + width - buttonWidth - 1;
      const top = originTop + block.startLine - this.offset;
      if (left < originLeft || top < originTop || top >= originTop + this.visibleHeight()) continue;
      visibleBlocks.add(index);
      let button = this.codeCopyButtons.get(index);
      if (!button) {
        button = blessed.box({
          parent: this.screen,
          width: buttonWidth,
          height: 1,
          tags: false,
          mouse: false,
          content: this.codeButtonContent(index),
          style: this.codeButtonStyle(),
        });
        this.codeCopyButtons.set(index, button);
      }
      button.left = left;
      button.top = top;
      button.width = buttonWidth;
      button.setContent(this.codeButtonContent(index));
      button.style = this.codeButtonStyle(index);
      button.show();
      button.setFront();
      this.codeCopyHitboxes.push({ blockIndex: index, left, top, width: buttonWidth });
    }

    for (const [index, button] of this.codeCopyButtons) {
      if (!visibleBlocks.has(index)) {
        button.destroy();
        this.codeCopyButtons.delete(index);
      }
    }
    if (this.hoveredCodeBlock !== undefined && !visibleBlocks.has(this.hoveredCodeBlock)) {
      this.hoveredCodeBlock = undefined;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pressedCodeBlock = undefined;
    this.pressedLink = undefined;
    this.draggingSelection = false;
    this.draggingScrollbar = false;
    this.clearCodeCopyStates();
    this.clearCodeCopyButtons();
    this.codeCopyHitboxes = [];
    this.linkHitboxes = [];
    this.viewportDirty = false;
  }
}

function isPrimaryButton(event: MouseData): boolean {
  return !event.button || event.button === "left";
}

function hasModifier(event: MouseData): boolean {
  const modifiers = event as MouseData & { ctrl?: boolean; meta?: boolean; alt?: boolean };
  return Boolean(modifiers.ctrl || modifiers.meta);
}

function sameLinkHitbox(
  left: LinkHitbox | undefined,
  right: LinkHitbox | undefined,
): boolean {
  return Boolean(left && right && left.href === right.href && left.left === right.left && left.top === right.top && left.width === right.width);
}

function numericDimension(value: number | string | undefined): number {
  return typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) || 0 : 0;
}
