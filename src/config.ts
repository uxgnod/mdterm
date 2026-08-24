import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Locale } from "./i18n";
import type { BackgroundMode } from "./theme";
import type { SelectionMode } from "./ui/selection";

export const CONFIG_MAX_BYTES = 64 * 1024;
export const DEFAULT_PREFERENCES: UserPreferences = {
  language: "en",
  background: "dark",
  selectionMode: "manual",
};

export interface UserPreferences {
  language: Locale;
  background: BackgroundMode;
  selectionMode: SelectionMode;
}

export type ConfigIssue =
  | "read"
  | "invalid"
  | "invalid-values"
  | "backup-failed"
  | "write-failed";

export interface ConfigLoadResult {
  path: string;
  preferences: UserPreferences;
  extras: Record<string, unknown>;
  issue?: ConfigIssue;
  store: ConfigStore;
}

export interface ConfigSaveResult {
  ok: boolean;
  issue?: "write-failed";
}

type KnownKey = keyof UserPreferences;

function homeDirectory(home?: string): string {
  return home ?? process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

export function configPath(home?: string): string {
  return path.join(homeDirectory(home), ".config", "mdterm", "config.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKnownKey(value: string): value is KnownKey {
  return value === "language" || value === "background" || value === "selectionMode";
}

function parsePreferences(value: Record<string, unknown>): { preferences: UserPreferences; issue?: ConfigIssue } {
  let issue: ConfigIssue | undefined;
  const language = value.language === "en" || value.language === "zh-CN" ? value.language : DEFAULT_PREFERENCES.language;
  const background = value.background === "dark" || value.background === "terminal" ? value.background : DEFAULT_PREFERENCES.background;
  const selectionMode = value.selectionMode === "manual" || value.selectionMode === "auto" || value.selectionMode === "off"
    ? value.selectionMode
    : DEFAULT_PREFERENCES.selectionMode;
  if (value.language !== undefined && language !== value.language) issue = "invalid-values";
  if (value.background !== undefined && background !== value.background) issue = "invalid-values";
  if (value.selectionMode !== undefined && selectionMode !== value.selectionMode) issue = "invalid-values";
  return { preferences: { language, background, selectionMode }, issue };
}

function extrasOf(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !isKnownKey(key)));
}

async function bestEffortChmod(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // Windows and some mounted filesystems do not expose POSIX mode bits.
  }
}

async function ensureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await bestEffortChmod(directory, 0o700);
}

async function temporaryName(target: string): Promise<string> {
  const suffix = randomBytes(8).toString("hex");
  return `${target}.tmp-${process.pid}-${suffix}`;
}

async function atomicWrite(target: string, value: Record<string, unknown>): Promise<void> {
  const directory = path.dirname(target);
  await ensureDirectory(directory);
  const temporary = await temporaryName(target);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await bestEffortChmod(temporary, 0o600);
    await rename(temporary, target);
    await bestEffortChmod(target, 0o600);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      await unlink(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

async function backupInvalidFile(target: string): Promise<boolean> {
  const backup = `${target}.invalid-${Date.now()}-${randomBytes(4).toString("hex")}`;
  try {
    await rename(target, backup);
    await bestEffortChmod(backup, 0o600);
    return true;
  } catch {
    return false;
  }
}

async function readObject(target: string): Promise<{ object?: Record<string, unknown>; issue?: ConfigIssue; missing: boolean }> {
  let buffer: Buffer;
  try {
    buffer = await readFile(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { missing: true };
    return { issue: "read", missing: false };
  }
  if (buffer.byteLength > CONFIG_MAX_BYTES) return { issue: "invalid", missing: false };
  try {
    const parsed: unknown = JSON.parse(buffer.toString("utf8"));
    return isObject(parsed) ? { object: parsed, missing: false } : { issue: "invalid", missing: false };
  } catch {
    return { issue: "invalid", missing: false };
  }
}

export class ConfigStore {
  readonly path: string;
  private preferences: UserPreferences;
  private extras: Record<string, unknown>;
  private queue: Promise<ConfigSaveResult> = Promise.resolve({ ok: true });

  constructor(target: string, preferences: UserPreferences, extras: Record<string, unknown> = {}) {
    this.path = target;
    this.preferences = { ...preferences };
    this.extras = { ...extras };
  }

  get current(): UserPreferences {
    return { ...this.preferences };
  }

  set(key: KnownKey, value: UserPreferences[KnownKey]): Promise<ConfigSaveResult> {
    this.preferences = { ...this.preferences, [key]: value };
    this.queue = this.queue.then(() => this.writeLatest());
    return this.queue;
  }

  flush(): Promise<ConfigSaveResult> {
    return this.queue;
  }

  private async writeLatest(): Promise<ConfigSaveResult> {
    try {
      const disk = await readObject(this.path);
      const diskExtras = disk.object ? extrasOf(disk.object) : {};
      this.extras = { ...this.extras, ...diskExtras };
      await atomicWrite(this.path, { ...this.extras, ...this.preferences });
      return { ok: true };
    } catch {
      return { ok: false, issue: "write-failed" };
    }
  }
}

export async function loadConfig(home?: string): Promise<ConfigLoadResult> {
  const target = configPath(home);
  const directory = path.dirname(target);
  const loaded = await readObject(target);
  if (loaded.missing) {
    const store = new ConfigStore(target, DEFAULT_PREFERENCES);
    const saved = await store.set("language", DEFAULT_PREFERENCES.language);
    return { path: target, preferences: store.current, extras: {}, issue: saved.ok ? undefined : "write-failed", store };
  }
  if (loaded.issue) {
    if (loaded.issue === "read") {
      return { path: target, preferences: { ...DEFAULT_PREFERENCES }, extras: {}, issue: "read", store: new ConfigStore(target, DEFAULT_PREFERENCES) };
    }
    const backedUp = await backupInvalidFile(target);
    const store = new ConfigStore(target, DEFAULT_PREFERENCES);
    if (backedUp) {
      const saved = await store.set("language", DEFAULT_PREFERENCES.language);
      return {
        path: target,
        preferences: store.current,
        extras: {},
        issue: saved.ok ? "invalid" : "write-failed",
        store,
      };
    }
    return { path: target, preferences: { ...DEFAULT_PREFERENCES }, extras: {}, issue: "backup-failed", store };
  }
  const value = loaded.object ?? {};
  const parsed = parsePreferences(value);
  const store = new ConfigStore(target, parsed.preferences, extrasOf(value));
  return { path: target, preferences: parsed.preferences, extras: extrasOf(value), issue: parsed.issue, store };
}
