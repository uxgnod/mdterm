const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
