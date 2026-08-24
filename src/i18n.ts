export type Locale = "en" | "zh-CN";

export interface MessageCatalog {
  appTitle: string;
  usage: string;
  optionsHeading: string;
  optionNoMouse: string;
  optionToc: string;
  optionLang: string;
  optionHelp: string;
  optionVersion: string;
  readerExit: string;
  unknownOption: (value: string) => string;
  invalidLanguage: (value: string) => string;
  duplicateFile: string;
  cliError: (command: string, value: string) => string;
  missingFile: string;
  fileNotFound: (value: string) => string;
  filePermission: (value: string) => string;
  cannotAccessFile: string;
  notFile: (value: string) => string;
  readFailed: string;
  invalidUtf8: (value: string) => string;
  interactiveRequired: string;
  startupFailed: (value: string) => string;
  runtimeError: (value: string) => string;
  mouseUnavailable: string;
  largeDocument: string;
  plainTextFallback: string;
  previewTruncated: string;
  untitledHeading: string;
  noHeadings: string;
  rendering: (percent: number) => string;
  parsing: string;
  searchLabel: string;
  helpLabel: string;
  tocLabel: string;
  languageLabel: string;
  languageSearchPlaceholder: string;
  languageEmpty: string;
  footer: string;
  footerMedium: string;
  footerNarrow: string;
  searchPrefix: string;
  searchMediumPrefix: string;
  searchMediumSuffix: (status: string) => string;
  searchNarrow: (status: string) => string;
  searchCompact: (status: string) => string;
  selectionOn: string;
  selectionAuto: string;
  selectionOff: string;
  selectionTerminal: string;
  backgroundDark: string;
  backgroundTerminal: string;
  searchNavigation: (query: string, status: string) => string;
  searchNext: string;
  searchPrevious: string;
  searchEdit: string;
  searchClear: string;
  copy: string;
  codePrefix: string;
  copied: string;
  sent: string;
  failed: string;
  openFailed: string;
  openedLink: string;
  noContent: string;
  imageAlt: string;
  clipboardEmpty: string;
  clipboardTooLarge: (prefix: string, bytes: number, maxBytes: number) => string;
  clipboardCopied: (prefix: string, characters: number) => string;
  clipboardRequestSent: string;
  clipboardUnavailable: string;
  clipboardCancelled: string;
  clipboardTimedOut: string;
  clipboardOsc52TooLarge: (bytes: number, maxBytes: number) => string;
  selectionName: string;
  configReadFailed: string;
  configInvalid: string;
  configBackupFailed: string;
  configInvalidValues: string;
  configWriteFailed: string;
  renderingFallback: (reason: string) => string;
  helpContent: string;
  helpContentForMouse: (mouse: boolean) => string;
  footerNoMouse: string;
  footerMediumNoMouse: string;
  footerNarrowNoMouse: string;
}

export const LOCALES: readonly Locale[] = ["en", "zh-CN"];

/**
 * Values that come from argv, filesystem errors, or runtime exceptions are
 * product text, not terminal control streams. Keep ordinary Unicode intact,
 * but make every C0/C1/DEL byte visible (CR/LF become a separating space).
 */
export function sanitizeProductText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    if (character === "\r" || character === "\n" || character === "\t") return " ";
    const code = character.codePointAt(0) ?? 0;
    return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
  });
}

function safe(value: string): string {
  return sanitizeProductText(value);
}

export const catalogs: Record<Locale, MessageCatalog> = {
  en: {
    appTitle: "mdterm — Terminal Markdown Reader",
    usage: "Usage:",
    optionsHeading: "Options:",
    optionNoMouse: "  --no-mouse  Disable mouse input; use keyboard-only mode",
    optionToc: "  --toc       Open the table of contents at startup",
    optionLang: "  --lang      Interface language: en or zh-CN",
    optionHelp: "  -h, --help  Show help",
    optionVersion: "  -v, --version  Show version",
    readerExit: "In the reader press q or Ctrl+c to exit.",
    unknownOption: (value) => `Unknown option: ${safe(value)}`,
    invalidLanguage: (value) => `Invalid language: ${safe(value)}`,
    duplicateFile: "Only one Markdown file can be opened at a time.",
    cliError: (command, value) => `${safe(command)}: ${safe(value)}`,
    missingFile: "A Markdown file is required.",
    fileNotFound: (value) => `File not found: ${safe(value)}`,
    filePermission: (value) => `Permission denied: ${safe(value)}`,
    cannotAccessFile: "Unable to access file.",
    notFile: (value) => `Path is not a file: ${safe(value)}`,
    readFailed: "Failed to read file.",
    invalidUtf8: (value) => `File is not valid UTF-8 text: ${safe(value)}`,
    interactiveRequired: "md must run in an interactive terminal.",
    startupFailed: (value) => `Startup failed: ${safe(value)}`,
    runtimeError: (value) => `Runtime error: ${safe(value)}`,
    mouseUnavailable: "Mouse unavailable; using keyboard mode",
    largeDocument: "Large file: lightweight rendering",
    plainTextFallback: "Fell back to plain text",
    previewTruncated: "Large document preview truncated safely",
    untitledHeading: "Untitled heading",
    noHeadings: "(no h1–h3 headings)",
    rendering: (percent) => `Rendering ${percent}%`,
    parsing: "Parsing…",
    searchLabel: " Search (Enter confirm / Esc clear) ",
    helpLabel: " Help ",
    tocLabel: " Table of contents ",
    languageLabel: " Language ",
    languageSearchPlaceholder: "Filter languages",
    languageEmpty: "No matching languages",
    footer: "q Quit · / Search · t TOC · m Text selection · y Copy · b Background · l Language · ? Help",
    footerMedium: "q Quit · / Search · t TOC · m Text selection · b Bg · l Lang · ? Help",
    footerNarrow: "q · / · t · m · b · l · ?",
    searchPrefix: "Search",
    searchMediumPrefix: "Search “",
    searchMediumSuffix: (status) => `” · ${status} · n · p · Esc`,
    searchNarrow: (status) => `${status} · n↓ · p↑ · Esc`,
    searchCompact: (status) => `${status}·n·p·Esc`,
    selectionOn: "Selection: On",
    selectionAuto: "Selection: Auto-copy",
    selectionOff: "Selection: Off",
    selectionTerminal: "Selection: Terminal",
    backgroundDark: "Background: Dark",
    backgroundTerminal: "Background: Terminal",
    searchNavigation: (query, status) => `Search “${safe(query)}” · ${status} · n Next · p Previous · / Edit · Esc Clear`,
    searchNext: "Next",
    searchPrevious: "Previous",
    searchEdit: "Edit",
    searchClear: "Clear",
    copy: "Copy",
    codePrefix: "Code",
    copied: "Copied",
    sent: "Sent",
    failed: "Failed",
    openFailed: "Unable to open link",
    openedLink: "Opened link",
    noContent: "(empty document)",
    imageAlt: "image",
    clipboardEmpty: "No content to copy",
    clipboardTooLarge: (prefix, bytes, maxBytes) => `${safe(prefix) || "Selection"} is too large (${bytes} bytes; limit ${maxBytes} bytes)`,
    clipboardCopied: (prefix, characters) => `${prefix ? `${safe(prefix)} ` : ""}copied ${characters} chars`,
    clipboardRequestSent: "Copy request sent",
    clipboardUnavailable: "No clipboard backend available",
    clipboardCancelled: "Copy cancelled",
    clipboardTimedOut: "Clipboard backend timed out",
    clipboardOsc52TooLarge: (bytes, maxBytes) => `Clipboard request is too large for OSC 52 (${bytes} bytes; limit ${maxBytes} bytes)`,
    selectionName: "Selection",
    configReadFailed: "Could not read the user configuration; using defaults",
    configInvalid: "The user configuration was invalid; a backup was created and defaults are in use",
    configBackupFailed: "The user configuration was invalid and could not be backed up; defaults are in use",
    configInvalidValues: "Some user configuration values were invalid; defaults were used for those values",
    configWriteFailed: "Settings apply to this session but could not be saved",
    renderingFallback: (reason) => `Rendering failed; safely fell back: ${safe(reason)}`,
    helpContent: [
      "Scroll     ↑/k  ↓/j         line by line",
      "           PgUp/PgDn       half page",
      "           Ctrl+u/Ctrl+d   half page",
      "           gg / G          top / bottom",
      "",
      "Search     /               open search",
      "           n / p / N       next / previous (N compatible)",
      "           Esc             clear search first",
      "",
      "TOC        t               show or hide table of contents",
      "           ↑/↓ + Enter     select and jump",
      "           Tab             focus content / TOC",
      "Links      Ctrl+left-click  open http(s); [Copy] copies code",
      "",
      "Text selection m             On → Auto-copy → Off",
      "           y               copy the current selection",
      "           --no-mouse      use terminal-native selection",
      "Background b               Dark ↔ Terminal",
      "Language   l               choose interface language",
      "",
      "Quit       q / Ctrl+c",
      "",
      "Press any key to close help",
    ].join("\n"),
    helpContentForMouse: (mouse) => mouse ? catalogs.en.helpContent : [
      "Scroll     ↑/k  ↓/j         line by line",
      "           PgUp/PgDn       half page",
      "           Ctrl+u/Ctrl+d   half page",
      "           gg / G          top / bottom",
      "",
      "Search     /               open search",
      "           n / p / N       next / previous (N compatible)",
      "           Esc             clear search first",
      "",
      "TOC        t               show or hide table of contents",
      "           ↑/↓ + Enter     select and jump",
      "           Tab             focus content / TOC",
      "Links      Ctrl+left-click  open http(s)",
      "",
      "Text selection --no-mouse  use terminal-native selection",
      "Background b               Dark ↔ Terminal",
      "Language   l               choose interface language",
      "",
      "Quit       q / Ctrl+c",
      "",
      "Press any key to close help",
    ].join("\n"),
    footerNoMouse: "q Quit · / Search · t TOC · b Background · l Language · ? Help",
    footerMediumNoMouse: "q Quit · / Search · t TOC · b Bg · l Lang · ? Help",
    footerNarrowNoMouse: "q · / · t · b · l · ?",
  },
  "zh-CN": {
    appTitle: "mdterm — 终端 Markdown 阅读器",
    usage: "用法:",
    optionsHeading: "选项:",
    optionNoMouse: "  --no-mouse  禁用鼠标，使用纯键盘模式",
    optionToc: "  --toc       启动时展开目录面板",
    optionLang: "  --lang      界面语言：en 或 zh-CN",
    optionHelp: "  -h, --help  显示帮助",
    optionVersion: "  -v, --version  显示版本",
    readerExit: "进入阅读器后按 q 或 Ctrl+c 退出。",
    unknownOption: (value) => `未知选项：${safe(value)}`,
    invalidLanguage: (value) => `语言无效：${safe(value)}`,
    duplicateFile: "一次只能打开一个 Markdown 文件。",
    cliError: (command, value) => `${safe(command)}：${safe(value)}`,
    missingFile: "请提供一个 Markdown 文件。",
    fileNotFound: (value) => `文件不存在：${safe(value)}`,
    filePermission: (value) => `没有权限读取文件：${safe(value)}`,
    cannotAccessFile: "无法访问文件。",
    notFile: (value) => `路径不是文件：${safe(value)}`,
    readFailed: "读取文件失败。",
    invalidUtf8: (value) => `文件不是有效的 UTF-8 文本：${safe(value)}`,
    interactiveRequired: "md 必须在交互式终端中运行。",
    startupFailed: (value) => `启动失败：${safe(value)}`,
    runtimeError: (value) => `运行时发生错误：${safe(value)}`,
    mouseUnavailable: "鼠标不可用，已切换键盘模式",
    largeDocument: "大文件：轻量渲染",
    plainTextFallback: "已降级为纯文本",
    previewTruncated: "大文档预览已安全截断",
    untitledHeading: "未命名标题",
    noHeadings: "（无 h1–h3 标题）",
    rendering: (percent) => `正在渲染 ${percent}%`,
    parsing: "正在解析…",
    searchLabel: " 搜索（Enter 确认 / Esc 清除） ",
    helpLabel: " 键位帮助 ",
    tocLabel: " 目录 ",
    languageLabel: " 语言 ",
    languageSearchPlaceholder: "筛选语言",
    languageEmpty: "没有匹配的语言",
    footer: "q 退出 · / 搜索 · t 目录 · m 文本选择 · y 复制 · b 背景 · l 语言 · ? 帮助",
    footerMedium: "q 退出 · / 搜索 · t 目录 · m 文本选择 · b 背景 · l 语言 · ? 帮助",
    footerNarrow: "q · / · t · m · b · l · ?",
    searchPrefix: "搜索",
    searchMediumPrefix: "搜索 “",
    searchMediumSuffix: (status) => `” · ${status} · n · p · Esc`,
    searchNarrow: (status) => `${status} · n↓ · p↑ · Esc`,
    searchCompact: (status) => `${status}·n·p·Esc`,
    selectionOn: "文本选择:开启",
    selectionAuto: "文本选择:自动复制",
    selectionOff: "文本选择:关闭",
    selectionTerminal: "文本选择:终端原生",
    backgroundDark: "背景:深色",
    backgroundTerminal: "背景:终端",
    searchNavigation: (query, status) => `搜索 “${safe(query)}” · ${status} · n 下一个 · p 上一个 · / 修改 · Esc 清除`,
    searchNext: "下一个",
    searchPrevious: "上一个",
    searchEdit: "修改",
    searchClear: "清除",
    copy: "复制",
    codePrefix: "代码",
    copied: "已复制",
    sent: "已发送",
    failed: "失败",
    openFailed: "无法打开链接",
    openedLink: "已打开链接",
    noContent: "（空文档）",
    imageAlt: "图片",
    clipboardEmpty: "没有可复制的内容",
    clipboardTooLarge: (prefix, bytes, maxBytes) => `${safe(prefix) || "选区"}过大（${bytes} 字节，上限 ${maxBytes} 字节）`,
    clipboardCopied: (prefix, characters) => `已复制${prefix ? `${safe(prefix)} ` : ""}${characters} 字`,
    clipboardRequestSent: "已发送复制请求",
    clipboardUnavailable: "没有可用的剪贴板后端",
    clipboardCancelled: "复制已取消",
    clipboardTimedOut: "剪贴板后端超时",
    clipboardOsc52TooLarge: (bytes, maxBytes) => `内容过大，无法通过 OSC 52 复制（${bytes} 字节，上限 ${maxBytes} 字节）`,
    selectionName: "选区",
    configReadFailed: "无法读取用户配置，已使用默认设置",
    configInvalid: "用户配置无效，已备份原文件并使用默认设置",
    configBackupFailed: "用户配置无效且无法备份，已使用默认设置",
    configInvalidValues: "部分用户配置值无效，已对这些值使用默认设置",
    configWriteFailed: "设置已用于本次会话，但无法保存配置",
    renderingFallback: (reason) => `渲染失败，已安全降级：${safe(reason)}`,
    helpContent: [
      "滚动     ↑/k  ↓/j         逐行滚动",
      "           PgUp/PgDn       半屏滚动",
      "           Ctrl+u/Ctrl+d   半屏滚动",
      "           gg / G          顶部 / 底部",
      "",
      "搜索     /               打开搜索框",
      "           n / p / N       下一个 / 上一个（N 兼容）",
      "           Esc             清除搜索",
      "",
      "目录     t               显示或隐藏目录",
      "           ↑/↓ + Enter     选择并跳转",
      "           Tab             正文与目录切换",
      "链接     Ctrl+左键         打开 http(s)；[复制] 复制代码",
      "",
      "文本选择 m               开启 → 自动复制 → 关闭",
      "           y               复制当前选区",
      "           --no-mouse      使用终端原生文本选择",
      "背景     b               深色 ↔ 终端",
      "语言     l               选择界面语言",
      "",
      "退出     q / Ctrl+c",
      "",
      "按任意键关闭帮助",
    ].join("\n"),
    helpContentForMouse: (mouse) => mouse ? catalogs["zh-CN"].helpContent : [
      "滚动     ↑/k  ↓/j         逐行滚动",
      "           PgUp/PgDn       半屏滚动",
      "           Ctrl+u/Ctrl+d   半屏滚动",
      "           gg / G          顶部 / 底部",
      "",
      "搜索     /               打开搜索框",
      "           n / p / N       下一个 / 上一个（N 兼容）",
      "           Esc             清除搜索",
      "",
      "目录     t               显示或隐藏目录",
      "           ↑/↓ + Enter     选择并跳转",
      "           Tab             正文与目录切换",
      "链接     Ctrl+左键         打开 http(s)",
      "",
      "文本选择 --no-mouse      使用终端原生文本选择",
      "背景     b               深色 ↔ 终端",
      "语言     l               选择界面语言",
      "",
      "退出     q / Ctrl+c",
      "",
      "按任意键关闭帮助",
    ].join("\n"),
    footerNoMouse: "q 退出 · / 搜索 · t 目录 · b 背景 · l 语言 · ? 帮助",
    footerMediumNoMouse: "q 退出 · / 搜索 · t 目录 · b 背景 · l 语言 · ? 帮助",
    footerNarrowNoMouse: "q · / · t · b · l · ?",
  },
};

export function normalizeLocale(value: string | undefined): Locale {
  return value === "zh-CN" || value?.toLowerCase() === "zh-cn" ? "zh-CN" : "en";
}

export function messages(locale: Locale): MessageCatalog {
  return catalogs[locale];
}
