const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const stripAnsi = require("strip-ansi");
const stringWidth = require("string-width");
const test = require("node:test");

const fixture = path.join(__dirname, "fixtures", "demo.md");
const navigationFixture = path.join(__dirname, "fixtures", "pty-navigation.md");
const codeCopyFixture = path.join(__dirname, "fixtures", "code-copy-long.md");
const searchReflowFixture = path.join(__dirname, "fixtures", "search-reflow.md");

const clipboardTestDirectories = [];
function fakeClipboardPath(exitCode) {
  const directory = mkdtempSync(path.join(os.tmpdir(), `mdterm-clipboard-${exitCode}-`));
  clipboardTestDirectories.push(directory);
  const script = `#!/bin/sh\ncat >/dev/null\nexit ${exitCode}\n`;
  for (const command of ["pbcopy", "wl-copy", "xclip", "clip.exe", "open", "xdg-open", "explorer.exe"]) {
    const filename = path.join(directory, command);
    writeFileSync(filename, script, "utf8");
    chmodSync(filename, 0o700);
  }
  return `${directory}:${process.env.PATH ?? ""}`;
}
const copiedClipboardPath = fakeClipboardPath(0);
const sentClipboardPath = fakeClipboardPath(1);
process.once("exit", () => {
  for (const directory of clipboardTestDirectories) rmSync(directory, { recursive: true, force: true });
});

function makeSearchRaceFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mdterm-search-race-"));
  const filename = path.join(directory, "search-race.md");
  const lines = Array.from({ length: 24000 }, (_, index) => `needleA row ${index} needleB`);
  writeFileSync(filename, `${lines.join("\n")}\n`);
  return { directory, filename };
}
const ptyScript = String.raw`
import base64, json, os, pty, select, signal, struct, termios, time, fcntl

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = os.environ.get("PTY_TERM", "xterm-256color")
    os.execv(os.environ["PTY_NODE"], [os.environ["PTY_NODE"], os.environ["PTY_CLI"], *json.loads(os.environ["PTY_ARGS"])])
fcntl.ioctl(
    fd,
    termios.TIOCSWINSZ,
    struct.pack("HHHH", int(os.environ.get("PTY_ROWS", "24")), int(os.environ.get("PTY_COLS", "80")), 0, 0),
)
flags = fcntl.fcntl(fd, fcntl.F_GETFL)
fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
events = [(float(delay), payload) for delay, payload in json.loads(os.environ["PTY_EVENTS"])]
started = time.time()
output = bytearray()
event_chunks = []
last_event_offset = 0
event_index = 0
capture_before_events = os.environ.get("PTY_CAPTURE_BEFORE_EVENTS") == "1"
timed_out = False
while time.time() - started < 8:
    ready, _, _ = select.select([fd], [], [], 0.03)
    if ready:
        try:
            output.extend(os.read(fd, 65536))
        except OSError:
            break
    if event_index < len(events) and time.time() - started >= events[event_index][0]:
        if capture_before_events or event_index > 0:
            event_chunks.append(bytes(output[last_event_offset:]).decode("utf-8", "replace"))
        payload = events[event_index][1]
        if isinstance(payload, dict) and payload.get("type") == "waitForFile":
            filename = payload.get("path", "")
            deadline = started + float(payload.get("timeout", 7))
            if not os.path.exists(filename):
                event_chunks.pop()
                if time.time() >= deadline:
                    timed_out = True
                    break
                time.sleep(0.01)
                continue
            event_index += 1
            last_event_offset = len(output)
            continue
        if isinstance(payload, dict) and payload.get("type") == "waitForOutput":
            marker = payload.get("value", "").encode("utf-8")
            deadline = started + float(payload.get("timeout", 7))
            if marker not in output:
                event_chunks.pop()
                if time.time() >= deadline:
                    timed_out = True
                    break
                time.sleep(0.01)
                continue
            event_index += 1
            last_event_offset = len(output)
            continue
        if isinstance(payload, dict) and payload.get("type") == "resize":
            fcntl.ioctl(
                fd,
                termios.TIOCSWINSZ,
                struct.pack("HHHH", int(payload["rows"]), int(payload["cols"]), 0, 0),
            )
            os.kill(pid, signal.SIGWINCH)
        else:
            os.write(fd, base64.b64decode(payload))
        event_index += 1
        last_event_offset = len(output)
    if events and event_index == len(events) and time.time() - started >= events[-1][0] + 1:
        break
else:
    timed_out = True
try:
    waited, status = os.waitpid(pid, os.WNOHANG)
    if waited == 0:
        timed_out = True
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        for _ in range(20):
            time.sleep(0.05)
            waited, status = os.waitpid(pid, os.WNOHANG)
            if waited != 0:
                break
        if waited == 0:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            waited, status = os.waitpid(pid, 0)
    exit_code = os.waitstatus_to_exitcode(status)
except ChildProcessError:
    exit_code = -1
if timed_out and exit_code == 0:
    exit_code = -signal.SIGTERM
if event_index > 0 and not capture_before_events:
    event_chunks.append(bytes(output[last_event_offset:]).decode("utf-8", "replace"))
print(json.dumps({"status": exit_code, "output": output.decode("utf-8", "replace"), "chunks": event_chunks}))
`;

function runPty(args, events, options = {}) {
  const suppliedHome = options.PTY_HOME;
  const home = suppliedHome ?? mkdtempSync(path.join(os.tmpdir(), "mdterm-pty-home-"));
  try {
    const python = spawnSync("python3", ["-c", ptyScript], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PTY_NODE: process.execPath,
        PTY_CLI: path.join(__dirname, "..", "dist", "cli.js"),
        PTY_ARGS: JSON.stringify(args),
        PTY_EVENTS: JSON.stringify(
          events.map(([delay, data]) => [
            delay,
            data && typeof data === "object" && !Buffer.isBuffer(data)
              ? data
              : Buffer.from(data).toString("base64"),
          ]),
        ),
        PATH: copiedClipboardPath,
        HOME: home,
        USERPROFILE: home,
        ...options,
      },
    });
    if (python.error?.code === "ENOENT") return undefined;
    assert.equal(python.status, 0, python.stderr);
    return JSON.parse(python.stdout);
  } finally {
    if (!suppliedHome) rmSync(home, { recursive: true, force: true });
  }
}

function visibleText(value) {
  return stripAnsi(value).replace(/\x1b(?:7|8|\([0-9A-Za-z])/g, "");
}

function terminalSnapshots(result) {
  const width = 160;
  const height = 40;
  const cells = Array.from({ length: height }, () => Array(width).fill(" "));
  let row = 0;
  let column = 0;
  let saved = { row: 0, column: 0 };
  const snapshots = [];
  const write = (value) => {
    const wide = Math.max(1, stringWidth(value));
    if (row >= 0 && row < height && column >= 0 && column < width) cells[row][column] = value;
    column = Math.min(width, column + wide);
  };
  const feed = (value) => {
    let offset = 0;
    while (offset < value.length) {
      if (value[offset] !== "\x1b") {
        const codePoint = Array.from(value.slice(offset))[0];
        if (!codePoint) break;
        offset += codePoint.length;
        if (codePoint === "\r") column = 0;
        else if (codePoint === "\n") row = Math.min(height - 1, row + 1);
        else if (codePoint === "\t") column = Math.min(width, column + (8 - (column % 8)));
        else if (codePoint.charCodeAt(0) >= 32) write(codePoint);
        continue;
      }
      const rest = value.slice(offset);
      const csi = /^\x1b\[([0-9;?]*)([ -\/]*)([@-~])/u.exec(rest);
      if (csi) {
        const params = (csi[1] ?? "").replace(/^\?/, "").split(";").filter(Boolean).map(Number);
        const amount = Math.max(1, params[0] ?? 1);
        switch (csi[3]) {
          case "H":
          case "f":
            row = Math.max(0, Math.min(height - 1, (params[0] ?? 1) - 1));
            column = Math.max(0, Math.min(width, (params[1] ?? 1) - 1));
            break;
          case "G": column = Math.max(0, Math.min(width, (params[0] ?? 1) - 1)); break;
          case "C": column = Math.min(width, column + amount); break;
          case "D": column = Math.max(0, column - amount); break;
          case "A": row = Math.max(0, row - amount); break;
          case "B": row = Math.min(height - 1, row + amount); break;
          case "J":
            if ((params[0] ?? 0) === 2) for (const line of cells) line.fill(" ");
            break;
          case "K": cells[row]?.fill(" ", column); break;
          case "s": saved = { row, column }; break;
          case "u": ({ row, column } = saved); break;
          default: break;
        }
        offset += csi[0].length;
        continue;
      }
      if (rest.startsWith("\x1b]")) {
        const bel = rest.indexOf("\x07", 2);
        const st = rest.indexOf("\x1b\\", 2);
        const end = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : st >= 0 ? st + 2 : rest.length;
        offset += end;
        continue;
      }
      if (rest.startsWith("\x1b7") || rest.startsWith("\x1b[s")) {
        saved = { row, column };
        offset += rest.startsWith("\x1b7") ? 2 : 3;
        continue;
      }
      if (rest.startsWith("\x1b8") || rest.startsWith("\x1b[u")) {
        ({ row, column } = saved);
        offset += rest.startsWith("\x1b8") ? 2 : 3;
        continue;
      }
      if (/^\x1b[()][ -~]/u.test(rest)) {
        offset += 3;
        continue;
      }
      offset += 2;
    }
  };
  const suffix = result.chunks.join("");
  const prefixLength = Math.max(0, result.output.length - suffix.length);
  feed(result.output.slice(0, prefixLength));
  for (const chunk of result.chunks) {
    feed(chunk);
    snapshots.push(cells.map((line) => line.join("")).join("\n"));
  }
  return snapshots;
}

function footerSnapshots(result) {
  return terminalSnapshots(result).map((snapshot) => snapshot.split("\n")[23] ?? "");
}

function codeFeedbackSnapshot(result, chunkIndex, kind) {
  const snapshot = terminalSnapshots(result)[chunkIndex] ?? "";
  const labels = {
    copied: "Copied",
    "request-sent": "Sent",
    failed: "Failed",
  };
  assert.match(snapshot, new RegExp(`\\[${labels[kind]}\\]`), `${kind} button label must be rendered in its event chunk`);
  return snapshot;
}

function assertStatusPercent(chunk, percent, message) {
  assert.match(
    chunk,
    new RegExp(`\\x1b\\[1;1H\\x1b\\[\\d+C\\x1b\\[[0-9;]*m${percent}(?:%|\\x1b|$)`),
    message,
  );
}

function lastFullScreenFrame(value) {
  const marker = "\x1b[H\x1b[2J";
  const start = value.lastIndexOf(marker);
  return start >= 0 ? value.slice(start) : value;
}

function hasOutlinedCurrentMatch(output, terminal = false) {
  return [...output.matchAll(/\x1b\[([0-9;]*)m/g)].some((match) => {
    const params = new Set((match[1] ?? "").split(";").map((value) => Number(value)));
    // neo-blessed's screen attribute codec has no SGR 53 bit, so its PTY
    // output naturally degrades overline while preserving the other search
    // attributes. The renderer/unit gate keeps the exact 53 style string.
    const required = terminal ? [1, 4] : [1, 4, 97];
    return required.every((value) => params.has(value)) && !params.has(7) && !params.has(27);
  });
}

const leftMouseDown = Buffer.from("\u001b[M" + String.fromCharCode(32, 35, 37));
const heldMouseMove = Buffer.from("\u001b[M" + String.fromCharCode(64, 47, 37));
const leftMouseUp = Buffer.from("\u001b[M" + String.fromCharCode(35, 47, 37));
// X10 sends Cb=32+65 for wheel-down. neo-blessed subtracts 32 and then
// applies its zero-based coordinate adjustment to x/y.
const wheelDown = Buffer.from("\u001b[M" + String.fromCharCode(97, 42, 37));
const tocMouseDown = Buffer.from("\u001b[M" + String.fromCharCode(32, 35, 35));
const tocMouseUp = Buffer.from("\u001b[M" + String.fromCharCode(35, 35, 35));
const scrollbarMouseDown = Buffer.from("\u001b[M" + String.fromCharCode(32, 112, 35));
const scrollbarMouseDrag = Buffer.from("\u001b[M" + String.fromCharCode(32, 112, 55));
const scrollbarMouseUp = Buffer.from("\u001b[M" + String.fromCharCode(35, 112, 55));
const bodyMouseDown = Buffer.from("\u001b[M" + String.fromCharCode(32, 63, 37));
const bodyMouseMove = Buffer.from("\u001b[M" + String.fromCharCode(64, 70, 37));
const bodyMouseUp = Buffer.from("\u001b[M" + String.fromCharCode(35, 70, 37));
const sgrCtrlLinkDown = Buffer.from("\u001b[<16;2;2M");
const sgrCtrlLinkUp = Buffer.from("\u001b[<16;2;2m");
const sgrCtrlRightUp = Buffer.from("\u001b[<18;2;2m");
const sgrCtrlMiddleUp = Buffer.from("\u001b[<17;2;2m");
const sgrCtrlOtherLinkUp = Buffer.from("\u001b[<16;2;3m");
const sgrPlainLinkDown = Buffer.from("\u001b[<0;2;2M");
const sgrPlainLinkUp = Buffer.from("\u001b[<0;2;2m");
// neo-blessed recognizes b=35 as a SGR mousemove (the modifier bits are not
// relevant after the original Ctrl-down owns the gesture).
const sgrCtrlLinkMoveOut = Buffer.from("\u001b[<35;2;3M");
const x10CtrlLinkDown = Buffer.from("\u001b[M" + String.fromCharCode(48, 34, 34));
const x10CtrlLinkRelease = Buffer.from("\u001b[M" + String.fromCharCode(51, 34, 34));
// X10 coordinates are one-based in the wire protocol; neo-blessed subtracts
// one again because the screen uses zero-based hitboxes.
const codeButtonDown = Buffer.from("\u001b[M" + String.fromCharCode(32, 105, 37));
const codeButtonUp = Buffer.from("\u001b[M" + String.fromCharCode(35, 105, 37));
const codeButtonRightDown = Buffer.from("\u001b[M" + String.fromCharCode(34, 105, 37));
const codeButtonRightUp = Buffer.from("\u001b[M" + String.fromCharCode(35, 105, 37));
const codeButtonMiddleDown = Buffer.from("\u001b[M" + String.fromCharCode(33, 105, 37));
const codeButtonMiddleUp = Buffer.from("\u001b[M" + String.fromCharCode(35, 105, 37));
const codeButtonOutsideUp = Buffer.from("\u001b[M" + String.fromCharCode(35, 42, 37));
const codeBodyDown = Buffer.from("\u001b[M" + String.fromCharCode(32, 38, 38));
const codeBodyMove = Buffer.from("\u001b[M" + String.fromCharCode(64, 48, 38));
const codeBodyUp = Buffer.from("\u001b[M" + String.fromCharCode(35, 48, 38));
const codeSecondButtonDown = Buffer.from("\u001b[M" + String.fromCharCode(32, 105, 53));
const codeSecondButtonUp = Buffer.from("\u001b[M" + String.fromCharCode(35, 105, 53));
const codeNarrowButtonDown = Buffer.from("\u001b[M" + String.fromCharCode(32, 85, 53));
const codeNarrowButtonUp = Buffer.from("\u001b[M" + String.fromCharCode(35, 85, 53));
// The nested fixture's list and blockquote code headers begin two and nine
// rendered rows below the top-level code-button coordinate respectively.
const nestedListButtonDown = Buffer.from("\u001b[M" + String.fromCharCode(32, 105, 39));
const nestedListButtonUp = Buffer.from("\u001b[M" + String.fromCharCode(35, 105, 39));
const nestedQuoteButtonDown = Buffer.from("\u001b[M" + String.fromCharCode(32, 105, 46));
const nestedQuoteButtonUp = Buffer.from("\u001b[M" + String.fromCharCode(35, 105, 46));
const dsrLightResponse = Buffer.from("\u001b[?997;2n");
const osc11BrightPart1 = Buffer.from("\u001b]11;rgb:ffff/ffff/ffff");
const osc11BrightPart2 = Buffer.from("\u0007");
const mouseModeEnable = /\x1b\[\?(?:1000|1002|1003|1005|1006|1015|1016)h/;

test("CODECOPY-01 uses viewport hitboxes, preserves selection and rejects invalid clicks", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [codeCopyFixture],
    [
      [2.0, "m"],
      [2.3, codeBodyDown],
      [2.4, codeBodyMove],
      [2.5, codeBodyUp],
      [2.9, codeButtonDown],
      [3.0, codeButtonUp],
      [3.3, codeButtonRightDown],
      [3.4, codeButtonRightUp],
      [3.7, codeButtonMiddleDown],
      [3.8, codeButtonMiddleUp],
      [4.1, codeButtonDown],
      [4.2, codeButtonOutsideUp],
      [4.5, "m"],
      [4.8, codeButtonDown],
      [4.9, codeButtonUp],
      [5.2, "G"],
      [5.5, codeButtonDown],
      [5.6, codeButtonUp],
      [5.9, { type: "resize", rows: 24, cols: 60 }],
      [6.2, codeButtonDown],
      [6.3, codeButtonUp],
      [6.9, "q"],
    ],
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  assert.match(result.output, /\[Copy\]/, "mouse-enabled code blocks must expose a visible button");
  assert.ok(terminalSnapshots(result).some((snapshot) => /\[Copied\]/.test(snapshot)), "a left release must render Copied");
  assert.ok(result.chunks.some((chunk) => /\x1b\[[0-9;]*32m/.test(chunk)), "Copied must use a success color");
  assert.match(result.output, /\x1b\[(?:97;44;1|1;44;97)m/, "a pre-existing manual selection must remain after a code click");
  assert.match(result.output, /\x1b\[\?1049l/);
});

test("CODECOPY-01 distinguishes valid up from right, middle and drag-out chunks", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const runClick = (down, up) => runPty(
    [codeCopyFixture],
    [[2, "m"], [2.4, down], [2.5, up], [3.4, "q"]],
  );
  const valid = runClick(codeButtonDown, codeButtonUp);
  assert.ok(valid);
  assert.equal(valid.status, 0);
  assert.doesNotMatch(terminalSnapshots(valid)[1] ?? "", /\[(?:Copied|Sent|Failed)\]/, "mousedown alone must not copy");
  codeFeedbackSnapshot(valid, 2, "copied");

  for (const [label, down, up] of [
    ["right", codeButtonRightDown, codeButtonRightUp],
    ["middle", codeButtonMiddleDown, codeButtonMiddleUp],
    ["drag-out", codeButtonDown, codeButtonOutsideUp],
  ]) {
    const invalid = runClick(down, up);
    assert.ok(invalid, `${label} PTY result`);
    assert.equal(invalid.status, 0, `${label} PTY status`);
    assert.doesNotMatch(terminalSnapshots(invalid)[1] ?? "", /\[(?:Copied|Sent|Failed)\]/, `${label} down must not copy`);
    assert.doesNotMatch(terminalSnapshots(invalid)[2] ?? "", /\[(?:Copied|Sent|Failed)\]/, `${label} release must not copy`);
  }
});

test("CODECOPY-01 reports OSC52 Sent when the platform clipboard command fails", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [codeCopyFixture],
    [[2, "m"], [2.4, codeButtonDown], [2.5, codeButtonUp], [3.4, "q"]],
    { PATH: sentClipboardPath },
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  codeFeedbackSnapshot(result, 2, "request-sent");
  assert.match(result.chunks[2], /\x1b\]52;c;/, "Sent must be backed by an OSC52 request in the same release chunk");
  assert.match(result.chunks[2], /\x1b\[(?:[0-9;]*33|[0-9;]*93)m/, "Sent must use the warning color");
});

test("LINK-02 opens only same-hitbox Ctrl-clicks for SGR and legacy X10 PTY events", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "mdterm-link-pty-"));
  const filename = path.join(directory, "link.md");
    writeFileSync(filename, "[Open](https://example.com)\n[Other](https://other.example)\nplain\n", "utf8");
  try {
    const sgr = runPty(
      [filename],
      [[2.2, sgrCtrlLinkDown], [2.3, sgrCtrlLinkUp], [3.4, "q"]],
    );
    assert.ok(sgr);
    assert.equal(sgr.status, 0);
    assert.match(sgr.output, /Opened link/);
    assert.match(sgr.output, /\x1b\[\?1006h/, "the real PTY must enable SGR mouse mode");
    assert.equal((sgr.output.match(/Opened link/g) ?? []).length, 1, "one valid gesture opens once");

    const rightRelease = runPty(
      [filename],
      [[2.2, sgrCtrlLinkDown], [2.3, sgrCtrlRightUp], [3.4, "q"]],
    );
    assert.ok(rightRelease);
    assert.equal(rightRelease.status, 0);
    assert.doesNotMatch(rightRelease.output, /Opened link/, "Ctrl+right release must not open");

    const middleRelease = runPty(
      [filename],
      [[2.2, sgrCtrlLinkDown], [2.3, sgrCtrlMiddleUp], [3.4, "q"]],
    );
    assert.ok(middleRelease);
    assert.equal(middleRelease.status, 0);
    assert.doesNotMatch(middleRelease.output, /Opened link/, "Ctrl+middle release must not open");

    const differentLink = runPty(
      [filename],
      [[2.2, sgrCtrlLinkDown], [2.3, sgrCtrlOtherLinkUp], [3.4, "q"]],
    );
    assert.ok(differentLink);
    assert.equal(differentLink.status, 0);
    assert.doesNotMatch(differentLink.output, /Opened link/, "release on a different link must cancel");

    const sgrDragOut = runPty(
      [filename],
      [[2.2, sgrCtrlLinkDown], [2.3, sgrCtrlLinkMoveOut], [2.4, sgrCtrlLinkUp], [3.4, "q"]],
    );
    assert.ok(sgrDragOut);
    assert.equal(sgrDragOut.status, 0);
    assert.doesNotMatch(sgrDragOut.output, /Opened link/);

    const plain = runPty(
      [filename],
      [[2.2, sgrPlainLinkDown], [2.3, sgrPlainLinkUp], [3.4, "q"]],
    );
    assert.ok(plain);
    assert.equal(plain.status, 0);
    assert.doesNotMatch(plain.output, /Opened link/, "ordinary click must remain selection, not open a link");

    const x10 = runPty(
      [filename],
      [[2.2, x10CtrlLinkDown], [2.3, x10CtrlLinkRelease], [3.4, "q"]],
    );
    assert.ok(x10);
    assert.equal(x10.status, 0);
    assert.match(x10.output, /Opened link/, "legacy X10 Ctrl release must use the remembered same-link gesture");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CODECOPY-01 rebuilds the second-block hitbox after G, TOC and resize", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const bottom = runPty(
    [codeCopyFixture],
    [[2, "G"], [2.5, codeSecondButtonDown], [2.6, codeSecondButtonUp], [3.5, "q"]],
  );
  assert.ok(bottom);
  assert.equal(bottom.status, 0);
  codeFeedbackSnapshot(bottom, 2, "copied");

  const toc = runPty(
    [codeCopyFixture],
    [[2, "G"], [2.5, "t"], [3.3, codeSecondButtonDown], [3.4, codeSecondButtonUp], [4.3, "q"]],
  );
  assert.ok(toc);
  assert.equal(toc.status, 0);
  codeFeedbackSnapshot(toc, 3, "copied");

  const resized = runPty(
    [codeCopyFixture],
    [
      [2, "G"],
      [2.5, { type: "resize", rows: 24, cols: 60 }],
      [3.5, codeNarrowButtonDown],
      [3.6, codeNarrowButtonUp],
      [4.5, "q"],
    ],
  );
  assert.ok(resized);
  assert.equal(resized.status, 0);
  codeFeedbackSnapshot(resized, 3, "copied");
  assert.match(terminalSnapshots(resized)[3] ?? "", /\[Copied\]/, "resize click must still address the second block, not the first block");
});

test("CODECOPY-01 hides buttons for no-mouse, TERM fallback and narrow viewports", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const noMouse = runPty(["--no-mouse", codeCopyFixture], [[2, "q"]]);
  assert.ok(noMouse);
  assert.equal(noMouse.status, 0);
  assert.doesNotMatch(noMouse.output, /\[(?:Copy|复制)\]/);

  const fallback = runPty([codeCopyFixture], [[2, "q"]], { PTY_TERM: "dumb" });
  assert.ok(fallback);
  assert.equal(fallback.status, 0);
  assert.doesNotMatch(fallback.output, /\[(?:Copy|复制)\]/);

  const narrow = runPty([codeCopyFixture], [[2, "q"]], { PTY_COLS: "12" });
  assert.ok(narrow);
  assert.equal(narrow.status, 0);
  assert.doesNotMatch(narrow.output, /\[(?:Copy|复制)\]/);
});

test("CODECOPY-02 q and Ctrl+c abort a hanging backend without an orphan or late UI", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  for (const [label, quit] of [["q", "q"], ["Ctrl+c", "\u0003"]]) {
    const directory = mkdtempSync(path.join(os.tmpdir(), `mdterm-clipboard-pty-${label}-`));
    const pidFile = path.join(directory, "child.pid");
    const script = `#!${process.execPath}\nconst fs = require("node:fs"); fs.writeFileSync(process.env.MDTERM_CLIPBOARD_PID, String(process.pid)); process.stdin.on("data", () => {}); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);\n`;
    for (const commandName of ["pbcopy", "wl-copy"]) {
      const command = path.join(directory, commandName);
      writeFileSync(command, script, "utf8");
      chmodSync(command, 0o700);
    }
    try {
      const result = runPty(
        [codeCopyFixture],
        [
          [5.0, codeButtonDown],
          [5.1, codeButtonUp],
          [5.2, { type: "waitForFile", path: pidFile, timeout: 7 }],
          [6.0, quit],
        ],
        { PATH: `${directory}:${process.env.PATH ?? ""}`, MDTERM_CLIPBOARD_PID: pidFile },
      );
      assert.ok(result, `${label} PTY result`);
      assert.equal(result.status, 0, `${label} must exit through the TUI shutdown path`);
      assert.doesNotMatch(result.output, /\[(?:Copied|Sent|Failed)\]/, `${label} must not publish a late copy result`);
      const pid = Number(readFileSync(pidFile, "utf8"));
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      assert.equal(alive, false, `${label} clipboard child ${pid} must be reaped`);
      assert.match(result.output, /\x1b\[\?1049l/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("CODECOPY-01 exposes copy hitboxes for list and blockquote fenced code", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [path.join(__dirname, "fixtures", "code-copy-nested.md")],
    [
      [2.2, nestedListButtonDown],
      [2.3, nestedListButtonUp],
      [3.2, nestedQuoteButtonDown],
      [3.3, nestedQuoteButtonUp],
      [4.4, "q"],
    ],
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  assert.match(result.output, /\[Copy\]/, "nested fenced code must expose a button");
  assert.doesNotMatch(result.chunks[0] ?? "", /\[(?:Copied|Sent|Failed)\]/, "list mousedown must not copy");
  assert.match(result.chunks[1] ?? "", /\[Copied\]/, "list code release must copy once");
  assert.doesNotMatch(result.chunks[2] ?? "", /\[(?:Copied|Sent|Failed)\]/, "blockquote mousedown must not copy");
  assert.match(result.chunks[3] ?? "", /\[Copied\]/, "blockquote code release must copy once");
});

test("--no-mouse keeps terminal-native selection and restores the PTY", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(["--no-mouse", fixture], [[2, "q"]]);
  assert.ok(result);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.output, /\x1b\[\?1000h/);
  assert.match(result.output, /Selection[\s\S]{0,10}Terminal/);
  assert.match(result.output, /\x1b\[\?1049l/);
});

test("--no-mouse footer and help hide application m/y actions", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(["--no-mouse", fixture], [[2.0, "?"], [2.7, "\x1b"], [3.4, "q"]]);
  assert.ok(result);
  assert.equal(result.status, 0);
  const footer = footerSnapshots(result).join("\n");
  assert.doesNotMatch(footer, /(?:^| · )m(?: | ·|$)|(?:^| · )y(?: | ·|$)/u);
  const help = terminalSnapshots(result)[0] ?? "";
  assert.doesNotMatch(help, /Text selection m|文本选择 m|\by\s+copy|\by\s+复制/u);
  assert.doesNotMatch(help, /open http|打开 http/u);
  assert.match(help, /Ctrl-left-click/u);
  assert.match(help, /unavailable/u);
  assert.match(help, /drag|应用拖选/u);
  assert.match(help, /auto-copy|自动复制/u);
  assert.match(help, /\[Copy\]|\[复制\]/u);
  assert.match(help, /terminal-native|终端原生文本选择/u);
});

test("CONFIG-02 persists language, background and selection mode across launches", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const home = mkdtempSync(path.join(os.tmpdir(), "mdterm-config-pty-home-"));
  try {
    const first = runPty([fixture], [
      [2.0, "b"],
      [2.3, "m"],
      [2.6, "l"],
      [2.9, "zh"],
      [3.3, "\r"],
      [4.6, "q"],
    ], { PTY_HOME: home });
    assert.ok(first);
    assert.equal(first.status, 0);
    const saved = JSON.parse(require("node:fs").readFileSync(path.join(home, ".config", "mdterm", "config.json"), "utf8"));
    assert.deepEqual(saved, { language: "zh-CN", background: "terminal", selectionMode: "auto" });

    const native = runPty(["--no-mouse", fixture], [[2.0, "q"]], { PTY_HOME: home });
    assert.ok(native);
    assert.equal(native.status, 0);
    assert.equal(JSON.parse(require("node:fs").readFileSync(path.join(home, ".config", "mdterm", "config.json"), "utf8")).selectionMode, "auto");

    const second = runPty([fixture], [[2.2, "q"]], { PTY_HOME: home });
    assert.ok(second);
    assert.equal(second.status, 0);
    assert.match(visibleText(second.output), /背景:终端/);
    assert.match(visibleText(second.output), /文本选择:自动复制/);
    assert.match(second.output, /\x1b\[\?1049l/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("immediate q restores the PTY without theme probing", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  for (const [label, events] of [
    ["q", [[0.03, "q"]]],
    ["Ctrl+c", [[0.25, { type: "waitForOutput", value: "\u001b[?1049h", timeout: 7 }], [0.25, "\u0003"]]],
  ]) {
    const result = runPty([fixture], events, {
      PTY_CAPTURE_BEFORE_EVENTS: label === "Ctrl+c" ? "1" : undefined,
    });
    assert.ok(result, `${label} PTY result`);
    assert.equal(result.status, 0, `${label} must exit cleanly`);
    if (label === "Ctrl+c") {
      assert.match(result.chunks[0] ?? "", /\x1b\[\?1049h/, "Ctrl+c must be sent after alternate-screen takeover");
    }
    assert.doesNotMatch(result.output, /\x1b\[\?996n|\x1b\]11;\?/i, `${label}: 0.4 must not probe terminal theme`);
    const restoreOffset = result.output.lastIndexOf("\x1b[?1049l");
    assert.ok(restoreOffset >= 0, `${label}: alternate screen must be restored`);
    assert.doesNotMatch(
      result.output.slice(restoreOffset),
      /\x1b\]11;\?/i,
      `${label}: cancelled probe must not query OSC 11 after restore`,
    );
  }
});

test("pre-TUI SIGINT is not treated as an owned screen session", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty([fixture], [[0.001, "\u0003"]], {
    PTY_CAPTURE_BEFORE_EVENTS: "1",
  });
  assert.ok(result);
  assert.ok([0, -2].includes(result.status), `unexpected pre-TUI SIGINT status ${result.status}`);
  assert.doesNotMatch(result.chunks[0] ?? "", /\x1b\[\?1049h|\x1b\[\?1000h/);
  if (result.status === -2) {
    assert.doesNotMatch(result.output, /\x1b\[\?1049h/, "an unowned process must not enter the alternate screen");
    assert.doesNotMatch(result.output, mouseModeEnable, "an unowned process must not enable mouse modes");
    assert.doesNotMatch(result.output, /\x1b\[\?1049l/, "an unowned process must not emit a restore sequence");
  } else {
    assert.match(result.output, /\x1b\[\?1049l/, "an owned TUI process must restore the alternate screen");
  }
});

test("PTY cycles selection modes and copies manual and auto selections", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [fixture],
    [
      [2.5, leftMouseDown],
      [2.6, heldMouseMove],
      [2.7, leftMouseUp],
      [3.1, "y"],
      [3.8, "m"],
      [4.1, leftMouseDown],
      [4.2, heldMouseMove],
      [4.3, leftMouseUp],
      [5.0, "m"],
      [5.3, "m"],
      [5.6, "q"],
    ],
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  assert.match(result.output, /\x1b\[\?1000h/);
  const visible = visibleText(result.output);
  const screens = terminalSnapshots(result);
  assert.match(visible, /Selection:\s*On/);
  assert.ok(screens.some((snapshot) => /Auto-copy/.test(snapshot)), "m must enter Auto-copy");
  assert.ok(screens.some((snapshot) => /\bOff\b/.test(snapshot)), "m must enter Off");
  assert.match(result.output, /\x1b\[(?:97;44;1|1;44;97)m/);
  assert.ok(screens.some((snapshot) => /Selection copied \d+ chars/.test(snapshot)), "selection copy must be visible in a committed frame");
  assert.match(result.output, /\x1b\[\?1049l/);
});

test("selection mode leaves wheel, TOC and scrollbar mouse paths usable", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [navigationFixture],
    [
      [2, "m"],
      [2.5, wheelDown],
      [3.0, "t"],
      [4.0, tocMouseDown],
      [4.1, tocMouseUp],
      [4.8, "t"],
      [5.5, scrollbarMouseDown],
      [5.8, scrollbarMouseDrag],
      [6.0, scrollbarMouseUp],
      [6.4, "q"],
    ],
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  assert.ok(result.chunks.length >= 10);
  assertStatusPercent(result.chunks[1], "[1-9]", "wheel-down must update the non-zero status percentage");
  assert.match(result.chunks[1], /TARGET_MARKER|Navigation line/, "wheel-down must redraw body content");
  const screens = terminalSnapshots(result);
  assert.match(screens[2] ?? "", /Table of/, "t must open the TOC");
  assert.match(screens[4] ?? "", /TARGET_MARKER/, "TOC click must jump to the target body");
  assertStatusPercent(result.chunks[7], "100", "scrollbar drag must move to 100%");
  assert.match(result.output, /\x1b\[\?1049l/);
});

test("正文 drag takes focus from an open TOC for manual and auto copy", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const manual = runPty(
    ["--toc", navigationFixture],
    [
      [2.5, bodyMouseDown],
      [2.6, bodyMouseMove],
      [2.7, bodyMouseUp],
      [3.2, "y"],
      [4.0, "q"],
    ],
  );
  assert.ok(manual);
  assert.equal(manual.status, 0);
  assert.match(visibleText(manual.output), /Selection:\s*On/);
  assert.match(manual.output, /\x1b\[(?:97;44;1|1;44;97)m/);
  assert.ok(terminalSnapshots(manual).some((snapshot) => /Selection copied \d+ chars/.test(snapshot)));

  const automatic = runPty(
    ["--toc", navigationFixture],
    [
      [2, "m"],
      [2.5, bodyMouseDown],
      [2.6, bodyMouseMove],
      [2.7, bodyMouseUp],
      [3.8, "q"],
    ],
  );
  assert.ok(automatic);
  assert.equal(automatic.status, 0);
  assert.ok(terminalSnapshots(automatic).some((snapshot) => /Auto-copy/.test(snapshot)));
  assert.ok(terminalSnapshots(automatic).some((snapshot) => /Selection copied \d+ chars/.test(snapshot)));
});

test("Ctrl+c restores mouse protocol, cursor and alternate screen", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty([fixture], [[2, "\u0003"]]);
  assert.ok(result);
  assert.equal(result.status, 0);
  assert.match(result.output, /\x1b\[\?1000h/);
  assert.match(result.output, /\x1b\[\?1000l/);
  assert.match(result.output, /\x1b\[\?25h/);
  assert.match(result.output, /\x1b\[\?1049l/);
});

test("Esc respects search and help modal priority before body selection", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }

  const searchModal = runPty(
    [navigationFixture],
    [
      [2.4, bodyMouseDown],
      [2.5, bodyMouseMove],
      [2.6, bodyMouseUp],
      [3.0, "/"],
      [3.3, "Alpha"],
      [3.8, "\u001b"],
      [4.2, "y"],
      [4.8, "q"],
    ],
  );
  assert.ok(searchModal);
  assert.equal(searchModal.status, 0);
  assert.ok(
    terminalSnapshots(searchModal).some((snapshot) => /Selection copied \d+ chars/.test(snapshot)),
    "search Esc must leave the body selection for manual copy",
  );

  const helpModal = runPty(
    [fixture],
    [
      [2, "?"],
      [2.8, "\u001b"],
      [3.8, "q"],
    ],
  );
  assert.ok(helpModal);
  assert.equal(helpModal.status, 0);
  assert.match(helpModal.chunks[0], /Auto-copy|Text selection/, "help must explain the selection modes");
  assert.doesNotMatch(helpModal.chunks[1], /Auto-copy/, "Esc must close help as a modal action");
});

test("正文 Esc clears selection before an already confirmed search", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [fixture],
    [
      [2, "/"],
      [2.3, "Alpha"],
      [2.8, "\u000d"],
      [3.4, "m"],
      [3.7, leftMouseDown],
      [3.8, heldMouseMove],
      [3.9, leftMouseUp],
      [4.4, "\u001b"],
      [5.0, "\u001b"],
      [5.8, "q"],
    ],
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  const footerAtChunk = footerSnapshots(result);
  assert.match(footerAtChunk[7] ?? "", /Search[\s\S]*1\/2/, "first body Esc must retain the confirmed search");
  assert.doesNotMatch(result.chunks[6], /\x1b\[(?:97;44;1|1;44;97)m/, "first body Esc must clear selection");
  assert.doesNotMatch(footerAtChunk[8] ?? "", /Search[\s\S]*1\/2/, "second body Esc must clear the confirmed search");
});

test("SEARCH-01 keeps a persistent navigation bar and supports n/p/N, edit and clear", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [fixture],
    [
      [2, "/"],
      [2.3, "Alpha中文Beta"],
      [2.8, "\u000d"],
      [3.4, "n"],
      [4.0, "p"],
      [4.6, "N"],
      [4.7, "/"],
      [5.0, "\u007f"],
      [5.3, "X"],
      [5.7, "\u000d"],
      [5.8, "\u001b"],
      [6.1, "q"],
    ],
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  const visible = visibleText(result.output);
  assert.match(visible, /Search[\s\S]{0,40}Alpha中文Beta/);
  assert.match(visible, /1\/2/);
  // blessed redraws only changed footer cells after the initial full draw;
  // assert the 2 -> 1 -> 2 index deltas in the corresponding PTY chunks
  // instead of expecting a second contiguous "2/2" in the byte stream.
  const footerAtChunk = footerSnapshots(result);
  assert.match(footerAtChunk[3] ?? "", /2\/2/);
  assert.match(footerAtChunk[4] ?? "", /1\/2/);
  assert.match(footerAtChunk[5] ?? "", /2\/2/);
  assert.match(visible, /n Next/);
  assert.match(visible, /p Previous/);
  // The input box is a blessed diff-rendered widget: after the edit it may
  // write the replacement `X` in a separate cell update. Check the retained
  // query and the edit marker independently instead of requiring one raw
  // byte substring across those updates.
  assert.match(visible, /Alpha中文Bet/);
  assert.match(visible, /Alpha中文BetX/);
  const sgrSequences = [...new Set(result.output.match(/\x1b\[[0-9;]*m/g) ?? [])].join(", ");
  assert.ok(
    hasOutlinedCurrentMatch(result.output),
    `current search match must keep bold/underline/bright foreground without inverse; observed SGR: ${sgrSequences}`,
  );
  assert.doesNotMatch(result.output, /\x1b\[7m/);
  assert.match(result.output, /\x1b\[\?1049l/);
});

test("SEARCH-01 live input matches the visible multi-character Chinese query", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [fixture],
    [
      [2.0, "/"],
      [2.3, "中文"],
      [3.9, "\u000d"],
      [4.8, "q"],
    ],
    { PTY_ROWS: "30", PTY_COLS: "100" },
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  const liveStatus = terminalSnapshots(result)[1]?.split("\n")[0] ?? "";
  assert.match(liveStatus, /Search[\s\S]*1\/8/, `live status must follow the visible 中文 query: ${liveStatus}`);
  assert.doesNotMatch(liveStatus, /1\/9/, `live status used a stale one-character query: ${liveStatus}`);
  assert.match(visibleText(result.output), /中文/);
  assert.match(result.output, /\x1b\[\?1049l/);
});

test("SEARCH-01 shows 0/0 and Esc restores the ordinary toolbar", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [fixture],
    [
      [2, "/"],
      [2.3, "不存在的关键词"],
      [2.8, "\u000d"],
      [3.8, "\u001b"],
      [4.8, "q"],
    ],
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  const visible = visibleText(result.output);
  assert.match(visible, /0\/0/);
  assert.match(visible, /Search[\s\S]{0,80}Esc/);
  assert.match(visible, /q Quit[\s\S]*\/ Search/);
});

test("SEARCH-01 keeps the current ordinal through theme reflow and a resize event", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [searchReflowFixture],
    [
      [1.8, "/"],
      [2.1, "search-reflow"],
      [2.5, "\u000d"],
      [3.0, "n"],
      [3.5, "n"],
      [4.0, "b"],
      [5.3, { type: "resize", rows: 24, cols: 60 }],
      [6.6, "q"],
    ],
    { PTY_COLS: "100" },
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  const footerAtChunk = footerSnapshots(result);
  assert.match(footerAtChunk[5] ?? "", /3\/17/, "theme reflow must keep 3/17 before resize");
  assert.match(footerAtChunk[6] ?? "", /3\/17/, "resize reflow must keep 3/17");
  assert.match(visibleText(result.output), /Search[\s\S]{0,30}3\/17/);
  assert.match(result.output, /\x1b\[\?1049l/);
});

test("SEARCH-01 preserves a pending confirmed query when / reopens immediately", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const { directory, filename } = makeSearchRaceFixture();
  try {
    const result = runPty(
      [filename],
      [
        [2.8, "/"],
        [3.1, "needleA"],
        [3.4, "\u000d"],
        [4.0, "/"],
        [4.3, "\u007f\u007f\u007f\u007f\u007f\u007f\u007f"],
        [4.4, "needleB"],
        [4.7, "\u000d"],
        [4.701, "/"],
        [6.2, "\u001b"],
        [5.8, "q"],
      ],
    );
    assert.ok(result);
    assert.equal(result.status, 0);
    const reopened = visibleText(result.chunks[7] ?? "");
    // The large document can contribute its own B matches to the same diff
    // chunk, so use the input value and stale-query exclusion as the stable
    // evidence rather than relying on one cursor-order byte substring.
    assert.match(reopened, /needleB/);
    assert.doesNotMatch(reopened, /needleA/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SEARCH-01 Esc immediately after Enter cancels the pending result", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const { directory, filename } = makeSearchRaceFixture();
  try {
    const result = runPty(
      [filename],
      [
        [3.0, "/"],
        [3.3, "needleA"],
        [3.6, "\u000d"],
        [4.3, "/"],
        [4.6, "needleB"],
        [4.9, "\u000d"],
        [4.901, "\u001b"],
        [6.2, "q"],
      ],
    );
    assert.ok(result);
    assert.equal(result.status, 0);
    const footerAtChunk = footerSnapshots(result);
    const afterEsc = footerAtChunk.at(-2) ?? "";
    assert.doesNotMatch(afterEsc, /n 下一个|p 上一个|needleB/);
    assert.match(visibleText(result.output), /q Quit/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SEARCH-01 keeps n navigation issued during a theme reflow", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const { directory, filename } = makeSearchRaceFixture();
  try {
    const result = runPty(
      [filename],
      [
        [3.0, "/"],
        [3.3, "needleA"],
        [3.6, "\u000d"],
        [4.2, "n"],
        [4.8, "b"],
        [4.801, "n"],
        [6.4, "q"],
      ],
    );
    assert.ok(result);
    assert.equal(result.status, 0);
    const footerAtChunk = footerSnapshots(result);
    assert.match(footerAtChunk.at(-2) ?? "", /3\/10000\+/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SEARCH-01 replaces the query while a reflow is still rendering", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const { directory, filename } = makeSearchRaceFixture();
  try {
    const result = runPty(
      [filename],
      [
        [3.0, "/"],
        [3.3, "needleA"],
        [3.6, "\u000d"],
        [5.0, "b"],
        [5.5, "/"],
        [5.8, "\u007f\u007f\u007f\u007f\u007f\u007f\u007f"],
        [6.0, "needleB"],
        [6.3, "\u000d"],
        [7.0, "q"],
      ],
    );
    assert.ok(result);
    assert.equal(result.status, 0);
    const footerAtChunk = footerSnapshots(result);
    const beforeQuit = footerAtChunk.at(-2) ?? "";
    assert.match(beforeQuit, /needleB/);
    assert.doesNotMatch(beforeQuit, /needleA/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("height-only PTY resize repaints the newly exposed viewport without full reflow", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [navigationFixture],
    [
      [2.5, { type: "resize", rows: 20, cols: 80 }],
      [4.0, "q"],
    ],
    { PTY_ROWS: "10", PTY_COLS: "80" },
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  const afterResize = visibleText(result.chunks[0] ?? "");
  assert.match(afterResize, /Navigation\s*line\s*1[0-3]/);
  assert.doesNotMatch(afterResize, /正在渲染 0%/);
  assert.match(result.output, /\x1b\[\?1049l/);
});

test("height-only resize clamps a bottom-pinned viewport back to 100%", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [navigationFixture],
    [
      [2.5, "G"],
      [3.5, { type: "resize", rows: 20, cols: 80 }],
      [5.0, "q"],
    ],
    { PTY_ROWS: "10", PTY_COLS: "80" },
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  const afterResize = visibleText(result.chunks[1] ?? "");
  assert.match(afterResize, /100%/);
  assert.match(afterResize, /Navigation\s*line\s*[2-4][0-9]/);
  assert.doesNotMatch(afterResize, /12[0-9]%/);
  assert.match(result.output, /\x1b\[\?1049l/);
});

test("0.4 Background is dark by default and b toggles terminal/dark without probes", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [fixture],
    [
      [1.8, "/"],
      [2.1, "Alpha中文Beta"],
      [2.5, "\u000d"],
      [3.2, "b"],
      [4.5, "b"],
      [5.8, "q"],
    ],
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  const visible = visibleText(result.output);
  assert.match(visible, /Background: Dark/);
  assert.match(visible, /Background: Terminal/);
  assert.match(visible, /Search[\s\S]{0,40}Alpha中文Beta/);
  assert.match(visible, /1\/2/);
  assert.doesNotMatch(result.output, /\x1b\[\?996n|\x1b\]11;\?/i);
  assert.match(result.output, /\x1b\[\?1049l/);
});

test("Terminal background search current match stays bright and outlined", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [fixture],
    [
      [1.8, "/"],
      [2.1, "Alpha中文Beta"],
      [2.5, "\u000d"],
      [3.2, "b"],
      [4.4, "q"],
    ],
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  assert.ok(hasOutlinedCurrentMatch(result.chunks[3] ?? "", true), "Terminal match must publish bold underline SGR without forced foreground");
  assert.doesNotMatch(result.chunks[3] ?? "", /\x1b\[7m|\x1b\[[0-9;]*(?:4[0-9]|10[0-9])m/);
});

test("rapid b toggling keeps the input owner and later keys usable", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [fixture],
    [
      [0.14, "b"],
      [0.20, "b"],
      [0.26, "b"],
      [1.10, "q"],
    ],
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  assert.match(visibleText(result.output), /Background: Dark/);
  assert.match(visibleText(result.output), /Background: Terminal/);
  assert.doesNotMatch(result.output, /\x1b\[\?996n|\x1b\]11;\?/i);
  assert.match(result.output, /\x1b\[\?1049l/);
});

test("language modal survives Background changes, filtering, arrows and Esc/Enter", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [fixture],
    [
      [2.4, "b"],
      [2.8, "l"],
      [3.2, "zh"],
      [3.5, "\x1b[A"],
      [3.7, "\x1b[B"],
      [3.9, "\x1b"],
      [4.3, "b"],
      [4.7, "l"],
      [5.1, "zh"],
      [5.4, "\x1b[B"],
      [5.6, "\r"],
      [6.8, "q"],
    ],
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  assert.match(result.output, /Background: Terminal/);
  assert.match(result.output, /Background: Dark/);
  assert.match(visibleText(result.output), /背景:深色|文本选择/);
  assert.doesNotMatch(result.output, /Cannot read properties of undefined/);
  assert.match(result.output, /\x1b\[\?1049l/);
});

test("language modal is keyboard-only with --no-mouse and applies zh-CN", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    ["--no-mouse", fixture],
    [
      [2.4, "b"],
      [2.8, "l"],
      [3.2, "zh"],
      [3.5, "\x1b[A"],
      [3.7, "\x1b[B"],
      [3.9, "\r"],
      [5.2, "q"],
    ],
    { PTY_TERM: "xterm-256color" },
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.output, mouseModeEnable, "--no-mouse must not enable widget mouse modes");
  assert.match(result.output, /Background: Terminal/);
  assert.match(visibleText(result.output), /背景:终端|文本选择:终端原生/);
  assert.match(result.output, /\x1b\[\?1049l/);
});

test("fallback mouse notice follows the active language in both directions", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [fixture],
    [
      [2.2, "l"],
      [2.6, "zh"],
      [2.9, "\r"],
      [3.8, "l"],
      [4.2, "en"],
      [4.5, "\r"],
      [5.0, { type: "resize", rows: 30, cols: 80 }],
      [6.2, "q"],
    ],
    { PTY_TERM: "dumb" },
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  assert.match(result.output, /Mouse[\s\S]{0,200}terminal-native/);
  assert.match(result.output, /鼠标[\s\S]{0,200}终端原生/);
  assert.doesNotMatch(result.output, mouseModeEnable);
});

test("language modal keeps q, b and m as filter input until it closes", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [fixture],
    [[2.2, "l"], [2.6, "q"], [2.9, "b"], [3.2, "m"], [3.8, "\x1b"], [4.6, "q"]],
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  assert.ok(terminalSnapshots(result).some((snapshot) => snapshot.includes("No matching languages")));
  assert.doesNotMatch(result.output, /Background: Terminal/);
  assert.doesNotMatch(result.output, /Selection: Auto-copy/);
  assert.match(result.output, /\x1b\[\?1049l/);
});

test("TOC focus accepts Background toggle and restores TOC after language Esc", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    ["--toc", fixture],
    [[2.2, "b"], [2.6, "l"], [3.0, "zh"], [3.3, "\x1b"], [3.7, "b"], [4.8, "q"]],
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  assert.match(visibleText(result.output), /Background: Terminal/);
  assert.match(visibleText(result.output), /Background: Dark/);
  assert.match(result.output, /\x1b\[\?1049l/);
});

test("TOC focus survives language Enter and still handles a TOC jump", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    ["--toc", fixture],
    [[2.2, "l"], [2.6, "zh"], [2.9, "\r"], [3.5, "\x1b[B"], [3.8, "\r"], [5.0, "q"]],
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  assert.match(visibleText(result.output), /目录|列表与任务/);
  assert.match(visibleText(result.output), /列表与任务/);
  assert.doesNotMatch(result.output, /Cannot read properties of undefined/);
  assert.match(result.output, /\x1b\[\?1049l/);
});

test("TOC keyboard selection survives language apply and jumps the same non-current entry", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    ["--toc", fixture],
    [
      [2.0, "\x1b[B"],
      [2.2, "\x1b[B"],
      [2.5, "l"],
      [2.9, "zh"],
      [3.2, "\r"],
      [4.3, "\r"],
      [5.5, "q"],
    ],
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  const visible = visibleText(result.output);
  assert.match(visible, /阅读不是把文字搬进眼睛/);
  assert.doesNotMatch(visible, /Cannot read properties of undefined/);
});

test("TOC toggle and resize reflow clear a live body selection", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const result = runPty(
    [navigationFixture],
    [
      [2, "m"],
      [2.4, bodyMouseDown],
      [2.5, bodyMouseMove],
      [2.6, bodyMouseUp],
      [3.0, "t"],
      [4.0, "t"],
      [4.3, bodyMouseDown],
      [4.4, bodyMouseMove],
      [4.5, bodyMouseUp],
      [4.9, { type: "resize", rows: 24, cols: 70 }],
      [6.0, "q"],
    ],
  );
  assert.ok(result);
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.chunks[4], /\x1b\[(?:97;44;1|1;44;97)m/, "TOC reflow must clear selection");
  assert.doesNotMatch(
    lastFullScreenFrame(result.chunks[9] ?? ""),
    /\x1b\[(?:97;44;1|1;44;97)m/,
    "resize reflow must clear selection in the committed full frame",
  );
});
