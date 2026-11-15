import child_process from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import moduleKit from "node:module";
import path from "node:path";
import url from "node:url";

const scriptDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const webAppDirectory = path.join(repositoryRoot, "apps", "web");
const desktopAppDirectory = path.join(repositoryRoot, "apps", "desktop");
const noticesMarkdownTarget = path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md");

const isCheckExecution = process.argv.includes("--check");
const cratesArgumentIndex = process.argv.indexOf("--crates");
const cratesDestinationFile = cratesArgumentIndex >= 0 ? process.argv[cratesArgumentIndex + 1] : null;

if (cratesArgumentIndex >= 0 && !cratesDestinationFile) {
  throw new Error("--crates needs the file to write the crates' licenses to");
}

const INSTALLED_LEGAL_FOLDER = "resources/legal";
const NODE_LICENSE_FILENAME = "node-LICENSE";
const CRATES_LICENSE_FILENAME = "RUST_CRATE_LICENSES.md";

const SHIPPED_LOCATIONS = {
  server: "local server (`resources/server.cjs`)",
  frontend: "interface (`resources/frontend`)",
};

const LICENSE_FILENAME_PATTERN = /^(?:licen[cs]e|copying|copyright|notice|ofl|unlicense)(?:[-_.][\w.-]*)?$/i;

const PERMISSIVE_SPDX_IDENTIFIERS = new Set([
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

const STANDARD_MIT_TEXT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
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

const compareStringsAscending = (strA, strB) => (strA < strB ? -1 : strA > strB ? 1 : 0);

function extractPackageFolderFromPath(filePath) {
  const normalized = filePath.replace(/^\0/, "").split("?")[0].replace(/\\/g, "/");
  const moduleSegmentIndex = normalized.lastIndexOf("/node_modules/");
  if (moduleSegmentIndex < 0) return null;

  const subTokens = normalized.slice(moduleSegmentIndex + "/node_modules/".length).split("/");
  const packageName = subTokens[0].startsWith("@") ? `${subTokens[0]}/${subTokens[1]}` : subTokens[0];
  return `${normalized.slice(0, moduleSegmentIndex)}/node_modules/${packageName}`;
}

async function collectServerDependencies() {
  const desktopRequire = moduleKit.createRequire(path.join(desktopAppDirectory, "package.json"));
  const esbuildInstance = desktopRequire("esbuild");

  const localWorkspaceResolver = {
    name: "workspace-sources",
    setup(builder) {
      builder.onResolve({ filter: /^@ancilla\/[^/]+$/ }, (args) => {
        const localSource = path.join(repositoryRoot, "packages", args.path.slice("@ancilla/".length), "src", "index.ts");
        return fs.existsSync(localSource) ? { path: localSource } : undefined;
      });
    },
  };

  const compilation = await esbuildInstance.build({
    entryPoints: [path.join(repositoryRoot, "packages", "server", "src", "cli.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: path.join(repositoryRoot, "server.cjs"),
    write: false,
    metafile: true,
    logLevel: "error",
    absWorkingDir: repositoryRoot,
    plugins: [localWorkspaceResolver],
  });

  return Object.keys(compilation.metafile.inputs).map((relPath) => path.resolve(repositoryRoot, relPath));
}

async function collectFrontendDependencies() {
  const { build: viteBuild } = await import("vite");
  const capturedModulePaths = new Set();

  await viteBuild({
    root: webAppDirectory,
    configFile: path.join(webAppDirectory, "vite.config.ts"),
    logLevel: "silent",
    build: { write: false },
    plugins: [
      {
        name: "ancilla-third-party-notices",
        generateBundle(_config, outputBundle) {
          for (const bundleEntry of Object.values(outputBundle)) {
            if (bundleEntry.type === "chunk") {
              for (const [modId, modInfo] of Object.entries(bundleEntry.modules)) {
                if (modInfo.renderedLength > 0) capturedModulePaths.add(modId);
              }
            } else {
              for (const origName of bundleEntry.originalFileNames ?? []) {
                capturedModulePaths.add(path.resolve(webAppDirectory, origName));
              }
            }
          }
          for (const trackedId of [...this.getModuleIds(), ...this.getWatchFiles()]) {
            if (/\.css(?:\?|$)/.test(trackedId)) {
              capturedModulePaths.add(path.resolve(webAppDirectory, trackedId.replace(/^\0/, "")));
            }
          }
        },
      },
    ],
  });

  return [...capturedModulePaths];
}

function cleanTextWhitespace(inputRawText) {
  const lineArray = inputRawText.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd());
  while (lineArray.length > 0 && lineArray[0] === "") lineArray.shift();
  while (lineArray.length > 0 && lineArray.at(-1) === "") lineArray.pop();
  return lineArray.join("\n");
}

async function findLicenseFiles(folderPath) {
  const retrievedFiles = [];
  const appendFile = async (absPath, displayName) => {
    const rawContent = await fsp.readFile(absPath, "utf8");
    const cleaned = cleanTextWhitespace(rawContent);
    if (cleaned) retrievedFiles.push({ name: displayName, text: cleaned });
  };

  const directoryEntries = (await fsp.readdir(folderPath)).sort(compareStringsAscending);
  for (const entryName of directoryEntries) {
    if (entryName !== "LICENSES" && !LICENSE_FILENAME_PATTERN.test(entryName)) continue;
    const itemPath = path.join(folderPath, entryName);
    const itemStat = await fsp.stat(itemPath);

    if (itemStat.isFile()) {
      await appendFile(itemPath, entryName);
    } else if (itemStat.isDirectory() && entryName === "LICENSES") {
      const nestedEntries = (await fsp.readdir(itemPath)).sort(compareStringsAscending);
      for (const nestedName of nestedEntries) {
        const nestedItemPath = path.join(itemPath, nestedName);
        if ((await fsp.stat(nestedItemPath)).isFile()) {
          await appendFile(nestedItemPath, `LICENSES/${nestedName}`);
        }
      }
    }
  }
  return retrievedFiles;
}

function parseDeclaredLicense(packageManifest) {
  if (typeof packageManifest.license === "string") return packageManifest.license;
  if (packageManifest.license?.type) return packageManifest.license.type;
  if (Array.isArray(packageManifest.licenses)) {
    return packageManifest.licenses.map((entry) => entry.type ?? entry).join(" OR ");
  }
  return "UNKNOWN";
}

function parseRepositoryUrl(repositoryField, homepageField, defaultFallback) {
  let repositoryString = typeof repositoryField === "string" ? repositoryField : repositoryField?.url;
  if (repositoryString) {
    repositoryString = repositoryString
      .replace(/^git\+/, "")
      .replace(/^git:\/\//, "https://")
      .replace(/^(?:ssh:\/\/)?git@github\.com[:/]/, "https://github.com/")
      .replace(/^github:/, "https://github.com/")
      .replace(/\/+$/, "")
      .replace(/\.git$/, "");
    if (/^[\w.-]+\/[\w.-]+$/.test(repositoryString)) {
      repositoryString = `https://github.com/${repositoryString}`;
    }
    return repositoryString;
  }
  if (typeof homepageField === "string") return homepageField;
  return defaultFallback;
}

function extractContributorNames(peopleList) {
  return peopleList
    .map((person) => (typeof person === "string" ? person : (person?.name ?? "")).replace(/\s*[<(].*$/, "").trim())
    .filter(Boolean);
}

function synthesizeStandardMitNotice(packageRecord) {
  if (!/(?:^|[\s(/])MIT(?=$|[\s)/])/.test(packageRecord.license)) return null;
  if (!packageRecord.files.every((file) => /\.spdx$/i.test(file.name))) return null;

  const copyrightMatch = packageRecord.files
    .map((f) => f.text.match(/^PackageCopyrightText:\s*(.+)$/m)?.[1].replace(/<\/?text>/g, "").trim())
    .find(Boolean);

  const githubOwner = packageRecord.source.match(/^https:\/\/github\.com\/([^/]+)\//)?.[1];
  const copyrightHolder = copyrightMatch ?? (packageRecord.authors.length > 0 ? packageRecord.authors.join(", ") : (githubOwner ?? `the ${packageRecord.name} authors`));

  return {
    name: "MIT License (standard text)",
    text: `MIT License\n\nCopyright (c) ${copyrightHolder}\n\n${STANDARD_MIT_TEXT_BODY}`,
  };
}

async function ingestPackageMetadata(packageFolder, locationRole, catalogMap) {
  const manifestData = JSON.parse(await fsp.readFile(path.join(packageFolder, "package.json"), "utf8"));
  const packageIdentifier = `${manifestData.name}@${manifestData.version}`;
  const existingRecord = catalogMap.get(packageIdentifier);

  if (existingRecord) {
    existingRecord.shippedIn.add(locationRole);
    return;
  }

  const newRecord = {
    kind: "package",
    manifest: "package.json",
    name: manifestData.name,
    version: manifestData.version,
    license: parseDeclaredLicense(manifestData),
    source: parseRepositoryUrl(manifestData.repository, manifestData.homepage, `https://www.npmjs.com/package/${manifestData.name}/v/${manifestData.version}`),
    authors: extractContributorNames(manifestData.author ? [manifestData.author] : Array.isArray(manifestData.authors) ? manifestData.authors : []),
    files: await findLicenseFiles(packageFolder),
    shippedIn: new Set([locationRole]),
  };

  newRecord.standard = synthesizeStandardMitNotice(newRecord);
  catalogMap.set(packageIdentifier, newRecord);
}

function isLicenseExpressionPermissive(spdxExpression) {
  const tokenList = spdxExpression.replace(/\//g, " OR ").match(/[()]|[^\s()]+/g) ?? [];
  const getOperator = (tok) => tok?.toUpperCase();
  let cursor = 0;

  const parseSingle = () => {
    if (tokenList[cursor] === "(") {
      cursor += 1;
      const groupOk = parseOr();
      cursor += 1;
      return groupOk;
    }
    const identifier = tokenList[cursor++];
    if (getOperator(tokenList[cursor]) === "WITH") cursor += 2;
    return PERMISSIVE_SPDX_IDENTIFIERS.has(identifier);
  };

  const parseAnd = () => {
    let result = parseSingle();
    while (getOperator(tokenList[cursor]) === "AND") {
      cursor += 1;
      result = parseSingle() && result;
    }
    return result;
  };

  const parseOr = () => {
    let result = parseAnd();
    while (getOperator(tokenList[cursor]) === "OR") {
      cursor += 1;
      result = parseAnd() || result;
    }
    return result;
  };

  return parseOr() && cursor === tokenList.length;
}

function auditPackageLicensing(pkg) {
  const identifier = `${pkg.name}@${pkg.version}`;
  if (pkg.files.length === 0) {
    const fallbackNote = pkg.standard ? "; the MIT License's standard text stands in" : "";
    console.error(`note: ${identifier} publishes no license file (declares ${pkg.license})${fallbackNote}`);
  }
  if (!isLicenseExpressionPermissive(pkg.license)) {
    console.error(`attention: ${identifier} is licensed ${pkg.license}`);
  }
}

function containsExplicitCopyrightLine(licenseText) {
  return licenseText
    .split("\n")
    .some((line) => /^\W*(?:[Cc]opyright|COPYRIGHT|\([Cc]\)|©)\s*(?:\([Cc]\)|©)?\s*[\dA-Z]/.test(line) || /CopyrightText:\s*\S/.test(line));
}

function groupPackagesIntoNotices(packageList) {
  const groupedNotices = [];
  const sharedTextGroups = new Map();

  for (const pkg of packageList) {
    const combinedFileText = pkg.files.map((f) => `${f.name}\n${f.text}`).join("\n\n");
    if (pkg.files.length === 0 || pkg.standard || containsExplicitCopyrightLine(combinedFileText)) {
      groupedNotices.push({ packages: [pkg], files: pkg.files });
      continue;
    }
    const existingGroup = sharedTextGroups.get(combinedFileText);
    if (existingGroup) {
      existingGroup.packages.push(pkg);
    } else {
      const freshGroup = { packages: [pkg], files: pkg.files };
      sharedTextGroups.set(combinedFileText, freshGroup);
      groupedNotices.push(freshGroup);
    }
  }
  return groupedNotices;
}

function constructCodeFence(textContent) {
  const backtickRuns = (textContent.match(/`+/g) ?? []).map((run) => run.length);
  const maxConsecutiveBackticks = Math.max(0, ...backtickRuns);
  return "`".repeat(Math.max(3, maxConsecutiveBackticks + 1));
}

function generatePackageBulletPoints(pkg) {
  const points = [`- License: ${pkg.license}`, `- Source: <${pkg.source}>`];
  if (pkg.shippedIn) {
    const locations = [...pkg.shippedIn].sort(compareStringsAscending).map((loc) => SHIPPED_LOCATIONS[loc]);
    points.push(`- Shipped in: the ${locations.join(" and the ")}`);
  }
  return points;
}

function formatNoticeSection(noticeItem) {
  const outputLines = [];
  const [firstPackage] = noticeItem.packages;
  const filesList = firstPackage.standard ? [...noticeItem.files, firstPackage.standard] : noticeItem.files;

  if (noticeItem.packages.length === 1) {
    const standardHint = firstPackage.standard ? " The MIT License's standard text is added below." : "";
    outputLines.push(`### ${firstPackage.name} ${firstPackage.version}`, "", ...generatePackageBulletPoints(firstPackage), "");

    if (noticeItem.files.length === 0) {
      const authorSuffix = firstPackage.authors.length > 0 ? `, by ${firstPackage.authors.join(", ")}` : "";
      outputLines.push(`The published ${firstPackage.kind} includes no license file. Its ${firstPackage.manifest} declares ${firstPackage.license}${authorSuffix}.${standardHint}`, "");
    } else if (noticeItem.files.every((file) => /\.spdx$/i.test(file.name))) {
      outputLines.push(`The published ${firstPackage.kind}'s license file is an SPDX summary, which names its licenses rather than quoting them.${standardHint}`, "");
    }
  } else {
    outputLines.push(`### ${noticeItem.packages.map((p) => `${p.name} ${p.version}`).join(", ")}`, "");
    outputLines.push(`These ${firstPackage.kind}s ship the same license text:`, "");
    for (const member of noticeItem.packages) {
      outputLines.push(`- ${member.name} ${member.version}`, ...generatePackageBulletPoints(member).map((l) => `  ${l}`));
    }
    outputLines.push("");
  }

  for (const docFile of filesList) {
    const fenceDelim = constructCodeFence(docFile.text);
    outputLines.push(`\`${docFile.name}\`:`, "", `${fenceDelim}text`, docFile.text, fenceDelim, "");
  }
  return outputLines;
}

async function readPinnedNodeVersion() {
  const fetchScriptPath = path.join(desktopAppDirectory, "scripts", "fetch-node.mjs");
  const scriptContent = await fsp.readFile(fetchScriptPath, "utf8");
  const versionMatch = scriptContent.match(/const PINNED_NODE_RELEASE = "(v[\d.]+)"/) ||
                       scriptContent.match(/const NODE_VERSION = "(v[\d.]+)"/);
  if (!versionMatch) {
    throw new Error("cannot find pinned Node version in apps/desktop/scripts/fetch-node.mjs");
  }
  return versionMatch[1];
}

async function listCargoLockCrates() {
  const cargoLockPath = path.join(desktopAppDirectory, "src-tauri", "Cargo.lock");
  const lockfileContent = await fsp.readFile(cargoLockPath, "utf8");
  const recordedCrates = [];

  const packageBlocks = lockfileContent.replace(/\r\n?/g, "\n").split("\n[[package]]\n").slice(1);
  for (const block of packageBlocks) {
    const findField = (name) => block.match(new RegExp(`^${name} = "([^"]*)"`, "m"))?.[1] ?? null;
    const crateSource = findField("source");
    if (!crateSource) continue;
    recordedCrates.push({
      name: findField("name"),
      version: findField("version"),
      source: crateSource,
    });
  }

  return recordedCrates.sort((a, b) => compareStringsAscending(a.name, b.name) || compareStringsAscending(a.version, b.version));
}

async function collectCrateLicenses() {
  const tauriCargoManifest = path.join(desktopAppDirectory, "src-tauri", "Cargo.toml");
  const metadataRaw = child_process.execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--manifest-path", tauriCargoManifest],
    {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  const parsedMetadata = JSON.parse(metadataRaw);
  const crateList = [];

  for (const crate of parsedMetadata.packages) {
    if (!crate.source) continue;
    const crateDir = path.dirname(crate.manifest_path);
    const crateFiles = await findLicenseFiles(crateDir);

    const explicitLicenseFile = crate.license_file ? path.resolve(crateDir, crate.license_file) : null;
    if (explicitLicenseFile && fs.existsSync(explicitLicenseFile) && !crateFiles.some((f) => f.name === path.basename(explicitLicenseFile))) {
      const explicitContent = cleanTextWhitespace(await fsp.readFile(explicitLicenseFile, "utf8"));
      if (explicitContent) crateFiles.push({ name: path.basename(explicitLicenseFile), text: explicitContent });
    }

    const crateRecord = {
      kind: "crate",
      manifest: "Cargo.toml",
      name: crate.name,
      version: crate.version,
      license: crate.license ?? (crate.license_file ? `see ${crate.license_file}` : "UNKNOWN"),
      source: parseRepositoryUrl(crate.repository, crate.homepage, `https://crates.io/crates/${crate.name}/${crate.version}`),
      authors: extractContributorNames(crate.authors ?? []),
      files: crateFiles,
    };
    crateRecord.standard = synthesizeStandardMitNotice(crateRecord);
    crateList.push(crateRecord);
  }

  return crateList.sort((a, b) => compareStringsAscending(a.name, b.name) || compareStringsAscending(a.version, b.version));
}

function renderCratesMarkdown(cratesList) {
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

  for (const crate of cratesList) {
    lines.push(`| ${crate.name} | ${crate.version} | ${crate.license.replace(/\|/g, "\\|")} |`);
  }
  lines.push("", "## Licenses", "");
  for (const group of groupPackagesIntoNotices(cratesList)) {
    lines.push(...formatNoticeSection(group));
  }
  return `${lines.join("\n")}\n`;
}

function renderThirdPartyNoticesMarkdown({ packages, nodeVersion, rustCrates, hasNoticeFile }) {
  const countInServer = packages.filter((p) => p.shippedIn.has("server")).length;
  const countInFrontend = packages.filter((p) => p.shippedIn.has("frontend")).length;

  const carriedLegalArtifacts = [
    "this file",
    "[LICENSE](LICENSE)",
    ...(hasNoticeFile ? ["[NOTICE.md](NOTICE.md)"] : []),
  ];

  const lines = [
    "# Third-party notices",
    "",
    "<!-- Generated by scripts/third-party-notices.mjs. Do not edit: run `npm run notices` to refresh it. -->",
    "",
    "Ancilla is free software under the GNU Affero General Public License, version 3; see [LICENSE](LICENSE).",
    "",
    "Desktop builds of Ancilla also redistribute the third-party components below, each under its own license.",
    `An installed copy carries ${carriedLegalArtifacts.join(", ")}, the Node.js license and the Rust crates' license texts in its`,
    `\`${INSTALLED_LEGAL_FOLDER}\` folder.`,
    "",
    `- [JavaScript packages](#javascript-packages): ${countInServer} bundled into the local server, ${countInFrontend} into the interface`,
    `- [Node.js runtime](#nodejs-runtime): Node.js ${nodeVersion}`,
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
    const shippedLabels = [...pkg.shippedIn]
      .sort(compareStringsAscending)
      .map((loc) => (loc === "server" ? "server" : "interface"));
    lines.push(`| ${pkg.name} | ${pkg.version} | ${pkg.license.replace(/\|/g, "\\|")} | ${shippedLabels.join(", ")} |`);
  }

  lines.push(
    `| Node.js | ${nodeVersion.slice(1)} | MIT, with bundled components under their own licenses | sidecar |`,
    "",
    "## JavaScript packages",
    "",
    "The license files each package publishes, as published. A package that declares the MIT License without",
    "publishing its text gets the license's standard text as well.",
    "",
  );

  for (const group of groupPackagesIntoNotices(packages)) {
    lines.push(...formatNoticeSection(group));
  }

  lines.push(
    "## Node.js runtime",
    "",
    `Desktop builds run the local server on the official Node.js ${nodeVersion} binary, downloaded from nodejs.org and`,
    "checksum-verified by apps/desktop/scripts/fetch-node.mjs, and installed as the `node` sidecar next to the",
    "Ancilla executable. Node.js is released under the MIT License and contains third-party components (V8, libuv,",
    "OpenSSL and ICU among them) under their own licenses. Its complete license file, taken from the same release",
    `archive as the binary, is installed with Ancilla as \`${INSTALLED_LEGAL_FOLDER}/${NODE_LICENSE_FILENAME}\` and is published at`,
    `<https://github.com/nodejs/node/blob/${nodeVersion}/LICENSE>.`,
    "",
    "## Rust crates",
    "",
    "The desktop executable is compiled from apps/desktop/src-tauri against the crates below: everything its",
    "Cargo.lock resolves, for every platform. A given build links only the ones its target uses, and some (build",
    "scripts, procedural macros) run only while building. Their license texts are only in the crate sources Cargo",
    "downloads, so the desktop build collects them from there (`npm run notices -- --crates <file>`) and an",
    `installed copy carries them as \`${INSTALLED_LEGAL_FOLDER}/${CRATES_LICENSE_FILENAME}\`. Each crate's crates.io page names its`,
    "license too.",
    "",
  );

  for (const crate of rustCrates) {
    const registryNote = crate.source.startsWith("registry+https://github.com/rust-lang/crates.io-index") ? "" : ` (${crate.source})`;
    lines.push(`- [${crate.name} ${crate.version}](https://crates.io/crates/${crate.name}/${crate.version})${registryNote}`);
  }

  return `${lines.join("\n")}\n`;
}

if (cratesDestinationFile) {
  const crateItems = await collectCrateLicenses();
  for (const crate of crateItems) auditPackageLicensing(crate);
  await fsp.writeFile(cratesDestinationFile, renderCratesMarkdown(crateItems));
  console.log(`wrote ${cratesDestinationFile} (${crateItems.length} crates)`);
} else {
  const discoveredPackages = new Map();
  const fileSources = [
    ["server", await collectServerDependencies()],
    ["frontend", await collectFrontendDependencies()],
  ];

  for (const [locationTag, fileList] of fileSources) {
    const packageDirs = [...new Set(fileList.map(extractPackageFolderFromPath).filter(Boolean))].sort(compareStringsAscending);
    for (const pDir of packageDirs) {
      await ingestPackageMetadata(pDir, locationTag, discoveredPackages);
    }
  }

  const sortedPackageList = [...discoveredPackages.values()].sort(
    (a, b) => compareStringsAscending(a.name, b.name) || compareStringsAscending(a.version, b.version),
  );

  for (const pkg of sortedPackageList) auditPackageLicensing(pkg);

  const compiledNoticeMarkdown = renderThirdPartyNoticesMarkdown({
    packages: sortedPackageList,
    nodeVersion: await readPinnedNodeVersion(),
    rustCrates: await listCargoLockCrates(),
    hasNoticeFile: fs.existsSync(path.join(repositoryRoot, "NOTICE.md")),
  });

  if (isCheckExecution) {
    const existingContent = fs.existsSync(noticesMarkdownTarget)
      ? (await fsp.readFile(noticesMarkdownTarget, "utf8")).replace(/\r\n/g, "\n")
      : null;

    if (existingContent !== compiledNoticeMarkdown) {
      console.error("THIRD_PARTY_NOTICES.md is out of date: run `npm run notices` and commit the result.");
      process.exit(1);
    }
    console.log(`THIRD_PARTY_NOTICES.md is up to date (${sortedPackageList.length} packages)`);
  } else {
    await fsp.writeFile(noticesMarkdownTarget, compiledNoticeMarkdown);
    console.log(`wrote THIRD_PARTY_NOTICES.md (${sortedPackageList.length} packages)`);
  }
}
