# Security policy

## Supported versions

The latest `0.5.x` release is the supported line. Older versions may not receive security fixes.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this project:

<https://github.com/uxgnod/mdterm/security/advisories/new>

Do not post a suspected vulnerability, terminal escape sequence, credential, or private document in a public issue. Include the affected version, operating system and Node.js version, a minimal reproduction that uses synthetic input where possible, and the security impact. We will acknowledge reports as soon as practical and coordinate disclosure after a fix is available.

mdterm is a local terminal reader. It does not upload documents, open arbitrary URLs, or run Markdown as shell code. Link opening is restricted to `http` and `https` and uses argument arrays without a shell; clipboard backends are bounded and cancellable. These boundaries are defense-in-depth, not a promise that every terminal emulator or operating-system integration is identical.
