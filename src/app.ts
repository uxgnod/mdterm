import path from "node:path";
import { spawnSync } from "node:child_process";

import blessed = require("neo-blessed");

import { parseMarkdown, sanitizeTerminalInput, type ParsedDocument } from "./markdown/parse";
import { renderDocument, wrapAnsiLine, type RenderedDocument } from "./markdown/render";
import { resolveReadingTheme, type BackgroundMode, type ThemePalette } from "./theme";
import { messages, type Locale } from "./i18n";
import { type ConfigIssue, type ConfigStore, type UserPreferences } from "./config";
import { copyToClipboard } from "./ui/clipboard";
import { ContentView, type CodeCopyFeedback } from "./ui/content";
import { SearchModel, type SearchSnapshot } from "./ui/search";
import { selectionModeLabel, type SelectionMode } from "./ui/selection";
import { FooterBar, formatMouseFallbackNotice, StatusBar } from "./ui/statusbar";
import { TocView } from "./ui/toc";
import { LanguageModal } from "./ui/language";
import { openExternalUrl } from "./ui/links";

type AppMode = "content" | "toc" | "search" | "help" | "language";

export interface AppOptions {
  filePath: string;
  source: string;
  mouse: boolean;
  showToc: boolean;
  locale: Locale;
  commandName: string;
  background: BackgroundMode;
  selectionMode: SelectionMode;
  configStore: ConfigStore;
  configIssue?: ConfigIssue;
}

function numeric(value: number | string, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function shifted(key: blessed.Widgets.Events.IKeyEventArg, name: string): boolean {
  return (key.name === name && Boolean(key.shift)) || key.full === `S-${name}`;
}

type MouseFallbackReason = "unavailable" | undefined;

function keyboardMouseFallback(requested: boolean): { enabled: boolean; reason: MouseFallbackReason } {
  if (!requested) return { enabled: false, reason: undefined };
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb") {
    return { enabled: false, reason: "unavailable" };
  }
  return { enabled: true, reason: undefined };
}

function captureTtyState(): string | undefined {
  if (process.platform === "win32" || !process.stdin.isTTY) return undefined;
  try {
    const result = spawnSync("stty", ["-g"], { encoding: "utf8", stdio: [0, "pipe", "ignore"] });
    return result.status === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

function restoreTtyState(state: string | undefined): void {
  if (!state || process.platform === "win32") return;
  try {
    spawnSync("stty", [state], { stdio: [0, "ignore", "ignore"] });
  } catch {
    // screen.destroy() already performs the portable restoration path.
  }
}

function configIssueNotice(issue: ConfigIssue | undefined, locale: Locale): string {
  const copy = messages(locale);
  if (issue === "read") return copy.configReadFailed;
  if (issue === "invalid") return copy.configInvalid;
  if (issue === "backup-failed") return copy.configBackupFailed;
  if (issue === "invalid-values") return copy.configInvalidValues;
  if (issue === "write-failed") return copy.configWriteFailed;
  return "";
}

export function runApp(options: AppOptions): Promise<number> {
  return new Promise((resolve) => {
    let shutdownApp: ((code?: number, message?: string) => void) | undefined;
    let sigintBeforeShutdownReady = false;
    const onSigint = (): void => {
      if (shutdownApp) shutdownApp(0);
      else sigintBeforeShutdownReady = true;
    };
    process.once("SIGINT", onSigint);

    const initialTtyState = captureTtyState();
    let locale = options.locale;
    const mouse = keyboardMouseFallback(options.mouse);
    const fileName = sanitizeTerminalInput(path.basename(options.filePath)).replace(/[\r\n\t]+/g, " ");
    const screen = blessed.screen({
      smartCSR: false,
      fullUnicode: true,
      forceUnicode: true,
      // Resolve known fallback environments before constructing the screen so
      // a TERM=dumb session never enables widget mouse modes briefly before
      // we publish its terminal-native selection notice.
      mouse: mouse.enabled,
      resizeTimeout: 80,
      terminal: process.env.TERM === "dumb" ? "xterm-256color" : undefined,
      dockBorders: true,
      warnings: false,
    });

    let activeTheme: ThemePalette = resolveReadingTheme(options.background);
    let themeMode: BackgroundMode = options.background;
    const initialSelectionMode: SelectionMode = mouse.enabled ? options.selectionMode : "off";
    const status = new StatusBar(
      screen,
      fileName,
      activeTheme,
      locale,
      selectionModeLabel(initialSelectionMode, mouse.enabled, locale),
    );
    const footer = new FooterBar(screen, activeTheme, locale, mouse.enabled);

    let stopped = false;
    let mode: AppMode = options.showToc ? "toc" : "content";
    let selectionMode: SelectionMode = initialSelectionMode;
    let parsed: ParsedDocument | undefined;
    let rendered: RenderedDocument = { lines: [messages(locale).rendering(0)], headingLines: [], width: 80, codeBlocks: [], links: [] };
    let renderGeneration = 0;
    let documentGeneration = 0;
    let reflowInProgress = false;
    let resizeTimer: NodeJS.Timeout | undefined;
    let searchTimer: NodeJS.Timeout | undefined;
    let searchInputUpdate: NodeJS.Immediate | undefined;
    let gTimer: NodeJS.Timeout | undefined;
    let noticeTimer: NodeJS.Timeout | undefined;
    let pendingG = false;
    let searchConfirmed = false;
    let desiredSearchQuery = "";
    let desiredSearchOrdinal = -1;
    let searchGeneration = 0;
    let searchNavigationRevision = 0;
    const search = new SearchModel();
    let languageModal: LanguageModal | undefined;
    let languageReturnMode: "content" | "toc" = mode === "toc" ? "toc" : "content";
    const clipboardAbort = new AbortController();

    const columns = (): number => numeric(process.stdout.columns ?? numeric(screen.width, 80), 80);
    const rows = (): number => numeric(process.stdout.rows ?? numeric(screen.height, 24), 24);
    let lastLayout = { columns: columns(), rows: rows() };
    screen.on("prerender", () => screen.clearRegion(0, columns(), 0, rows()));
    const tocWidth = (): number => {
      const available = columns();
      return Math.max(14, Math.min(Math.floor(available * 0.25), Math.max(14, available - 18)));
    };

    let toc!: TocView;
    const content = new ContentView({
      screen,
      mouse: mouse.enabled,
      theme: activeTheme,
      locale,
      left: options.showToc ? tocWidth() : 0,
      onSelectionStart: () => {
        // A body drag is an explicit focus change, even when the TOC was
        // opened with `t` and still owns the blessed focus.
        mode = "content";
        content.focus();
        updateChrome();
      },
      onCopyCode: async (text): Promise<CodeCopyFeedback | undefined> => {
        const result = await copyToClipboard(text, {
          locale,
          messagePrefix: messages(locale).codePrefix,
          signal: clipboardAbort.signal,
        });
        if (stopped) return undefined;
        showTransientNotice(result.message);
        return { kind: result.status };
      },
      onOpenLink: (href) => {
        void openExternalUrl(href).then((opened) => {
          if (!stopped) showTransientNotice(opened ? messages(locale).openedLink : messages(locale).openFailed);
        });
      },
    });
    toc = new TocView({
      screen,
      mouse: mouse.enabled,
      theme: activeTheme,
      locale,
      visible: options.showToc,
      width: tocWidth(),
      onJump: (index) => {
        content.scrollTo(toc.lineFor(index));
        mode = "content";
        content.focus();
        updateChrome();
      },
    });

    // neo-blessed only marks the program as mouse-enabled after the widgets
    // have registered their mouse paths. Resolve that capability before the
    // first application render, then publish the final selection label.
    if (mouse.enabled && !screen.program.mouseEnabled) {
      mouse.enabled = false;
      mouse.reason = "unavailable";
    }
    content.setMouseEnabled(mouse.enabled);
    toc.setMouseEnabled(mouse.enabled);
    footer.setMouseEnabled(mouse.enabled);
    if (mouse.enabled) {
      // neo-blessed's xterm fallback may otherwise omit SGR mouse mode and
      // lose the modifier bit on X10 release. Keep legacy modes for normal
      // selection, but add SGR 1006 for unambiguous Ctrl-click releases.
      screen.program.setMouse({ sgrMouse: true }, true);
    }
    toc.setLocale(locale);
    selectionMode = initialSelectionMode;
    content.setSelectionMode(selectionMode);
    // StatusBar is constructed before neo-blessed reports the final mouse
    // capability. Publish the actual mode before the first render so a
    // mouse-capable session never flashes the terminal-native/off state.
    status.setSelection(selectionModeLabel(selectionMode, mouse.enabled, locale));

    const searchInput = blessed.textbox({
      parent: screen,
      label: messages(locale).searchLabel,
      bottom: 0,
      left: "15%",
      width: "70%",
      height: 3,
      border: "line",
      padding: { left: 1, right: 1 },
      keys: true,
      vi: false,
      mouse: false,
      inputOnFocus: true,
      hidden: true,
        style: {
        fg: activeTheme.foreground,
        bg: activeTheme.background,
        border: { fg: activeTheme.accent },
        label: { fg: activeTheme.accentBright },
      },
    });

    const help = blessed.box({
      parent: screen,
      label: messages(locale).helpLabel,
      top: "center",
      left: "center",
      width: "80%",
      height: 24,
      border: "line",
      padding: { top: 1, left: 2, right: 2 },
      tags: false,
      hidden: true,
      content: messages(locale).helpContentForMouse(mouse.enabled),
      style: {
        fg: activeTheme.foreground,
        bg: activeTheme.background,
        border: { fg: activeTheme.accent },
        label: { fg: activeTheme.accentBright, bold: true },
      },
    });

    const contentWidth = (): number => {
      const left = toc.isVisible() ? tocWidth() : 0;
      return Math.max(12, columns() - left - 3);
    };

    const applyTheme = (theme: ThemePalette): void => {
      activeTheme = theme;
      status.setTheme(theme);
      footer.setTheme(theme);
      content.setTheme(theme);
      toc.setTheme(theme);
      searchInput.style = {
        fg: theme.foreground,
        bg: theme.background,
        border: { fg: theme.accent },
        label: { fg: theme.accentBright },
      };
      help.style = {
        fg: theme.foreground,
        bg: theme.background,
        border: { fg: theme.accent },
        label: { fg: theme.accentBright, bold: true },
      };
      languageModal?.setTheme(theme);
    };

    const updateChrome = (): void => {
      status.setScrollPercent(content.getScrollPercent());
      status.setSearch(search.status());
      status.setSelection(selectionModeLabel(selectionMode, mouse.enabled, locale));
      status.setThemeStatus(activeTheme.mode === "dark" ? messages(locale).backgroundDark : messages(locale).backgroundTerminal);
      if (searchConfirmed && search.state.query.length > 0) footer.setSearchNavigation(search.state.query, search.status());
      else footer.clearSearchNavigation();
      toc.updateCurrent(content.getScroll());
      screen.render();
    };

    const applyLocale = (nextLocale: Locale): void => {
      const tocSelection = toc.getSelectedIndex();
      locale = nextLocale;
      status.setLocale(locale);
      footer.setLocale(locale);
      searchInput.setLabel(messages(locale).searchLabel);
      help.setLabel(messages(locale).helpLabel);
      help.setContent(messages(locale).helpContentForMouse(mouse.enabled));
      content.setLocale(locale);
      toc.setLocale(locale, tocSelection);
      languageModal?.setLocale(locale);
      if (parsed) {
        parsed = parseMarkdown(parsed.source, locale);
        toc.setEntries(parsed.toc, rendered.headingLines, tocSelection);
        void reflow(content.getScrollPercent());
      }
      showStableNotice();
      updateChrome();
    };

    languageModal = new LanguageModal({
      screen,
      locale,
      theme: activeTheme,
      mouse: mouse.enabled,
      onApply: (nextLocale) => {
        const tocSelection = languageReturnMode === "toc" ? toc.getSelectedIndex() : undefined;
        mode = languageReturnMode;
        applyLocale(nextLocale);
        persistPreference("language", nextLocale);
        if (tocSelection !== undefined) toc.select(tocSelection);
        restoreFocus();
        updateChrome();
      },
      onClose: () => {
        if (mode === "language") {
          mode = languageReturnMode;
          restoreFocus();
        }
      },
    });

    const restoreFocus = (): void => {
      if (mode === "toc" && toc.isVisible()) toc.focus();
      else content.focus();
    };

    const clearTimers = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer);
      if (searchTimer) clearTimeout(searchTimer);
      if (searchInputUpdate) clearImmediate(searchInputUpdate);
      if (gTimer) clearTimeout(gTimer);
      if (noticeTimer) clearTimeout(noticeTimer);
    };

    const removeProcessHandlers = (): void => {
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGHUP", onSighup);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGWINCH", onResizeSignal);
      process.removeListener("uncaughtException", onUncaught);
      process.removeListener("unhandledRejection", onUnhandled);
    };

    let shutdownPromise: Promise<void> | undefined;
    const shutdown = (code = 0, message?: string): void => {
      if (shutdownPromise) return;
      stopped = true;
      renderGeneration += 1;
      clearTimers();
      removeProcessHandlers();
      clipboardAbort.abort();
      shutdownPromise = (async () => {
        try {
          content.dispose();
          screen.destroy();
        } finally {
          restoreTtyState(initialTtyState);
          const saved = await options.configStore.flush();
          const finalMessage = message ?? (!saved.ok ? messages(locale).configWriteFailed : undefined);
          if (finalMessage) process.stderr.write(`${messages(locale).cliError(options.commandName, finalMessage)}\n`);
          resolve(code);
        }
      })();
    };

    const onSigterm = (): void => shutdown(0);
    const onSighup = (): void => shutdown(0);
    const onUncaught = (error: Error): void =>
      shutdown(1, messages(locale).runtimeError(error instanceof Error ? error.message : String(error)));
    const onUnhandled = (reason: unknown): void =>
      shutdown(1, messages(locale).runtimeError(reason instanceof Error ? reason.message : String(reason)));

    shutdownApp = shutdown;
    if (sigintBeforeShutdownReady) {
      shutdown(0);
      return;
    }
    process.once("SIGTERM", onSigterm);
    process.once("SIGHUP", onSighup);
    process.once("uncaughtException", onUncaught);
    process.once("unhandledRejection", onUnhandled);

    const showStableNotice = (): void => {
      const notice = [
        configIssueNotice(options.configIssue, locale),
        formatMouseFallbackNotice(mouse.reason, locale),
        parsed?.largeDocument ? messages(locale).largeDocument : "",
      ]
        .filter(Boolean)
        .join(" · ");
      status.setNotice(notice);
      if (notice) {
        if (noticeTimer) clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => {
          if (!stopped) {
            status.setNotice("");
            screen.render();
          }
        }, 4000).unref();
      }
    };

    const showTransientNotice = (notice: string): void => {
      if (noticeTimer) clearTimeout(noticeTimer);
      status.setNotice(notice);
      screen.render();
      noticeTimer = setTimeout(() => {
        if (!stopped) showStableNotice();
      }, 3500).unref();
    };

    const persistPreference = <K extends keyof UserPreferences>(key: K, value: UserPreferences[K]): void => {
      void options.configStore.set(key, value).then((saved) => {
        if (!saved.ok && !stopped) showTransientNotice(messages(locale).configWriteFailed);
      });
    };

    const copySelection = async (text = content.getSelectedText()): Promise<void> => {
      if (!text) return;
      const result = await copyToClipboard(text, { locale, signal: clipboardAbort.signal });
      if (stopped) return;
      showTransientNotice(result.message);
    };

    content.setSelectionCallbacks({
      onSelectionChange: updateChrome,
      onSelectionComplete: (text) => {
        if (selectionMode === "auto") void copySelection(text);
      },
    });

    const reflow = async (_preservePercent: number, resetTerminal = false): Promise<void> => {
      if (!parsed || stopped) return;
      // TOC/resize reflow invalidates the old visual coordinates. Never keep
      // a selection whose endpoints refer to the previous viewport.
      content.clearSelection();
      const generation = ++renderGeneration;
      const reflowSearchGeneration = searchGeneration;
      const reflowNavigationRevision = searchNavigationRevision;
      const searchQuery = desiredSearchQuery;
      const searchConfirmedAtStart = searchConfirmed;
      const searchOrdinal = search.state.query === searchQuery ? desiredSearchOrdinal : 0;
      reflowInProgress = true;
            status.setNotice(messages(locale).rendering(0));
      screen.render();

      try {
        const next = await renderDocument(parsed, contentWidth(), {
          theme: activeTheme,
          locale,
          isCancelled: () => stopped || generation !== renderGeneration,
          yieldIntervalMs: parsed.largeDocument ? 12 : 250,
          onProgress:
            parsed.largeDocument
              ? (completed, total) => {
                  if (stopped || generation !== renderGeneration || total === 0) return;
                  const percent = Math.floor((completed / total) * 100);
                  status.setNotice(messages(locale).rendering(percent));
                  screen.render();
                }
              : undefined,
        });
        if (stopped || generation !== renderGeneration) {
          if (generation === renderGeneration) reflowInProgress = false;
          return;
        }

        rendered = next;
        let nextSearch: SearchSnapshot | undefined;
        if (searchQuery.length > 0) {
          nextSearch = await search.updateAsync(
            rendered.lines,
            searchQuery,
            () =>
              stopped ||
              generation !== renderGeneration ||
              reflowSearchGeneration !== searchGeneration ||
              desiredSearchQuery !== searchQuery ||
              searchConfirmed !== searchConfirmedAtStart,
          );
          if (stopped || generation !== renderGeneration) {
            if (generation === renderGeneration) reflowInProgress = false;
            return;
          }
        }
        const searchStillCurrent = reflowSearchGeneration === searchGeneration &&
          desiredSearchQuery === searchQuery &&
          searchConfirmed === searchConfirmedAtStart;
        const searchChangedDuringReflow = !searchStillCurrent ||
          (searchQuery.length > 0 && !nextSearch);
        if (!searchChangedDuringReflow && nextSearch) {
          const ordinalToRestore = searchNavigationRevision === reflowNavigationRevision
            ? searchOrdinal
            : desiredSearchQuery === searchQuery
              ? desiredSearchOrdinal
              : 0;
          search.commit(nextSearch);
          search.setCurrentOrdinal(ordinalToRestore);
          desiredSearchOrdinal = search.state.current;
        }
        // Read the position only after rendering and async searching have
        // both settled. A user can scroll while updateAsync yields.
        const latestPercent = content.getScrollPercent();
        documentGeneration += 1;
        const committedSearch = !searchChangedDuringReflow && search.state.query === searchQuery
          ? search.state
          : undefined;
        content.setDocument(rendered, committedSearch);
        toc.setHeadingLines(rendered.headingLines);
        content.setScrollPercent(latestPercent);
        if (resetTerminal) {
          screen.realloc();
          // realloc can replay the pre-resize screen buffer. Repaint the
          // viewport after terminal geometry is committed so a cleared
          // selection cannot reappear in that full redraw.
          content.renderLines(committedSearch);
        }
        showStableNotice();
        restoreFocus();
        updateChrome();
        reflowInProgress = false;
        if (searchChangedDuringReflow && desiredSearchQuery) void performSearch(desiredSearchQuery);
      } catch (error) {
        if (stopped || generation !== renderGeneration) {
          if (generation === renderGeneration) reflowInProgress = false;
          return;
        }
        const reason = error instanceof Error ? error.message : String(error);
        const width = contentWidth();
        const previewLimit = 64 * 1024;
        const preview = parsed.source.slice(0, previewLimit);
        rendered = {
          lines: [
            messages(locale).renderingFallback(reason),
            "",
            ...preview.split(/\r?\n/).flatMap((line) => wrapAnsiLine(line, width)),
            ...(parsed.source.length > previewLimit ? ["", messages(locale).previewTruncated] : []),
          ],
          headingLines: [],
          width,
          codeBlocks: [],
          links: [],
        };
        content.setDocument(rendered);
        status.setNotice(messages(locale).plainTextFallback);
        restoreFocus();
        screen.render();
        documentGeneration += 1;
        reflowInProgress = false;
      }
    };

    const performSearch = async (query: string, requestGeneration?: number): Promise<void> => {
      const generation = requestGeneration ?? ++searchGeneration;
      const documentAtStart = documentGeneration;
      const renderAtStart = renderGeneration;
      const snapshot = await search.updateAsync(
        content.getLines(),
        query,
        () =>
          stopped ||
          generation !== searchGeneration ||
          documentAtStart !== documentGeneration ||
          renderAtStart !== renderGeneration ||
          desiredSearchQuery !== query,
      );
      if (
        !snapshot ||
        stopped ||
        generation !== searchGeneration ||
        documentAtStart !== documentGeneration ||
        renderAtStart !== renderGeneration ||
        reflowInProgress ||
        desiredSearchQuery !== query
      ) return;
      search.commit(snapshot);
      if (desiredSearchQuery === query) {
        search.setCurrentOrdinal(desiredSearchOrdinal >= 0 ? desiredSearchOrdinal : snapshot.current);
        desiredSearchOrdinal = search.state.current;
      }
      content.renderLines(search.state);
      const match = search.currentMatch();
      if (match) content.scrollTo(match.line);
      updateChrome();
    };

    const queueSearch = (): void => {
      if (searchTimer) clearTimeout(searchTimer);
      desiredSearchQuery = searchInput.getValue();
      const requestGeneration = ++searchGeneration;
      searchTimer = setTimeout(() => {
        if (!stopped && mode === "search") void performSearch(desiredSearchQuery, requestGeneration);
      }, 35);
    };

    let closingSearch = false;

    const queueSearchAfterInput = (): void => {
      if (searchInputUpdate) clearImmediate(searchInputUpdate);
      searchInputUpdate = setImmediate(() => {
        searchInputUpdate = undefined;
        // neo-blessed emits textbox keypress before its internal handler has
        // committed the character to getValue(). Defer one turn so live
        // search observes the same value that the user sees in the box.
        if (!stopped && mode === "search") queueSearch();
      });
    };

    const closeSearch = (clear: boolean): void => {
      if (closingSearch) return;
      closingSearch = true;
      if (searchTimer) clearTimeout(searchTimer);
      if (searchInputUpdate) clearImmediate(searchInputUpdate);
      searchInputUpdate = undefined;
      try {
        searchInput.hide();
        searchInput.cancel();
        mode = "content";
        if (clear) {
          searchGeneration += 1;
          searchNavigationRevision += 1;
          desiredSearchQuery = "";
          desiredSearchOrdinal = -1;
          searchConfirmed = false;
          search.clear();
          content.renderLines();
        } else {
          const query = searchInput.getValue();
          const keepOrdinal = query.length > 0 && query === search.state.query ? search.state.current : 0;
          desiredSearchQuery = query;
          desiredSearchOrdinal = query.length > 0 ? keepOrdinal : -1;
          const requestGeneration = ++searchGeneration;
          searchNavigationRevision += 1;
          searchConfirmed = query.length > 0;
          if (searchConfirmed) void performSearch(query, requestGeneration);
          else {
            search.clear();
          }
        }
        content.focus();
        updateChrome();
      } finally {
        closingSearch = false;
      }
    };

    const openSearch = (): void => {
      mode = "search";
      searchInput.setValue(desiredSearchQuery);
      searchInput.show();
      searchInput.focus();
      searchInput.readInput();
      screen.render();
    };

    searchInput.on("keypress", (_character, key) => {
      if (key.full === "C-c" || (key.name === "c" && key.ctrl)) {
        shutdown(0);
        return;
      }
      if (key.name !== "enter" && key.name !== "escape") queueSearchAfterInput();
    });
    searchInput.on("submit", () => {
      if (mode === "search") closeSearch(false);
    });
    searchInput.on("cancel", () => {
      if (mode === "search") closeSearch(true);
    });

    const toggleToc = (): void => {
      const visible = toc.toggle();
      toc.setWidth(tocWidth());
      content.setLeft(visible ? tocWidth() : 0);
      mode = visible ? "toc" : "content";
      restoreFocus();
      void reflow(content.getScrollPercent());
    };

    const moveSearch = (direction: -1 | 1): void => {
      searchNavigationRevision += 1;
      if (searchConfirmed) searchGeneration += 1;
      const match = direction === 1 ? search.next() : search.previous();
      if (!match) return;
      desiredSearchOrdinal = search.state.current;
      content.renderLines(search.state);
      content.scrollTo(match.line);
      updateChrome();
    };

    const clearPendingG = (): void => {
      pendingG = false;
      if (gTimer) clearTimeout(gTimer);
      gTimer = undefined;
    };

    screen.on("keypress", (character, key) => {
      try {
        if (key.full === "C-c" || (key.name === "c" && key.ctrl)) {
          shutdown(0);
          return;
        }
        if (mode === "language") return;
        if (
          mode === "search" &&
          (key.name === "enter" || key.name === "return" || key.name === "linefeed")
        ) {
          closeSearch(false);
          return;
        }
        if (mode === "search") return;
        if (mode === "help") {
          help.hide();
          mode = toc.isVisible() && toc.isFocused() ? "toc" : "content";
          restoreFocus();
          screen.render();
          return;
        }
        if (key.name === "q" && !key.ctrl && !key.meta) {
          shutdown(0);
          return;
        }

        if (key.name === "b") {
          if (mode === "content" || mode === "toc") cycleTheme();
          return;
        }

        if (key.name !== "g") clearPendingG();

        if (key.name === "?" || character === "?") {
          mode = "help";
          help.show();
          help.setFront();
          screen.render();
          return;
        }
        if (key.name === "l") {
          languageReturnMode = mode === "toc" && toc.isVisible() ? "toc" : "content";
          mode = "language";
          languageModal?.show();
          return;
        }
        if (key.name === "/" || character === "/") {
          openSearch();
          return;
        }
        if (key.name === "t") {
          content.clearSelection();
          toggleToc();
          return;
        }
        if (key.name === "m" && mouse.enabled) {
          selectionMode =
            selectionMode === "manual" ? "auto" : selectionMode === "auto" ? "off" : "manual";
          content.setSelectionMode(selectionMode);
          persistPreference("selectionMode", selectionMode);
          updateChrome();
          return;
        }
        if (key.name === "tab" && toc.isVisible()) {
          mode = mode === "toc" ? "content" : "toc";
          restoreFocus();
          updateChrome();
          return;
        }
        if (key.name === "escape") {
          if (content.getSelection()) {
            content.clearSelection();
            updateChrome();
            return;
          }
          searchGeneration += 1;
          searchNavigationRevision += 1;
          desiredSearchQuery = "";
          desiredSearchOrdinal = -1;
          searchConfirmed = false;
          search.clear();
          content.renderLines();
          updateChrome();
          return;
        }
        if (key.name === "y" && selectionMode === "manual" && mode === "content") {
          void copySelection();
          return;
        }
        if (key.name === "n" && !key.shift) {
          moveSearch(1);
          return;
        }
        if (key.name === "p" && !key.shift) {
          moveSearch(-1);
          return;
        }
        if (shifted(key, "n")) {
          moveSearch(-1);
          return;
        }

        if (mode === "toc") {
          if (key.name === "up" || key.name === "k") toc.move(-1);
          else if (key.name === "down" || key.name === "j") toc.move(1);
          else if (key.name === "enter") toc.jumpSelected();
          screen.render();
          return;
        }

        let scrolled = false;
        if (key.name === "up" || key.name === "k") {
          content.scrollBy(-1);
          scrolled = true;
        } else if (key.name === "down" || key.name === "j") {
          content.scrollBy(1);
          scrolled = true;
        } else if (key.name === "pageup" || (key.name === "u" && key.ctrl)) {
          content.scrollHalf(-1);
          scrolled = true;
        } else if (key.name === "pagedown" || (key.name === "d" && key.ctrl)) {
          content.scrollHalf(1);
          scrolled = true;
        } else if (shifted(key, "g")) {
          content.scrollBottom();
          scrolled = true;
        }
        else if (key.name === "g" && character === "g") {
          if (pendingG) {
            clearPendingG();
            content.scrollTop();
            scrolled = true;
          } else {
            pendingG = true;
            gTimer = setTimeout(clearPendingG, 500);
          }
        }
        if (!scrolled) updateChrome();
      } catch (error) {
        onUncaught(error instanceof Error ? error : new Error(String(error)));
      }
    });

    content.element.on("scroll", () => updateChrome());

    const handleResize = (): void => {
      if (stopped) return;
      // On the screen event, neo-blessed's geometry is the committed source
      // of truth. stdout.columns/rows can still describe the pre-resize TTY
      // (and using them here can skip the clear-selection/reflow branch).
      const nextLayout = {
        columns: numeric(screen.width, columns()),
        rows: numeric(screen.height, rows()),
      };
      const widthChanged = nextLayout.columns !== lastLayout.columns;
      const heightChanged = nextLayout.rows !== lastLayout.rows;
      if (!widthChanged && !heightChanged) {
        // A duplicate blessed resize still means its program geometry is the
        // authoritative viewport size; repaint without a document reflow.
        content.renderLines(search.state);
        updateChrome();
        return;
      }
      lastLayout = nextLayout;
      content.clearSelection();
      content.renderLines(search.state);
      if (!widthChanged) {
        updateChrome();
        return;
      }
      toc.setWidth(tocWidth());
      content.setLeft(toc.isVisible() ? tocWidth() : 0);
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => void reflow(content.getScrollPercent(), true), 90);
      updateChrome();
    };

    const onResizeSignal = (): void => {
      // Do not commit layout from SIGWINCH: stdout dimensions can update
      // before neo-blessed updates program.rows/program.columns. The screen
      // resize event below is the layout commit point.
    };
    const onScreenResize = (): void => handleResize();

    screen.on("resize", onScreenResize);
    process.on("SIGWINCH", onResizeSignal);

    content.setDocument(rendered);
    parsed = parseMarkdown(options.source, locale);
    toc.setEntries(parsed.toc, []);
    if (options.showToc) toc.focus();
    else content.focus();
    status.setNotice(messages(locale).parsing);
    void reflow(0);

    const cycleTheme = (): void => {
      const next: BackgroundMode = themeMode === "dark" ? "terminal" : "dark";
      themeMode = next;
      persistPreference("background", next);
      applyTheme(resolveReadingTheme(next));
      // Publish the still-confirmed search footer before the asynchronous
      // document reflow starts. The reflow may yield, but the current ordinal
      // must never disappear during that transition.
      updateChrome();
      void reflow(content.getScrollPercent());
    };
  });
}
