import esbuild from "esbuild";
import child_process from "node:child_process";
import fs from "node:fs/promises";
import moduleKit from "node:module";
import path from "node:path";
import url from "node:url";

const scriptDirectory = path.dirname(url.fileURLToPath(import.meta.url));
const desktopAppRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(desktopAppRoot, "../..");
const tauriResourcesDir = path.join(desktopAppRoot, "src-tauri", "resources");
const legalStagingDir = path.join(tauriResourcesDir, "legal");

const MANDATORY_LEGAL_DOCS = ["LICENSE", "THIRD_PARTY_NOTICES.md"];
const OPTIONAL_LEGAL_DOCS = ["NOTICE.md"];
const CRATE_LICENSES_FILENAME = "RUST_CRATE_LICENSES.md";

async function checkFileExists(targetPath) {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

function isCargoAvailable() {
  try {
    child_process.execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function prepareResourceDirectories() {
  await fs.rm(path.join(tauriResourcesDir, "frontend"), { recursive: true, force: true });
  await fs.rm(path.join(tauriResourcesDir, "server.cjs"), { force: true });
  await fs.rm(path.join(tauriResourcesDir, "asr-worker.cjs"), { force: true });
  await fs.mkdir(legalStagingDir, { recursive: true });
}

async function stageFrontendAssets() {
  const distSource = path.resolve(repositoryRoot, "apps", "web", "dist");
  const distDestination = path.join(tauriResourcesDir, "frontend");
  await fs.cp(distSource, distDestination, { recursive: true });
}

async function stageLegalArtifacts() {
  const allDocuments = [...MANDATORY_LEGAL_DOCS, ...OPTIONAL_LEGAL_DOCS];
  for (const docName of allDocuments) {
    const sourceFilePath = path.join(repositoryRoot, docName);
    const destinationPath = path.join(legalStagingDir, docName);
    await fs.rm(destinationPath, { force: true });

    if (OPTIONAL_LEGAL_DOCS.includes(docName)) {
      if (!(await checkFileExists(sourceFilePath))) {
        continue;
      }
    }
    await fs.cp(sourceFilePath, destinationPath);
  }

  const crateLicensePath = path.join(legalStagingDir, CRATE_LICENSES_FILENAME);
  await fs.rm(crateLicensePath, { force: true });

  if (isCargoAvailable()) {
    const noticeScript = path.join(repositoryRoot, "scripts", "third-party-notices.mjs");
    child_process.execFileSync(process.execPath, [noticeScript, "--crates", crateLicensePath], {
      stdio: "inherit",
    });
  } else {
    console.warn(`cargo not found: leaving ${CRATE_LICENSES_FILENAME} out, as there is no desktop executable to build either`);
  }
}

const pdfkitFontResolutionPlugin = {
  name: "pdfkit-standard-fonts-bundler",
  setup(pluginBuild) {
    const serverPackagePath = path.join(repositoryRoot, "packages", "server", "package.json");
    const serverRequire = moduleKit.createRequire(serverPackagePath);

    pluginBuild.onResolve({ filter: /^pdfkit$/ }, () => ({
      path: serverRequire.resolve("pdfkit"),
    }));

    pluginBuild.onLoad({ filter: /[\\/]pdfkit[\\/]js[\\/]pdfkit\.js$/ }, async (loadArgs) => {
      const originalCode = await fs.readFile(loadArgs.path, "utf8");
      const rewrittenCode = originalCode.replaceAll("require$1('#standard-fonts/", "require('#standard-fonts/");
      if (rewrittenCode === originalCode) {
        throw new Error(`pdfkit's standard-font loaders were not found in ${loadArgs.path}; the bundle plugin needs updating`);
      }
      return { contents: rewrittenCode, loader: "js" };
    });
  },
};

async function buildServerBundle() {
  const serverEntry = path.join(repositoryRoot, "packages", "server", "src", "cli.ts");
  const serverOutput = path.join(tauriResourcesDir, "server.cjs");

  await esbuild.build({
    entryPoints: [serverEntry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: serverOutput,
    logLevel: "info",
    plugins: [pdfkitFontResolutionPlugin],
  });
}

async function buildAsrWorkerBundle() {
  const asrEntry = path.join(repositoryRoot, "packages", "server", "src", "voice", "engines", "asr-worker.ts");
  const asrOutput = path.join(tauriResourcesDir, "asr-worker.cjs");

  await esbuild.build({
    entryPoints: [asrEntry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: asrOutput,
    logLevel: "info",
  });
}

await prepareResourceDirectories();
await stageFrontendAssets();
await stageLegalArtifacts();
await buildServerBundle();
await buildAsrWorkerBundle();

console.log("bundled desktop resources into src-tauri/resources");
