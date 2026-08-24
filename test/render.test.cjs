const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const { Marked } = require("marked");
const stringWidth = require("string-width");
const stripAnsi = require("strip-ansi");

const { parseMarkdown, sanitizeTerminalInput } = require("../dist/markdown/parse.js");
const {
  renderDocument,
  truncateAnsi,
  visibleWidth,
  wrapAnsiLine,
} = require("../dist/markdown/render.js");

const fixturePath = path.join(__dirname, "fixtures", "demo.md");

test("display width handles ANSI, CJK, combining marks and emoji", () => {
  assert.equal(visibleWidth("中文"), 4);
  assert.equal(visibleWidth("A中B"), 4);
  assert.equal(visibleWidth("e\u0301"), 1);
  assert.equal(visibleWidth("🙂"), 2);
  assert.equal(visibleWidth("🇨🇳"), 2);
  assert.equal(visibleWidth("👍🏽"), 2);
  assert.equal(visibleWidth("👨‍👩‍👧‍👦"), 2);
  assert.equal(visibleWidth("\u001b[31m中文\u001b[0m"), 4);
});

test("ANSI-aware wrapping and truncation never exceed the target width", () => {
  const styled = "\u001b[31mAlpha中文🙂Beta\u001b[0m";
  for (const line of wrapAnsiLine(styled, 6)) assert.ok(stringWidth(stripAnsi(line)) <= 6);
  const clipped = truncateAnsi(styled, 7);
  assert.ok(stringWidth(stripAnsi(clipped)) <= 7);
  assert.match(stripAnsi(clipped), /…$/);
});

test("ANSI-aware wrapping closes styles at every visual line boundary", () => {
  const lines = wrapAnsiLine("\u001b[31mabcdefghi", 3);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => /\u001b\[0m$/.test(line)));
});

test("long styled paragraphs keep bounded ANSI state while wrapping", async () => {
  const unit = "**x** ";
  const source = unit.repeat(Math.floor((240 * 1024) / unit.length));
  const rendered = await renderDocument(parseMarkdown(source), 80);
  const output = rendered.lines.join("\n");

  assert.ok(output.length < source.length * 8, `unexpected ANSI growth: ${output.length}`);
  assert.ok(rendered.lines.every((line) => visibleWidth(line) <= 80));
});

test("lexer extracts a stable h1-h3 TOC and sanitizes terminal controls", async () => {
  const source = await readFile(fixturePath, "utf8");
  const parsed = parseMarkdown(source);
  assert.equal(parsed.fallbackToPlainText, false);
  assert.ok(parsed.toc.some((entry) => entry.title === "中文表格"));
  assert.ok(parsed.toc.every((entry) => entry.level <= 3));
  assert.equal(sanitizeTerminalInput("safe\u001b]52;c;bad\u0007"), "safe�]52;c;bad�");
  assert.equal(parseMarkdown("# &#27;[2J\n").toc[0].title, "�[2J");
});

test("TOC text follows parsed inline heading content", () => {
  const parsed = parseMarkdown(
    "# <https://example.com>\n\n## A < B > C\n\n### `name_with_*_punctuation`\n",
  );
  assert.deepEqual(
    parsed.toc.map((entry) => entry.title),
    ["https://example.com", "A < B > C", "name_with_*_punctuation"],
  );
});

test("CJK strong boundaries render the real project-trust sentence without leaking stars", async () => {
  const source = [
    "**项目信任（project trust）**只是\"输入加载守卫\"：`.pi/` 下的扩展。**注意它不防 prompt injection**：……",
    "",
    "- **项目信任（project trust）**只是列表说明",
    "",
    "1. **项目信任（project trust）**只是有序说明",
    "",
    "| **项目信任（project trust）**只是 | 值 |",
    "| --- | --- |",
    "| **项目信任（project trust）**只是 | 1 |",
    "",
    "> **项目信任（project trust）**只是引用",
    "",
    "### **项目信任（project trust）**只是标题",
  ].join("\n");
  const rendered = await renderDocument(parseMarkdown(source), 100);
  const plain = stripAnsi(rendered.lines.join("\n"));
  assert.doesNotMatch(plain, /\*\*项目信任/);
  assert.match(rendered.lines.join("\n"), /\u001b\[1m项目信任（project trust）/);
});

test("CJK strong extension preserves escaped, literal-space, code and raw-HTML stars", async () => {
  const source = [
    "\\***示例）**中文",
    "**literal **中文",
    "`**code）**中文`",
    "<code>**HTML）**中文</code>",
  ].join("\n");
  const rendered = await renderDocument(parseMarkdown(source), 100);
  const plain = stripAnsi(rendered.lines.join("\n"));
  const native = new Marked({ gfm: true, breaks: false, pedantic: false }).lexer(source);
  assert.deepEqual(parseMarkdown(source).tokens, native);
  assert.match(plain, /\*\*\*示例）\*\*中文/);
  assert.match(plain, /\*\*literal \*\*中文/);
  assert.match(plain, /\*\*code）\*\*中文/);
  assert.match(plain, /<code>\*\*HTML）\*\*中文<\/code>/);
});

test("CJK strong tokenizer handles astral Han after the closing delimiter", async () => {
  const astralHan = String.fromCodePoint(0x20000);
  const source = `**项目信任）**${astralHan}之后`;
  const parsed = parseMarkdown(source);
  assert.equal(parsed.tokens[0].tokens[0].type, "strong");
  const rendered = await renderDocument(parsed, 20);
  const plain = stripAnsi(rendered.lines.join(""));
  assert.equal(plain, `项目信任）${astralHan}之后`);
  assert.ok(rendered.lines.every((line) => visibleWidth(line) <= 20));
  assert.doesNotMatch(rendered.lines.join("\n"), /\u001b\[1m\*\*/);
});

test("link metadata follows renderer link IDs rather than duplicate visible text", async () => {
  const rendered = await renderDocument(
    parseMarkdown("same (https://x.example) and [same](https://x.example) plus [中文](https://example.com/long/path)."),
    50,
  );
  assert.equal(rendered.links.length, 3);
  assert.ok(rendered.links[1].segments[0].startColumn >= 29);
  assert.ok(rendered.links[2].segments.every((segment) => segment.startColumn >= 0));
  assert.ok(rendered.links[2].segments.length >= 1);
  assert.equal(stripAnsi(rendered.lines.join("\n")).includes("https://x.example"), true);
});

test("demo renders every P0 element and tables stay aligned", async () => {
  const source = await readFile(fixturePath, "utf8");
  const parsed = parseMarkdown(source);
  const rendered = await renderDocument(parsed, 52);
  const plain = stripAnsi(rendered.lines.join("\n"));

  assert.match(plain, /mdterm 演示文档/);
  assert.match(plain, /\[x\] 已完成任务/);
  assert.match(plain, /3\. 从三开始/);
  assert.match(plain, /▎/);
  assert.match(plain, /项目主页 \(https:\/\/example\.com\/mdterm\)/);
  assert.match(plain, /🖼 \[终端里的风景\]/);
  assert.match(plain, /┌.*┐/);
  assert.match(plain, /└.*┘/);

  for (const line of rendered.lines) {
    assert.ok(visibleWidth(line) <= 52, `overwide line (${visibleWidth(line)}): ${stripAnsi(line)}`);
  }

  const tableLines = rendered.lines.filter((line) => /[┌├└│]/.test(stripAnsi(line)));
  assert.ok(tableLines.length >= 5);
  for (const line of tableLines) assert.ok(visibleWidth(line) <= 52);
});

test("a Chinese table has identical physical row widths at narrow sizes", async () => {
  const source = "| 中文 | English | 表情 |\n| --- | ---: | :---: |\n| 上海 | a very long value | 🙂 |\n| 成都 | 42 | é |\n";
  for (const width of [24, 40, 80]) {
    const rendered = await renderDocument(parseMarkdown(source), width);
    const table = rendered.lines.filter((line) => /[┌├└│]/.test(stripAnsi(line)));
    assert.ok(table.length >= 5);
    assert.equal(new Set(table.map(visibleWidth)).size, 1);
    assert.ok(table.every((line) => visibleWidth(line) <= width));
  }
});

test("truncated table links keep only the visible fragment hitbox", async () => {
  const source = [
    "| Link | Value |",
    "| --- | --- |",
    "| [very very very long link label](https://a.example/path) | after |",
    "| plain next row | after |",
  ].join("\n");
  const rendered = await renderDocument(parseMarkdown(source), 24);
  const plain = rendered.lines.map((line) => stripAnsi(line));
  assert.equal(rendered.links.length, 1);
  assert.equal(rendered.links[0].href, "https://a.example/path");
  assert.deepEqual(rendered.links[0].segments, [{ line: 3, startColumn: 2, endColumn: 14 }]);
  assert.match(plain[3], /…/u);
  assert.ok(rendered.links[0].segments.every((segment) => segment.line === 3));
  assert.ok(rendered.links[0].segments.every((segment) => segment.endColumn < visibleWidth(plain[3]) - 1));
  assert.equal(rendered.links.some((link) => link.segments.some((segment) => segment.line >= 4)), false);
});

test("77-column tables keep every visible column readable instead of starving short columns", async () => {
  const source =
    "| 术语 | 一句话解释 | 安卓/iOS 里的近似物 |\n" +
    "| --- | --- | --- |\n" +
    "| HarmonyOS NEXT / 纯血鸿蒙 | 不含 AOSP 代码、只跑鸿蒙原生应用 | —— |\n";
  const rendered = await renderDocument(parseMarkdown(source), 77);
  const borders = rendered.lines.filter((line) => /^[┌├└]/u.test(stripAnsi(line)));
  const top = stripAnsi(borders[0]);
  const widths = top
    .slice(1, -1)
    .split("┬")
    .map((part) => part.length - 2);
  assert.equal(widths.length, 3);
  assert.ok(widths.every((width) => width >= 8), widths.join(","));
  assert.ok(Math.max(...widths) - Math.min(...widths) < 30, widths.join(","));
  assert.ok(rendered.lines.every((line) => visibleWidth(line) <= 77));
});

test("narrow list and quote continuations retain their structural prefixes", async () => {
  const list = stripAnsi(
    (await renderDocument(parseMarkdown("- 这是一个很长的中文列表项目，需要换行显示。\n"), 20)).lines.join("\n"),
  ).split("\n");
  assert.ok(list.length > 1);
  assert.match(list[0], /^• /u);
  assert.ok(list.slice(1).every((line) => /^  /u.test(line)), list.join("\n"));

  const quote = stripAnsi(
    (await renderDocument(parseMarkdown("> 这是一个很长的中文引用内容，需要换行显示。\n"), 20)).lines.join("\n"),
  ).split("\n");
  assert.ok(quote.length > 1);
  assert.ok(quote.every((line) => /^▎ /u.test(line)), quote.join("\n"));
});

test("list items render every supported inline token without leaking Markdown markers", async () => {
  const source =
    "- **粗体** *斜体* ~~删除~~ `代码` [链接](https://example.com) ![图片](image.png)\n" +
    "  - 子项 **仍然加粗**\n" +
    "1. [有序链接](https://ordered.example)\n" +
    "- [ ] 未完成任务\n" +
    "- [x] 已完成任务\n";
  const rendered = await renderDocument(parseMarkdown(source), 80);
  const plain = stripAnsi(rendered.lines.join("\n"));
  assert.doesNotMatch(plain, /\*\*|`代码`|\[链接\]\(/);
  assert.match(plain, /粗体/);
  assert.match(plain, /代码/);
  assert.match(plain, /链接 \(https:\/\/example\.com\)/);
  assert.match(plain, /🖼 \[图片\]/);
  assert.match(plain, /子项 仍然加粗/);
  assert.match(rendered.lines.join("\n"), /\u001b\[1m/);
  assert.match(plain, /• \[ \] 未完成任务/);
  assert.match(plain, /1\. 有序链接/);
});

test("tight nested lists have no blank hole while loose lists keep paragraph separation", async () => {
  const tight = stripAnsi(
    (await renderDocument(parseMarkdown("- parent\n  - child\n  - child 2\n"), 50)).lines.join("\n"),
  ).split("\n");
  assert.deepEqual(tight.filter((line) => line.trim() === ""), []);
  assert.deepEqual(tight.slice(0, 3), ["• parent", "  • child", "  • child 2"]);

  const loose = stripAnsi(
    (await renderDocument(parseMarkdown("- first paragraph\n\n  second paragraph\n- next\n"), 50)).lines.join("\n"),
  ).split("\n");
  assert.ok(loose.some((line) => line.trim() === ""), loose.join("\n"));
  assert.match(loose.join("\n"), /• first paragraph[\s\S]*second paragraph/);
});

test("long code lines are lossless after ANSI-aware soft wrapping", async () => {
  const logical = "const 命令 = '0123456789abcdefghijklmnopqrstuvwxyz中文🙂'; // tail";
  const fence = String.fromCharCode(96).repeat(3);
  const rendered = await renderDocument(parseMarkdown(fence + "\n" + logical + "\n" + fence + "\n"), 22);
  const fragments = rendered.lines
    .map(stripAnsi)
    .filter((line) => line.startsWith("│ "))
    .map((line) => line.slice(2, -2).replace(/ +$/u, ""));
  assert.equal(fragments.join(""), logical);
  assert.ok(rendered.lines.every((line) => visibleWidth(line) <= 22));
  assert.doesNotMatch(fragments.join(""), /…/);
});

test("all Unicode grapheme clusters stay atomic during narrow wrapping", () => {
  const clusters = ["🇨🇳", "👍🏽", "👨‍👩‍👧‍👦", "e\u0301", "中文"];
  for (const cluster of clusters) {
    const wrapped = wrapAnsiLine(`A${cluster}B`, 3).map(stripAnsi).join("");
    assert.equal(wrapped, `A${cluster}B`, cluster);
  }
});

test("mixed ASCII and Unicode fallback lines preserve grapheme boundaries", async () => {
  const clusters = ["e\u0301", "1\uFE0F\u20E3", "👨‍👩‍👧‍👦", "🇨🇳", "👍🏽", "中文"];
  const logical = `${"A".repeat(520 * 1024)}${clusters.join("")}tail`;
  const parsed = parseMarkdown(logical);
  assert.equal(parsed.fallbackToPlainText, true);

  const rendered = await renderDocument(parsed, 37);
  assert.equal(rendered.lines.join(""), logical);
  assert.ok(rendered.lines.every((line) => visibleWidth(line) <= 37));

  // The fixture is deliberately assembled from a known ASCII prefix/tail and
  // explicit grapheme clusters. Treat every ASCII code-unit boundary as legal
  // and add only the ends of the explicit clusters, avoiding a second
  // full-document Intl.Segmenter pass in Node 18.
  const asciiPrefix = 520 * 1024;
  const clusterEnds = new Set();
  let clusterOffset = asciiPrefix;
  for (const cluster of clusters) {
    clusterOffset += cluster.length;
    clusterEnds.add(clusterOffset);
  }
  let offset = 0;
  for (const line of rendered.lines) {
    offset += line.length;
    const isBoundary = offset <= asciiPrefix || offset >= clusterOffset || clusterEnds.has(offset);
    assert.ok(isBoundary, `line ended inside a grapheme at UTF-16 offset ${offset}`);
  }
});

test("large CJK fallback stays bounded and preserves complex Unicode boundaries", async () => {
  for (const size of [512 * 1024, 1024 * 1024]) {
    const logical = "中".repeat(size);
    const started = process.hrtime.bigint();
    const rendered = await renderDocument(parseMarkdown(logical), 80, { yieldIntervalMs: 12 });
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(rendered.lines.join(""), logical);
    assert.ok(rendered.lines.every((line) => visibleWidth(line) <= 80));
    assert.ok(elapsedMs < 2_000, `${size} bytes took ${elapsedMs.toFixed(1)}ms`);
  }

  const clusters = ["e\u0301", "1\uFE0F\u20E3", "👨‍👩‍👧‍👦", "🇨🇳", "👍🏽"];
  const logical = "中".repeat(4090) + clusters.join("") + "尾";
  const rendered = await renderDocument(parseMarkdown(logical), 37, { yieldIntervalMs: 12 });
  assert.equal(stripAnsi(rendered.lines.join("")), logical);
  assert.ok(rendered.lines.every((line) => visibleWidth(line) <= 37));

  const extensionHan = String.fromCodePoint(0x20000);
  const extensionLogical = "中".repeat(5) + extensionHan + "中".repeat(5) + extensionHan + "尾";
  const extensionRendered = await renderDocument(parseMarkdown(extensionLogical), 12, { yieldIntervalMs: 12 });
  const extensionVisible = extensionRendered.lines.map(stripAnsi).join("");
  assert.equal(extensionVisible, extensionLogical);
  assert.ok(extensionRendered.lines.every((line) => visibleWidth(line) <= 12));
  for (const line of extensionRendered.lines) {
    for (let index = 0; index < line.length; index += 1) {
      const code = line.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        assert.ok(index + 1 < line.length && line.charCodeAt(index + 1) >= 0xdc00 && line.charCodeAt(index + 1) <= 0xdfff);
        index += 1;
      } else {
        assert.ok(code < 0xdc00 || code > 0xdfff, `isolated low surrogate at ${index}`);
      }
    }
  }

  const hangulJamo = "\u1100\u1161\u11a8";
  const hangulLogical = "中".repeat(5) + hangulJamo + "尾";
  const hangulRendered = await renderDocument(parseMarkdown(hangulLogical), 12, { yieldIntervalMs: 12 });
  assert.equal(stripAnsi(hangulRendered.lines.join("")), hangulLogical);
  assert.ok(hangulRendered.lines.some((line) => stripAnsi(line).includes(hangulJamo)));
  assert.ok(hangulRendered.lines.every((line) => visibleWidth(line) <= 12));

  // A single pathological ZWJ chain must not make carry grow without bound.
  // The renderer preserves ordinary clusters and applies a documented safety
  // cut only after the 4 KiB carry cap is exceeded.
  const unit = "👩‍";
  const repeats = Math.ceil((10 * 1024 * 1024) / Buffer.byteLength(unit));
  const pathological = unit.repeat(repeats) + "👩";
  const pathologicalStart = process.hrtime.bigint();
  const pathologicalRendered = await renderDocument(parseMarkdown(pathological), 80, { yieldIntervalMs: 12 });
  const pathologicalMs = Number(process.hrtime.bigint() - pathologicalStart) / 1e6;
  assert.ok(pathologicalRendered.lines.length > 0);
  assert.equal(stripAnsi(pathologicalRendered.lines.join("")), pathological);
  assert.ok(pathologicalRendered.lines.every((line) => visibleWidth(line) <= 80));
  assert.ok(pathologicalMs < 5_000, `pathological grapheme chain took ${pathologicalMs.toFixed(1)}ms`);
});

test("narrow code blocks preserve complex emoji/CJK lines for no, known and unknown languages", async () => {
  const logical = "const family='👨‍👩‍👧‍👦'; const flag='🇨🇳'; const skin='👍🏽'; const 中文='尾部';";
  const fence = String.fromCharCode(96).repeat(3);
  for (const language of ["", "js", "not-a-real-language"]) {
    const info = language ? language : "";
    const source = `${fence}${info}\n${logical}\n${fence}\n`;
    const rendered = await renderDocument(parseMarkdown(source), 22);
    const plain = rendered.lines.map(stripAnsi);
    const body = plain
      .filter((line) => line.startsWith("│ ") && line.endsWith(" │"))
      .map((line) => line.slice(2, -2).replace(/ +$/u, ""));
    assert.equal(body.join(""), logical, language || "no-language");
    assert.ok(rendered.lines.every((line) => visibleWidth(line) <= 22), language || "no-language");
    assert.ok(
      plain.filter((line) => line.startsWith("│ ")).every((line) => line.endsWith(" │")),
      language || "no-language",
    );
  }
});

test("tables with complex emoji, CJK and ANSI remain physically aligned at release widths", async () => {
  const source =
    "| 名称 | 说明 | 样式内容 |\n" +
    "| --- | --- | --- |\n" +
    "| 🇨🇳 中国 | 家庭 👨‍👩‍👧‍👦 与肤色 👍🏽 | **粗体中文** |\n" +
    "| é 组合 | `inline 🇨🇳` | *斜体* 与 CJK |\n";
  for (const width of [24, 40, 52, 77, 160]) {
    const rendered = await renderDocument(parseMarkdown(source), width);
    const table = rendered.lines.filter((line) => /^[┌├└│]/u.test(stripAnsi(line)));
    assert.ok(table.length >= 5, `${width}: missing table`);
    assert.equal(new Set(table.map(visibleWidth)).size, 1, `${width}: uneven table borders`);
    assert.ok(table.every((line) => visibleWidth(line) <= width), `${width}: overwide table`);
  }
});

test("24-column four-column tables hide a column instead of keeping ellipsis-only content columns", async () => {
  const source =
    "| 定位 | 类型 | 关键能力 | 备注 |\n" +
    "| --- | --- | --- | --- |\n" +
    "| 核心入口 | 组件 | 中文 CJK 与 🇨🇳 | 长文本说明 |\n" +
    "| 后台服务 | 扩展 | 家庭 👨‍👩‍👧‍👦 | 👍🏽 |\n";
  for (const width of [24, 40, 52, 77, 160]) {
    const rendered = await renderDocument(parseMarkdown(source), width);
    const plain = rendered.lines.map(stripAnsi);
    const table = plain.filter((line) => /^[┌├└│]/u.test(line));
    assert.ok(table.length >= 6, `${width}: missing four-column table`);
    assert.equal(new Set(table.map(visibleWidth)).size, 1, `${width}: uneven borders`);
    assert.ok(table.every((line) => visibleWidth(line) <= width), `${width}: overwide table`);
    if (width === 24) {
      const header = table.find((line) => line.startsWith("│") && line.includes("定位"));
      assert.ok(header, "24: missing readable header");
      const cells = header.split("│").slice(1, -1).map((cell) => cell.trim());
      assert.ok(cells.length < 4, cells.join(" | "));
      assert.equal(cells.at(-1), "…");
      assert.ok(cells.slice(0, -1).every((cell) => cell !== "…"), cells.join(" | "));
    }
  }
});

test("large documents keep TOC anchors in lightweight rendering", async () => {
  const source = `# 第一章\n${"中文内容 ".repeat(70_000)}\n## 第二章\n结尾`;
  const parsed = parseMarkdown(source);
  assert.equal(parsed.largeDocument, true);
  assert.deepEqual(parsed.toc.map((entry) => entry.title), ["第一章", "第二章"]);
  const rendered = await renderDocument(parsed, 40, { yieldIntervalMs: 2 });
  assert.ok(rendered.headingLines[1] > rendered.headingLines[0]);
  assert.ok(rendered.lines.every((line) => visibleWidth(line) <= 40));
});

test("large-document TOC is bounded for heading-heavy input", () => {
  const parsed = parseMarkdown("# a\n".repeat(150_000));
  assert.equal(parsed.largeDocument, true);
  assert.equal(parsed.toc.length, 2_000);

  const fenced = parseMarkdown(`\`\`\`md\n# fake\n\`\`\`\n# real\n${"x".repeat(600_000)}`);
  assert.deepEqual(fenced.toc.map((entry) => entry.title), ["real"]);
});

test("large rendering yields to cancellation", async () => {
  const parsed = parseMarkdown("a".repeat(1024 * 1024));
  let cancelled = false;
  setImmediate(() => {
    cancelled = true;
  });
  const rendered = await renderDocument(parsed, 80, {
    isCancelled: () => cancelled,
    yieldIntervalMs: 0,
  });
  assert.ok(rendered.lines.length < 1_000, `render did not stop early: ${rendered.lines.length}`);
});

test("10 MiB dense markup and 1 MiB code stay bounded on a 256 MiB heap", () => {
  const script = String.raw`
    const { parseMarkdown } = require('./dist/markdown/parse.js');
    const { renderDocument, visibleWidth } = require('./dist/markdown/render.js');
    (async () => {
      const denseUnit = '**x** ';
      const chunk = denseUnit.repeat(Math.ceil(((10 * 1024 * 1024) / 3) / denseUnit.length));
      const dense = '# start\n' + chunk + '\n## middle\n' + chunk + '\n### end\n' + chunk + '中文';
      const codeLine = 'const value = 123; // 中文\n';
      const code = '\`\`\`js\n# fake heading\n' + codeLine.repeat(Math.ceil((1024 * 1024) / codeLine.length)) + '\`\`\`\n';
      const results = [];
      for (const source of [dense, code]) {
        const parsed = parseMarkdown(source);
        const wide = await renderDocument(parsed, 80, { yieldIntervalMs: 4 });
        const narrow = await renderDocument(parsed, 37, { yieldIntervalMs: 4 });
        const increasing = (values) => values.every((value, index) => index === 0 || value > values[index - 1]);
        results.push({
          large: parsed.largeDocument,
          toc: parsed.toc.map((entry) => entry.title),
          lines: [wide.lines.length, narrow.lines.length],
          widths: [
            wide.lines.reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 0),
            narrow.lines.reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 0),
          ],
          anchors: increasing(wide.headingLines) && increasing(narrow.headingLines),
        });
      }
      process.stdout.write(JSON.stringify(results));
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `;
  const child = spawnSync(process.execPath, ["--max-old-space-size=256", "-e", script], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  const results = JSON.parse(child.stdout);
  assert.ok(results.every((result) => result.large && result.lines.every((count) => count > 0)));
  assert.deepEqual(results[0].toc, ["start", "middle", "end"]);
  assert.deepEqual(results[1].toc, []);
  assert.equal(results[0].anchors, true);
  assert.ok(results.every((result) => result.widths[0] <= 80 && result.widths[1] <= 37));
});

test("re-rendering does not mutate task-list tokens", async () => {
  const parsed = parseMarkdown("- [ ] task\n- [x] done\n");
  const first = stripAnsi((await renderDocument(parsed, 40)).lines.join("\n"));
  const second = stripAnsi((await renderDocument(parsed, 40)).lines.join("\n"));
  assert.equal(second, first);
  assert.equal((second.match(/\[ \]/g) ?? []).length, 1);
});

test("empty and malformed documents render without throwing", async () => {
  const empty = await renderDocument(parseMarkdown(""), 40);
  assert.match(stripAnsi(empty.lines.join("\n")), /\(empty document\)/);
  const chineseEmpty = await renderDocument(parseMarkdown("", "zh-CN"), 40, { locale: "zh-CN" });
  assert.match(stripAnsi(chineseEmpty.lines.join("\n")), /空文档/);
  const malformed = await renderDocument(parseMarkdown("# [broken\n```js\nconst x = 1"), 40);
  assert.ok(malformed.lines.length > 0);
});

test("unlabelled fenced code uses the active locale label", async () => {
  const source = "```\nconst value = 1;\n```\n";
  const english = await renderDocument(parseMarkdown(source, "en"), 40, { locale: "en" });
  const chinese = await renderDocument(parseMarkdown(source, "zh-CN"), 40, { locale: "zh-CN" });
  assert.match(stripAnsi(english.lines.join("\n")), /─ Code /);
  assert.match(stripAnsi(chinese.lines.join("\n")), /─ 代码 /);
});

test("nested list and blockquote fenced code expose clean copy metadata", async () => {
  const source = [
    "- item",
    "",
    "  ```js",
    "  const listValue = 1;  ",
    "  ```",
    "",
    "> quote",
    ">",
    "> ```",
    "> const quoteValue = 2;  ",
    "> ```",
    "",
  ].join("\n");
  const rendered = await renderDocument(parseMarkdown(source), 60);
  assert.equal(rendered.codeBlocks.length, 2);
  assert.deepEqual(
    rendered.codeBlocks.map((block) => ({ source: block.source, language: block.language })),
    [
      { source: "const listValue = 1;  ", language: "js" },
      { source: "const quoteValue = 2;  ", language: "" },
    ],
  );
  for (const block of rendered.codeBlocks) {
    assert.ok(block.startLine <= block.endLine);
    assert.ok(block.endLine < rendered.lines.length);
  }
  const visible = stripAnsi(rendered.lines.join("\n"));
  assert.match(visible, /• item/);
  assert.match(visible, /▎ quote/);
  assert.doesNotMatch(visible, /mdterm-(?:code|link)/);
  assert.doesNotMatch(rendered.lines.join("\n"), /\u001b\]998;mdterm-code:/);
});
