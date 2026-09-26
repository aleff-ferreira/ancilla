import esbuild from "esbuild";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const rootDir = join(appDir, "..", "..");
const resourcesDir = join(appDir, "src-tauri", "resources");
// Installed with the app (bundle.resources in tauri.conf.json): the license every copy has to carry, and the
// notices for what it redistributes. fetch-node.mjs puts Node's own license here as well, and may run first, so
// this script replaces only what it makes rather than clearing the folder.
const legalDir = join(resourcesDir, "legal");
const LEGAL_FILES = ["LICENSE", "NOTICE.md", "THIRD_PARTY_NOTICES.md"];
const OPTIONAL = new Set(["NOTICE.md"]);

async function exists(path) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

await rm(join(resourcesDir, "frontend"), { recursive: true, force: true });
await rm(join(resourcesDir, "server.cjs"), { force: true });
await mkdir(legalDir, { recursive: true });
await cp(join(appDir, "..", "web", "dist"), join(resourcesDir, "frontend"), {
  recursive: true,
});
for (const name of LEGAL_FILES) {
  const target = join(legalDir, name);
  await rm(target, { force: true });
  if (OPTIONAL.has(name) && !(await exists(join(rootDir, name)))) continue;
  await cp(join(rootDir, name), target);
}
// scripts/third-party-notices.mjs repeats this build to list the packages it bundles; keep the two in step.
await esbuild.build({
  entryPoints: [join(rootDir, "packages", "server", "src", "cli.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: join(resourcesDir, "server.cjs"),
  logLevel: "info",
});
console.log("bundled desktop resources into src-tauri/resources");
