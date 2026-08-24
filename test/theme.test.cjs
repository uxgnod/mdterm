const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const stripAnsi = require("strip-ansi");

const { ansiForTheme, contrastRatio, readingThemes, resolveReadingTheme, searchStyleForTheme } = require("../dist/theme.js");
const { openExternalUrl, validateExternalUrl } = require("../dist/ui/links.js");
const { parseMarkdown } = require("../dist/markdown/parse.js");
const { renderDocument } = require("../dist/markdown/render.js");

test("0.4 exposes only dark and terminal backgrounds", () => {
  assert.deepEqual(Object.keys(readingThemes).sort(), ["dark", "terminal"]);
  assert.equal(resolveReadingTheme("dark").label, "Background: Dark");
  assert.equal(resolveReadingTheme("terminal").label, "Background: Terminal");
  assert.equal(contrastRatio("white", "black") >= 4.5, true);
  assert.equal(contrastRatio("white", "default"), undefined);
});

test("dark and terminal inline code never use a white background", async () => {
  for (const mode of ["dark", "terminal"]) {
    const rendered = await renderDocument(parseMarkdown("text `inline`."), 80, { theme: resolveReadingTheme(mode) });
    assert.match(stripAnsi(rendered.lines.join("\n")), /text inline\./);
    assert.doesNotMatch(rendered.lines.join("\n"), /\u001b\[[0-9;]*47m/);
  }
});

test("terminal current search matches remain bright and outlined without inverse or background", () => {
  const style = searchStyleForTheme(resolveReadingTheme("terminal"));
  assert.match(style.currentOpen, /\u001b\[1;4;53m/);
  assert.doesNotMatch(style.currentOpen, /97/);
  assert.doesNotMatch(style.currentOpen, /\u001b\[7m|\u001b\[[0-9;]*(?:4[0-9]|10[0-9])m/);
  assert.doesNotMatch(style.currentClose, /39m/);
});

test("external URL validation is http/https only and rejects unsafe forms", () => {
  assert.equal(validateExternalUrl("https://example.com/a?q=1"), "https://example.com/a?q=1");
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///tmp/x",
    "/relative/path",
    "https://user:pass@example.com/",
    "https://example.com/with space",
    "https://example.com/\u0007",
    `https://example.com/${"x".repeat(2048)}`,
  ]) assert.equal(validateExternalUrl(value), undefined, value);
});

test("opener uses an argument array, shell:false and handles async spawn errors", async () => {
  const calls = [];
  const child = new EventEmitter();
  child.unref = () => undefined;
  const opened = openExternalUrl("https://example.com", {
    platform: "linux",
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      setImmediate(() => child.emit("spawn"));
      return child;
    },
  });
  assert.equal(await opened, true);
  assert.deepEqual(calls[0].args, ["https://example.com/"]);
  assert.equal(calls[0].options.shell, false);

  const failed = new EventEmitter();
  failed.unref = () => undefined;
  const rejected = openExternalUrl("https://example.com", {
    spawnProcess: () => {
      setImmediate(() => failed.emit("error", new Error("missing opener")));
      return failed;
    },
  });
  assert.equal(await rejected, false);
});
