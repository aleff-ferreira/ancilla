# Security Policy

## Release Support

Security updates are committed to `main` and shipped in the subsequent tagged release:

- **`main` & latest release:** Actively maintained.
- **Older releases:** Unsupported.

## Threat Model & Protections

The Ancilla server (`ancilla-server`, or the embedded desktop sidecar) launches AI CLI hosts and executes approved workspace actions on the host machine. Any client authorized to call the API holds terminal-equivalent capabilities within configured project directories.

### Built-in Mitigations

1. **Loopback default & required authentication:**
   - Without `--host`, the server binds exclusively to `127.0.0.1`.
   - Binding to any non-loopback address (`127.0.0.0/8`, `localhost`, and `::1` excluded) fails unless `--token` is supplied.
2. **DNS rebinding & cross-origin isolation:**
   - Every incoming request is verified against its `Host` header before route execution. Only loopback names (`127.0.0.1`, `localhost`, `::1`, or a specifically bound loopback IP) and explicitly allowed hosts (`--allow-host`, `allowHosts` in `runtime.json`, or the host component of `--allow-origin`) are accepted—unless the request carries a valid `Authorization: Bearer` header.
   - Cross-origin CORS headers are withheld for unlisted origins, and URL `?token=` logins from foreign origins are denied.
   - Without `--allow-origin`, browser `Sec-Fetch-Site` requests marked `cross-site` or `same-site` are rejected for API calls.
   - `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` headers block third-party iframe framing while preserving same-origin document previews.
3. **Token verification & scoping:**
   - Bearer tokens passed via `--token` are validated using constant-time comparison with bounded `POST /api/auth` payload parsing. Use high-entropy random secrets (`openssl rand -hex 24`).
   - Authentication accepts `Authorization: Bearer <token>`, the HTTP cookie set by `POST /api/auth` (`ancilla_token` for `EventSource` and `<img>` loads), or same-origin `?token=` queries. Notice that CLI flags are visible to local process inspectors and plain HTTP requires TLS or a tunnel over untrusted networks.

### Explicitly Out of Scope

- **Same-user or unrestricted local loopback processes:** Processes sharing the same OS user account or reaching an unauthenticated loopback server can invoke API endpoints directly. When YOLO mode or disabled sandboxing is active, connected CLI tools themselves execute with user-level access.
- **Bearer token holders:** Tokens confer full server permissions rather than per-folder or per-endpoint ACLs.
- **CLI sandboxing & configured network proxies:** Sandbox isolation and approval rules remain enforced by the underlying CLI (`muse`, `codex`, `claude`, etc.), and any hostname listed in `allowHosts` is trusted.

## Reporting a Vulnerability

Disclose potential vulnerabilities privately using [GitHub Security Advisories](https://github.com/aleff-ferreira/ancilla/security/advisories/new) (**Security > Report a vulnerability**). Do not file public issues for authentication bypasses, credential leaks, path traversal, or remote execution bugs.

Include reproduction steps, Ancilla version (`Settings`), OS/runtime mode (native or WSL2), `muse --version`, and approval/sandbox settings, stripping any secrets or private session logs. Initial acknowledgement targets 72 hours.
