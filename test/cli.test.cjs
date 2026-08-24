const assert = require("node:assert/strict");
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const cli = path.join(__dirname, "..", "dist", "cli.js");

function run(args, home = mkdtempSync(path.join(os.tmpdir(), "mdterm-cli-home-"))) {
  try {
    return runInHome(home, args);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runInHome(home, args, entry = cli) {
  return spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

test("help and version are friendly and successful", () => {
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /md <file\.md>/);
  assert.match(help.stdout, /mdview <file\.md>/);
  assert.match(help.stdout, /Options:/);
  assert.match(help.stdout, /Disable application mouse input/);
  assert.doesNotMatch(help.stdout, /用法|禁用鼠标/);
  assert.equal(help.stderr, "");

  const version = run(["--version"]);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^0\.5\.0\n$/);

  const chinese = run(["--lang", "zh-CN", "--help"]);
  assert.equal(chinese.status, 0);
  assert.match(chinese.stdout, /用法:/);
  assert.match(chinese.stdout, /禁用应用鼠标输入/);
  assert.doesNotMatch(chinese.stdout, /Options:/);
});

test("missing arguments and bad paths exit 1 without a stack", () => {
  const missing = run([]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /A Markdown file is required/);
  assert.doesNotMatch(missing.stderr, /\n\s+at /);

  const absent = run(["definitely-does-not-exist.md"]);
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /File not found/);
  assert.doesNotMatch(absent.stderr, /\n\s+at /);

  const directory = run([__dirname]);
  assert.equal(directory.status, 1);
  assert.match(directory.stderr, /Path is not a file/);
});

test("config language is the default, explicit --lang is one-shot, and no-mouse help hides actions", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mdterm-cli-config-home-"));
  const configDirectory = path.join(home, ".config", "mdterm");
  require("node:fs").mkdirSync(configDirectory, { recursive: true });
  const configFile = path.join(configDirectory, "config.json");
  writeFileSync(configFile, JSON.stringify({ language: "zh-CN", background: "dark", selectionMode: "manual" }));
  try {
    const configured = runInHome(home, ["--help"]);
    assert.match(configured.stdout, /用法:/);
    const oneShot = runInHome(home, ["--lang", "en", "--no-mouse", "--help"]);
    assert.match(oneShot.stdout, /Usage:/);
    assert.doesNotMatch(oneShot.stdout, /Text selection m|y\s+copy the current selection/);
    assert.match(oneShot.stdout, /terminal-native selection/);
    assert.equal(JSON.parse(readFileSync(configFile, "utf8")).language, "zh-CN");

    const mdview = runInHome(home, ["missing.md"], path.join(__dirname, "..", "dist", "mdview.js"));
    assert.match(mdview.stderr, /^mdview：文件不存在/u);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("CLI error interpolation cannot emit terminal control bytes in either locale", () => {
  const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
  for (const locale of ["en", "zh-CN"]) {
    const unknown = run(["--lang", locale, `--bad\u001b]52;c;evil\u0007\u009b`]);
    const unknownBody = unknown.stderr.replace(/[\r\n]+/gu, "");
    assert.equal(unknown.status, 1);
    assert.equal(controls.test(unknownBody), false, `${locale} unknown option leaked a control byte`);

    const pathResult = run(["--lang", locale, `missing\r\n\u001b]8;;https://evil.example\u0007.md`]);
    const pathBody = pathResult.stderr.replace(/[\r\n]+/gu, "");
    assert.equal(pathResult.status, 1);
    assert.equal(controls.test(pathBody), false, `${locale} path error leaked a control byte`);
    assert.match(pathBody, /U\+001B|U\+0007|U\+009B/);
  }
});

test("invalid UTF-8 is rejected and valid files reach the TTY check", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "mdterm-test-"));
  const invalid = path.join(temporary, "invalid.md");
  writeFileSync(invalid, Buffer.from([0xe2, 0x82]));
  const invalidResult = run([invalid]);
  assert.equal(invalidResult.status, 1);
  assert.match(invalidResult.stderr, /not valid UTF-8/);

  const valid = path.join(temporary, "valid.md");
  writeFileSync(valid, "# 中文\n", "utf8");
  const validResult = run(["--toc", valid, "--no-mouse"]);
  assert.equal(validResult.status, 1);
  assert.match(validResult.stderr, /interactive terminal/);
});

test("non-TTY errors use the actual md or mdview command name", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "mdterm-command-name-"));
  const file = path.join(temporary, "valid.md");
  writeFileSync(file, "# title\n", "utf8");
  try {
    for (const [commandName, entry] of [["md", cli], ["mdview", path.join(__dirname, "..", "dist", "mdview.js")]]) {
      const result = runInHome(temporary, [file], entry);
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`^${commandName}: ${commandName} must run in an interactive terminal\\.`));
    }
    for (const [commandName, entry] of [["md", cli], ["mdview", path.join(__dirname, "..", "dist", "mdview.js")]]) {
      const result = spawnSync(process.execPath, [entry, "--lang", "zh-CN", file], {
        encoding: "utf8",
        env: { ...process.env, HOME: temporary, USERPROFILE: temporary },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`^${commandName}：${commandName} 必须在交互式终端中运行。`));
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("an unreadable file gets a clear permission error", { skip: process.platform === "win32" }, () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "mdterm-permission-"));
  const unreadable = path.join(temporary, "unreadable.md");
  writeFileSync(unreadable, "# secret\n", "utf8");
  chmodSync(unreadable, 0o000);
  try {
    const result = run([unreadable]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Permission denied/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  } finally {
    chmodSync(unreadable, 0o600);
  }
});

test("package exposes both command names", () => {
  const packageJson = require("../package.json");
  assert.equal(packageJson.bin.md, "dist/cli.js");
  assert.equal(packageJson.bin.mdview, "dist/mdview.js");
});
