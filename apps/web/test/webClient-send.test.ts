import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { AncillaError, noAnswer } from "@ancilla/ui";

/**
 * What a prompt send reports when the daemon does not answer: a client error with status 0, which the thread reads
 * as "no answer, so it may have gone" rather than "not sent". An error the daemon did send keeps its own status.
 */

function installBrowser(): void {
  const globals = globalThis as Record<string, unknown>;
  globals["window"] = {
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { search: "", pathname: "/", hash: "" },
    history: { replaceState: () => {} },
  };
  globals["EventSource"] = class {
    addEventListener(): void {}
    close(): void {}
  };
}

let seq = 0;
async function freshClient() {
  seq += 1;
  installBrowser();
  const module = (await import(`../src/webClient.js?send=${seq}`)) as typeof import("../src/webClient.js");
  return new module.WebAncillaClient();
}

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

describe("a send the daemon never answers", () => {
  it("fails with no status after the call's wait, which the thread treats as an unconfirmed send", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const client = await freshClient();
    mock.method(globalThis, "fetch", (_target: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    );
    const sending = client.sendTurn("s1", "hello");
    const outcome = sending.then(
      () => null,
      (error: unknown) => error,
    );
    mock.timers.tick(60_000);
    const error = await outcome;
    assert.ok(error instanceof AncillaError);
    assert.equal(error.status, 0);
    assert.match(error.message, /took too long/);
    assert.equal(noAnswer(error), true);
  });

  it("fails with no status when the daemon cannot be reached", async () => {
    const client = await freshClient();
    mock.method(globalThis, "fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const error = await client.sendTurn("s1", "hello").then(
      () => null,
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof AncillaError);
    assert.equal(error.status, 0);
    assert.equal(noAnswer(error), true);
  });

  it("keeps the daemon's own status when it did answer with an error", async () => {
    const client = await freshClient();
    mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "Muse said no", kind: "turnRefused" }), { status: 409, headers: { "content-type": "application/json" } }));
    const error = await client.sendTurn("s1", "hello").then(
      () => null,
      (reason: unknown) => reason,
    );
    assert.ok(error instanceof AncillaError);
    assert.equal(error.status, 409);
    assert.equal(error.kind, "turnRefused");
    assert.equal(noAnswer(error), false, "an answer, however bad, is a definite refusal");
  });
});
