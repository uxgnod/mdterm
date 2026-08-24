const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const test = require("node:test");
const blessed = require("neo-blessed");

const { ContentView } = require("../dist/ui/content.js");
const { resolveReadingTheme } = require("../dist/theme.js");

function visibleContent(value) {
  return value.replace(/\u0003/g, "");
}

function makeContent(onCopyCode) {
  const input = new PassThrough();
  const output = new PassThrough();
  const screen = blessed.screen({
    input,
    output,
    terminal: "xterm-256color",
    smartCSR: false,
    fullUnicode: true,
    mouse: false,
    warnings: false,
  });
  screen.program.cols = 80;
  screen.program.rows = 24;
  screen.width = 80;
  screen.height = 24;
  const content = new ContentView({
    screen,
    mouse: true,
    left: 0,
    theme: resolveReadingTheme("dark"),
    onCopyCode,
  });
  content.setDocument({
    lines: ["const value = 1", "", ""],
    headingLines: [],
    width: 76,
    links: [],
    codeBlocks: [{ startLine: 0, endLine: 2, source: "const value = 1", language: "js" }],
  });
  screen.render();
  content.renderLines();
  const hitbox = content.codeCopyHitboxes[0];
  assert.ok(hitbox, "code button hitbox must be present");
  return { screen, content, hitbox };
}

function clickCodeButton(screen, hitbox) {
  screen.emit("mouse", { action: "mousedown", button: "left", x: hitbox.left, y: hitbox.top });
  screen.emit("mouse", { action: "mouseup", button: "left", x: hitbox.left, y: hitbox.top });
}

test("link release requires the same hitbox, primary button and modifier", () => {
  const opened = [];
  const input = new PassThrough();
  const output = new PassThrough();
  const screen = blessed.screen({
    input,
    output,
    terminal: "xterm-256color",
    smartCSR: false,
    fullUnicode: true,
    mouse: false,
    warnings: false,
  });
  screen.program.cols = 80;
  screen.program.rows = 24;
  screen.width = 80;
  screen.height = 24;
  const content = new ContentView({
    screen,
    mouse: true,
    left: 0,
    theme: resolveReadingTheme("dark"),
    onOpenLink: (href) => opened.push(href),
  });
  content.setDocument({
    lines: ["Open link", "Other link", ""],
    headingLines: [],
    width: 76,
    links: [
      { href: "https://one.example", segments: [{ line: 0, startColumn: 0, endColumn: 4 }] },
      { href: "https://two.example", segments: [{ line: 1, startColumn: 0, endColumn: 5 }] },
    ],
    codeBlocks: [],
  });
  screen.render();
  content.renderLines();
  const first = content.linkHitboxes[0];
  const second = content.linkHitboxes[1];
  assert.ok(first);
  assert.ok(second);
  const point = (hitbox) => ({ x: hitbox.left, y: hitbox.top });
  try {
    const firstPoint = point(first);
    const secondPoint = point(second);
    screen.emit("mouse", { action: "mousedown", button: "left", ctrl: true, ...firstPoint });
    screen.emit("mouse", { action: "mouseup", button: "right", ctrl: true, ...firstPoint });
    screen.emit("mouse", { action: "mousedown", button: "left", ctrl: true, ...firstPoint });
    screen.emit("mouse", { action: "mouseup", button: "middle", meta: true, ...firstPoint });
    assert.deepEqual(opened, [], "modifier right/middle release must not open a link");

    screen.emit("mouse", { action: "mousedown", button: "left", ctrl: true, ...firstPoint });
    screen.emit("mouse", { action: "mouseup", button: "left", ctrl: true, ...secondPoint });
    assert.deepEqual(opened, [], "release on a different link must cancel");

    screen.emit("mouse", { action: "mousedown", button: "left", ctrl: true, ...firstPoint });
    screen.emit("mouse", { action: "mouseup", button: "left", ctrl: true, ...firstPoint });
    screen.emit("mouse", { action: "mouseup", button: "left", ctrl: true, ...firstPoint });
    assert.deepEqual(opened, ["https://one.example"], "same-link primary release opens exactly once");
  } finally {
    content.dispose();
    screen.destroy();
  }
});

test("code feedback renders each real result kind with color and restores after 2 seconds", async () => {
  const cases = [
    ["copied", "[Copied]", "green"],
    ["request-sent", "[Sent]", "yellow"],
    ["failed", "[Failed]", "red"],
  ];
  for (const [kind, label, color] of cases) {
    const { screen, content, hitbox } = makeContent(() => ({ kind }));
    try {
      clickCodeButton(screen, hitbox);
      const button = content.codeCopyButtons.get(0);
      assert.ok(button);
      assert.equal(button.getContent(), label);
      assert.equal(button.style.fg, color);
      await new Promise((resolve) => setTimeout(resolve, 2_050));
      assert.equal(button.getContent(), "[Copy]");
      assert.equal(button.style.fg, "white");
    } finally {
      content.dispose();
      screen.destroy();
    }
  }
});

test("code copy button idle hover uses the bright accent without changing its hitbox", () => {
  const { screen, content, hitbox } = makeContent(() => ({ kind: "copied" }));
  try {
    const idle = content.codeCopyButtons.get(0);
    assert.ok(idle);
    assert.equal(idle.style.fg, "white");
    screen.emit("mouse", { action: "mousemove", x: hitbox.left, y: hitbox.top });
    assert.equal(idle.style.fg, "light-cyan");
    assert.equal(idle.style.bold, true);
    assert.equal(idle.style.underline, true);
    assert.equal(content.codeCopyHitboxes[0].left, hitbox.left);
    assert.equal(content.codeCopyHitboxes[0].top, hitbox.top);
  } finally {
    content.dispose();
    screen.destroy();
  }
});

test("code feedback stores a result kind across locale changes and dispose clears its timer", async () => {
  const { screen, content, hitbox } = makeContent(() => ({ kind: "copied" }));
  let renders = 0;
  const originalRender = screen.render.bind(screen);
  screen.render = (...args) => {
    renders += 1;
    return originalRender(...args);
  };
  try {
    clickCodeButton(screen, hitbox);
    const button = content.codeCopyButtons.get(0);
    assert.ok(button);
    content.setLocale("zh-CN");
    assert.equal(visibleContent(button.getContent()), "[已复制]");
    const rendersBeforeDispose = renders;
    content.dispose();
    await new Promise((resolve) => setTimeout(resolve, 2_050));
    assert.equal(visibleContent(button.getContent()), "[已复制]");
    assert.equal(renders, rendersBeforeDispose, "dispose must prevent the feedback timer from rendering after shutdown");
  } finally {
    screen.destroy();
  }
});

test("repeated code clicks reset the 2-second feedback timer", async () => {
  const { screen, content, hitbox } = makeContent(() => ({ kind: "failed" }));
  try {
    clickCodeButton(screen, hitbox);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    clickCodeButton(screen, hitbox);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const button = content.codeCopyButtons.get(0);
    assert.ok(button);
    assert.equal(visibleContent(button.getContent()), "[Failed]");
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    assert.equal(visibleContent(button.getContent()), "[Copy]");
  } finally {
    content.dispose();
    screen.destroy();
  }
});
