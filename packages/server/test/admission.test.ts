/** The pure parts of admission: which Host names the server answers, which bind addresses are loopback, and the helpers. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  crossSiteApiRequest,
  isLoopbackBind,
  normalizeAllowHost,
  normalizeHost,
  originHosts,
  parseAllowHosts,
  safeDecode,
  safeEqual,
  trustedHost,
  trustedHostSet,
} from "../src/admission.js";
import { parseRuntimeConfig } from "../src/runtimeConfig.js";

describe("the Host header", () => {
  it("is reduced to a lower-case name: port ignored, brackets stripped from an IPv6 literal", () => {
    assert.equal(normalizeHost("127.0.0.1"), "127.0.0.1");
    assert.equal(normalizeHost("127.0.0.1:3127"), "127.0.0.1");
    assert.equal(normalizeHost("LOCALHOST"), "localhost");
    assert.equal(normalizeHost("LocalHost:3127"), "localhost");
    assert.equal(normalizeHost("[::1]:3127"), "::1");
    assert.equal(normalizeHost("[::1]"), "::1");
    assert.equal(normalizeHost("[FE80::1]:80"), "fe80::1");
    assert.equal(normalizeHost("Ancilla.Example:8443"), "ancilla.example");
  });

  it("is refused when it is missing, empty or does not name one host", () => {
    for (const bad of [undefined, "", " ", "[::1", "[::1]x", "[::1]:port", "::1", "localhost:abc", "localhost:123456", "a b", "*", "user@localhost", "http://localhost", "localhost/", "-x", "x-", "localhost."]) {
      assert.equal(normalizeHost(bad), null, `${JSON.stringify(bad)} names no host`);
    }
  });
});

describe("which hosts the server answers", () => {
  const defaults = trustedHostSet([], []);

  it("is exactly 127.0.0.1, localhost and ::1, with any port and any case", () => {
    for (const ok of ["127.0.0.1", "127.0.0.1:3127", "localhost", "LOCALHOST", "localhost:1", "[::1]:3127", "[::1]"]) {
      assert.equal(trustedHost(ok, defaults), true, ok);
    }
  });

  it("refuses 0.0.0.0, look-alike names, other loopback spellings and a missing header", () => {
    for (const bad of [
      undefined,
      "",
      "0.0.0.0",
      "0.0.0.0:3127",
      "evil.localhost",
      "evil.localhost:3127",
      "localhost.evil.example",
      "127.0.0.1.evil.example",
      "127.0.0.2:3127",
      "127.1",
      "[::2]:3127",
      "[::]:3127",
      "localhost.",
      "evil.example",
    ]) {
      assert.equal(trustedHost(bad, defaults), false, `${JSON.stringify(bad)} is not this daemon`);
    }
  });

  it("adds the --allow-host entries, the hosts of the --allow-origin URLs and the loopback address it was bound to", () => {
    const set = trustedHostSet(["Proxy.Example:8443", "[fd00::5]"], ["https://ancilla.example", "http://[fd00::6]:3000", "not a url"], "127.0.0.2");
    for (const ok of ["proxy.example", "proxy.example:1", "[fd00::5]:80", "ancilla.example", "ancilla.example:443", "[fd00::6]:3000", "127.0.0.2:3127", "127.0.0.1", "localhost"]) {
      assert.equal(trustedHost(ok, set), true, ok);
    }
    for (const bad of ["evil.example", "0.0.0.0", "evil.localhost", "other.example"]) {
      assert.equal(trustedHost(bad, set), false, bad);
    }
    // A bind to every interface, or to a name that is not loopback, is not itself a host anyone may use.
    assert.equal(trustedHost("0.0.0.0:3127", trustedHostSet([], [], "0.0.0.0")), false);
    assert.equal(trustedHost("192.168.1.9", trustedHostSet([], [], "192.168.1.9")), false);
  });

  it("reads --allow-host entries as names, URLs or host:port, and reports what it cannot use", () => {
    assert.equal(normalizeAllowHost("ancilla.example"), "ancilla.example");
    assert.equal(normalizeAllowHost(" ANCILLA.example:8443 "), "ancilla.example");
    assert.equal(normalizeAllowHost("https://ancilla.example:8443/some/path"), "ancilla.example");
    assert.equal(normalizeAllowHost("[::1]"), "::1");
    assert.equal(normalizeAllowHost("::1"), "::1");
    assert.equal(normalizeAllowHost("fd00::5"), "fd00::5");
    for (const bad of ["", "  ", "*", "*.example.com", "a b", "http://", "exa$mple.com", "host:abc"]) {
      assert.equal(normalizeAllowHost(bad), null, JSON.stringify(bad));
    }
    assert.deepEqual(parseAllowHosts(["a.example", "*", "https://b.example:9", ""]), { hosts: ["a.example", "b.example"], invalid: ["*", ""] });
  });

  it("takes the hosts of origins and skips what is not a URL", () => {
    assert.deepEqual(originHosts(["https://Ancilla.example", "http://localhost:5173", "http://[::1]:5173", "nonsense", ""]), ["ancilla.example", "localhost", "::1"]);
  });
});

describe("loopback binds", () => {
  it("are 127.0.0.0/8, localhost and ::1, with or without brackets, in any case", () => {
    for (const ok of ["127.0.0.1", "127.0.0.2", "127.255.255.254", "localhost", "LOCALHOST", "::1", "[::1]"]) {
      assert.equal(isLoopbackBind(ok), true, ok);
    }
  });

  it("are not every interface, a LAN address, a name, or an address that only looks like one", () => {
    for (const bad of ["0.0.0.0", "::", "[::]", "", " ", "192.168.1.5", "10.0.0.1", "example.com", "localhost.example", "128.0.0.1", "127.0.0.256", "127.0.0", "1270.0.0.1", "::2", "fe80::1"]) {
      assert.equal(isLoopbackBind(bad), false, JSON.stringify(bad));
    }
  });
});

describe("comparing a secret", () => {
  it("is true only for equal strings, whatever their lengths", () => {
    assert.equal(safeEqual("secret", "secret"), true);
    assert.equal(safeEqual("secret", "secreT"), false);
    assert.equal(safeEqual("secret", "secre"), false);
    assert.equal(safeEqual("secret", "secrets"), false);
    assert.equal(safeEqual("", ""), true);
    assert.equal(safeEqual("secret", ""), false);
    assert.equal(safeEqual("péñ", "péñ"), true);
    assert.equal(safeEqual("péñ", "pen"), false);
  });
});

describe("percent-decoding", () => {
  it("decodes what is valid and answers null for a malformed escape instead of throwing", () => {
    assert.equal(safeDecode("a%20b"), "a b");
    assert.equal(safeDecode("%E2%82%AC"), "€");
    assert.equal(safeDecode("plain"), "plain");
    for (const bad of ["%", "%zz", "%E0%A4%A", "%C0%80x%"]) {
      assert.equal(safeDecode(bad), null, bad);
    }
  });
});

describe("Fetch Metadata", () => {
  it("refuses a cross-site or same-site request to the API that is not a navigation", () => {
    for (const site of ["cross-site", "same-site", "Cross-Site"]) {
      for (const mode of ["no-cors", "cors", "same-origin", undefined]) {
        assert.equal(crossSiteApiRequest(site, mode, "/api/health"), true, `${site} ${mode}`);
      }
    }
  });

  it("lets through navigations, same-origin and user-initiated requests, absent headers and anything but the API", () => {
    assert.equal(crossSiteApiRequest("cross-site", "navigate", "/api/files/raw"), false);
    assert.equal(crossSiteApiRequest("same-site", "Navigate", "/api/files/raw"), false);
    assert.equal(crossSiteApiRequest("same-origin", "cors", "/api/health"), false);
    assert.equal(crossSiteApiRequest("none", "navigate", "/api/health"), false);
    assert.equal(crossSiteApiRequest(undefined, undefined, "/api/health"), false);
    assert.equal(crossSiteApiRequest(undefined, "no-cors", "/api/health"), false);
    assert.equal(crossSiteApiRequest("cross-site", "no-cors", "/"), false);
    assert.equal(crossSiteApiRequest("cross-site", "no-cors", "/assets/app.js"), false);
    assert.equal(crossSiteApiRequest("cross-site", "no-cors", "/apix"), false);
  });
});

describe("runtime.json allowHosts", () => {
  const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");

  it("keeps the usable entries as names and says what it dropped", () => {
    const { config, warnings } = parseRuntimeConfig(bytes({ allowHosts: ["Ancilla.Example:8443", "https://b.example", "*", 3, ""] }));
    assert.deepEqual(config?.allowHosts, ["ancilla.example", "b.example"]);
    assert.deepEqual(warnings.map((warning) => warning.split(":")[0]), ['"allowHosts" entry "*" was ignored', '"allowHosts" entry 3 was ignored', '"allowHosts" entry "" was ignored']);
  });

  it("ignores a value that is not a list, and leaves the key out when nothing is usable or it is absent", () => {
    const text = parseRuntimeConfig(bytes({ allowHosts: "ancilla.example" }));
    assert.equal(text.config?.allowHosts, undefined);
    assert.deepEqual(text.warnings, ['"allowHosts" was ignored: it must be a list of host names, not string']);
    assert.equal("allowHosts" in (parseRuntimeConfig(bytes({ allowHosts: [] })).config ?? {}), false);
    assert.equal("allowHosts" in (parseRuntimeConfig(bytes({ distro: "Ubuntu" })).config ?? {}), false);
  });
});
