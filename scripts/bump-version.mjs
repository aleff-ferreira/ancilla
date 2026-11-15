import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const SEMVER_STRICT_PATTERN = /^\d+\.\d+\.\d+$/;

class TargetResolutionError extends Error {}

function loadWorkspaceFile(relativeFilePath) {
  const absolutePath = join(repositoryRoot, relativeFilePath);
  if (!existsSync(absolutePath)) {
    throw new TargetResolutionError(`${relativeFilePath} does not exist`);
  }
  return readFileSync(absolutePath, "utf8");
}

function escapeRegexCharacters(literalString) {
  return literalString.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createPatternField(targetPath, fieldDescription, searchPattern, customValidator) {
  const locateMatch = (fileContent) => {
    const activeFlags = searchPattern.flags.includes("g") ? searchPattern.flags : `${searchPattern.flags}g`;
    const matchesFound = [...fileContent.matchAll(new RegExp(searchPattern.source, activeFlags))];
    if (matchesFound.length !== 1) {
      throw new TargetResolutionError(`${targetPath}: expected exactly one ${fieldDescription}, found ${matchesFound.length}`);
    }
    return matchesFound[0];
  };

  return {
    path: targetPath,
    label: fieldDescription,
    written: true,
    read(content) {
      const extractedVersion = locateMatch(content)[2];
      if (customValidator) {
        customValidator(content, extractedVersion);
      }
      return extractedVersion;
    },
    write(content, targetVersion) {
      const matchedRecord = locateMatch(content);
      const prefixEndIndex = matchedRecord.index + matchedRecord[1].length;
      return content.slice(0, prefixEndIndex) + targetVersion + content.slice(prefixEndIndex + matchedRecord[2].length);
    },
  };
}

const buildMarkerText = (ver) =>
  `[notes for ${ver} not written yet: rewrite them to describe this release, then delete this line]`;

const PENDING_MARKER_REGEX = /^.*\[notes for \d+\.\d+\.\d+ not written yet[^\n]*\n?/gm;

function createNotesHeadingField(targetPath, fieldDescription, headingPattern, linePrefixRegex) {
  const baseField = createPatternField(targetPath, fieldDescription, headingPattern);
  return {
    ...baseField,
    rewriteNotes: true,
    write(content, targetVersion) {
      if (baseField.read(content) === targetVersion) {
        return content;
      }
      const updatedHeadingContent = baseField.write(content, targetVersion).replace(PENDING_MARKER_REGEX, "");
      const globalFlags = headingPattern.flags.includes("g") ? headingPattern.flags : `${headingPattern.flags}g`;
      const headingMatch = [...updatedHeadingContent.matchAll(new RegExp(headingPattern.source, globalFlags))][0];
      const newlineIndex = updatedHeadingContent.indexOf("\n", headingMatch.index);
      const eolSequence = newlineIndex > 0 && updatedHeadingContent[newlineIndex - 1] === "\r" ? "\r\n" : "\n";
      const linePrefix = linePrefixRegex.exec(headingMatch[1])[0];
      const insertionPoint = newlineIndex === -1 ? updatedHeadingContent.length : newlineIndex + 1;
      const markerLine = `${linePrefix}${buildMarkerText(targetVersion)}${eolSequence}`;
      const leadingGap = newlineIndex === -1 ? eolSequence : "";
      return `${updatedHeadingContent.slice(0, insertionPoint)}${leadingGap}${markerLine}${updatedHeadingContent.slice(insertionPoint)}`;
    },
  };
}

function findPendingNotesMarkers(fieldRegistry) {
  const pendingLocations = [];
  const candidatePaths = new Set(fieldRegistry.filter((f) => f.rewriteNotes).map((f) => f.path));

  for (const itemPath of candidatePaths) {
    const rawText = loadWorkspaceFile(itemPath);
    const versionMatch = /\[notes for (\d+\.\d+\.\d+) not written yet/.exec(rawText);
    if (versionMatch) {
      pendingLocations.push({ path: itemPath, version: versionMatch[1] });
    }
  }
  return pendingLocations;
}

function createJsonVersionField(targetPath) {
  return createPatternField(targetPath, `top-level "version"`, /^( {2}"version": *")([^"]*)(")/m, (rawText, foundVersion) => {
    try {
      const parsedData = JSON.parse(rawText);
      if (parsedData.version !== foundVersion) {
        throw new TargetResolutionError(`${targetPath}: the "version" found is not the top-level one`);
      }
    } catch (parseError) {
      if (parseError instanceof TargetResolutionError) throw parseError;
      throw new TargetResolutionError(`${targetPath}: failed to parse JSON (${parseError.message})`);
    }
  });
}

function serializeLockfileJson(jsonObject, newlineStyle) {
  return `${JSON.stringify(jsonObject, null, 2)}\n`.replace(/\n/g, newlineStyle);
}

function createPackageLockField(fieldDescription, propertyKeyPath) {
  const lockfilePath = "package-lock.json";
  const navigateProperty = (rootObject) => {
    const targetParent = propertyKeyPath.slice(0, -1).reduce((currentSubtree, propertyName) => currentSubtree?.[propertyName], rootObject);
    const leafPropertyName = propertyKeyPath.at(-1);
    if (typeof targetParent?.[leafPropertyName] !== "string") {
      throw new TargetResolutionError(`${lockfilePath}: ${fieldDescription} has no version; run npm install to bring the lockfile up to date`);
    }
    return targetParent;
  };

  return {
    path: lockfilePath,
    label: fieldDescription,
    written: true,
    read: (rawText) => navigateProperty(JSON.parse(rawText))[propertyKeyPath.at(-1)],
    write(rawText, targetVersion) {
      const detectedEol = rawText.includes("\r\n") ? "\r\n" : "\n";
      const parsedTree = JSON.parse(rawText);
      if (serializeLockfileJson(parsedTree, detectedEol) !== rawText) {
        throw new TargetResolutionError(`${lockfilePath} is not laid out the way npm writes it, so rewriting it would change more than versions; run npm install first`);
      }
      navigateProperty(parsedTree)[propertyKeyPath.at(-1)] = targetVersion;
      return serializeLockfileJson(parsedTree, detectedEol);
    },
  };
}

function createReadOnlyField(targetPath, fieldDescription, matchPattern, guidanceHint) {
  return {
    path: targetPath,
    label: fieldDescription,
    written: false,
    hint: guidanceHint,
    read(rawText) {
      const matchResult = matchPattern.exec(rawText);
      if (!matchResult) {
        throw new TargetResolutionError(`${targetPath}: no ${fieldDescription} found`);
      }
      return matchResult[1];
    },
  };
}

function discoverMonorepoWorkspaces() {
  const discoveredWorkspaces = [];
  const rootManifest = JSON.parse(loadWorkspaceFile("package.json"));
  const workspaceEntries = rootManifest.workspaces ?? [];

  for (const workspacePattern of workspaceEntries) {
    if (workspacePattern.endsWith("/*") && !/[*?[{]/.test(workspacePattern.slice(0, -2))) {
      const parentDir = workspacePattern.slice(0, -2);
      const directoryItems = readdirSync(join(repositoryRoot, parentDir), { withFileTypes: true });
      for (const item of directoryItems) {
        if (item.isDirectory() && existsSync(join(repositoryRoot, parentDir, item.name, "package.json"))) {
          discoveredWorkspaces.push(`${parentDir}/${item.name}`);
        }
      }
    } else if (!/[*?[{]/.test(workspacePattern)) {
      discoveredWorkspaces.push(workspacePattern);
    } else {
      throw new TargetResolutionError(`package.json: workspace pattern "${workspacePattern}" is not one this script understands`);
    }
  }

  if (discoveredWorkspaces.length === 0) {
    throw new TargetResolutionError("package.json lists no workspaces");
  }
  return discoveredWorkspaces.sort();
}

function buildConfiguredFieldRegistry() {
  const workspaceFolders = discoverMonorepoWorkspaces();
  const cargoTomlContent = loadWorkspaceFile("apps/desktop/src-tauri/Cargo.toml");
  const crateNameMatch = /^\[package\][^[]*?^name *= *"([^"]+)"/m.exec(cargoTomlContent);
  if (!crateNameMatch) {
    throw new TargetResolutionError("apps/desktop/src-tauri/Cargo.toml: no [package] name");
  }
  const desktopCrateIdentifier = crateNameMatch[1];

  return [
    createJsonVersionField("package.json"),
    ...workspaceFolders.map((subfolder) => createJsonVersionField(`${subfolder}/package.json`)),
    createPackageLockField(`the root "version"`, ["version"]),
    createPackageLockField(`packages[""]`, ["packages", "", "version"]),
    ...workspaceFolders.map((subfolder) => createPackageLockField(`packages["${subfolder}"]`, ["packages", subfolder, "version"])),
    createJsonVersionField("apps/desktop/src-tauri/tauri.conf.json"),
    createPatternField(
      "apps/desktop/src-tauri/Cargo.toml",
      "[package] version",
      /^(\[package\][ \t]*\r?\n(?:(?!\[|version\b)[^\n]*\n)*version *= *")([^"]*)(")/m,
    ),
    createPatternField(
      "apps/desktop/src-tauri/Cargo.lock",
      `"${desktopCrateIdentifier}" package`,
      new RegExp(`^(\\[\\[package\\]\\]\\r?\\nname = "${escapeRegexCharacters(desktopCrateIdentifier)}"\\r?\\nversion = ")([^"]*)(")`, "m"),
    ),
    createPatternField("packages/server/src/server.ts", "ANCILLA_VERSION", /^(export const ANCILLA_VERSION = ")([^"]*)(";)/m),
    createNotesHeadingField(
      ".github/workflows/release.yml",
      `release notes "New in" heading`,
      /^([ \t]*\*\*New in )(\d+\.\d+\.\d+)(\*\*)/m,
      /^[ \t]*/,
    ),
    createNotesHeadingField(
      "README.md",
      `README "New in" heading`,
      /^(> \*\*New in )(\d+\.\d+\.\d+)(:\*\*)/m,
      /^> /,
    ),
    createReadOnlyField(
      "docs/CHANGELOG.md",
      "newest entry",
      /^## +(\d+\.\d+\.\d+) *\r?$/m,
      "add an entry for it at the top of docs/CHANGELOG.md, then run node scripts/sync-changelog.mjs",
    ),
    createReadOnlyField(
      "packages/ui/src/model/changelog.generated.ts",
      "newest entry",
      /"version": "([^"]*)"/,
      "run node scripts/sync-changelog.mjs",
    ),
  ];
}

function surveyVersionRecords(registryList) {
  const cachedContents = new Map();
  return registryList.map((targetField) => {
    if (!cachedContents.has(targetField.path)) {
      cachedContents.set(targetField.path, loadWorkspaceFile(targetField.path));
    }
    return { field: targetField, version: targetField.read(cachedContents.get(targetField.path)) };
  });
}

function outputFormattedAlignmentReport(records, printOutputFunction, benchmarkVersion) {
  const maxLabelWidth = Math.max(...records.map(({ field }) => `${field.path}  ${field.label}`.length));
  for (const { field, version } of records) {
    const mismatchIndicator = benchmarkVersion && version !== benchmarkVersion ? `   <- expected ${benchmarkVersion}` : "";
    printOutputFunction(`  ${`${field.path}  ${field.label}`.padEnd(maxLabelWidth)}  ${version}${mismatchIndicator}`);
  }
}

function executeVersionCheck(explicitTargetVersion) {
  const fieldList = buildConfiguredFieldRegistry();
  const surveyedRows = surveyVersionRecords(fieldList);

  const occurrenceCounts = new Map();
  for (const { version } of surveyedRows) {
    occurrenceCounts.set(version, (occurrenceCounts.get(version) ?? 0) + 1);
  }

  const majorityVersion = [...occurrenceCounts].sort((first, second) => second[1] - first[1])[0][0];
  const requiredVersion = explicitTargetVersion ?? majorityVersion;
  const mismatchedRows = surveyedRows.filter(({ version }) => version !== requiredVersion);
  const unwrittenNotesMarkers = findPendingNotesMarkers(fieldList);

  if (mismatchedRows.length === 0 && unwrittenNotesMarkers.length === 0) {
    console.log(`All ${surveyedRows.length} versions are ${requiredVersion}.`);
    return true;
  }

  if (mismatchedRows.length > 0) {
    console.error(explicitTargetVersion ? `Not every version is ${explicitTargetVersion}:` : "The versions do not agree:");
    outputFormattedAlignmentReport(surveyedRows, console.error, requiredVersion);
    const remediationSet = new Set(
      mismatchedRows.map(({ field }) => field.hint ?? `run npm run version:bump -- ${requiredVersion}`),
    );
    console.error(`To fix: ${[...remediationSet].join("; ")}.`);
  }

  for (const { path: markerFilePath, version: markerVersion } of unwrittenNotesMarkers) {
    console.error(`The notes for ${markerVersion} are not written yet in ${markerFilePath}.`);
  }
  if (unwrittenNotesMarkers.length > 0) {
    console.error(
      `To fix: rewrite the notes under each "New in" heading so they describe this release, then delete the marker line under it.`,
    );
  }
  return false;
}

function executeVersionBump(newVersionString) {
  const fieldRegistry = buildConfiguredFieldRegistry();
  const writableFields = fieldRegistry.filter((f) => f.written);

  const baselineSurvey = surveyVersionRecords(fieldRegistry);
  const stagedFileModifications = new Map();

  for (const activeField of writableFields) {
    const currentText = stagedFileModifications.get(activeField.path) ?? loadWorkspaceFile(activeField.path);
    stagedFileModifications.set(activeField.path, activeField.write(currentText, newVersionString));
  }

  for (const [relativePath, transformedContent] of stagedFileModifications) {
    writeFileSync(join(repositoryRoot, relativePath), transformedContent);
  }

  const postSurvey = surveyVersionRecords(fieldRegistry);
  const incompleteUpdates = postSurvey.filter(({ field, version }) => field.written && version !== newVersionString);
  if (incompleteUpdates.length > 0) {
    const failedDescriptions = incompleteUpdates.map(({ field }) => `${field.path} ${field.label}`).join(", ");
    throw new TargetResolutionError(`still not ${newVersionString}: ${failedDescriptions}`);
  }

  const distinctPreviousVersions = [...new Set(baselineSurvey.filter(({ field }) => field.written).map((row) => row.version))].join(", ");
  console.log(`Set ${newVersionString} in ${writableFields.length} places across ${stagedFileModifications.size} files (was ${distinctPreviousVersions}):`);
  outputFormattedAlignmentReport(postSurvey.filter(({ field }) => field.written), console.log);

  const headingsUpdated = [...new Set(writableFields.filter((f) => f.rewriteNotes).map((f) => f.path))];
  if (headingsUpdated.length > 0) {
    console.info(`Only the headings were renamed. Rewrite the notes under "New in ${newVersionString}" in ${headingsUpdated.join(" and ")} so they describe this release.`);
    const activeMarkers = findPendingNotesMarkers(fieldRegistry).map(({ path }) => path);
    if (activeMarkers.length > 0) {
      console.info(`A marker line under the heading in ${activeMarkers.join(" and ")} keeps npm run version:check failing until the notes are rewritten and the line is deleted.`);
    }
  }

  for (const { field: roField, version: roVersion } of postSurvey.filter(({ field }) => !field.written)) {
    if (roVersion !== newVersionString) {
      console.log(`${roField.path} is still at ${roVersion}: ${roField.hint}.`);
    }
  }
}

function displayUsageAndExit() {
  console.error("Usage: node scripts/bump-version.mjs <x.y.z>");
  console.error("       node scripts/bump-version.mjs --check [x.y.z]");
  process.exit(2);
}

const commandLineArguments = process.argv.slice(2);
const isCheckModeActive = commandLineArguments.includes("--check");
const positionalArguments = commandLineArguments.filter((arg) => arg !== "--check");

if (positionalArguments.some((arg) => arg.startsWith("-")) || positionalArguments.length > 1 || (!isCheckModeActive && positionalArguments.length !== 1)) {
  displayUsageAndExit();
}

const requestedTargetVersion = positionalArguments[0]?.replace(/^v/, "") ?? null;
if (requestedTargetVersion !== null && !SEMVER_STRICT_PATTERN.test(requestedTargetVersion)) {
  console.error(`"${positionalArguments[0]}" is not a version: use three numbers, like 0.18.0.`);
  process.exit(2);
}

try {
  if (isCheckModeActive) {
    process.exitCode = executeVersionCheck(requestedTargetVersion) ? 0 : 1;
  } else {
    executeVersionBump(requestedTargetVersion);
  }
} catch (executionError) {
  if (!(executionError instanceof TargetResolutionError)) {
    throw executionError;
  }
  console.error(`bump-version: ${executionError.message}`);
  process.exitCode = 1;
}
