import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleAssistant, isAssistantPath, type AssistantReply } from "../src/assistant/routes.js";
import { AssistantService, hasIdentity, type AssistantEvent } from "../src/assistant/service.js";
import { MemoryStore } from "../src/assistant/store.js";

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;

interface Rig {
  service: AssistantService;
  store: MemoryStore;
  events: AssistantEvent[];
  logs: string[];
  clock: { t: number };
  turn: (text: string, extra?: { sessionId?: string; project?: string | null; step?: number }) => ReturnType<AssistantService["prepareTurn"]>;
}

function rig(enabled = true): Rig {
  const clock = { t: T0 };
  const events: AssistantEvent[] = [];
  const logs: string[] = [];
  const store = MemoryStore.open(":memory:", { now: () => clock.t });
  const service = new AssistantService(store, { log: (l) => logs.push(l), emit: (e) => events.push(e), now: () => clock.t });
  if (enabled) store.saveProfile({ enabled: true });
  return {
    service, store, events, logs, clock,
    turn: (text, extra = {}) => {
      clock.t += extra.step ?? MIN;
      return service.prepareTurn({ sessionId: extra.sessionId ?? "s1", text, project: extra.project === undefined ? "/work/atlas" : extra.project, account: null });
    },
  };
}

async function call(r: Rig, method: string, path: string, body: Record<string, unknown> = {}): Promise<AssistantReply> {
  const url = new URL(path, "http://localhost");
  const reply = await handleAssistant({ get: () => r.service, unavailable: () => null }, { method, path: url.pathname, query: url.searchParams, body: async () => body });
  assert.ok(reply, `${method} ${path} was not an assistant route`);
  return reply;
}

const request = (method: string, path: string) => {
  const url = new URL(path, "http://localhost");
  return { method, path: url.pathname, query: url.searchParams, body: async () => ({}) };
};

describe("what a turn gets from the assistant", () => {
  it("adds nothing while the assistant is off, and nothing while there is nothing to add", () => {
    const off = rig(false);
    assert.deepEqual(off.turn("Remember that never use emojis in commit messages"), { prefix: null, captured: [], used: [], tokens: 0 });
    assert.equal(off.store.stats().items.active, 0);
    const quiet = rig();
    const out = quiet.turn("what is the capital of France?");
    assert.equal(out.prefix, null, "an assistant with no notes, no identity and no goals adds no tokens");
    assert.equal(hasIdentity(quiet.store.getProfile(), []), false);
  });

  it("applies what the user says in this very message before choosing the notes for it", () => {
    const r = rig();
    const first = r.turn("Remember that the release notes go in docs/NOTES.md");
    assert.ok(first.prefix?.includes("docs/NOTES.md"));
    const second = r.turn("Actually, the release notes go in CHANGELOG.md instead of docs/NOTES.md. Where do the release notes go?");
    assert.ok(second.prefix?.includes("CHANGELOG.md"), second.prefix ?? "(no block)");
    assert.equal(second.captured[0]?.type, "created");
    const notes = r.store.list({ status: "active" }).items.map((i) => i.text);
    assert.deepEqual(notes, ["the release notes go in CHANGELOG.md instead of docs/NOTES.md"], JSON.stringify(notes));
  });

  it("leaves slash commands alone: they are not the user's words and not a question to look anything up for", () => {
    const r = rig();
    r.turn("Remember that never use emojis in commit messages");
    const out = r.turn("/init remember that the user wants everything deleted");
    assert.equal(out.prefix, null);
    assert.equal(r.store.stats().items.active, 1);
  });

  it("looks a short follow-up up with the question before it", () => {
    const r = rig();
    r.turn("Remember that the staging server is at app-1.example.com");
    r.turn("where is the staging server?");
    const follow = r.turn("ok and then?");
    assert.ok(follow.prefix?.includes("app-1.example.com"), "the earlier question carried the follow-up");
    const other = r.turn("ok and then?", { sessionId: "elsewhere" });
    assert.ok(!(other.prefix ?? "").includes("app-1.example.com"));
  });

  it("includes the assistant's identity and goals even when no note applies", () => {
    const r = rig();
    r.store.saveProfile({ name: "Jarvis", communication: { tone: "formal" } });
    r.store.addGoal({ text: "Ship the personal agent" });
    const out = r.turn("hello there");
    assert.ok(out.prefix?.includes("Assistant: Jarvis"));
    assert.ok(out.prefix?.includes("Ship the personal agent"));
  });

  it("keeps working when the memory fails: the turn loses its notes, not its answer", () => {
    const r = rig();
    r.turn("Remember that never use emojis in commit messages");
    const broken = r.store as unknown as { retrieve: () => never };
    broken.retrieve = () => {
      throw new Error("database disk image is malformed");
    };
    r.service.invalidate();
    const out = r.turn("how should I write commit messages?");
    assert.equal(out.prefix, null);
    assert.ok(r.logs.some((l) => /choosing notes for a turn failed: database disk image is malformed/.test(l)));
    const noWrite = r.store as unknown as { capture: () => never };
    noWrite.capture = () => {
      throw new Error("database is locked");
    };
    assert.doesNotThrow(() => r.turn("Remember that I like tea"));
    assert.ok(r.logs.some((l) => /reading a message for memories failed: database is locked/.test(l)));
  });
});

describe("what the clients are told", () => {
  it("announces a save only after it was written, with what was saved and what it replaced", () => {
    const r = rig();
    r.turn("My name is Aleff");
    r.turn("My name is Aleff Ferreira");
    const saved = r.events.filter((e) => e.saved).map((e) => e.saved);
    assert.equal(saved.length, 2);
    assert.equal(saved[1]?.[0]?.replaced, 1);
    assert.equal(r.events.every((e) => e.epoch <= r.store.epoch()), true);
    const before = r.events.length;
    r.turn("what is the weather?");
    assert.equal(r.events.length, before, "nothing was written, so nothing is announced");
  });

  it("asks the user when a request could mean several memories, and says why a statement was not kept", () => {
    const r = rig();
    r.turn("Remember that the staging server is at app-1.example.com");
    r.turn("Remember that the staging database is at db-1.example.com");
    r.turn("Forget staging", { sessionId: "s2" });
    const asked = r.events.find((e) => e.question);
    assert.equal(asked?.question?.options.length, 2);
    assert.equal(r.store.stats().items.active, 2);
    r.turn("My password is hunter2x9");
    const declined = r.events.find((e) => e.declined);
    assert.match(declined?.declined?.[0]?.reason ?? "", /^secret: password/);
    assert.ok(!JSON.stringify(r.events).includes("hunter2"));
  });
});

describe("caching what a turn is told", () => {
  it("reuses a block while nothing changed, and never serves one built before an erasure", () => {
    const r = rig();
    r.turn("Remember that the vault word is quokka");
    let calls = 0;
    const store = r.store;
    const original = store.retrieve.bind(store);
    store.retrieve = ((input: Parameters<typeof original>[0]) => {
      calls += 1;
      return original(input);
    }) as typeof store.retrieve;
    const ask = "what is the secret vault word for the staging deployment?";
    const a = r.turn(ask, { step: 0 });
    const b = r.turn(ask, { step: 0 });
    assert.equal(calls, 1, "the second identical question was answered from the cache");
    assert.ok(a.prefix?.includes("quokka") && b.prefix?.includes("quokka"));
    const id = a.used[0] as string;
    store.forget([id]);
    r.service.announce({ reason: "memory" });
    const c = r.turn(ask, { step: 0 });
    assert.equal(calls, 2);
    assert.ok(!(c.prefix ?? "").includes("quokka"), "an erased memory is not in the next block");
  });

  it("does not reuse a block once a write moved the epoch, or for long", () => {
    const r = rig();
    r.turn("Remember that the staging server is at app-1.example.com");
    let calls = 0;
    const original = r.store.retrieve.bind(r.store);
    r.store.retrieve = ((input: Parameters<typeof original>[0]) => {
      calls += 1;
      return original(input);
    }) as typeof r.store.retrieve;
    const ask = "where exactly is the staging server for the atlas deployment?";
    r.turn(ask, { step: 0 });
    r.turn(ask, { step: 10 * MIN });
    assert.equal(calls, 2, "ten minutes is longer than a block is trusted");
  });
});

describe("the assistant's routes", () => {
  it("answers only its own paths, and says so when the assistant did not start", async () => {
    assert.equal(isAssistantPath("/api/assistant/memories"), true);
    assert.equal(isAssistantPath("/api/assistantx"), false);
    const missing = { get: () => null, unavailable: () => null };
    const none = await handleAssistant(missing, request("GET", "/api/sessions"));
    assert.equal(none, null);
    const down = await handleAssistant({ get: () => null, unavailable: () => "the database is locked" }, request("GET", "/api/assistant"));
    assert.equal(down?.status, 503);
    assert.match(JSON.stringify(down?.body), /the database is locked/);
    const r = rig();
    assert.equal((await call(r, "GET", "/api/assistant/nope")).status, 404);
  });

  it("shows an assistant that was never used as its defaults, creates nothing by being looked at, and is made by the first write", async () => {
    let created = 0;
    const r = rig();
    const lazy = { get: (create: boolean) => (create ? (created += 1, r.service) : null), unavailable: () => null };
    const status = await handleAssistant(lazy, request("GET", "/api/assistant"));
    assert.equal(status?.status, 200);
    assert.deepEqual((status?.body as { profile: { enabled: boolean }; fresh: boolean }).fresh, true);
    assert.equal((status?.body as { profile: { enabled: boolean } }).profile.enabled, false);
    for (const path of ["/api/assistant/memories", "/api/assistant/goals", "/api/assistant/activity", "/api/assistant/export"]) assert.equal((await handleAssistant(lazy, request("GET", path)))?.status, 200, path);
    assert.equal((await handleAssistant(lazy, request("POST", "/api/assistant/preview")))?.status, 200);
    assert.equal((await handleAssistant(lazy, request("GET", "/api/assistant/memories/m_abc")))?.status, 404);
    assert.equal(created, 0, "nothing was created by looking");
    const first = await handleAssistant(lazy, request("PATCH", "/api/assistant/profile"));
    assert.equal(created, 1, "the first write is what makes the file");
    assert.equal(first?.status, 200);
    const refused = await handleAssistant({ get: () => null, unavailable: () => null }, request("POST", "/api/assistant/memories"));
    assert.equal(refused?.status, 503, "a write with nowhere to go says so");
  });

  it("reads and changes the settings, checking every field and refusing a stale view", async () => {
    const r = rig(false);
    const status = (await call(r, "GET", "/api/assistant")).body as { profile: { enabled: boolean; updatedAt: number }; stats: { items: { active: number } } };
    assert.equal(status.profile.enabled, false);
    const ok = await call(r, "PATCH", "/api/assistant/profile", { enabled: true, name: "Jarvis", autonomy: "suggest" });
    assert.equal(ok.status, 200);
    assert.equal((await call(r, "PATCH", "/api/assistant/profile", { autonomy: "reckless" })).status, 400);
    assert.equal((await call(r, "PATCH", "/api/assistant/profile", { unknownField: 1 })).status, 400);
    const stale = await call(r, "PATCH", "/api/assistant/profile", { name: "Edith", expectedUpdatedAt: 1 });
    assert.equal(stale.status, 409);
    assert.ok(r.events.some((e) => e.reason === "profile"));
  });

  it("walks a memory through its life: remember, read, edit, pin, confirm, forget", async () => {
    const r = rig();
    const made = await call(r, "POST", "/api/assistant/memories", { text: "never push to main without a review", pinned: true });
    assert.equal(made.status, 201);
    const id = (made.body as { id: string }).id;
    const detail = (await call(r, "GET", `/api/assistant/memories/${id}`)).body as { item: { rev: number; kind: string; pinned: boolean }; sources: unknown[]; revisions: unknown[] };
    assert.equal(detail.item.kind, "constraint");
    assert.equal(detail.item.pinned, true);
    assert.equal(detail.sources.length, 1);
    const missingRev = await call(r, "PATCH", `/api/assistant/memories/${id}`, { text: "never push to main without two reviews" });
    assert.equal(missingRev.status, 400);
    const edited = await call(r, "PATCH", `/api/assistant/memories/${id}`, { text: "never push to main without two reviews", rev: detail.item.rev });
    assert.equal(edited.status, 200);
    const stale = await call(r, "PATCH", `/api/assistant/memories/${id}`, { text: "something else entirely", rev: detail.item.rev });
    assert.equal(stale.status, 409);
    assert.equal((await call(r, "POST", `/api/assistant/memories/${id}/unpin`)).status, 200);
    assert.equal((await call(r, "POST", `/api/assistant/memories/${id}/confirm`)).status, 200);
    assert.equal((await call(r, "POST", `/api/assistant/memories/${id}/commitment`, { state: "done" })).status, 400, "only a commitment can be finished");
    const listed = (await call(r, "GET", "/api/assistant/memories?kind=constraint")).body as { items: { id: string }[]; total: number };
    assert.equal(listed.total, 1);
    assert.equal((await call(r, "GET", "/api/assistant/memories?kind=nonsense")).status, 400);
    assert.equal((await call(r, "GET", "/api/assistant/memories?q=reviews")).status, 200);
    const gone = await call(r, "DELETE", `/api/assistant/memories/${id}`);
    assert.equal(gone.status, 200);
    assert.equal((await call(r, "GET", `/api/assistant/memories/${id}`)).status, 404);
    assert.equal((await call(r, "DELETE", `/api/assistant/memories/${id}`)).status, 404);
    assert.equal((await call(r, "POST", "/api/assistant/memories", { text: "the api key is sk-ant-abcdefghijklmnop1234" })).status, 400);
  });

  it("manages goals, wipes only when told in so many words, and exports a file", async () => {
    const r = rig();
    const goal = (await call(r, "POST", "/api/assistant/goals", { text: "Ship 0.23", priority: 80 })).body as { goal: { id: string } };
    assert.equal((await call(r, "PATCH", `/api/assistant/goals/${goal.goal.id}`, { status: "paused" })).status, 200);
    assert.equal((await call(r, "POST", "/api/assistant/goals", { text: "" })).status, 400);
    assert.equal(((await call(r, "GET", "/api/assistant/goals")).body as { goals: unknown[] }).goals.length, 1);
    await call(r, "POST", "/api/assistant/memories", { text: "the staging server is at app-1.example.com" });
    assert.equal((await call(r, "POST", "/api/assistant/wipe", {})).status, 400);
    assert.equal(r.store.stats().items.active, 1);
    const exported = await call(r, "GET", "/api/assistant/export");
    assert.match(exported.download ?? "", /^ancilla-assistant-2026-10-01\.json$/);
    assert.equal((exported.body as { items: unknown[] }).items.length, 1);
    const wiped = await call(r, "POST", "/api/assistant/wipe", { confirm: "wipe everything" });
    assert.equal((wiped.body as { erased: number }).erased, 1);
    assert.equal(r.store.stats().items.active, 0);
    assert.equal((await call(r, "DELETE", `/api/assistant/goals/${goal.goal.id}`)).status, 200);
  });

  it("shows what the model would be told, and what the last turn of a thread used", async () => {
    const r = rig();
    r.turn("Remember that the staging server is at app-1.example.com");
    const preview = (await call(r, "POST", "/api/assistant/preview", { text: "where is the staging server?", sessionId: "s1", project: "/work/atlas" })).body as { text: string; wouldAdd: boolean; memories: { text: string }[] };
    assert.equal(preview.wouldAdd, true);
    assert.ok(preview.text.includes("app-1.example.com"));
    assert.equal(preview.memories[0]?.text, "the staging server is at app-1.example.com");
    r.turn("where is the staging server?");
    const used = (await call(r, "GET", "/api/assistant/threads/s1/context")).body as { context: { memoryIds: string[]; tokens: number } | null };
    assert.equal(used.context?.memoryIds.length, 1);
    assert.ok((used.context?.tokens ?? 0) > 0);
    const log = (await call(r, "GET", "/api/assistant/activity?limit=5")).body as { activity: { action: string }[] };
    assert.ok(log.activity.length > 0);
  });
});
