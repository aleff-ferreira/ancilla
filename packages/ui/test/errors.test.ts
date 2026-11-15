import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stuckThread } from "../src/model/errors.js";

describe("stuckThread error classification and remediation", () => {
  it("identifies unreadable image errors that compromise future conversation turns", () => {
    const diagnostic = stuckThread(
      "API error 400 [request_id=req_img_99]: invalid image data at input[4].content[0]: the `image/png` payload could not be decoded (corrupt image payload). (invalid_request_error)",
    );

    assert.equal(diagnostic?.kind, "image");
    assert.equal(diagnostic?.remedy, "compact");
    assert.match(diagnostic?.message ?? "", /Compacting/);
  });

  it("detects incompatible reasoning history that cannot be replayed after a provider switch", () => {
    const diagnostic = stuckThread(
      "provider-private history is incompatible with the active route: reasoning replay `rs_stream_01:rs_stream_02` has no provider attribution after a provider switch; start a fresh turn without opaque reasoning history",
    );

    assert.equal(diagnostic?.kind, "reasoning");
    assert.equal(diagnostic?.remedy, "fresh");
    assert.match(diagnostic?.message ?? "", /new thread/i);
  });

  it("distinguishes current turn image upload errors from historical thread image corruption", () => {
    const errorMessage =
      "API error 400: invalid image data at input[2].content[0]: payload could not be decoded.";

    const ownImagesDiagnostic = stuckThread(errorMessage, { ownImages: true });
    assert.equal(ownImagesDiagnostic?.kind, "image");
    assert.equal(ownImagesDiagnostic?.remedy, "none");
    assert.match(ownImagesDiagnostic?.message ?? "", /sent with this message/);
    assert.match(ownImagesDiagnostic?.message ?? "", /older image/);

    assert.equal(stuckThread(errorMessage, { ownImages: false })?.remedy, "compact");
    assert.equal(stuckThread(errorMessage)?.remedy, "compact");
  });

  it("ignores standard operational errors without classifying them as stuck states", () => {
    assert.equal(stuckThread("API error 429: Rate limit or subscription quota exceeded."), null);
    assert.equal(stuckThread("The agent turn failed unexpectedly."), null);
    assert.equal(stuckThread(""), null);
    assert.equal(stuckThread(null), null);
    assert.equal(stuckThread(undefined), null);
  });
});
