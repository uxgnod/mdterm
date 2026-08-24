const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const blessed = require("neo-blessed");

const { resolveReadingTheme } = require("../dist/theme.js");
const { LanguageModal } = require("../dist/ui/language.js");

test("language modal applies the item activated by a mouse click", () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const screen = blessed.screen({ input, output, terminal: "xterm-256color", mouse: false, warnings: false });
  let applied;
  const modal = new LanguageModal({
    screen,
    locale: "en",
    theme: resolveReadingTheme("dark"),
    mouse: true,
    onApply: (locale) => { applied = locale; },
  });
  try {
    modal.show();
    const item = modal.list.items[1];
    assert.ok(item);
    modal.list.emit("element click", item);
    assert.equal(applied, "zh-CN");
    assert.equal(modal.isVisible(), false);
  } finally {
    screen.destroy();
  }
});
