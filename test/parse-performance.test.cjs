const assert = require("node:assert/strict");
const test = require("node:test");

const { parseMarkdown } = require("../dist/markdown/parse.js");

const unit = "**项目信任）**中文";
const strongRaw = "**项目信任）**";
const strongText = "项目信任）";

function sourceOfBytes(targetBytes) {
  const count = Math.max(1, Math.floor(targetBytes / Buffer.byteLength(unit, "utf8")));
  return { source: unit.repeat(count), count };
}

function strongTokens(tokens, result = []) {
  for (const token of tokens) {
    if (token.type === "strong") result.push(token);
    if (Array.isArray(token.tokens)) strongTokens(token.tokens, result);
  }
  return result;
}

test("CJK strong tokenizer stays near-linear below the large-document cutoff", () => {
  // Keep these inputs below LARGE_DOCUMENT_THRESHOLD so this exercises the
  // native-tokenizer wrapper rather than the lightweight plain-text path.
  const sizes = [25, 125, 250, 400, 500].map((kilobytes) => kilobytes * 1024);
  const sources = sizes.map(sourceOfBytes);
  parseMarkdown(unit.repeat(8));

  const timings = sources.map(({ source, count }, index) => {
    const started = process.hrtime.bigint();
    const parsed = parseMarkdown(source);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(parsed.largeDocument, false, `${sizes[index]} bytes must stay on the tokenizer path`);
    assert.equal(parsed.fallbackToPlainText, false, `${sizes[index]} bytes must parse normally`);
    const strong = strongTokens(parsed.tokens);
    assert.equal(strong.length, count, `${sizes[index]} bytes must produce one strong token per repeated target`);
    assert.equal(strong[0]?.raw, strongRaw, `${sizes[index]} first strong raw`);
    assert.equal(strong.at(-1)?.raw, strongRaw, `${sizes[index]} last strong raw`);
    assert.equal(strong[0]?.text, strongText, `${sizes[index]} first strong text`);
    assert.equal(strong.at(-1)?.text, strongText, `${sizes[index]} last strong text`);
    assert.ok(strong.every((token) => !/\*/u.test(token.text)), `${sizes[index]} strong text must not leak stars`);
    return elapsedMs;
  });

  // A quadratic implementation grows roughly 25x, 4x, 4x over these size
  // steps. The additive allowance absorbs process startup/JIT noise without
  // allowing the old 500 KiB multi-second DoS path to pass.
  assert.ok(timings[1] < timings[0] * 12 + 80, `25->125 KiB growth: ${timings.map((value) => value.toFixed(1)).join(", ")}ms`);
  assert.ok(timings[2] < timings[1] * 3.5 + 80, `125->250 KiB growth: ${timings.map((value) => value.toFixed(1)).join(", ")}ms`);
  assert.ok(timings[4] < timings[2] * 3, `250->500 KiB ratio must stay below 3: ${timings.map((value) => value.toFixed(1)).join(", ")}ms`);
  assert.ok(timings[4] / timings[3] < 3, `400->500 KiB ratio must stay below 3: ${timings.map((value) => value.toFixed(1)).join(", ")}ms`);
  assert.ok(timings[3] < 1_000, `400 KiB parse took ${timings[3].toFixed(1)}ms`);
  assert.ok(timings[4] < 1_000, `500 KiB parse took ${timings[4].toFixed(1)}ms`);
});
