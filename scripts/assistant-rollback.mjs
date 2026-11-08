// Steps the assistant's database back to an earlier schema version, after writing a copy of what it holds.
//
//   node scripts/assistant-rollback.mjs <data folder> <version>    for example: ... ~/.ancilla 1
//   node scripts/assistant-rollback.mjs <data folder> --status     which version the file is at, and what the steps are
//
// Version 0 removes every table the assistant made; 1 keeps memory and profile and drops tasks and schedules.
// Quit Ancilla first. A rollback destroys the data of the steps it undoes; the export written beside the file is the
// way back to the memories (it does not hold tasks). To remove the assistant entirely, deleting assistant.db and its
// -wal and -shm files does the same.
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const dist = new URL("../packages/server/dist/src/assistant/", import.meta.url);
let schema;
let store;
try {
  schema = await import(new URL("schema.js", dist).href);
  store = await import(new URL("store.js", dist).href);
} catch (error) {
  console.error(`assistant-rollback: the server is not built (${error.code ?? error.message}). Run: npm run build --workspace @ancilla/server`);
  process.exit(2);
}

const [folder, target] = process.argv.slice(2);
if (!folder || !target) {
  console.error("usage: node scripts/assistant-rollback.mjs <data folder> <version | --status>");
  process.exit(2);
}
const file = join(resolve(folder), "assistant.db");
if (!existsSync(file)) {
  console.error(`assistant-rollback: there is no assistant.db in ${resolve(folder)}. Nothing to roll back.`);
  process.exit(1);
}

const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(file);
const current = schema.schemaVersion(db);

if (target === "--status") {
  console.log(`assistant.db is at schema version ${current}; this Ancilla understands up to ${schema.LATEST_VERSION}.`);
  for (const step of schema.MIGRATIONS) console.log(`  ${step.version}: ${step.name}${step.version <= current ? "" : " (not applied)"}`);
  db.close();
  process.exit(0);
}

const version = Number(target);
if (!Number.isInteger(version) || version < 0 || version >= current) {
  console.error(`assistant-rollback: the file is at version ${current}. Give a whole number from 0 to ${current - 1}, or --status.`);
  db.close();
  process.exit(2);
}
db.close();

// A copy first, through the store, so that what is written is exactly what the assistant would export.
const exportFile = join(resolve(folder), `assistant-export-before-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
const kept = store.MemoryStore.open(file);
writeFileSync(exportFile, JSON.stringify(kept.exportAll(), null, 2), "utf8");
kept.close();

const raw = new DatabaseSync(file);
raw.exec("PRAGMA foreign_keys = ON");
const now = schema.rollbackTo(raw, version);
raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
raw.close();
console.log(`Wrote ${exportFile}`);
console.log(`assistant.db is now at schema version ${now}.`);
