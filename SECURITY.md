# Security Policy

## Supported versions

Security fixes land on `main` first and ship in the next release.

| Version | Supported |
| ------- | --------- |
| `main` | ✅ |
| latest release | ✅ |
| older releases | ❌ |

## Reporting a vulnerability

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/aleff-ferreira/ancilla/security/advisories/new) for this
repository (**Security > Report a vulnerability**). Please do not open a public issue for credentials, auth bypass,
sandbox escape, remote-daemon access, path traversal in the file viewer, or WSL command-injection concerns.

Please include:

- steps to reproduce
- the Ancilla version (Settings shows it), and desktop or web
- your OS, and whether Muse runs natively on Windows or inside WSL2
- `muse --version`
- whether approval modes, the sandbox or YOLO mode were involved

Leave out tokens, `auth.json` contents and private logs; if a log is needed, redact it first.

We aim to acknowledge a report within 72 hours and will coordinate disclosure with you.
