/**
 * Writes one release version into every file that carries it, or checks that they all agree.
 *
 *   node scripts/bump-version.mjs 0.18.0           set 0.18.0 everywhere (npm run version:bump -- 0.18.0)
 *   node scripts/bump-version.mjs --check          fail unless every version is the same
 *   node scripts/bump-version.mjs --check v0.18.0  fail unless every version is 0.18.0
 *
 * The version lives in the npm packages and their lockfile, the Tauri config (which names the
 * installers, and is what the updater compares against), the Rust crate and its lockfile, and the
 * server's ANCILLA_VERSION. Each is edited in place, touching only the version, and a target that
 * cannot be found is an error rather than a skip: one file quietly left behind is exactly what this
 * is here to prevent. CI runs --check on every push, and the release workflow checks the tag.
 *
 * The changelog is checked but not written, since its entry needs words: until docs/CHANGELOG.md
 * has an entry for the version and scripts/sync-changelog.mjs has been run, --check fails.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Plain x.y.z: the changelog, the updater and the version comparisons in the UI know nothing else. */
const VERSION = /^\d+\.\d+\.\d+$/;

class TargetError extends Error {}

function read(path) {
  const full = join(root, path);
  if (!existsSync(full)) {
    throw new TargetError(`${path} does not exist`);
  }
  return readFileSync(full, "utf8");
}

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A version found by a pattern that must match exactly once, with three groups: what comes
 * before the version, the version, and what comes after. Only the middle one is ever rewritten.
 */
function patternField(path, label, pattern, verify) {
  const find = (text) => {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const matches = [...text.matchAll(new RegExp(pattern.source, flags))];
    if (matches.length !== 1) {
      throw new TargetError(`${path}: expected exactly one ${label}, found ${matches.length}`);
    }
    return matches[0];
  };
  return {
    path,
    label,
    written: true,
    read(text) {
      const version = find(text)[2];
      verify?.(text, version);
      return version;
    },
    write(text, version) {
      const match = find(text);
      const start = match.index + match[1].length;
      return text.slice(0, start) + version + text.slice(start + match[2].length);
    },
  };
}

/**
 * The top-level "version" of a JSON file indented by two spaces, which every one here is. The
 * pattern finds it by its indent; parsing the file confirms that what it found is the real one.
 */
function jsonVersion(path) {
  return patternField(path, `top-level "version"`, /^( {2}"version": *")([^"]*)(")/m, (text, version) => {
    if (JSON.parse(text).version !== version) {
      throw new TargetError(`${path}: the "version" found is not the top-level one`);
    }
  });
}

/** How npm writes package-lock.json, so rewriting it changes nothing but the versions. */
function serialize(data, eol) {
  return `${JSON.stringify(data, null, 2)}\n`.replace(/\n/g, eol);
}

/** A version in package-lock.json, at `keys`. */
function lockField(label, keys) {
  const path = "package-lock.json";
  const locate = (data) => {
    const parent = keys.slice(0, -1).reduce((node, key) => node?.[key], data);
    if (typeof parent?.[keys.at(-1)] !== "string") {
      throw new TargetError(`${path}: ${label} has no version; run npm install to bring the lockfile up to date`);
    }
    return parent;
  };
  return {
    path,
    label,
    written: true,
    read: (text) => locate(JSON.parse(text))[keys.at(-1)],
    write(text, version) {
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      const data = JSON.parse(text);
      if (serialize(data, eol) !== text) {
        throw new TargetError(`${path} is not laid out the way npm writes it, so rewriting it would change more than versions; run npm install first`);
      }
      locate(data)[keys.at(-1)] = version;
      return serialize(data, eol);
    },
  };
}

/** A version this script checks but leaves alone. */
function readOnlyField(path, label, pattern, hint) {
  return {
    path,
    label,
    written: false,
    hint,
    read(text) {
      const match = pattern.exec(text);
      if (!match) {
        throw new TargetError(`${path}: no ${label} found`);
      }
      return match[1];
    },
  };
}

/** The workspace folders, as the root package.json lists them. */
function workspaces() {
  const found = [];
  for (const entry of JSON.parse(read("package.json")).workspaces ?? []) {
    if (entry.endsWith("/*") && !/[*?[{]/.test(entry.slice(0, -2))) {
      const parent = entry.slice(0, -2);
      for (const child of readdirSync(join(root, parent), { withFileTypes: true })) {
        if (child.isDirectory() && existsSync(join(root, parent, child.name, "package.json"))) {
          found.push(`${parent}/${child.name}`);
        }
      }
    } else if (!/[*?[{]/.test(entry)) {
      found.push(entry);
    } else {
      throw new TargetError(`package.json: workspace pattern "${entry}" is not one this script understands`);
    }
  }
  if (found.length === 0) {
    throw new TargetError("package.json lists no workspaces");
  }
  return found.sort();
}

function fields() {
  const packages = workspaces();
  const crate = /^\[package\][^[]*?^name *= *"([^"]+)"/m.exec(read("apps/desktop/src-tauri/Cargo.toml"))?.[1];
  if (!crate) {
    throw new TargetError("apps/desktop/src-tauri/Cargo.toml: no [package] name");
  }
  return [
    jsonVersion("package.json"),
    ...packages.map((folder) => jsonVersion(`${folder}/package.json`)),
    lockField(`the root "version"`, ["version"]),
    lockField(`packages[""]`, ["packages", "", "version"]),
    ...packages.map((folder) => lockField(`packages["${folder}"]`, ["packages", folder, "version"])),
    jsonVersion("apps/desktop/src-tauri/tauri.conf.json"),
    patternField(
      "apps/desktop/src-tauri/Cargo.toml",
      "[package] version",
      /^(\[package\][ \t]*\r?\n(?:(?!\[|version\b)[^\n]*\n)*version *= *")([^"]*)(")/m,
    ),
    patternField(
      "apps/desktop/src-tauri/Cargo.lock",
      `"${crate}" package`,
      new RegExp(`^(\\[\\[package\\]\\]\\r?\\nname = "${escape(crate)}"\\r?\\nversion = ")([^"]*)(")`, "m"),
    ),
    patternField("packages/server/src/server.ts", "ANCILLA_VERSION", /^(export const ANCILLA_VERSION = ")([^"]*)(";)/m),
    readOnlyField(
      "docs/CHANGELOG.md",
      "newest entry",
      /^## +(\d+\.\d+\.\d+) *\r?$/m,
      "add an entry for it at the top of docs/CHANGELOG.md, then run node scripts/sync-changelog.mjs",
    ),
    readOnlyField(
      "packages/ui/src/model/changelog.generated.ts",
      "newest entry",
      /"version": "([^"]*)"/,
      "run node scripts/sync-changelog.mjs",
    ),
  ];
}

/** Every field with the version it holds now, reading each file once. */
function survey(list) {
  const texts = new Map();
  return list.map((field) => {
    if (!texts.has(field.path)) {
      texts.set(field.path, read(field.path));
    }
    return { field, version: field.read(texts.get(field.path)) };
  });
}

function report(rows, log, expected) {
  const width = Math.max(...rows.map(({ field }) => `${field.path}  ${field.label}`.length));
  for (const { field, version } of rows) {
    const mark = expected && version !== expected ? `   <- expected ${expected}` : "";
    log(`  ${`${field.path}  ${field.label}`.padEnd(width)}  ${version}${mark}`);
  }
}

function check(wanted) {
  const rows = survey(fields());
  // Without a version to hold them to, the odd ones out are whatever differs from the majority.
  const counts = new Map();
  for (const { version } of rows) {
    counts.set(version, (counts.get(version) ?? 0) + 1);
  }
  const expected = wanted ?? [...counts].sort((a, b) => b[1] - a[1])[0][0];
  const wrong = rows.filter(({ version }) => version !== expected);
  if (wrong.length === 0) {
    console.log(`All ${rows.length} versions are ${expected}.`);
    return true;
  }
  console.error(wanted ? `Not every version is ${wanted}:` : "The versions do not agree:");
  report(rows, console.error, expected);
  const fixes = new Set(wrong.map(({ field }) => field.hint ?? `run npm run version:bump -- ${expected}`));
  console.error(`To fix: ${[...fixes].join("; ")}.`);
  return false;
}

function bump(version) {
  const list = fields();
  const written = list.filter((field) => field.written);
  // Every target is found, and every edit worked out, before anything is written: a target that
  // is missing stops the run with no file changed.
  const before = survey(list);
  const edited = new Map();
  for (const field of written) {
    edited.set(field.path, field.write(edited.get(field.path) ?? read(field.path), version));
  }
  for (const [path, text] of edited) {
    writeFileSync(join(root, path), text);
  }
  const after = survey(list);
  const missed = after.filter(({ field, version: now }) => field.written && now !== version);
  if (missed.length > 0) {
    throw new TargetError(`still not ${version}: ${missed.map(({ field }) => `${field.path} ${field.label}`).join(", ")}`);
  }
  const previous = [...new Set(before.filter(({ field }) => field.written).map((row) => row.version))].join(", ");
  console.log(`Set ${version} in ${written.length} places across ${edited.size} files (was ${previous}):`);
  report(after.filter(({ field }) => field.written), console.log);
  for (const { field, version: now } of after.filter(({ field: f }) => !f.written)) {
    if (now !== version) {
      console.log(`${field.path} is still at ${now}: ${field.hint}.`);
    }
  }
}

function usage() {
  console.error("Usage: node scripts/bump-version.mjs <x.y.z>");
  console.error("       node scripts/bump-version.mjs --check [x.y.z]");
  process.exit(2);
}

const args = process.argv.slice(2);
const checking = args.includes("--check");
const rest = args.filter((arg) => arg !== "--check");
if (rest.some((arg) => arg.startsWith("-")) || rest.length > 1 || (!checking && rest.length !== 1)) {
  usage();
}
// A tag name is accepted as it is, so the release workflow can pass v0.18.0 straight through.
const wanted = rest[0]?.replace(/^v/, "") ?? null;
if (wanted !== null && !VERSION.test(wanted)) {
  console.error(`"${rest[0]}" is not a version: use three numbers, like 0.18.0.`);
  process.exit(2);
}

try {
  if (checking) {
    process.exitCode = check(wanted) ? 0 : 1;
  } else {
    bump(wanted);
  }
} catch (error) {
  if (!(error instanceof TargetError)) {
    throw error;
  }
  console.error(`bump-version: ${error.message}`);
  process.exitCode = 1;
}
