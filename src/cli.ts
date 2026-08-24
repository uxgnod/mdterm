import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

import packageJson from "../package.json";
import { loadConfig, type ConfigIssue } from "./config";
import { runApp } from "./app";
import { messages, type Locale } from "./i18n";

interface CliOptions {
  filePath?: string;
  mouse: boolean;
  toc: boolean;
  help: boolean;
  version: boolean;
  locale: Locale;
}

function helpText(locale: Locale, mouse = true): string {
  const copy = messages(locale);
  return [
    copy.appTitle,
    "",
    `${copy.usage}`,
    "  md <file.md> [--no-mouse] [--toc] [--lang en|zh-CN]",
    "  mdview <file.md> [--no-mouse] [--toc] [--lang en|zh-CN]",
    "",
    copy.optionsHeading,
    copy.optionNoMouse,
    copy.optionToc,
    copy.optionLang,
    copy.optionHelp,
    copy.optionVersion,
    "",
    copy.helpContentForMouse(mouse),
    "",
    copy.readerExit,
  ].join("\n");
}

function localeHint(args: readonly string[], fallback: Locale): Locale {
  const index = args.findIndex((argument) => argument === "--lang" || argument.startsWith("--lang="));
  if (index < 0) return fallback;
  const argument = args[index] ?? "";
  const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : args[index + 1];
  return value === "en" || value === "zh-CN" ? value : fallback;
}

function parseArgs(args: readonly string[], fallbackLocale: Locale): CliOptions {
  const locale = localeHint(args, fallbackLocale);
  const copy = messages(locale);
  const options: CliOptions = { mouse: true, toc: false, help: false, version: false, locale };
  let positionalOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--" && !positionalOnly) {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && (argument === "-h" || argument === "--help")) {
      options.help = true;
    } else if (!positionalOnly && (argument === "-v" || argument === "--version")) {
      options.version = true;
    } else if (!positionalOnly && argument === "--no-mouse") {
      options.mouse = false;
    } else if (!positionalOnly && argument === "--toc") {
      options.toc = true;
    } else if (!positionalOnly && (argument === "--lang" || argument.startsWith("--lang="))) {
      const value = argument.includes("=")
        ? argument.slice(argument.indexOf("=") + 1)
        : args[++index];
      if (value !== "en" && value !== "zh-CN") {
        throw new Error(`${copy.invalidLanguage(value ?? "")}\n\n${helpText(locale, options.mouse)}`);
      }
      options.locale = value;
    } else if (!positionalOnly && argument.startsWith("-")) {
      throw new Error(`${copy.unknownOption(argument)}\n\n${helpText(locale, options.mouse)}`);
    } else if (options.filePath) {
      throw new Error(`${copy.duplicateFile}\n\n${helpText(locale, options.mouse)}`);
    } else {
      options.filePath = argument;
    }
  }

  return options;
}

async function loadUtf8File(filePath: string, locale: Locale): Promise<string> {
  const copy = messages(locale);
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(copy.fileNotFound(filePath));
    if (code === "EACCES") throw new Error(copy.filePermission(filePath));
    throw new Error(copy.cannotAccessFile);
  }

  if (!fileStat.isFile()) throw new Error(copy.notFile(filePath));

  try {
    await access(filePath, fsConstants.R_OK);
  } catch {
    throw new Error(copy.filePermission(filePath));
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES") throw new Error(copy.filePermission(filePath));
    throw new Error(copy.readFailed);
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error(copy.invalidUtf8(filePath));
  }
}

function configIssueMessage(issue: ConfigIssue | undefined, locale: Locale): string {
  const copy = messages(locale);
  if (issue === "read") return copy.configReadFailed;
  if (issue === "invalid") return copy.configInvalid;
  if (issue === "backup-failed") return copy.configBackupFailed;
  if (issue === "invalid-values") return copy.configInvalidValues;
  if (issue === "write-failed") return copy.configWriteFailed;
  return "";
}

function commandError(locale: Locale, commandName: string, value: string): string {
  return messages(locale).cliError(commandName, value);
}

export async function main(args: readonly string[] = process.argv.slice(2), commandName = "md"): Promise<number> {
  const config = await loadConfig();
  let options: CliOptions;
  try {
    options = parseArgs(args, config.preferences.language);
  } catch (error) {
    const locale = localeHint(args, config.preferences.language);
    process.stderr.write(`${commandError(locale, commandName, error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  }

  const configNotice = configIssueMessage(config.issue, options.locale);
  if (configNotice) process.stderr.write(`${configNotice}\n`);

  if (options.help) {
    process.stdout.write(`${helpText(options.locale, options.mouse)}\n`);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${packageJson.version}\n`);
    return 0;
  }
  if (!options.filePath) {
    process.stderr.write(`${commandError(options.locale, commandName, messages(options.locale).missingFile)}\n\n${helpText(options.locale, options.mouse)}\n`);
    return 1;
  }

  const filePath = path.resolve(options.filePath);
  let source: string;
  try {
    source = await loadUtf8File(filePath, options.locale);
  } catch (error) {
    process.stderr.write(`${commandError(options.locale, commandName, error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`${commandError(options.locale, commandName, messages(options.locale).interactiveRequired(commandName))}\n`);
    return 1;
  }

  try {
    return await runApp({
      filePath,
      source,
      mouse: options.mouse,
      showToc: options.toc,
      locale: options.locale,
      commandName,
      background: config.preferences.background,
      selectionMode: config.preferences.selectionMode,
      configStore: config.store,
      configIssue: config.issue,
    });
  } catch (error) {
    process.stderr.write(`${commandError(options.locale, commandName, messages(options.locale).startupFailed(error instanceof Error ? error.message : String(error)))}\n`);
    return 1;
  }
}
