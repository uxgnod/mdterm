# Changelog

## 0.5.0 — 2026-08-24

- Added session preferences in `~/.config/mdterm/config.json` for language, background, and selection mode. Explicit CLI values take precedence over valid saved values; writes are validated, size-limited, atomic, serialized, and non-blocking on failure, with damaged-file backups and localized notices.
- Fixed Unicode search source coordinates for case-folded matches such as `AİB` searched with `b`, while preserving combining sequences, emoji, CJK, and ANSI/grapheme boundaries in synchronous and asynchronous search.
- Kept Terminal-background search free of fixed white or inverse styling while distinguishing ordinary and current matches with supported foreground and text attributes.
- Removed application `m`/`y` actions from no-mouse and capability-fallback footer/help, so terminal-native selection is not presented with unavailable controls.
- Replaced synchronous clipboard execution with bounded, cancellable asynchronous backends: system clipboard input is limited to 4 MiB and OSC 52 has an independent 100 KiB limit. Shutdown cancels outstanding work without late UI updates.
- Completed typed English/Simplified Chinese catalog coverage for configuration failures, command-specific errors, selection labels, clipboard notices, help, and status text.
- Added the English default README and structural `README_CN.md` mirror, contributor and security guidance, MIT licensing, npm metadata for `https://github.com/uxgnod/mdterm`, and GitHub Actions CI configuration. This source preparation does not publish to npm or create remote GitHub releases.

## 0.4.0 — 2026-08-24

- Made English the default interface and added typed `en` / `zh-CN` session language switching with `--lang` and the searchable `l` dialog.
- Changed mouse-capable selection to manual by default; `m` cycles manual, auto-copy, and off. `--no-mouse` keeps terminal-native selection and does not enable application mouse protocols.
- Simplified Background to `Dark` and `Terminal`, without system-theme probing or application white-background rendering.
- Added safe `http`/`https` link hitboxes and shell-free Ctrl-click opening. Cmd-click remains best effort because modifier reporting is terminal-dependent.
- Added code-block copy feedback for Copied, Sent, and Failed with a two-second reset, including common list and blockquote nesting.
- TOC hover was not delivered; TOC remains keyboard and click based.

## 0.3.0 — 2026-08-24

- Added persistent search navigation with `n`, `p`, compatible `N`, `/` editing, and Esc clearing; current matches use bright text, bold, underline, and an optional renderer overline without inverse/background styling.
- Improved footer contrast, inline-code semantic colors, bilingual help, selection labels, viewport code-copy hitboxes, and PTY/resize/TOC regression coverage.

## 0.2.0 — 2026-08-24

- Improved inline Markdown rendering in ordered, unordered, task, and nested lists.
- Improved tight-list spacing, narrow-table width allocation, ANSI-aware code wrapping, and early text-selection/clipboard behavior.
- Added render, selection, clipboard, and installation regression coverage.
