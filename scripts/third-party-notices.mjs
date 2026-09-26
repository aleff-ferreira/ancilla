// Writes THIRD_PARTY_NOTICES.md: every third-party component a desktop build of Ancilla redistributes, with the
// license text it ships under. `--check` writes nothing and fails when the checked-in file is out of date.
//
// What a desktop build carries, and how this finds each part:
// - resources/server.cjs, esbuild's bundle of packages/server (apps/desktop/scripts/bundle-server.mjs): the same
//   build, run again for its metafile.
// - resources/frontend, Vite's build of apps/web: the same build, run without writing, for the modules that made it
//   into a chunk, the stylesheets Tailwind inlined and the files (fonts) it emitted.
// - the Node.js sidecar (apps/desktop/scripts/fetch-node.mjs): its own license file ships next to this one.
// - the Rust crates compiled into the executable: listed from Cargo.lock.
//
// Nothing is downloaded: the output depends only on the lockfiles and what npm installed from them, so it is the
// same on every machine and CI can hold the checked-in file to it.
import { existsSync } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(rootDir, "apps", "web");
const desktopDir = join(rootDir, "apps", "desktop");
const outFile = join(rootDir, "THIRD_PARTY_NOTICES.md");
const check = process.argv.includes("--check");

// Where bundle-server.mjs and fetch-node.mjs put the license files in an installed app.
const LEGAL_DIR = "resources/legal";
const NODE_LICENSE = "node-LICENSE";

const SHIPPED_IN = {
  server: "local server (`resources/server.cjs`)",
  frontend: "interface (`resources/frontend`)",
};

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice|ofl)(?:[-_.][\w.-]*)?$/i;

// Permissive licenses that ask only for their notice to travel with the code. Anything else is flagged for a look.
const PERMISSIVE = "(?:MIT|ISC|0BSD|BSD-[23]-Clause|Apache-2\\.0|OFL-1\\.1)";
const PERMISSIVE_EXPRESSION = new RegExp(`^\\(?${PERMISSIVE}(?: OR ${PERMISSIVE})*\\)?$`);

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The installed package a bundled file came from, as its directory, or null for a file outside node_modules. */
function packageDir(file) {
  const path = file.replace(/^\0/, "").split("?")[0].replace(/\\/g, "/");
  const at = path.lastIndexOf("/node_modules/");
  if (at < 0) return null;
  const parts = path.slice(at + "/node_modules/".length).split("/");
  const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  return `${path.slice(0, at)}/node_modules/${name}`;
}

/** Every file esbuild puts into resources/server.cjs. */
async function serverFiles() {
  // bundle-server.mjs's own esbuild, with its options; keep the two in step.
  const esbuild = createRequire(join(desktopDir, "package.json"))("esbuild");
  // The build reads the workspace packages from source, so it does not depend on a fresh `tsc` of each; their
  // third-party imports are the same either way.
  const workspaceSources = {
    name: "workspace-sources",
    setup(build) {
      build.onResolve({ filter: /^@ancilla\/[^/]+$/ }, (args) => {
        const source = join(rootDir, "packages", args.path.slice("@ancilla/".length), "src", "index.ts");
        return existsSync(source) ? { path: source } : undefined;
      });
    },
  };
  const result = await esbuild.build({
    entryPoints: [join(rootDir, "packages", "server", "src", "cli.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: join(rootDir, "server.cjs"),
    write: false,
    metafile: true,
    logLevel: "error",
    absWorkingDir: rootDir,
    plugins: [workspaceSources],
  });
  return Object.keys(result.metafile.inputs).map((input) => resolve(rootDir, input));
}

/** Every file whose contents end up in resources/frontend. */
async function frontendFiles() {
  const { build } = await import("vite");
  const files = new Set();
  await build({
    root: webDir,
    configFile: join(webDir, "vite.config.ts"),
    logLevel: "silent",
    build: { write: false },
    plugins: [
      {
        name: "ancilla-third-party-notices",
        generateBundle(_options, bundle) {
          for (const item of Object.values(bundle)) {
            if (item.type === "chunk") {
              // A module tree-shaken down to nothing is not shipped.
              for (const [id, module] of Object.entries(item.modules)) if (module.renderedLength > 0) files.add(id);
            } else {
              for (const name of item.originalFileNames ?? []) files.add(resolve(webDir, name));
            }
          }
          // Stylesheets render to empty modules once Vite pulls their CSS out, and the ones Tailwind inlines through
          // @import (its own preflight, the font faces) are only reported as files to watch.
          for (const id of [...this.getModuleIds(), ...this.getWatchFiles()]) {
            if (/\.css(?:\?|$)/.test(id)) files.add(resolve(webDir, id.replace(/^\0/, "")));
          }
        },
      },
    ],
  });
  return [...files];
}

function normalizeText(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

/** npm's `license`, or the older `licenses` array, as one SPDX-ish expression. */
function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((entry) => entry.type ?? entry).join(" OR ");
  return "UNKNOWN";
}

function sourceOf(pkg) {
  let url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (url) {
    url = url
      .replace(/^git\+/, "")
      .replace(/^git:\/\//, "https://")
      .replace(/^(?:ssh:\/\/)?git@github\.com[:/]/, "https://github.com/")
      .replace(/^github:/, "https://github.com/")
      .replace(/\.git$/, "");
    // npm's shorthand for a GitHub repository.
    if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
    return url;
  }
  if (typeof pkg.homepage === "string") return pkg.homepage;
  return `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`;
}

function authorOf(pkg) {
  const author = typeof pkg.author === "string" ? pkg.author : pkg.author?.name;
  // Just the name: npm's "Name <email> (url)" form carries contact details that do not belong in a notice.
  return author ? author.replace(/\s*[<(].*$/, "").trim() || null : null;
}

async function readPackage(dir, shippedIn, packages) {
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  const key = `${pkg.name}@${pkg.version}`;
  const known = packages.get(key);
  if (known) {
    known.shippedIn.add(shippedIn);
    return;
  }
  const files = [];
  for (const name of (await readdir(dir)).sort(byText)) {
    if (!LICENSE_FILE.test(name) || !(await stat(join(dir, name))).isFile()) continue;
    const text = normalizeText(await readFile(join(dir, name), "utf8"));
    if (text) files.push({ name, text });
  }
  packages.set(key, {
    name: pkg.name,
    version: pkg.version,
    license: licenseOf(pkg),
    source: sourceOf(pkg),
    author: authorOf(pkg),
    files,
    shippedIn: new Set([shippedIn]),
  });
}

/**
 * Whether a license text names who holds the copyright: "Copyright (c) 2022 WorkOS" (or an SPDX document's
 * "PackageCopyrightText: ..."), but not the license's own talk of "copyright notices" or a template's
 * "Copyright [yyyy] [name of copyright owner]".
 */
function hasCopyrightLine(text) {
  return text
    .split("\n")
    .some((line) => /^\W*(?:[Cc]opyright|COPYRIGHT|\([Cc]\)|©)\s*(?:\([Cc]\)|©)?\s*[\dA-Z]/.test(line) || /CopyrightText:\s*\S/.test(line));
}

/**
 * One section per package, except that packages shipping the very same license text with no copyright line of
 * its own (a bare Apache-2.0, say) share one.
 */
function noticesFor(packages) {
  const notices = [];
  const shared = new Map();
  for (const pkg of packages) {
    const text = pkg.files.map((file) => `${file.name}\n${file.text}`).join("\n\n");
    if (pkg.files.length === 0 || hasCopyrightLine(text)) {
      notices.push({ packages: [pkg], files: pkg.files });
      continue;
    }
    const notice = shared.get(text);
    if (notice) notice.packages.push(pkg);
    else {
      const created = { packages: [pkg], files: pkg.files };
      shared.set(text, created);
      notices.push(created);
    }
  }
  return notices;
}

function fence(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

function facts(pkg) {
  const shipped = [...pkg.shippedIn].sort(byText).map((where) => SHIPPED_IN[where]);
  return [`- License: ${pkg.license}`, `- Source: <${pkg.source}>`, `- Shipped in: the ${shipped.join(" and the ")}`];
}

function renderNotice(notice) {
  const lines = [];
  if (notice.packages.length === 1) {
    const [pkg] = notice.packages;
    lines.push(`### ${pkg.name} ${pkg.version}`, "", ...facts(pkg), "");
    if (notice.files.length === 0) {
      const by = pkg.author ? `, by ${pkg.author}` : "";
      lines.push(`The published package includes no license file. Its package.json declares ${pkg.license}${by}.`, "");
    } else if (notice.files.every((file) => /\.spdx$/i.test(file.name))) {
      lines.push("The published package's license file is an SPDX summary, which names its licenses rather than quoting them.", "");
    }
  } else {
    lines.push(`### ${notice.packages.map((pkg) => `${pkg.name} ${pkg.version}`).join(", ")}`, "");
    lines.push("These packages ship the same license text:", "");
    for (const pkg of notice.packages) {
      lines.push(`- ${pkg.name} ${pkg.version}`, ...facts(pkg).map((line) => `  ${line}`));
    }
    lines.push("");
  }
  for (const file of notice.files) {
    const marker = fence(file.text);
    lines.push(`\`${file.name}\`:`, "", `${marker}text`, file.text, marker, "");
  }
  return lines;
}

/** NODE_VERSION as fetch-node.mjs pins it; importing the script would run it. */
async function nodeVersion() {
  const script = await readFile(join(desktopDir, "scripts", "fetch-node.mjs"), "utf8");
  const match = script.match(/const NODE_VERSION = "(v[\d.]+)"/);
  if (!match) throw new Error("cannot find NODE_VERSION in apps/desktop/scripts/fetch-node.mjs");
  return match[1];
}

/** The crates.io packages Cargo.lock resolves for the desktop crate, sorted. */
async function crates() {
  const lock = await readFile(join(desktopDir, "src-tauri", "Cargo.lock"), "utf8");
  const found = [];
  for (const block of lock.replace(/\r\n?/g, "\n").split("\n[[package]]\n").slice(1)) {
    const field = (key) => block.match(new RegExp(`^${key} = "([^"]*)"`, "m"))?.[1] ?? null;
    const source = field("source");
    // The desktop crate itself has no source; it is Ancilla.
    if (!source) continue;
    found.push({ name: field("name"), version: field("version"), source });
  }
  return found.sort((a, b) => byText(a.name, b.name) || byText(a.version, b.version));
}

function render({ packages, node, rustCrates }) {
  const serverCount = packages.filter((pkg) => pkg.shippedIn.has("server")).length;
  const frontendCount = packages.filter((pkg) => pkg.shippedIn.has("frontend")).length;
  const lines = [
    "# Third-party notices",
    "",
    "<!-- Generated by scripts/third-party-notices.mjs. Do not edit: run `npm run notices` to refresh it. -->",
    "",
    "Ancilla is free software under the MIT License; see [LICENSE](LICENSE). It is a fork of",
    "[Helicon](https://github.com/HarjjotSinghh/helicon), Copyright (c) 2026 Harjot Singh Rana and contributors,",
    "which is also under the MIT License. Helicon's copyright and permission notice is kept in [LICENSE](LICENSE)",
    "and covers the parts of Ancilla that come from Helicon.",
    "",
    "Desktop builds of Ancilla also redistribute the third-party components below, each under its own license.",
    `An installed copy carries this file, LICENSE and the Node.js license in its \`${LEGAL_DIR}\` folder.`,
    "",
    `- [JavaScript packages](#javascript-packages): ${serverCount} bundled into the local server, ${frontendCount} into the interface`,
    `- [Node.js runtime](#nodejs-runtime): Node.js ${node}`,
    `- [Rust crates](#rust-crates): ${rustCrates.length} crates from Cargo.lock`,
    "",
    "Code the build tools generate into the bundles themselves (esbuild's and Rollup's module helpers, Vite's",
    "module-preload polyfill) is not listed.",
    "",
    "## Summary",
    "",
    "| Package | Version | License | Shipped in |",
    "| --- | --- | --- | --- |",
  ];
  for (const pkg of packages) {
    const shipped = [...pkg.shippedIn].sort(byText).map((where) => (where === "server" ? "server" : "interface"));
    lines.push(`| ${pkg.name} | ${pkg.version} | ${pkg.license.replace(/\|/g, "\\|")} | ${shipped.join(", ")} |`);
  }
  lines.push(
    `| Node.js | ${node.slice(1)} | MIT, with bundled components under their own licenses | sidecar |`,
    "",
    "## JavaScript packages",
    "",
    "The license files each package publishes, as published.",
    "",
  );
  for (const notice of noticesFor(packages)) lines.push(...renderNotice(notice));
  lines.push(
    "## Node.js runtime",
    "",
    `Desktop builds run the local server on the official Node.js ${node} binary, downloaded from nodejs.org and`,
    "checksum-verified by apps/desktop/scripts/fetch-node.mjs, and installed as the `node` sidecar next to the",
    "Ancilla executable. Node.js is released under the MIT License and contains third-party components (V8, libuv,",
    "OpenSSL and ICU among them) under their own licenses. Its complete license file, taken from the same release",
    `archive as the binary, is installed with Ancilla as \`${LEGAL_DIR}/${NODE_LICENSE}\` and is published at`,
    `<https://github.com/nodejs/node/blob/${node}/LICENSE>.`,
    "",
    "## Rust crates",
    "",
    "The desktop executable is compiled from apps/desktop/src-tauri against the crates below: everything its",
    "Cargo.lock resolves, for every platform. A given build links only the ones its target uses, and some (build",
    "scripts, procedural macros) run only while building. Their license texts are not reproduced here yet; each",
    "crate's license is on its crates.io page.",
    "",
  );
  for (const crate of rustCrates) {
    const note = crate.source.startsWith("registry+https://github.com/rust-lang/crates.io-index") ? "" : ` (${crate.source})`;
    lines.push(`- [${crate.name} ${crate.version}](https://crates.io/crates/${crate.name}/${crate.version})${note}`);
  }
  return `${lines.join("\n")}\n`;
}

const packages = new Map();
for (const [shippedIn, files] of [
  ["server", await serverFiles()],
  ["frontend", await frontendFiles()],
]) {
  const dirs = [...new Set(files.map(packageDir).filter(Boolean))].sort(byText);
  for (const dir of dirs) await readPackage(dir, shippedIn, packages);
}
const sorted = [...packages.values()].sort((a, b) => byText(a.name, b.name) || byText(a.version, b.version));

for (const pkg of sorted) {
  if (pkg.files.length === 0) console.error(`note: ${pkg.name}@${pkg.version} publishes no license file (declares ${pkg.license})`);
  if (!PERMISSIVE_EXPRESSION.test(pkg.license)) console.error(`attention: ${pkg.name}@${pkg.version} is licensed ${pkg.license}`);
}

const output = render({ packages: sorted, node: await nodeVersion(), rustCrates: await crates() });

if (check) {
  const current = existsSync(outFile) ? (await readFile(outFile, "utf8")).replace(/\r\n/g, "\n") : null;
  if (current !== output) {
    console.error("THIRD_PARTY_NOTICES.md is out of date: run `npm run notices` and commit the result.");
    process.exit(1);
  }
  console.log(`THIRD_PARTY_NOTICES.md is up to date (${sorted.length} packages)`);
} else {
  await writeFile(outFile, output);
  console.log(`wrote THIRD_PARTY_NOTICES.md (${sorted.length} packages)`);
}
