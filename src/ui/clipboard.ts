import { spawn, type ChildProcess } from "node:child_process";

import { messages, type Locale } from "../i18n";

export type ClipboardStatus = "copied" | "request-sent" | "failed";

export interface ClipboardResult {
  status: ClipboardStatus;
  message: string;
  characters: number;
  bytes: number;
}

export interface ClipboardOptions {
  platform?: NodeJS.Platform;
  maxBytes?: number;
  osc52MaxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  commandAvailable?: (command: string) => boolean;
  runCommand?: (
    command: string,
    args: readonly string[],
    text: string,
    signal?: AbortSignal,
  ) => boolean | Promise<boolean>;
  writeOsc52?: (sequence: string) => boolean | Promise<boolean>;
  messagePrefix?: string;
  locale?: Locale;
}

const DEFAULT_SYSTEM_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_OSC52_MAX_BYTES = 100 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;

function commandCandidates(platform: NodeJS.Platform): Array<[string, string[]]> {
  if (platform === "darwin") return [["pbcopy", []]];
  if (platform === "win32") return [["clip.exe", []]];
  return [
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
  ];
}

interface CommandResult {
  ok: boolean;
  reason?: "timeout" | "cancelled";
}

function killChild(child: ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // The child may have already exited.
  }
}

function runClipboardCommand(
  command: string,
  args: readonly string[],
  text: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch {
      resolve({ ok: false });
      return;
    }

    let finished = false;
    let reason: CommandResult["reason"];
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (ok: boolean): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ok, reason });
    };
    const stop = (nextReason: NonNullable<CommandResult["reason"]>): void => {
      reason = nextReason;
      killChild(child);
      killTimer = setTimeout(() => {
        if (!finished) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The child may have exited between the two signals.
          }
        }
      }, 250);
    };
    const onAbort = (): void => stop("cancelled");

    child.once("error", () => finish(false));
    child.once("close", (code: number | null) => finish(code === 0 && !reason));
    // stdin errors are represented by the process result; they must not
    // become unhandled errors during shutdown.
    const stdin = child.stdin;
    if (!stdin) {
      finish(false);
      return;
    }
    stdin.once("error", () => finish(false));
    stdin.end(text);
    timer = setTimeout(() => stop("timeout"), timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function writeOsc52Sequence(sequence: string): boolean {
  if (!process.stdout.isTTY) return false;
  try {
    process.stdout.write(sequence);
    return true;
  } catch {
    return false;
  }
}

export async function copyToClipboard(text: string, options: ClipboardOptions = {}): Promise<ClipboardResult> {
  const bytes = Buffer.byteLength(text, "utf8");
  const characters = Array.from(text).length;
  const maxBytes = options.maxBytes ?? DEFAULT_SYSTEM_MAX_BYTES;
  const osc52MaxBytes = options.osc52MaxBytes ?? DEFAULT_OSC52_MAX_BYTES;
  const prefix = options.messagePrefix ?? "";
  const locale = options.locale ?? "en";
  const copy = messages(locale);
  if (bytes === 0) {
    return { status: "failed", message: copy.clipboardEmpty, characters, bytes };
  }
  if (bytes > maxBytes) {
    return {
      status: "failed",
      message: copy.clipboardTooLarge(prefix || copy.selectionName, bytes, maxBytes),
      characters,
      bytes,
    };
  }
  if (options.signal?.aborted) {
    return { status: "failed", message: copy.clipboardCancelled, characters, bytes };
  }

  const platform = options.platform ?? process.platform;
  const commandAvailable = options.commandAvailable ?? (() => true);
  let timedOut = false;
  for (const [command, args] of commandCandidates(platform)) {
    if (!commandAvailable(command)) continue;
    const commandResult = options.runCommand
      ? { ok: await options.runCommand(command, args, text, options.signal) }
      : await runClipboardCommand(command, args, text, options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (commandResult.reason === "timeout") timedOut = true;
    if (commandResult.ok && !options.signal?.aborted) {
      return {
        status: "copied",
        message: copy.clipboardCopied(prefix || copy.selectionName, characters),
        characters,
        bytes,
      };
    }
    if (options.signal?.aborted) {
      return { status: "failed", message: copy.clipboardCancelled, characters, bytes };
    }
  }

  if (bytes > osc52MaxBytes) {
    return {
      status: "failed",
      message: copy.clipboardOsc52TooLarge(bytes, osc52MaxBytes),
      characters,
      bytes,
    };
  }
  if (options.signal?.aborted) {
    return { status: "failed", message: copy.clipboardCancelled, characters, bytes };
  }
  if (timedOut) {
    return { status: "failed", message: copy.clipboardTimedOut, characters, bytes };
  }
  const encoded = Buffer.from(text, "utf8").toString("base64");
  const sequence = `\u001b]52;c;${encoded}\u0007`;
  const writeOsc52 = options.writeOsc52 ?? writeOsc52Sequence;
  if (await writeOsc52(sequence)) {
    return { status: "request-sent", message: copy.clipboardRequestSent, characters, bytes };
  }
  return { status: "failed", message: copy.clipboardUnavailable, characters, bytes };
}
