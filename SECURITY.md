# Security Policy

## Supported versions

Security fixes land on `main` first and ship in the next release.

| Version | Supported |
| ------- | --------- |
| `main` | ✅ |
| latest release | ✅ |
| older releases | ❌ |

## Threat model

Ancilla's server (the desktop app's bundled sidecar, or `ancilla-server`) drives Muse under your account and can run
commands in your project folders: the `!` shell in a thread, file writes, the approval decisions Muse asks for. Whoever
can send it requests can do what you can do in a terminal in those folders. That access is what the checks below
protect.

**What is protected**

- *Other machines.* The server listens on `127.0.0.1` unless you pass `--host`. It refuses to listen on any
  non-loopback address without `--token`; every address in `127.0.0.0/8`, `localhost` and `::1` need none.
- *Other websites in your browser.* A page you visit can send requests to `127.0.0.1`, and a page can be rebound (DNS
  rebinding) so that its own name resolves to your machine. The server therefore:
  - answers only when the `Host` header names `127.0.0.1`, `localhost` or `::1`, or a name you listed with
    `--allow-host` or `allowHosts` in `runtime.json` (or the host of an `--allow-origin`). This runs first, for every
    request. A request that carries the token as `Authorization: Bearer` skips it, because a web page does not hold the
    token and so cannot send a valid Bearer; this keeps a loopback server behind a proxy usable for clients that hold
    the token. A cookie or a token in the URL does not skip it. A server bound to one specific loopback address
    (`--host 127.0.0.2`) trusts that address as a `Host` as well;
  - sends no CORS headers to an origin that was not passed to `--allow-origin`, and does not accept a token in the URL
    from another site's origin;
  - while no origin is listed, refuses API requests that a browser marks as `cross-site` or `same-site`, except page
    navigations (browsers that send no Fetch Metadata are not affected);
  - sends `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` with its JSON answers and its page, so another
    site cannot embed Ancilla. Project files served for preview are not covered, because the in-app PDF preview frames
    them from the same origin.
- *Guessing the token.* `--token` is compared in constant time, and the handshake (`POST /api/auth`) takes a body only as
  large as a token could make it (a few kilobytes, more for a very long token). There is no lockout or rate limit: use a long random token (`openssl rand -hex 24`).

**Token semantics.** With `--token`, every `/api/` request needs the token as `Authorization: Bearer <token>`, as the
`ancilla_token` cookie that `POST /api/auth` sets (the event stream and images cannot carry a header), or, for requests
with no foreign origin, as `?token=`. Any one of them is enough. A token on the command line shows in the process list
to other users of the machine, and a copied `?token=` link works as a password; treat both accordingly. The server
speaks plain HTTP: reaching it across a network needs TLS or a tunnel in front of it.

**What is not protected**

- *Any process running as you, or any user of the same machine.* Without `--token` the server answers whatever connects
  to its loopback port, and a process that can connect can also send the right `Host`. The desktop app's sidecar has no
  token yet, and a server started without `--token` now logs a warning that it will need one in a later release. Muse
  itself, when its sandbox is off or in YOLO mode, is such a process.
- *A holder of the token.* There is no per-route or per-folder permission: the token is full access, as it is for the
  person who started the server.
- *The sandbox and approvals.* These belong to Muse; Ancilla shows and relays them and does not restrict what Muse's
  own delegation can do.
- *The network path.* A hostname that points at the server (proxy, tunnel, port forward) is trusted once it is listed.

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
