const assert = require("node:assert/strict");
const test = require("node:test");
const stripAnsi = require("strip-ansi");

const { SearchModel, applySearchHighlights } = require("../dist/ui/search.js");

test("literal mixed-language search counts and cycles", () => {
  const lines = ["Alpha中文Beta and C++ [x]", "alpha中文beta", "nothing"];
  const search = new SearchModel();
  search.update(lines, "Alpha中文Beta");
  assert.equal(search.status(), "1/2");
  assert.equal(search.next().line, 1);
  assert.equal(search.status(), "2/2");
  assert.equal(search.next().line, 0);
  assert.equal(search.previous().line, 1);

  search.update(lines, "C++ [x]");
  assert.equal(search.state.matches.length, 1);
  const highlighted = applySearchHighlights(lines, search.state);
  assert.equal(stripAnsi(highlighted[0]), lines[0]);
  search.clear();
  assert.equal(search.status(), "");
});

test("case-folded Unicode matches map back to original grapheme coordinates", async () => {
  const lines = ["AİB", "İx", "e\u0301clair", "👩🏽‍💻 flag 🇨🇳", "中文B"];
  const sync = new SearchModel();
  sync.update(lines, "b");
  assert.deepEqual(sync.state.matches.map(({ line, start, length }) => ({ line, start, length })), [
    { line: 0, start: 2, length: 1 },
    { line: 4, start: 2, length: 1 },
  ]);
  assert.equal(stripAnsi(applySearchHighlights(lines, sync.state)[0]), "AİB");
  assert.match(applySearchHighlights(lines, sync.state)[0], /\u001b\[1;4;53;97mB/);

  const dotted = new SearchModel();
  dotted.update(lines, "i");
  assert.deepEqual(dotted.state.matches.find((match) => match.line === 1), { line: 1, start: 0, length: 1, ordinal: 1 });

  const asyncModel = new SearchModel();
  const snapshot = await asyncModel.updateAsync(lines, "b");
  assert.ok(snapshot);
  assert.deepEqual(snapshot.matches.map(({ line, start, length }) => ({ line, start, length })), [
    { line: 0, start: 2, length: 1 },
    { line: 4, start: 2, length: 1 },
  ]);
  assert.equal(asyncModel.state.query, "", "async search remains a pure snapshot until commit");
});

test("search mapping keeps combining and emoji clusters whole", () => {
  const search = new SearchModel();
  search.update(["e\u0301clair 👩🏽‍💻 🇨🇳"], "e");
  assert.deepEqual(search.state.matches[0], { line: 0, start: 0, length: 2, ordinal: 0 });
  const highlighted = applySearchHighlights(["e\u0301clair 👩🏽‍💻 🇨🇳"], search.state)[0];
  assert.equal(stripAnsi(highlighted), "e\u0301clair 👩🏽‍💻 🇨🇳");
});

test("very common queries use a bounded, explicit match count", () => {
  const search = new SearchModel();
  search.update(["a".repeat(2_000_000)], "a");
  assert.equal(search.state.matches.length, 10_000);
  assert.equal(search.state.truncated, true);
  assert.equal(search.status(), "1/10000+");
  assert.equal(search.previous().ordinal, 9_999);
});

test("async reflow search preserves the selected ordinal and cancels stale work", async () => {
  const lines = Array.from({ length: 512 }, (_value, index) => `row ${index} keyword`);
  const search = new SearchModel();
  const snapshot = await search.updateAsync(lines, "keyword");
  assert.ok(snapshot);
  assert.equal(search.state.query, "", "async search must not mutate the committed snapshot");
  search.commit(snapshot);
  search.setCurrentOrdinal(2);
  assert.equal(search.status(), "3/512");

  let cancelled = false;
  const stale = await search.updateAsync(
    lines,
    "new query",
    () => {
      cancelled = true;
      return true;
    },
  );
  assert.equal(stale, undefined);
  assert.equal(cancelled, true);
  assert.equal(search.state.query, "keyword");
  assert.equal(search.status(), "3/512");
  assert.equal(search.currentMatch().line, 2);
});
