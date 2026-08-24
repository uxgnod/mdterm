const assert = require("node:assert/strict");
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const stripAnsi = require("strip-ansi");

const {
  highlightSelection,
  isSelectionEmpty,
  normalizeSelection,
  pointAtColumn,
  selectedText,
  selectionModeLabel,
} = require("../dist/ui/selection.js");
const { copyToClipboard } = require("../dist/ui/clipboard.js");
const { formatStatusBar, formatSearchNavigation, formatMouseFallbackNotice } = require("../dist/ui/statusbar.js");
const { SearchModel, applySearchHighlights } = require("../dist/ui/search.js");
const { messages, sanitizeProductText } = require("../dist/i18n.js");
const { formatFooterBar } = require("../dist/ui/statusbar.js");

test("selection mode labels include terminal fallback", () => {
  assert.equal(selectionModeLabel("off"), "Selection: Off");
  assert.equal(selectionModeLabel("manual"), "Selection: On");
  assert.equal(selectionModeLabel("auto"), "Selection: Auto-copy");
  assert.equal(selectionModeLabel("manual", false), "Selection: Terminal");
});

test("narrow status bars reserve the selection state before truncating the filename", () => {
  const width = require("string-width");
  for (const label of ["Selection: Off", "Selection: On", "Selection: Auto-copy", "Selection: Terminal"]) {
    const labelWidth = width(label);
    assert.equal(width(formatStatusBar("a-very-long-file-name.md", 42, "", "", label, labelWidth)), labelWidth);
    assert.equal(width(formatStatusBar("a-very-long-file-name.md", 42, "", "", label, labelWidth + 1)), labelWidth + 1);
    assert.match(formatStatusBar("a-very-long-file-name.md", 42, "", "", label, labelWidth), new RegExp(label));
    assert.ok(width(formatStatusBar("a-very-long-file-name.md", 42, "", "", label, labelWidth - 1)) <= labelWidth - 1);
  }
  const status = formatStatusBar("an-extremely-long-markdown-file-name.md", 42, "3/17", "", "Selection: Auto-copy", 24);
  assert.match(status, /Selection: Auto-copy/);
  assert.ok(width(status) <= 24, status);
});

test("search navigation keeps index, n, p and Esc at every supported width", () => {
  const width = require("string-width");
  for (const columns of [24, 40, 52, 77, 160]) {
    const value = formatSearchNavigation("中文关键词🙂", "3/17", columns);
    assert.ok(width(value) <= columns, `${columns}: ${value}`);
    assert.match(value, /3\/17/);
    assert.match(value, /n/);
    assert.match(value, /p/);
    assert.match(value, /Esc/);
  }
});

test("product text sanitization preserves Unicode and removes terminal controls", () => {
  const value = sanitizeProductText("中文\u001b]52;c;bad\u0007\u009b\r\n🙂");
  assert.equal(value, "中文U+001B]52;c;badU+0007U+009B  🙂");
  for (const locale of ["en", "zh-CN"]) {
    const copy = messages(locale);
    const outputs = [
      copy.unknownOption("--bad\u001b\u0007"),
      copy.runtimeError("boom\u009b\r\nnext"),
      copy.renderingFallback("reason\u001b"),
      copy.clipboardTooLarge("代码\u0007", 5, 4),
      copy.clipboardCopied("代码\u0007", 2),
      copy.searchNavigation("词\u001b\n", "1/1"),
    ];
    for (const output of outputs) {
      assert.doesNotMatch(output, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u);
    }
  }
});

test("responsive footer never falls back to the ambiguous selection label", () => {
  for (const [locale, widths] of [["en", [80, 100]], ["zh-CN", [60, 80, 100]]]) {
    for (const width of widths) {
      const footer = formatFooterBar(width, undefined, locale);
      assert.doesNotMatch(footer, /m (?:Select|选择)(?:\b|$)/u, `${locale}/${width}: ${footer}`);
      if (width >= 80) assert.match(footer, locale === "en" ? /Text selection/ : /文本选择/);
    }
  }
});

test("English and Simplified Chinese chrome stays bounded across the supported widths", () => {
  const width = require("string-width");
  for (const locale of ["en", "zh-CN"]) {
    for (const columns of [24, 40, 60, 80, 120]) {
      const selection = selectionModeLabel("manual", true, locale);
      const footer = formatFooterBar(columns, undefined, locale);
      const search = formatSearchNavigation("中文 keyword", "3/17", columns, locale);
      const status = formatStatusBar("document.md", 42, "3/17", "", selection, columns, "", locale);
      assert.ok(width(footer) <= columns, `${locale}/${columns}: ${footer}`);
      assert.ok(width(search) <= columns, `${locale}/${columns}: ${search}`);
      assert.ok(width(status) <= columns, `${locale}/${columns}: ${status}`);
      assert.match(search, /3\/17/);
      assert.match(search, /n/);
      assert.match(search, /p/);
      assert.match(search, /Esc/);
      assert.doesNotMatch(footer, /m (?:Select|选择)(?:\b|$)/u);
    }
    assert.equal(formatMouseFallbackNotice("unavailable", locale), messages(locale).mouseUnavailable);
    assert.equal(formatMouseFallbackNotice(undefined, locale), "");
  }
});

test("no-mouse chrome and help do not advertise application selection or copy actions", () => {
  for (const locale of ["en", "zh-CN"]) {
    for (const columns of [24, 40, 60, 80, 120]) {
      const footer = formatFooterBar(columns, undefined, locale, false);
      assert.doesNotMatch(footer, /(?:^| · )m(?: | ·|$)/u, `${locale}/${columns}: ${footer}`);
      assert.doesNotMatch(footer, /(?:^| · )y(?: | ·|$)/u, `${locale}/${columns}: ${footer}`);
    }
    const help = messages(locale).helpContentForMouse(false);
    assert.doesNotMatch(help, /Text selection m|文本选择 m|\by\s+copy|\by\s+复制/u);
    assert.doesNotMatch(help, /open http|打开 http/u);
    assert.match(help, /Ctrl-left-click unavailable|Ctrl[+]左键[^\n]*不可用/u);
    assert.match(help, /drag|应用拖选/u);
    assert.match(help, /auto-copy|自动复制/u);
    assert.match(help, /\[Copy\]|\[复制\]/u);
    assert.match(help, /terminal-native|终端原生文本选择/u);
  }
});

test("selection maps ANSI, CJK and emoji to whole grapheme boundaries", () => {
  const line = "A\u001b[1m中🙂B\u001b[22m";
  assert.equal(pointAtColumn(line, 0), 0);
  assert.equal(pointAtColumn(line, 2), 3);
  assert.equal(pointAtColumn(line, 4), 5);
  assert.equal(pointAtColumn(line, 5), 5);

  const forward = normalizeSelection({ line: 0, column: 1 }, { line: 0, column: 5 });
  assert.equal(selectedText([line], forward), "中🙂");
  const reverse = normalizeSelection({ line: 1, column: 4 }, { line: 0, column: 2 });
  assert.equal(selectedText(["第一🙂", "第二行"], reverse), "一🙂\n第二");
  assert.equal(isSelectionEmpty(normalizeSelection({ line: 0, column: 2 }, { line: 0, column: 2 })), true);
});

test("selection highlighting preserves visible width and ANSI content", () => {
  const line = "\u001b[31mA中文🙂B\u001b[39m";
  const painted = highlightSelection(line, { start: 1, end: 7 });
  assert.equal(stripAnsi(painted), stripAnsi(line));
  assert.equal(require("string-width")(stripAnsi(painted)), require("string-width")(stripAnsi(line)));
  assert.match(painted, /\u001b\[0m\u001b\[97;44;1m/);
  assert.match(painted, /\u001b\[0m\u001b\[31m/);
});

test("selection overlay stays distinct from current and ordinary search highlights", () => {
  const line = "\u001b[31mABCDE\u001b[39m";
  const search = new SearchModel();
  search.update([line], "BCD");
  const searched = applySearchHighlights([line], search.state)[0];
  const partial = highlightSelection(searched, { start: 1, end: 3 });
  assert.equal(stripAnsi(partial), stripAnsi(line));
  assert.equal(require("string-width")(stripAnsi(partial)), require("string-width")(stripAnsi(line)));
  assert.match(partial, /\u001b\[0m\u001b\[97;44;1mB/);
  assert.match(partial, /C\u001b\[0m\u001b\[97m[\s\S]*D\u001b\[55;24;22;39m/);
  assert.doesNotMatch(searched, /\u001b\[7m/);

  const complete = highlightSelection(searched, { start: 1, end: 4 });
  assert.equal(stripAnsi(complete), stripAnsi(line));
  assert.match(complete, /\u001b\[97;44;1mD\u001b\[0m[\s\S]*D?\u001b\[55;24;22;39m/);

  const ordinary = new SearchModel();
  ordinary.update(["ABCDE BCD"], "BC");
  const ordinaryLine = applySearchHighlights(["ABCDE BCD"], ordinary.state)[0];
  const paintedOrdinary = highlightSelection(ordinaryLine, { start: 6, end: 8 });
  assert.equal(stripAnsi(paintedOrdinary), "ABCDE BCD");
  assert.match(paintedOrdinary, /\u001b\[4m\u001b\[0m\u001b\[97;44;1mB/);
  assert.match(paintedOrdinary, /\u001b\[24mD/);
});

test("selection restores inline code and color ANSI state after each grapheme", () => {
  const line = "\u001b[1;96mcode\u001b[39;22m and \u001b[91m颜色\u001b[39m";
  const painted = highlightSelection(line, { start: 1, end: 5 });
  assert.equal(stripAnsi(painted), stripAnsi(line));
  assert.equal(require("string-width")(stripAnsi(painted)), require("string-width")(stripAnsi(line)));
  assert.match(painted, /\u001b\[0m\u001b\[1m\u001b\[96m/);
  assert.match(painted, /\u001b\[39;22m/);
  assert.match(painted, /\u001b\[91m颜色\u001b\[39m/);
});

test("selection remains blue and bright over an originally bold current match", () => {
  const line = "\u001b[1mABCDE\u001b[22m";
  const search = new SearchModel();
  search.update([line], "BCD");
  const painted = highlightSelection(applySearchHighlights([line], search.state)[0], { start: 1, end: 4 });
  assert.equal(stripAnsi(painted), "ABCDE");
  assert.match(painted, /\u001b\[97;44;1mB/);
  assert.match(painted, /\u001b\[0m\u001b\[1m\u001b\[4m/);
  assert.doesNotMatch(painted, /\u001b\[7m|\u001b\[30;47;1m/);
});

test("clipboard uses stdin, never shell interpolation, and reports success", async () => {
  const calls = [];
  const result = await copyToClipboard("中文; $(touch unsafe)", {
    platform: "linux",
    commandAvailable: (command) => command === "wl-copy",
    runCommand: (command, args, text) => {
      calls.push({ command, args, text });
      return true;
    },
  });
  assert.equal(result.status, "copied");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { command: "wl-copy", args: [], text: "中文; $(touch unsafe)" });
});

test("code clipboard uses the shared backend and exact code status wording", async () => {
  const result = await copyToClipboard("const x = 1", {
    platform: "linux",
    messagePrefix: "代码",
    locale: "zh-CN",
    commandAvailable: (command) => command === "wl-copy",
    runCommand: () => true,
  });
  assert.equal(result.status, "copied");
  assert.equal(result.message, "已复制代码 11 字");

  const oversized = await copyToClipboard("x".repeat(5), {
    messagePrefix: "代码",
    locale: "zh-CN",
    maxBytes: 4,
    commandAvailable: () => {
      throw new Error("oversized code must not invoke a backend");
    },
  });
  assert.equal(oversized.status, "failed");
  assert.match(oversized.message, /^代码过大/);
});

test("code clipboard accepts exactly 4 MiB and rejects the next byte", async () => {
  const boundary = "x".repeat(4 * 1024 * 1024);
  const calls = [];
  const accepted = await copyToClipboard(boundary, {
    platform: "linux",
    messagePrefix: "代码",
    locale: "zh-CN",
    commandAvailable: (command) => command === "wl-copy",
    runCommand: (command, args, text) => {
      calls.push({ command, args, textLength: text.length });
      return true;
    },
  });
  assert.equal(accepted.status, "copied");
  assert.equal(accepted.bytes, 4 * 1024 * 1024);
  assert.equal(calls.length, 1);

  const rejected = await copyToClipboard(`${boundary}x`, {
    messagePrefix: "代码",
    locale: "zh-CN",
    commandAvailable: () => {
      throw new Error("over-limit code must not invoke a backend");
    },
  });
  assert.equal(rejected.status, "failed");
  assert.match(rejected.message, /^代码过大/);
});

test("clipboard falls back to OSC 52 with a request status", async () => {
  let sequence = "";
  const result = await copyToClipboard("复制🙂", {
    platform: "linux",
    locale: "zh-CN",
    commandAvailable: () => false,
    writeOsc52: (value) => {
      sequence = value;
      return true;
    },
  });
  assert.equal(result.status, "request-sent");
  assert.equal(result.message, "已发送复制请求");
  assert.match(sequence, /^\u001b\]52;c;[A-Za-z0-9+/]+=*\u0007$/);
});

test("clipboard reports unavailable and oversized backends without false success", async () => {
  const unavailable = await copyToClipboard("text", {
    platform: "linux",
    commandAvailable: () => false,
    writeOsc52: () => false,
  });
  assert.equal(unavailable.status, "failed");
  const oversized = await copyToClipboard("中文", {
    maxBytes: 1,
    locale: "zh-CN",
    writeOsc52: () => {
      throw new Error("must not be called");
    },
  });
  assert.equal(oversized.status, "failed");
  assert.match(oversized.message, /选区过大/);
});

test("OSC 52 has its own 100 KiB input limit", async () => {
  const exact = await copyToClipboard("x".repeat(100 * 1024), {
    platform: "linux",
    commandAvailable: () => false,
    writeOsc52: () => true,
  });
  assert.equal(exact.status, "request-sent");
  const oversized = await copyToClipboard("x".repeat(100 * 1024 + 1), {
    platform: "linux",
    commandAvailable: () => false,
    writeOsc52: () => {
      throw new Error("OSC 52 must not receive oversized input");
    },
  });
  assert.equal(oversized.status, "failed");
  assert.match(oversized.message, /OSC 52/);
});

test("injected clipboard timeout and abort behavior is cross-platform", async () => {
  let timeoutObserved = false;
  const timedOut = await copyToClipboard("timeout", {
    platform: "linux",
    timeoutMs: 20,
    commandAvailable: (command) => command === "wl-copy",
    runCommand: async (_command, _args, _text, signal) => {
      return new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
          timeoutObserved = true;
          resolve(false);
        }, { once: true });
      });
    },
    writeOsc52: () => false,
  });
  assert.equal(timedOut.status, "failed");
  assert.match(timedOut.message, /timed out|超时/u);
  assert.equal(timeoutObserved, true);

  const controller = new AbortController();
  let abortObserved = false;
  const pending = copyToClipboard("cancel", {
    platform: "linux",
    commandAvailable: (command) => command === "wl-copy",
    runCommand: (_command, _args, _text, signal) => new Promise((resolve) => {
      const onAbort = () => {
        abortObserved = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(false);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
    signal: controller.signal,
    writeOsc52: () => false,
  });
  setImmediate(() => controller.abort());
  const cancelled = await pending;
  assert.equal(cancelled.status, "failed");
  assert.equal(abortObserved, true);
});

test("Unix clipboard timeout and abort terminate a hanging backend", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mdterm-clipboard-hang-"));
  const command = path.join(directory, "wl-copy");
  writeFileSync(command, "#!/usr/bin/env node\nprocess.stdin.on('data', () => {}); setTimeout(() => {}, 10_000);\n", "utf8");
  chmodSync(command, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath ?? ""}`;
  try {
    const timedOut = await copyToClipboard("timeout", { platform: "linux", timeoutMs: 50 });
    assert.equal(timedOut.status, "failed");
    assert.match(timedOut.message, /timed out|超时/u);

    const controller = new AbortController();
    const pending = copyToClipboard("cancel", { platform: "linux", timeoutMs: 5_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 40);
    const cancelled = await pending;
    assert.equal(cancelled.status, "failed");
    assert.match(cancelled.message, /cancelled|取消/u);
  } finally {
    process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Unix clipboard reaps an EPIPE child that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mdterm-clipboard-ePIPE-"));
  const command = path.join(directory, "wl-copy");
  const pidFile = path.join(directory, "child.pid");
  writeFileSync(command, `#!${process.execPath}\nconst fs = require("node:fs"); fs.writeFileSync(process.env.MDTERM_CLIPBOARD_PID, String(process.pid)); try { fs.closeSync(0); } catch {} process.stdin.destroy(); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n`, "utf8");
  chmodSync(command, 0o700);
  const previousPath = process.env.PATH;
  const previousPid = process.env.MDTERM_CLIPBOARD_PID;
  process.env.PATH = `${directory}:${previousPath ?? ""}`;
  process.env.MDTERM_CLIPBOARD_PID = pidFile;
  try {
    const started = Date.now();
    const result = await copyToClipboard("x".repeat(4 * 1024 * 1024), {
      platform: "linux",
      timeoutMs: 5_000,
      writeOsc52: () => false,
    });
    assert.equal(result.status, "failed");
    assert.ok(Date.now() - started < 2_000, "EPIPE must terminate without waiting for the normal timeout");
    const pid = Number(readFileSync(pidFile, "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, `clipboard child ${pid} must be reaped before copy resolves`);
  } finally {
    process.env.PATH = previousPath;
    if (previousPid === undefined) delete process.env.MDTERM_CLIPBOARD_PID;
    else process.env.MDTERM_CLIPBOARD_PID = previousPid;
    rmSync(directory, { recursive: true, force: true });
  }
});
