#!/usr/bin/env node
/**
 * Runs the call scenarios of packages/server/test/voice-golden.ts on the voice code of any built checkout and writes down
 * what each call said, played and recorded. This is how `packages/server/test/fixtures/voice-golden-v0.30.0.json` was made,
 * and how it is renewed: the claim of the spoken-interruption pilot is that, with it off, a call is exactly what v0.30.0
 * made of it, so the scenarios are run on a build of v0.30.0 and this build is held to the same traces.
 *
 *   node scripts/voice/golden.mjs <root of a built checkout> [out.json]
 *
 * The helper is compiled in THIS checkout (npm run build --workspace @ancilla/server); it imports nothing but the test
 * doubles, so it is copied into the other checkout's build and run there. Time in the traces is the doubles' virtual time.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = path.resolve(process.argv[2] ?? here);
const out = process.argv[3] ?? null;
const compiled = path.join(here, "packages/server/dist/test/voice-golden.js");
if (!fs.existsSync(compiled)) {
  console.error("build this checkout first: npm run build --workspace @ancilla/server");
  process.exit(2);
}
const targetDir = path.join(root, "packages/server/dist/test");
fs.mkdirSync(targetDir, { recursive: true });
const target = path.join(targetDir, "voice-golden.js");
if (root !== here) fs.copyFileSync(compiled, target);
const require = createRequire(import.meta.url);
const { runGolden } = require(root === here ? compiled : target);
const traces = await runGolden();
const text = `${JSON.stringify(traces, null, 1)}\n`;
if (out) {
  fs.writeFileSync(out, text);
  console.log(`${traces.length} scenarios, ${text.length} bytes -> ${out}`);
} else {
  process.stdout.write(text);
}
process.exit(0);
