// Writes THIRD_PARTY_NOTICES.md: every third-party component a desktop build of Ancilla redistributes, with the
// license text it ships under. `--check` writes nothing and fails when the checked-in file is out of date.
// `--crates <file>` writes the Rust crates' license texts to <file> instead (see below).
//
// What a desktop build carries, and how this finds each part:
// - resources/server.cjs, esbuild's bundle of packages/server (apps/desktop/scripts/bundle-server.mjs): the same
//   build, run again for its metafile.
// - resources/frontend, Vite's build of apps/web: the same build, run without writing, for the modules that made it
//   into a chunk, the stylesheets Tailwind inlined and the files (fonts) it emitted.
// - the Node.js sidecar (apps/desktop/scripts/fetch-node.mjs): its own license file ships next to this one.
// - the Rust crates compiled into the executable: listed from Cargo.lock. Their license files exist only in the
//   crate sources Cargo downloads, so `--crates` collects them through `cargo metadata` into a file of their own,
//   which bundle-server.mjs writes while the desktop app is built.
//
// Apart from `--crates`, nothing is downloaded: the output depends only on the lockfiles and what npm installed from
// them, so it is the same on every machine and CI can hold the checked-in file to it.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const webDir = join(rootDir, "apps", "web");
const desktopDir = join(rootDir, "apps", "desktop");
const outFile = join(rootDir, "THIRD_PARTY_NOTICES.md");
const check = process.argv.includes("--check");
const cratesFlag = process.argv.indexOf("--crates");
const cratesOut = cratesFlag >= 0 ? process.argv[cratesFlag + 1] : null;
if (cratesFlag >= 0 && !cratesOut) throw new Error("--crates needs the file to write the crates' licenses to");

// Where bundle-server.mjs and fetch-node.mjs put the license files in an installed app.
const LEGAL_DIR = "resources/legal";
const NODE_LICENSE = "node-LICENSE";
const RUST_LICENSES = "RUST_CRATE_LICENSES.md";

const SHIPPED_IN = {
  server: "local server (`resources/server.cjs`)",
  frontend: "interface (`resources/frontend`)",
};

const LICENSE_FILE = /^(?:licen[cs]e|copying|copyright|notice|ofl|unlicense)(?:[-_.][\w.-]*)?$/i;

// Permissive licenses that ask only for their notice to travel with the code. Anything else is flagged for a look.
const PERMISSIVE = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BSL-1.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
  "OFL-1.1",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "Unlicense",
  "Zlib",
]);

// The MIT License's permission notice, for packages that declare MIT but publish no copy of it.
const MIT_PERMISSION = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

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

/** The license files at the top of a package or crate, and in a REUSE-style LICENSES folder, sorted by name. */
async function licenseFiles(dir) {
  const files = [];
  const add = async (path, name) => {
    const text = normalizeText(await readFile(path, "utf8"));
    if (text) files.push({ name, text });
  };
  for (const name of (await readdir(dir)).sort(byText)) {
    if (name !== "LICENSES" && !LICENSE_FILE.test(name)) continue;
    const path = join(dir, name);
    const info = await stat(path);
    if (info.isFile()) await add(path, name);
    else if (info.isDirectory() && name === "LICENSES") {
      for (const inner of (await readdir(path)).sort(byText)) {
        if ((await stat(join(path, inner))).isFile()) await add(join(path, inner), `LICENSES/${inner}`);
      }
    }
  }
  return files;
}

/** npm's `license`, or the older `licenses` array, as one SPDX-ish expression. */
function licenseOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((entry) => entry.type ?? entry).join(" OR ");
  return "UNKNOWN";
}

function sourceOf(repository, homepage, fallback) {
  let url = typeof repository === "string" ? repository : repository?.url;
  if (url) {
    url = url
      .replace(/^git\+/, "")
      .replace(/^git:\/\//, "https://")
      .replace(/^(?:ssh:\/\/)?git@github\.com[:/]/, "https://github.com/")
      .replace(/^github:/, "https://github.com/")
      .replace(/\/+$/, "")
      .replace(/\.git$/, "");
    // npm's shorthand for a GitHub repository.
    if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
    return url;
  }
  if (typeof homepage === "string") return homepage;
  return fallback;
}

/** Just the names: npm's "Name <email> (url)" and Cargo's "Name <email>" carry contact details that do not belong in a notice. */
function namesOf(people) {
  return people
    .map((person) => (typeof person === "string" ? person : (person?.name ?? "")).replace(/\s*[<(].*$/, "").trim())
    .filter(Boolean);
}

/**
 * The MIT License's standard text for a package that offers MIT but publishes no copy of it (no license file, or
 * only an SPDX summary), naming whoever the package itself credits: the copyright its SPDX summary states, its
 * authors, or else the owner of its repository.
 */
function standardText(pkg) {
  if (!/(?:^|[\s(/])MIT(?=$|[\s)/])/.test(pkg.license)) return null;
  if (!pkg.files.every((file) => /\.spdx$/i.test(file.name))) return null;
  const stated = pkg.files
    .map((file) => file.text.match(/^PackageCopyrightText:\s*(.+)$/m)?.[1].replace(/<\/?text>/g, "").trim())
    .find(Boolean);
  const owner = pkg.source.match(/^https:\/\/github\.com\/([^/]+)\//)?.[1];
  const holder = stated ?? (pkg.authors.length > 0 ? pkg.authors.join(", ") : (owner ?? `the ${pkg.name} authors`));
  return { name: "MIT License (standard text)", text: `MIT License\n\nCopyright (c) ${holder}\n\n${MIT_PERMISSION}` };
}

async function readPackage(dir, shippedIn, packages) {
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  const key = `${pkg.name}@${pkg.version}`;
  const known = packages.get(key);
  if (known) {
    known.shippedIn.add(shippedIn);
    return;
  }
  const found = {
    kind: "package",
    manifest: "package.json",
    name: pkg.name,
    version: pkg.version,
    license: licenseOf(pkg),
    source: sourceOf(pkg.repository, pkg.homepage, `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`),
    authors: namesOf(pkg.author ? [pkg.author] : Array.isArray(pkg.authors) ? pkg.authors : []),
    files: await licenseFiles(dir),
    shippedIn: new Set([shippedIn]),
  };
  found.standard = standardText(found);
  packages.set(key, found);
}

/**
 * Whether an SPDX expression can be met under the permissive licenses above: either side of an OR, both sides of
 * an AND. Cargo's older "MIT/Apache-2.0" means OR; an exception (WITH) only ever adds permissions.
 */
function isPermissive(expression) {
  const tokens = expression.replace(/\//g, " OR ").match(/[()]|[^\s()]+/g) ?? [];
  const operator = (token) => token?.toUpperCase();
  let at = 0;
  const one = () => {
    if (tokens[at] === "(") {
      at += 1;
      const ok = either();
      at += 1;
      return ok;
    }
    const id = tokens[at++];
    if (operator(tokens[at]) === "WITH") at += 2;
    return PERMISSIVE.has(id);
  };
  const both = () => {
    let ok = one();
    while (operator(tokens[at]) === "AND") {
      at += 1;
      ok = one() && ok;
    }
    return ok;
  };
  const either = () => {
    let ok = both();
    while (operator(tokens[at]) === "OR") {
      at += 1;
      ok = both() || ok;
    }
    return ok;
  };
  return either() && at === tokens.length;
}

function report(pkg) {
  const label = `${pkg.name}@${pkg.version}`;
  if (pkg.files.length === 0) {
    const stand = pkg.standard ? "; the MIT License's standard text stands in" : "";
    console.error(`note: ${label} publishes no license file (declares ${pkg.license})${stand}`);
  }
  if (!isPermissive(pkg.license)) console.error(`attention: ${label} is licensed ${pkg.license}`);
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
    if (pkg.files.length === 0 || pkg.standard || hasCopyrightLine(text)) {
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
  const lines = [`- License: ${pkg.license}`, `- Source: <${pkg.source}>`];
  if (pkg.shippedIn) {
    const shipped = [...pkg.shippedIn].sort(byText).map((where) => SHIPPED_IN[where]);
    lines.push(`- Shipped in: the ${shipped.join(" and the ")}`);
  }
  return lines;
}

function renderNotice(notice) {
  const lines = [];
  const [pkg] = notice.packages;
  // noticesFor() never groups a package that needs the standard text.
  const files = pkg.standard ? [...notice.files, pkg.standard] : notice.files;
  if (notice.packages.length === 1) {
    const standard = pkg.standard ? " The MIT License's standard text is added below." : "";
    lines.push(`### ${pkg.name} ${pkg.version}`, "", ...facts(pkg), "");
    if (notice.files.length === 0) {
      const by = pkg.authors.length > 0 ? `, by ${pkg.authors.join(", ")}` : "";
      lines.push(`The published ${pkg.kind} includes no license file. Its ${pkg.manifest} declares ${pkg.license}${by}.${standard}`, "");
    } else if (notice.files.every((file) => /\.spdx$/i.test(file.name))) {
      lines.push(`The published ${pkg.kind}'s license file is an SPDX summary, which names its licenses rather than quoting them.${standard}`, "");
    }
  } else {
    lines.push(`### ${notice.packages.map((each) => `${each.name} ${each.version}`).join(", ")}`, "");
    lines.push(`These ${pkg.kind}s ship the same license text:`, "");
    for (const each of notice.packages) {
      lines.push(`- ${each.name} ${each.version}`, ...facts(each).map((line) => `  ${line}`));
    }
    lines.push("");
  }
  for (const file of files) {
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

/**
 * The same crates as crates(), with the license files their sources carry. `cargo metadata` downloads any crate the
 * lockfile names that is not already in Cargo's cache, for every platform, and says where each one's source is.
 */
async function crateLicenses() {
  const manifest = join(desktopDir, "src-tauri", "Cargo.toml");
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--manifest-path", manifest], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
  const found = [];
  for (const crate of metadata.packages) {
    // The desktop crate itself has no source; it is Ancilla.
    if (!crate.source) continue;
    const dir = dirname(crate.manifest_path);
    const files = await licenseFiles(dir);
    // Cargo.toml's license-file, when it names a file the pattern above does not.
    const extra = crate.license_file ? resolve(dir, crate.license_file) : null;
    if (extra && existsSync(extra) && !files.some((file) => file.name === basename(extra))) {
      const text = normalizeText(await readFile(extra, "utf8"));
      if (text) files.push({ name: basename(extra), text });
    }
    const pkg = {
      kind: "crate",
      manifest: "Cargo.toml",
      name: crate.name,
      version: crate.version,
      license: crate.license ?? (crate.license_file ? `see ${crate.license_file}` : "UNKNOWN"),
      source: sourceOf(crate.repository, crate.homepage, `https://crates.io/crates/${crate.name}/${crate.version}`),
      authors: namesOf(crate.authors ?? []),
      files,
    };
    pkg.standard = standardText(pkg);
    found.push(pkg);
  }
  return found.sort((a, b) => byText(a.name, b.name) || byText(a.version, b.version));
}

function renderCrates(rustCrates) {
  const lines = [
    "# Rust crate licenses",
    "",
    "<!-- Generated by scripts/third-party-notices.mjs --crates while the desktop app is built. -->",
    "",
    "The Ancilla desktop executable is compiled against the Rust crates below: everything its Cargo.lock resolves,",
    "for every platform. A given build links only the ones its target uses, and some (build scripts, procedural",
    "macros) run only while building. These are the license files each crate publishes, as published, from the",
    "sources Cargo downloaded for this build. THIRD_PARTY_NOTICES.md, next to this file, covers the rest of what",
    "Ancilla redistributes.",
    "",
    "## Summary",
    "",
    "| Crate | Version | License |",
    "| --- | --- | --- |",
  ];
  for (const crate of rustCrates) lines.push(`| ${crate.name} | ${crate.version} | ${crate.license.replace(/\|/g, "\\|")} |`);
  lines.push("", "## Licenses", "");
  for (const notice of noticesFor(rustCrates)) lines.push(...renderNotice(notice));
  return `${lines.join("\n")}\n`;
}

function render({ packages, node, rustCrates, hasNotice }) {
  const serverCount = packages.filter((pkg) => pkg.shippedIn.has("server")).length;
  const frontendCount = packages.filter((pkg) => pkg.shippedIn.has("frontend")).length;
  // What bundle-server.mjs and fetch-node.mjs put next to this file; NOTICE.md only when the repository has one.
  const carried = ["this file", "[LICENSE](LICENSE)", ...(hasNotice ? ["[NOTICE.md](NOTICE.md)"] : [])];
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
    `An installed copy carries ${carried.join(", ")}, the Node.js license and the Rust crates' license texts in its`,
    `\`${LEGAL_DIR}\` folder.`,
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
    "The license files each package publishes, as published. A package that declares the MIT License without",
    "publishing its text gets the license's standard text as well.",
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
    "scripts, procedural macros) run only while building. Their license texts are only in the crate sources Cargo",
    "downloads, so the desktop build collects them from there (`npm run notices -- --crates <file>`) and an",
    `installed copy carries them as \`${LEGAL_DIR}/${RUST_LICENSES}\`. Each crate's crates.io page names its`,
    "license too.",
    "",
  );
  for (const crate of rustCrates) {
    const note = crate.source.startsWith("registry+https://github.com/rust-lang/crates.io-index") ? "" : ` (${crate.source})`;
    lines.push(`- [${crate.name} ${crate.version}](https://crates.io/crates/${crate.name}/${crate.version})${note}`);
  }
  return `${lines.join("\n")}\n`;
}

if (cratesOut) {
  const rustCrates = await crateLicenses();
  for (const crate of rustCrates) report(crate);
  await writeFile(cratesOut, renderCrates(rustCrates));
  console.log(`wrote ${cratesOut} (${rustCrates.length} crates)`);
} else {
  const packages = new Map();
  for (const [shippedIn, files] of [
    ["server", await serverFiles()],
    ["frontend", await frontendFiles()],
  ]) {
    const dirs = [...new Set(files.map(packageDir).filter(Boolean))].sort(byText);
    for (const dir of dirs) await readPackage(dir, shippedIn, packages);
  }
  const sorted = [...packages.values()].sort((a, b) => byText(a.name, b.name) || byText(a.version, b.version));
  for (const pkg of sorted) report(pkg);

  const output = render({
    packages: sorted,
    node: await nodeVersion(),
    rustCrates: await crates(),
    hasNotice: existsSync(join(rootDir, "NOTICE.md")),
  });

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
}
