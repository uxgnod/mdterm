const assert = require("node:assert/strict");
const { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, truncateSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const { CONFIG_MAX_BYTES, ConfigStore, configPath, loadConfig } = require("../dist/config.js");

function temporaryHome() {
  return mkdtempSync(path.join(os.tmpdir(), "mdterm-config-"));
}

test("missing config creates private defaults in the requested temporary home", async () => {
  const home = temporaryHome();
  const loaded = await loadConfig(home);
  assert.deepEqual(loaded.preferences, { language: "en", background: "dark", selectionMode: "manual" });
  assert.equal(configPath(home), loaded.path);
  assert.deepEqual(JSON.parse(readFileSync(loaded.path, "utf8")), loaded.preferences);
});

test("valid config keeps unknown fields and serializes rapid changes atomically", async () => {
  const home = temporaryHome();
  const target = configPath(home);
  const directory = path.dirname(target);
  require("node:fs").mkdirSync(directory, { recursive: true });
  writeFileSync(target, JSON.stringify({ language: "zh-CN", background: "terminal", selectionMode: "auto", plugin: { keep: true } }));
  const loaded = await loadConfig(home);
  assert.deepEqual(loaded.preferences, { language: "zh-CN", background: "terminal", selectionMode: "auto" });
  await Promise.all([
    loaded.store.set("background", "dark"),
    loaded.store.set("selectionMode", "off"),
    loaded.store.set("language", "en"),
  ]);
  const saved = JSON.parse(readFileSync(target, "utf8"));
  assert.deepEqual(saved, { language: "en", background: "dark", selectionMode: "off", plugin: { keep: true } });
  assert.equal(readdirSync(directory).some((name) => name.includes(".tmp-")), false);
});

test("each queued preference patch merges the latest valid disk fields", async () => {
  const home = temporaryHome();
  const target = configPath(home);
  require("node:fs").mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ language: "en", background: "dark", selectionMode: "manual", plugin: { keep: true } }));
  const loaded = await loadConfig(home);
  writeFileSync(target, JSON.stringify({ language: "zh-CN", background: "dark", selectionMode: "manual", plugin: { changed: true } }));
  await loaded.store.set("background", "terminal");
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), {
    language: "zh-CN",
    background: "terminal",
    selectionMode: "manual",
    plugin: { changed: true },
  });
});

test("partial invalid fields fall back independently without discarding valid values", async () => {
  const home = temporaryHome();
  const target = configPath(home);
  require("node:fs").mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ language: "zh-CN", background: "light", selectionMode: "bad", keep: 7 }));
  const loaded = await loadConfig(home);
  assert.deepEqual(loaded.preferences, { language: "zh-CN", background: "dark", selectionMode: "manual" });
  assert.equal(loaded.issue, "invalid-values");
  await loaded.store.set("background", "terminal");
  assert.equal(JSON.parse(readFileSync(target, "utf8")).keep, 7);
});

test("all 12 legal preference combinations load without cross-field fallback", async () => {
  for (const language of ["en", "zh-CN"]) {
    for (const background of ["dark", "terminal"]) {
      for (const selectionMode of ["manual", "auto", "off"]) {
        const home = temporaryHome();
        const target = configPath(home);
        require("node:fs").mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, JSON.stringify({ language, background, selectionMode }));
        const loaded = await loadConfig(home);
        assert.deepEqual(loaded.preferences, { language, background, selectionMode });
      }
    }
  }
});

test("damaged and oversized config files are backed up before defaults are written", async () => {
  for (const contents of ["{broken", "[]", "x".repeat(CONFIG_MAX_BYTES + 1)]) {
    const home = temporaryHome();
    const target = configPath(home);
    require("node:fs").mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
    const loaded = await loadConfig(home);
    assert.equal(loaded.preferences.language, "en");
    assert.match(loaded.issue, /invalid/);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), loaded.preferences);
    assert.equal(readdirSync(path.dirname(target)).some((name) => name.startsWith("config.json.invalid-")), true);
  }
});

test("a sparse oversized config is rejected with bounded I/O", async () => {
  const home = temporaryHome();
  const target = configPath(home);
  require("node:fs").mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "");
  truncateSync(target, 1024 * 1024 * 1024);
  const started = Date.now();
  const loaded = await loadConfig(home);
  assert.ok(Date.now() - started < 1000);
  assert.equal(loaded.issue, "invalid");
  assert.equal(readdirSync(path.dirname(target)).some((name) => name.startsWith("config.json.invalid-")), true);
});

test("runtime damage is backed up before a patch is written", async () => {
  const home = temporaryHome();
  const target = configPath(home);
  require("node:fs").mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ language: "zh-CN", background: "dark", selectionMode: "manual" }));
  const loaded = await loadConfig(home);
  writeFileSync(target, "{broken");
  const result = await loaded.store.set("background", "terminal");
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), {
    language: "zh-CN",
    background: "terminal",
    selectionMode: "manual",
  });
  assert.equal(readdirSync(path.dirname(target)).some((name) => name.startsWith("config.json.invalid-")), true);
});

test("a failed config read or backup never overwrites the existing target", { skip: process.platform === "win32" }, async () => {
  const home = temporaryHome();
  const target = configPath(home);
  require("node:fs").mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ language: "en", background: "dark", selectionMode: "manual" }));
  chmodSync(target, 0o000);
  try {
    const store = new ConfigStore(target, { language: "en", background: "dark", selectionMode: "manual" });
    const result = await store.set("background", "terminal");
    assert.equal(result.ok, false);
  } finally {
    chmodSync(target, 0o600);
  }
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { language: "en", background: "dark", selectionMode: "manual" });

  const backupBlocked = await new ConfigStore("/dev/null", { language: "en", background: "dark", selectionMode: "manual" }).set("background", "terminal");
  assert.equal(backupBlocked.ok, false);
});

test("configPath never turns empty, relative, or unset homes into a cwd-relative path", () => {
  const cwdConfig = path.join(process.cwd(), ".config", "mdterm", "config.json");
  for (const value of ["", ".", "relative-home"]) {
    const resolved = configPath(value);
    assert.equal(path.isAbsolute(resolved), true);
    assert.notEqual(resolved, cwdConfig);
  }
  const home = process.env.HOME;
  const userProfile = process.env.USERPROFILE;
  try {
    for (const [homeValue, userProfileValue] of [["", "relative-user"], ["relative-home", ""], [undefined, undefined]]) {
      if (homeValue === undefined) delete process.env.HOME;
      else process.env.HOME = homeValue;
      if (userProfileValue === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = userProfileValue;
      const resolved = configPath();
      assert.equal(path.isAbsolute(resolved), true);
      assert.notEqual(resolved, cwdConfig);
    }
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    if (userProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = userProfile;
  }
  assert.equal(existsSync(path.join(process.cwd(), ".config", "mdterm")), false);
});

test("configPath uses an absolute temporary fallback when userInfo and homedir are unavailable", () => {
  const probe = String.raw`
    const os = require("node:os");
    const path = require("node:path");
    os.userInfo = () => { throw new Error("userInfo unavailable"); };
    os.homedir = () => { throw new Error("homedir unavailable"); };
    const { configPath } = require("./dist/config.js");
    const resolved = configPath();
    process.stdout.write(JSON.stringify({
      path: resolved,
      expected: path.join(path.resolve(os.tmpdir(), "mdterm-home"), ".config", "mdterm", "config.json"),
      absolute: path.isAbsolute(resolved),
    }));
  `;
  const result = spawnSync(process.execPath, ["-e", probe], {
    cwd: path.join(__dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, HOME: "", USERPROFILE: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  const resolved = JSON.parse(result.stdout);
  assert.equal(resolved.absolute, true);
  assert.equal(resolved.path, resolved.expected);
});

test("FIFO and other non-regular configs cannot block version startup", { skip: process.platform === "win32" }, () => {
  const home = temporaryHome();
  const target = configPath(home);
  require("node:fs").mkdirSync(path.dirname(target), { recursive: true });
  const fifo = spawnSync("mkfifo", [target]);
  if (fifo.status !== 0) return;
  const cli = path.join(__dirname, "..", "dist", "cli.js");
  const result = spawnSync(process.execPath, [cli, "--version"], {
    encoding: "utf8",
    timeout: 1000,
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^0\.5\.0\n$/);
});

test("a config write failure does not throw or mutate the in-memory preference", async () => {
  const home = temporaryHome();
  const blocker = path.join(home, "not-a-directory");
  writeFileSync(blocker, "blocker");
  const store = new ConfigStore(path.join(blocker, "config.json"), { language: "en", background: "dark", selectionMode: "manual" });
  const result = await store.set("background", "terminal");
  assert.equal(result.ok, false);
  assert.equal(store.current.background, "terminal");
  assert.equal(existsSync(path.join(blocker, "config.json")), false);
});
