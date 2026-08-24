import { spawn } from "node:child_process";

const MAX_URL_LENGTH = 2048;

export function validateExternalUrl(value: string): string | undefined {
  if (value.length === 0 || value.length > MAX_URL_LENGTH || /[\u0000-\u001f\u007f-\u009f\s]/u.test(value)) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function opener(platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "open", args: [] };
  if (platform === "win32") return { command: "explorer.exe", args: [] };
  return { command: "xdg-open", args: [] };
}

export function openExternalUrl(
  value: string,
  options: {
    platform?: NodeJS.Platform;
    spawnProcess?: typeof spawn;
  } = {},
): Promise<boolean> {
  const href = validateExternalUrl(value);
  if (!href) return Promise.resolve(false);
  const command = opener(options.platform ?? process.platform);
  const spawnProcess = options.spawnProcess ?? spawn;
  try {
    return new Promise((resolve) => {
      const child = spawnProcess(command.command, [...command.args, href], {
        shell: false,
        detached: true,
        stdio: "ignore",
      });
      let settled = false;
      const finish = (success: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(success);
      };
      child.once("error", () => finish(false));
      child.once("spawn", () => finish(true));
      child.unref();
    });
  } catch {
    return Promise.resolve(false);
  }
}
