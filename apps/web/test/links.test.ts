import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { externalHref } from "../src/links.js";

describe("externalHref URL filtering and external navigation routing", () => {
  const applicationOrigin = "http://127.0.0.1:48291";

  it("routes external HTTP/HTTPS websites and mailto links to the system browser", () => {
    assert.equal(
      externalHref("https://ancilla.dev/documentation", applicationOrigin),
      "https://ancilla.dev/documentation",
    );
    assert.equal(
      externalHref("mailto:contact@ancilla.dev", applicationOrigin),
      "mailto:contact@ancilla.dev",
    );
    assert.equal(
      externalHref("https://github.com/aleff-ferreira/ancilla/pull/42", applicationOrigin),
      "https://github.com/aleff-ferreira/ancilla/pull/42",
    );
  });

  it("retains internal routes, relative paths, same-origin endpoints, and scripts inside the app", () => {
    assert.equal(externalHref("/threads/session-991", applicationOrigin), null);
    assert.equal(externalHref("packages/ui/src/index.ts#L10", applicationOrigin), null);
    assert.equal(
      externalHref("http://127.0.0.1:48291/api/v1/sessions", applicationOrigin),
      null,
    );
    assert.equal(externalHref("javascript:void(0)", applicationOrigin), null);
  });
});
