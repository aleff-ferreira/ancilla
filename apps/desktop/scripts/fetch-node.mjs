import crypto from "node:crypto";
import child_process from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";

const PINNED_NODE_RELEASE = "v22.23.2";

const currentDir = path.dirname(url.fileURLToPath(import.meta.url));
const desktopRoot = path.join(currentDir, "..");
const tauriBinariesDir = path.join(desktopRoot, "src-tauri", "binaries");
const legalLicenseDest = path.join(desktopRoot, "src-tauri", "resources", "legal", "node-LICENSE");
const localCacheDir = path.join(desktopRoot, ".cache", "node", PINNED_NODE_RELEASE);

const TARGET_DISTRIBUTIONS = {
  "x86_64-pc-windows-msvc": {
    archiveBase: `node-${PINNED_NODE_RELEASE}-win-x64`,
    format: "zip",
    executableRelPath: "node.exe",
  },
  "aarch64-apple-darwin": {
    archiveBase: `node-${PINNED_NODE_RELEASE}-darwin-arm64`,
    format: "tar.gz",
    executableRelPath: "bin/node",
  },
  "x86_64-apple-darwin": {
    archiveBase: `node-${PINNED_NODE_RELEASE}-darwin-x64`,
    format: "tar.gz",
    executableRelPath: "bin/node",
  },
  "x86_64-unknown-linux-gnu": {
    archiveBase: `node-${PINNED_NODE_RELEASE}-linux-x64`,
    format: "tar.gz",
    executableRelPath: "bin/node",
  },
  "aarch64-unknown-linux-gnu": {
    archiveBase: `node-${PINNED_NODE_RELEASE}-linux-arm64`,
    format: "tar.gz",
    executableRelPath: "bin/node",
  },
};

function detectHostTriple() {
  const { platform, arch } = process;
  if (platform === "win32") {
    return "x86_64-pc-windows-msvc";
  }
  if (platform === "darwin") {
    return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (platform === "linux") {
    return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  return null;
}

const activeTarget = process.env.ANCILLA_NODE_TARGET || process.env.TAURI_ENV_TARGET_TRIPLE || detectHostTriple();

async function pathExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

let cachedManifestText = null;

async function lookupExpectedSha256(archiveFilename) {
  if (!cachedManifestText) {
    const manifestUrl = `https://nodejs.org/dist/${PINNED_NODE_RELEASE}/SHASUMS256.txt`;
    const res = await fetch(manifestUrl);
    if (!res.ok) {
      throw new Error(`Failed to fetch Node checksums from ${manifestUrl}: HTTP ${res.status}`);
    }
    cachedManifestText = await res.text();
  }

  const matchingRow = cachedManifestText
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row.endsWith(`  ${archiveFilename}`));

  if (!matchingRow) {
    throw new Error(`Checksum for archive ${archiveFilename} not found in official SHASUMS256.txt`);
  }
  return matchingRow.split(/\s+/)[0];
}

async function resolveNodeArtifacts(triple) {
  const spec = TARGET_DISTRIBUTIONS[triple];
  if (!spec) {
    throw new Error(`Unsupported target triple for Node runtime: ${triple}`);
  }

  const binaryPath = path.join(localCacheDir, spec.archiveBase, spec.executableRelPath);
  const licensePath = path.join(localCacheDir, spec.archiveBase, "LICENSE");

  if ((await pathExists(binaryPath)) && (await pathExists(licensePath))) {
    return { binary: binaryPath, license: licensePath };
  }

  await fs.mkdir(localCacheDir, { recursive: true });
  const archiveName = `${spec.archiveBase}.${spec.format}`;
  const archivePath = path.join(localCacheDir, archiveName);

  if (!(await pathExists(archivePath))) {
    const remoteUrl = `https://nodejs.org/dist/${PINNED_NODE_RELEASE}/${archiveName}`;
    console.log(`downloading ${remoteUrl}`);
    const downloadRes = await fetch(remoteUrl);
    if (!downloadRes.ok) {
      throw new Error(`Download failed with status ${downloadRes.status} for ${remoteUrl}`);
    }

    const payload = Buffer.from(await downloadRes.arrayBuffer());
    const computedHash = crypto.createHash("sha256").update(payload).digest("hex");
    const requiredHash = await lookupExpectedSha256(archiveName);

    if (computedHash !== requiredHash) {
      throw new Error(`Checksum verification failed for ${archiveName}: computed ${computedHash}, expected ${requiredHash}`);
    }
    await fs.writeFile(archivePath, payload);
  }

  const tarProgram =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : "tar";

  child_process.execFileSync(
    tarProgram,
    ["-xf", archivePath, "-C", localCacheDir, `${spec.archiveBase}/${spec.executableRelPath}`, `${spec.archiveBase}/LICENSE`],
    { stdio: "inherit" },
  );

  return { binary: binaryPath, license: licensePath };
}

async function installSidecarBinary(sourcePath, triple) {
  const isWindows = triple.includes("windows");
  const destPath = path.join(tauriBinariesDir, `node-${triple}${isWindows ? ".exe" : ""}`);
  await fs.copyFile(sourcePath, destPath);
  await fs.chmod(destPath, 0o755);
  console.log(`sidecar ready: ${destPath}`);

  if (triple.includes("linux")) {
    const internalRuntime = path.join(desktopRoot, "src-tauri", "resources", "node");
    await fs.mkdir(path.dirname(internalRuntime), { recursive: true });
    await fs.copyFile(sourcePath, internalRuntime);
    await fs.chmod(internalRuntime, 0o755);
    console.log(`private runtime ready: ${internalRuntime}`);
  }
}

async function installRuntimeLicense(sourceLicensePath) {
  await fs.mkdir(path.dirname(legalLicenseDest), { recursive: true });
  await fs.copyFile(sourceLicensePath, legalLicenseDest);
  console.log(`license ready: ${legalLicenseDest}`);
}

if (!activeTarget) {
  throw new Error("Target triple could not be determined. Please set ANCILLA_NODE_TARGET environment variable.");
}

await fs.rm(tauriBinariesDir, { recursive: true, force: true });
await fs.mkdir(tauriBinariesDir, { recursive: true });

if (activeTarget === "universal-apple-darwin") {
  const armArtifacts = await resolveNodeArtifacts("aarch64-apple-darwin");
  const x64Artifacts = await resolveNodeArtifacts("x86_64-apple-darwin");

  await installSidecarBinary(armArtifacts.binary, "aarch64-apple-darwin");
  await installSidecarBinary(x64Artifacts.binary, "x86_64-apple-darwin");

  const universalBinaryPath = path.join(tauriBinariesDir, "node-universal-apple-darwin");
  child_process.execFileSync("lipo", ["-create", armArtifacts.binary, x64Artifacts.binary, "-output", universalBinaryPath], {
    stdio: "inherit",
  });
  await fs.chmod(universalBinaryPath, 0o755);
  console.log(`sidecar ready: ${universalBinaryPath}`);

  await installRuntimeLicense(armArtifacts.license);
} else {
  const targetArtifacts = await resolveNodeArtifacts(activeTarget);
  await installSidecarBinary(targetArtifacts.binary, activeTarget);
  await installRuntimeLicense(targetArtifacts.license);
}

console.log(`bundled Node.js ${PINNED_NODE_RELEASE} for ${activeTarget}`);
