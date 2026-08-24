# Contributing to mdterm

Thank you for helping improve mdterm. Changes should keep the reader read-only, preserve terminal safety, and remain usable on Node.js 18 and newer.

## Development setup

```bash
npm install
npm run typecheck
npm run build
npm test
```

The supported test matrix is Node.js 18, 22, and the current supported Node release. The test command runs serially because startup and PTY timing tests are intentionally sensitive to CPU contention. Windows runs the non-PTY unit, render, CLI, configuration, search, language, theme, and clipboard coverage; PTY coverage is exercised on Unix-like CI runners.

Tests use temporary `HOME` directories and injected clipboard/opener backends. Do not point them at a real `~/.config/mdterm`, write to a global npm prefix, or use a real personal clipboard. New tests should keep that isolation and should assert the user-visible behavior rather than only internal flags.

## Scope and review

Keep patches focused. For terminal input, file paths, URLs, clipboard data, and configuration text, preserve the existing sanitization and shell-free process boundaries. Do not add a system-theme probe, background color mutation, configuration framework, telemetry, or file watcher without a product decision.

Before opening a change, run typecheck, build, and the relevant targeted tests. For release-facing changes, also run the complete serial suite and inspect the npm pack contents with a temporary prefix. Do not commit `dist/`, temporary tarballs, private checklists, local paths, or credentials.

## Commit messages

Use a short imperative subject, for example:

```text
Fix Unicode search source coordinates
```

Explain compatibility or security-sensitive behavior in the body when it is not obvious from the subject.
