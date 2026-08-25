const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// npm test remains strict by default. Hosted CI sets this to 0 because its
// scheduler is not a stable wall-clock performance benchmark.
const enforceWallClockBudgets = process.env.MDTERM_ENFORCE_WALL_CLOCK_BUDGETS !== "0";

const startupProbe = String.raw`
import json, os, pty, select, signal, struct, termios, time, fcntl

node = os.environ["MDTERM_NODE"]
cli = os.environ["MDTERM_CLI"]
filename = os.environ["MDTERM_STARTUP_FILE"]
cases = json.loads(os.environ["MDTERM_STARTUP_CASES"])
samples = []

for label, colorfgbg in cases:
    for _ in range(3):
        started = time.perf_counter()
        pid, fd = pty.fork()
        if pid == 0:
            os.environ["TERM"] = "xterm-256color"
            if colorfgbg is None:
                os.environ.pop("COLORFGBG", None)
            else:
                os.environ["COLORFGBG"] = colorfgbg
            os.execv(node, [node, cli, filename])
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 120, 0, 0))
        output = bytearray()
        tui_ms = None
        body_ms = None
        sent_q = False
        status = None
        deadline = time.perf_counter() + 5
        while time.perf_counter() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.02)
            if ready:
                try:
                    output.extend(os.read(fd, 65536))
                except OSError:
                    break
                if tui_ms is None and b"\x1b[?1049h" in output:
                    tui_ms = (time.perf_counter() - started) * 1000
                if body_ms is None and "启动基准".encode("utf-8") in output:
                    body_ms = (time.perf_counter() - started) * 1000
                    os.write(fd, b"q")
                    sent_q = True
            waited, child_status = os.waitpid(pid, os.WNOHANG)
            if waited == pid:
                status = os.waitstatus_to_exitcode(child_status)
                break
        if status is None:
            os.kill(pid, signal.SIGKILL)
            _, child_status = os.waitpid(pid, 0)
            status = os.waitstatus_to_exitcode(child_status)
        if not sent_q or tui_ms is None or body_ms is None:
            raise SystemExit("startup probe did not reach the interactive TUI")
        samples.append({"case": label, "tuiMs": tui_ms, "bodyMs": body_ms, "status": status, "restored": b"\x1b[?1049l" in output, "probes": b"\x1b[?996n" in output or b"\x1b]11;" in output})

print(json.dumps(samples))
`;

test("1 MiB startup reaches an interactive TUI in under 300ms without theme probing", (context) => {
  if (process.platform === "win32" || spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 PTY helper is unavailable");
    return;
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "mdterm-startup-"));
  const home = mkdtempSync(path.join(os.tmpdir(), "mdterm-startup-home-"));
  const filename = path.join(directory, "one-megabyte.md");
  const block = Buffer.from("# 启动基准\n\n```text\n" + "x".repeat(4096) + "\n```\n");
  const payload = Buffer.alloc(1_048_576);
  for (let offset = 0; offset < payload.length; offset += block.length) {
    block.copy(payload, offset, 0, Math.min(block.length, payload.length - offset));
  }
  writeFileSync(filename, payload);
  try {
    const result = spawnSync("python3", ["-c", startupProbe], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        MDTERM_NODE: process.execPath,
        MDTERM_CLI: path.join(__dirname, "..", "dist", "cli.js"),
        MDTERM_STARTUP_FILE: filename,
        MDTERM_STARTUP_CASES: JSON.stringify([
          ["dark-default", "0;0"],
          ["dark-colorfgbg-ignored", "0;15"],
        ]),
        HOME: home,
        USERPROFILE: home,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const samples = JSON.parse(result.stdout);
    assert.equal(samples.length, 6);
    assert.ok(samples.every((sample) => sample.status === 0 && sample.restored));
    assert.ok(samples.every((sample) => !sample.probes), JSON.stringify(samples));
    for (const caseName of ["dark-default", "dark-colorfgbg-ignored"]) {
      const caseSamples = samples.filter((sample) => sample.case === caseName);
      assert.equal(caseSamples.length, 3);
      const maxTuiMs = Math.max(...caseSamples.map((sample) => sample.tuiMs));
      const maxBodyMs = Math.max(...caseSamples.map((sample) => sample.bodyMs));
      if (enforceWallClockBudgets) {
        assert.ok(maxTuiMs < 300, JSON.stringify(samples));
        assert.ok(maxBodyMs < 300, JSON.stringify(samples));
      }
    }
    if (!enforceWallClockBudgets) {
      const summary = ["dark-default", "dark-colorfgbg-ignored"].map((caseName) => {
        const caseSamples = samples.filter((sample) => sample.case === caseName);
        return `${caseName} tui=${Math.max(...caseSamples.map((sample) => sample.tuiMs)).toFixed(1)}ms body=${Math.max(...caseSamples.map((sample) => sample.bodyMs)).toFixed(1)}ms`;
      });
      console.log(`diagnostic: hosted runner does not enforce wall-clock budget for startup; wall-clock assertions disabled (${summary.join("; ")}). Functional TUI, restoration, and no-theme-probe assertions remain enforced.`);
    }
    if (process.env.MDTERM_STARTUP_VERBOSE === "1") console.log(JSON.stringify(samples));
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
