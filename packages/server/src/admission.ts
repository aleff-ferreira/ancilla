import { createHash, timingSafeEqual } from "node:crypto";

/**
 * What the server lets in, as pure functions. A server on 127.0.0.1 answers any page in the user's browser that can
 * reach the port, so the first fence is the `Host` header: a page that was rebound to the loopback address
 * (DNS rebinding) still names its own host, which is not one of ours. The check is not a login; it is what makes a
 * request that names some other site recognisable.
 */

/** The names the daemon always answers to. Everything else must be listed on purpose. */
export const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "::1"];

const NAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const IPV6 = /^[0-9a-f:.]*:[0-9a-f:.]*$/;
const PORT = /^\d{0,5}$/;

/**
 * The host name in a `Host` header or a host setting: lower case, with the port dropped and the brackets taken off an
 * IPv6 literal. Null when it does not name exactly one host (empty, a trailing dot, a space, a wildcard, an
 * unbracketed IPv6 address, a port that is not digits).
 */
export function normalizeHost(raw: string | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (!value) {
    return null;
  }
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close === -1 || !/^(?::\d{0,5})?$/.test(value.slice(close + 1))) {
      return null;
    }
    const inside = value.slice(1, close);
    return IPV6.test(inside) ? inside : null;
  }
  const colon = value.indexOf(":");
  if (colon !== value.lastIndexOf(":")) {
    return null;
  }
  const name = colon === -1 ? value : value.slice(0, colon);
  if (colon !== -1 && !PORT.test(value.slice(colon + 1))) {
    return null;
  }
  return NAME.test(name) ? name : null;
}

/**
 * A `--allow-host` or `allowHosts` entry: a name, `name:port`, a bracketed or bare IPv6 address, or the URL the
 * proxy is reached at (`https://ancilla.example:8443/`). Null for anything that is not one host, wildcards included.
 */
export function normalizeAllowHost(raw: string): string | null {
  const value = raw.trim();
  if (value.includes("://")) {
    try {
      return normalizeHost(new URL(value).host);
    } catch {
      return null;
    }
  }
  const lower = value.toLowerCase();
  if ((lower.match(/:/g) ?? []).length >= 2 && !lower.startsWith("[") && IPV6.test(lower)) {
    return lower;
  }
  return normalizeHost(value);
}

/** Splits entries into the host names they stand for and the entries that name none. */
export function parseAllowHosts(raw: readonly string[]): { hosts: string[]; invalid: string[] } {
  const hosts: string[] = [];
  const invalid: string[] = [];
  for (const entry of raw) {
    const host = normalizeAllowHost(entry);
    if (host === null) {
      invalid.push(entry);
    } else if (!hosts.includes(host)) {
      hosts.push(host);
    }
  }
  return { hosts, invalid };
}

/** The hosts of the `--allow-origin` URLs: a page served from there reaches the daemon under that name. */
export function originHosts(origins: readonly string[]): string[] {
  const hosts: string[] = [];
  for (const origin of origins) {
    try {
      const host = normalizeHost(new URL(origin).host);
      if (host !== null) {
        hosts.push(host);
      }
    } catch {
      /* not a URL: it is no origin either, and cors() never matches it */
    }
  }
  return hosts;
}

/**
 * Whether a bind address is on this machine only: 127.0.0.0/8, `localhost` and `::1`. Anything else (`0.0.0.0`, `::`,
 * a LAN address, a name that is not localhost, an empty string, which binds every interface) is reachable by others.
 */
export function isLoopbackBind(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (name === "localhost" || name === "::1") {
    return true;
  }
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name);
  return octets !== null && octets.slice(1).every((part) => Number(part) <= 255);
}

/**
 * Every host name the daemon answers: the loopback ones, the configured ones, the hosts of the allowed origins and,
 * when it was bound to one specific loopback address, that address. Binding to `0.0.0.0` or a LAN address adds
 * nothing: those are not names a client uses.
 */
export function trustedHostSet(allowHosts: readonly string[], allowOrigins: readonly string[], bindHost?: string): ReadonlySet<string> {
  const set = new Set<string>(LOOPBACK_HOSTS);
  for (const entry of allowHosts) {
    const host = normalizeAllowHost(entry);
    if (host !== null) {
      set.add(host);
    }
  }
  for (const host of originHosts(allowOrigins)) {
    set.add(host);
  }
  if (bindHost !== undefined && isLoopbackBind(bindHost)) {
    const host = normalizeAllowHost(bindHost);
    if (host !== null) {
      set.add(host);
    }
  }
  return set;
}

/** Whether the request's `Host` header names one of `trusted`. A missing or malformed header names none. */
export function trustedHost(header: string | undefined, trusted: ReadonlySet<string>): boolean {
  const host = normalizeHost(header);
  return host !== null && trusted.has(host);
}

/** Compares two secrets without the time depending on where they first differ, or on how long they are. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** `decodeURIComponent` that answers null for a malformed escape instead of throwing. */
export function safeDecode(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Fetch Metadata: a browser tags every request with the relation of the page that started it to this server. A
 * request to the API from another site (or another origin of the same site) that is not the user navigating is
 * never the app itself; refusing it also stops a page's `<img>`, `<video>` and no-cors `fetch` from reaching GETs
 * that carry no `Origin`. Absent headers (older webviews send none) are not refused.
 */
export function crossSiteApiRequest(site: string | undefined, mode: string | undefined, path: string): boolean {
  if (!path.startsWith("/api/")) {
    return false;
  }
  if (mode?.toLowerCase() === "navigate") {
    return false;
  }
  const relation = site?.toLowerCase();
  return relation === "cross-site" || relation === "same-site";
}
