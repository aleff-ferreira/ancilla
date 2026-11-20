/**
 * The spoken-interruption pilot is a setting that is off by default, and off it must change nothing: a call has to be
 * exactly what version 0.30.0 made of it. The proof is not an argument but a comparison: the call scenarios of
 * `voice-golden.ts` were run on a build of v0.30.0 (`scripts/voice/golden.mjs`), what each call said, played and recorded
 * was kept in `fixtures/voice-golden-v0.30.0.json`, and every way of being off is held to those traces to the message, the
 * sample and the virtual millisecond. The pilot also needs a page that can pause and a microphone that cancels echo: when
 * either is missing, switching the setting on changes nothing either.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { join, resolve } from "node:path";
import { GOLDEN_SCENARIO_NAMES, runGolden, type GoldenTrace } from "./voice-golden.js";

const golden = JSON.parse(readFileSync(join(resolve(__dirname, "..", ".."), "test", "fixtures", "voice-golden-v0.30.0.json"), "utf8")) as GoldenTrace[];

async function same(setup: Parameters<typeof runGolden>[0]): Promise<void> {
  const traces = JSON.parse(JSON.stringify(await runGolden(setup))) as GoldenTrace[];
  assert.equal(traces.length, golden.length);
  for (let i = 0; i < golden.length; i++) {
    assert.deepEqual(traces[i], golden[i], `the call "${golden[i]?.name}" is not what v0.30.0 made of it`);
  }
}

describe("with the spoken-interruption pilot off, a call is what v0.30.0 made of it", () => {
  it("holds traces of the calls that matter: a stop word, words, a sound of listening, echo, a click, a merge, typing", () => {
    assert.deepEqual(
      golden.map((g) => g.name),
      GOLDEN_SCENARIO_NAMES,
    );
    assert.ok(golden.some((g) => g.flights.some((f) => (f as { fate: string }).fate === "barge-in")), "a reply cut off by the person is among them");
  });

  it("by default", async () => {
    await same({});
  });

  it("with the setting off explicitly, and a page that can pause", async () => {
    await same({ config: { interruptPilot: false }, hello: { pause: true } });
  });

  it("with the setting on, when the page cannot pause", async () => {
    await same({ config: { interruptPilot: true } });
  });

  it("with the setting on and a page that can pause, when the browser does not cancel the echo", async () => {
    await same({ config: { interruptPilot: true }, hello: { pause: true, echoCancelled: false } });
  });
});
