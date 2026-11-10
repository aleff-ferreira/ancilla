import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConflictError, ValidationError } from "../src/assistant/store.js";
import { AuditLog } from "../src/connectors/audit.js";
import { GITHUB, githubTarget } from "../src/connectors/catalog.js";
import { APPROVAL_MS, argsProblem, canonical, cardFields, computeFlags, detach, hashOf, MAX_PROPOSALS, PROPOSAL_MS, ReadLog, reasonOf, VALUE_MAX, WriteGate, type HoldInput, type Verdict } from "../src/connectors/gate.js";
import { classOf, cleanPolicy } from "../src/connectors/manifest.js";
import { OTHER_KEY } from "./connectors-fixtures.js";

/**
 * The gate a change goes through, with no server and no model: what an approval is bound to, that it is good once and not for
 * long, what is shown of a change, and what code notices about it that the model never says.
 */

function rig() {
  const clock = { t: 1_000_000 };
  const audit = new AuditLog(null);
  const gate = new WriteGate({ audit, now: () => clock.t });
  return { clock, audit, gate };
}

const ARGS = { owner: "aleff-ferreira", repo: "ancilla", issue_number: 12, body: "Fixed in 0.27." };

const input = (patch: Partial<HoldInput> = {}): HoldInput => ({
  taskId: "t_1",
  connector: "github",
  connectorName: "GitHub",
  tool: "add_issue_comment",
  cls: "communicates",
  what: "Comment on an issue or a pull request.",
  args: { ...ARGS },
  target: githubTarget(ARGS),
  flags: [],
  offerAlways: false,
  ...patch,
});

const call = (patch: Record<string, unknown> = {}) => ({ connector: "github", tool: "add_issue_comment", args: { ...ARGS, ...patch }, task: "t_1" as string | null });

/** Holds a change and answers it at once. */
async function approved(gate: WriteGate, patch: Partial<HoldInput> = {}) {
  const pending = gate.hold(input(patch));
  const card = gate.question("t_1");
  assert.ok(card);
  gate.answer(card.id, "do");
  const verdict = await pending;
  assert.equal(verdict.allowed, true);
  return { card, verdict: verdict as Extract<Verdict, { allowed: true }> };
}

describe("what an approval is bound to", () => {
  it("is a hash of the connector, the tool and every argument, the same whatever order the keys came in, and different for any change", () => {
    const base = hashOf("github", "add_issue_comment", ARGS);
    assert.match(base, /^[0-9a-f]{64}$/);
    assert.equal(hashOf("github", "add_issue_comment", { body: "Fixed in 0.27.", issue_number: 12, repo: "ancilla", owner: "aleff-ferreira" }), base, "key order does not matter");
    assert.equal(canonical({ b: [1, { d: 1, c: undefined }], a: "x" }), '{"a":"x","b":[1,{"d":1}]}');
    for (const other of [
      hashOf("github", "add_issue_comment", { ...ARGS, body: "Fixed in 0.27" }),
      hashOf("github", "add_issue_comment", { ...ARGS, issue_number: 13 }),
      hashOf("github", "add_issue_comment", { ...ARGS, issue_number: "12" }),
      hashOf("github", "add_issue_comment", { ...ARGS, extra: true }),
      hashOf("github", "add_issue_comment", { owner: ARGS.owner, repo: ARGS.repo, issue_number: 12 }),
      hashOf("github", "merge_pull_request", ARGS),
      hashOf("brevo", "add_issue_comment", ARGS),
    ]) assert.notEqual(other, base);
  });

  it("is made from plain data only: what is shown, hashed and sent is one detached copy", () => {
    const live = { a: { b: 1 }, f: () => 1, u: undefined };
    const copy = detach(live);
    assert.deepEqual(copy, { a: { b: 1 } });
    (live.a as { b: number }).b = 2;
    assert.deepEqual(copy, { a: { b: 1 } }, "a later change to the model's object does not reach it");
    assert.deepEqual(detach("not an object"), {});
    assert.deepEqual(detach([1, 2]), {});
    const loop: Record<string, unknown> = {};
    loop["self"] = loop;
    assert.deepEqual(detach(loop), {}, "something that cannot be written down is nothing");
  });
});

describe("a change held for the person", () => {
  it("shows a card made from the call and sends only with the approval their answer made, once", async () => {
    const { gate, audit } = rig();
    const pending = gate.hold(input());
    const card = gate.question("t_1");
    assert.ok(card);
    assert.equal(gate.question("t_other"), null, "a card belongs to its task");
    assert.deepEqual(card.fields, [
      { name: "owner", value: "aleff-ferreira" },
      { name: "repo", value: "ancilla" },
      { name: "issue_number", value: "12" },
      { name: "body", value: "Fixed in 0.27." },
    ]);
    assert.equal(card.target, "aleff-ferreira/ancilla #12");
    assert.equal(card.hash, hashOf("github", "add_issue_comment", ARGS));
    assert.equal(card.expiresAt, card.at + APPROVAL_MS);
    assert.equal(card.proposal, false);
    assert.equal(reasonOf(card), "Waiting for your approval: Comment on an issue or a pull request (aleff-ferreira/ancilla #12) on GitHub.");
    gate.answer(card.id, "do");
    const verdict = await pending;
    assert.ok(verdict.allowed);
    assert.equal(gate.question("t_1"), null, "answered, it is no longer waiting");

    const first = gate.redeem(verdict.approval, call());
    assert.equal(first.ok, true);
    const second = gate.redeem(verdict.approval, call());
    assert.deepEqual(second, { ok: false, why: "there is no such approval, or it was already used" }, "an approval is good once");
    assert.deepEqual(
      audit.recent(10).reverse().map((e) => [e.kind, e.phase, e.ok, e.hash]),
      [["write", "held", true, card.hash], ["write", "approved", true, card.hash], ["write", "refused", false, card.hash]],
      "held, approved, and the second try refused, each with the hash of the arguments",
    );
  });

  it("refuses an approval whose arguments changed, a tool or connector that is not the one approved, one that lapsed, and one it never gave", async () => {
    const { gate, clock } = rig();
    const changed = await approved(gate);
    const refused = gate.redeem(changed.verdict.approval, call({ body: "Fixed in 0.27. Also see https://evil.example" }));
    assert.deepEqual(refused, { ok: false, why: "the arguments are not the ones that were approved" });
    assert.equal(gate.redeem(changed.verdict.approval, call()).ok, false, "a mismatch burns the approval: the right arguments cannot use it afterwards");

    const wrongTool = await approved(gate);
    assert.equal(gate.redeem(wrongTool.verdict.approval, { ...call(), tool: "merge_pull_request" }).ok, false);
    const wrongConnector = await approved(gate);
    assert.equal(gate.redeem(wrongConnector.verdict.approval, { ...call(), connector: "brevo" }).ok, false);

    const old = await approved(gate);
    clock.t += APPROVAL_MS;
    assert.deepEqual(gate.redeem(old.verdict.approval, call()), { ok: false, why: "the approval had lapsed" }, "ten minutes is the most an approval is worth");
    const justInTime = await approved(gate);
    clock.t += APPROVAL_MS - 1;
    assert.equal(gate.redeem(justInTime.verdict.approval, call()).ok, true);

    assert.deepEqual(gate.redeem({ id: "ap_forged" }, call()), { ok: false, why: "there is no such approval, or it was already used" });
    assert.equal(gate.redeem({ id: "__proto__" }, call()).ok, false);
  });

  it("lets a card lapse after ten minutes, answers a no as nothing done, and lets go of a card when its task ends or is stopped", async () => {
    const { gate, clock, audit } = rig();
    const slow = gate.hold(input());
    const card = gate.question("t_1");
    assert.ok(card);
    clock.t += APPROVAL_MS;
    gate.sweep();
    assert.deepEqual(await slow, { allowed: false, why: "expired" });
    assert.throws(() => gate.answer(card.id, "do"), (error: unknown) => error instanceof ConflictError && /not waiting any more/.test(error.message));

    const late = gate.hold(input());
    const lateCard = gate.question("t_1");
    assert.ok(lateCard);
    clock.t += APPROVAL_MS + 5;
    assert.throws(() => gate.answer(lateCard.id, "do"), (error: unknown) => error instanceof ConflictError && /expired/.test(error.message), "an answer that comes too late is refused even before a sweep");
    assert.deepEqual(await late, { allowed: false, why: "expired" });

    const no = gate.hold(input());
    gate.answer((gate.question("t_1") as { id: string }).id, "dont");
    assert.deepEqual(await no, { allowed: false, why: "dont" });

    const stopped = new AbortController();
    const ended = gate.hold(input(), stopped.signal);
    stopped.abort();
    assert.deepEqual(await ended, { allowed: false, why: "ended" });
    assert.equal(gate.question("t_1"), null);
    assert.deepEqual(await gate.hold(input(), stopped.signal), { allowed: false, why: "ended" }, "a signal that is already aborted never shows a card");

    const over = gate.hold(input());
    gate.end("t_1");
    assert.deepEqual(await over, { allowed: false, why: "ended" });
    assert.deepEqual(audit.recent(50).filter((e) => e.phase === "executed"), [], "none of this sent anything");
  });

  it("answers only do, dont, or always where always is offered, and only for a card that is waiting", async () => {
    const { gate } = rig();
    const plain = gate.hold(input());
    const card = gate.question("t_1") as { id: string };
    assert.throws(() => gate.answer(card.id, "maybe"), (error: unknown) => error instanceof ValidationError);
    assert.throws(() => gate.answer(card.id, "always"), (error: unknown) => error instanceof ValidationError && /cannot be allowed for good/.test(error.message));
    assert.throws(() => gate.answer("wq_unknown", "do"), ConflictError);
    gate.answer(card.id, "dont");
    await plain;

    const offered = gate.hold(input({ cls: "reversible", offerAlways: true }));
    const offeredCard = gate.question("t_1");
    assert.equal(offeredCard?.offerAlways, true);
    gate.answer((offeredCard as { id: string }).id, "always");
    const verdict = await offered;
    assert.ok(verdict.allowed && verdict.always);
  });

  it("allows a standing reversible change without a card but still binds it to its arguments, once, and writes it down", () => {
    const { gate, audit } = rig();
    const approval = gate.standing(input({ cls: "reversible", tool: "create_branch", args: { owner: "o", repo: "r", branch: "x" } }));
    assert.equal(gate.redeem(approval, { connector: "github", tool: "create_branch", args: { owner: "o", repo: "r", branch: "y" }, task: "t_1" }).ok, false);
    const again = gate.standing(input({ cls: "reversible", tool: "create_branch", args: { owner: "o", repo: "r", branch: "x" } }));
    assert.equal(gate.redeem(again, { connector: "github", tool: "create_branch", args: { owner: "o", repo: "r", branch: "x" }, task: "t_1" }).ok, true);
    assert.ok(audit.recent(10).some((e) => e.phase === "approved" && /standing rule/.test(e.note ?? "")));
  });
});

describe("a change nobody was there to look at", () => {
  it("is kept as a proposal, never held by a task, and sent only by approving that very card, once", () => {
    const { gate, clock, audit } = rig();
    const card = gate.propose(input({ taskId: "t_sched" }));
    assert.ok(card);
    assert.equal(card.proposal, true);
    assert.equal(card.expiresAt, card.at + PROPOSAL_MS);
    assert.deepEqual(gate.proposals().map((p) => p.id), [card.id]);
    assert.equal(gate.question("t_sched"), null, "no task is held for it");
    assert.throws(() => gate.takeProposal(card.id, "always"), ValidationError);
    const taken = gate.takeProposal(card.id, "do");
    assert.ok(taken);
    assert.deepEqual(taken.args, ARGS);
    assert.equal(gate.redeem(taken.approval, { connector: "github", tool: "add_issue_comment", args: { ...ARGS, body: "other" }, task: null }).ok, false);
    assert.throws(() => gate.takeProposal(card.id, "do"), ConflictError, "a proposal is answered once");

    const refused = gate.propose(input({ taskId: "t_sched" }));
    assert.ok(refused);
    assert.equal(gate.takeProposal(refused.id, "dont"), null);
    const stale = gate.propose(input({ taskId: "t_sched" }));
    assert.ok(stale);
    clock.t += PROPOSAL_MS;
    assert.deepEqual(gate.proposals(), [], "a proposal that nobody answered for a day is dropped");
    assert.throws(() => gate.takeProposal(stale.id, "do"), ConflictError);
    assert.ok(audit.recent(30).some((e) => e.phase === "expired"));
    assert.deepEqual(audit.recent(30).filter((e) => e.phase === "executed"), []);
  });

  it("keeps only a few: a crowd of them is refused, and the refusal is written down", () => {
    const { gate, audit } = rig();
    for (let i = 0; i < MAX_PROPOSALS; i += 1) assert.ok(gate.propose(input({ args: { ...ARGS, issue_number: i } })));
    assert.equal(gate.propose(input()), null);
    assert.equal(gate.proposals().length, MAX_PROPOSALS);
    assert.match(audit.recent(1)[0]?.note ?? "", /too many/);
  });
});

describe("what is shown of a change", () => {
  it("is every argument whole, with what cannot be seen made visible, and a text too long to read is not sent", () => {
    const fields = cardFields({ body: `line one\nline two‮hidden​`, labels: ["a", "b"], draft: false, n: 3 });
    assert.deepEqual(fields.map((f) => f.name), ["body", "labels", "draft", "n"]);
    assert.equal(fields[0]?.value, "line one\nline two�hidden�", "a newline stays, an invisible character becomes a mark");
    assert.deepEqual(fields.slice(1).map((f) => f.value), ['["a","b"]', "false", "3"]);
    assert.equal(argsProblem({ body: "x".repeat(VALUE_MAX) }), null);
    assert.match(argsProblem({ body: "x".repeat(VALUE_MAX + 1) }) ?? "", /more than the approval can show whole/);
    assert.match(argsProblem({ nested: { deeper: ["x".repeat(VALUE_MAX + 1)] } }) ?? "", /more than the approval can show whole/, "a long text hidden in a list is found too");
    assert.match(argsProblem({ a: "x".repeat(7000), b: "x".repeat(7000), c: "x".repeat(7000) }) ?? "", /longer than 20000/);
  });

  it("classes a call by its arguments as well as its tool, never lower than the tool", () => {
    const issue = GITHUB.tools["issue_write"];
    assert.ok(issue);
    assert.equal(classOf(issue, { method: "create", title: "x" }), "communicates");
    assert.equal(classOf(issue, { method: "update", state: "closed" }), "destructive", "closing is a close");
    assert.equal(classOf(issue, { method: "update", state: "CLOSED" }), "destructive");
    assert.equal(classOf(issue, { method: "update", state: "open" }), "communicates");
    const merge = GITHUB.tools["merge_pull_request"];
    assert.ok(merge);
    assert.equal(classOf(merge, {}), "destructive");
    assert.equal(classOf({ class: "destructive", text: "", escalate: () => "reversible" }, {}), "destructive", "an argument cannot make a call less than its tool");
  });

  it("stores only what is safe: a setting it does not know is off, and only a reversible change can be allowed without asking", () => {
    assert.deepEqual(cleanPolicy(undefined), { reversible: "off", communicates: "off", destructive: "off" });
    assert.deepEqual(cleanPolicy({ reversible: "always", communicates: "always", destructive: "always" }), { reversible: "always", communicates: "ask", destructive: "ask" }, "a hand-edited file cannot allow a comment or a merge without asking");
    assert.deepEqual(cleanPolicy({ reversible: "yes", communicates: 1, destructive: null, extra: "ask" }), { reversible: "off", communicates: "off", destructive: "off" });
    assert.deepEqual(cleanPolicy("ask"), { reversible: "off", communicates: "off", destructive: "off" });
  });
});

describe("what code notices before the person says yes", () => {
  const goal = "Comment on issue 12 of aleff-ferreira/ancilla that it is fixed in 0.27. Link https://github.com/aleff-ferreira/ancilla/pull/9 please.";
  const flagsOf = (args: Record<string, unknown>, reads = new ReadLog(), asked = goal, known: string[] = []) => computeFlags({ args, target: githubTarget(args), goal: asked, reads, known });
  const codes = (args: Record<string, unknown>, reads?: ReadLog, asked?: string) => flagsOf(args, reads, asked).map((f) => f.code);

  it("says nothing about a change that is what the person said", () => {
    assert.deepEqual(flagsOf({ ...ARGS, body: "Fixed in 0.27. See https://github.com/aleff-ferreira/ancilla/pull/9" }), []);
    assert.deepEqual(codes({ ...ARGS, issue_number: "12" }), [], "a number as text is the same number");
    assert.deepEqual(codes({ owner: "x", repo: "ancilla", issue_number: 12, body: "ok" }), ["not-named"], "the same repository name under another owner is another repository");
    assert.deepEqual(flagsOf(ARGS, new ReadLog(), "comment on issue 12 in ancilla that it is fixed"), [], "the repository's name alone, as a word, is naming it");
  });

  it("flags a target the person did not name: another repository, another number, or both", () => {
    assert.deepEqual(flagsOf({ ...ARGS, owner: "mallory", repo: "other" }).map((f) => [f.code, f.text]), [["not-named", "You did not name mallory/other in what you asked."]]);
    assert.match(flagsOf({ ...ARGS, issue_number: 99 })[0]?.text ?? "", /did not name #99/);
    assert.match(flagsOf({ owner: "mallory", repo: "other", issue_number: 7, body: "x" })[0]?.text ?? "", /mallory\/other or #7/);
    assert.deepEqual(codes({ owner: "aleff-ferreira", repo: "ancilla", issue_number: 120, body: "x" }), ["not-named"], "12 is not 120");
  });

  it("flags a link or an address in the text that the person did not write, and no other", () => {
    assert.deepEqual(codes({ ...ARGS, body: "see https://evil.example/x or mail evil@example.com or www.evil.example." }), ["link"]);
    const text = flagsOf({ ...ARGS, body: "see https://evil.example/x, evil@example.com and www.evil.example." })[0]?.text ?? "";
    assert.ok(text.includes("https://evil.example/x") && text.includes("evil@example.com") && text.includes("www.evil.example"), text);
    assert.deepEqual(codes({ ...ARGS, body: "mail ana@example.com" }, undefined, `${goal} Mail ana@example.com.`), [], "an address the person wrote is theirs");
  });

  it("flags text shaped like a key, and the connector's own token wherever it shows", () => {
    assert.deepEqual(codes({ ...ARGS, body: `the key is ${OTHER_KEY}` }), ["secret"]);
    assert.deepEqual(flagsOf({ ...ARGS, body: "token hunter2-hunter2-hunter2" }, new ReadLog(), goal, ["hunter2-hunter2-hunter2"]).map((f) => f.code), ["secret"]);
    assert.deepEqual(codes({ ...ARGS, body: ["nested", { deeper: OTHER_KEY }] as unknown as string }), ["secret"], "a key in a list is found too");
  });

  it("flags text copied from a different item than the one answered, and says which", () => {
    const reads = new ReadLog();
    const other = "The deployment key rotation procedure requires three approvals from the infrastructure group before Friday.";
    reads.record(false, "mallory/other#7", `Issue 7 says: ${other}`);
    reads.record(false, "aleff-ferreira/ancilla#12", "Issue 12 says: the sidebar flickers when the window is resized.");
    const copied = flagsOf({ ...ARGS, body: `Thanks. ${other}` }, reads);
    assert.deepEqual(copied.map((f) => f.code), ["stranger-text", "copied"]);
    assert.match(copied[1]?.text ?? "", /copies words from mallory\/other#7, which is not the one it answers \(aleff-ferreira\/ancilla#12\)/);
    assert.deepEqual(flagsOf({ ...ARGS, body: "Thanks. The sidebar flickers when the window is resized, I will look." }, reads).map((f) => f.code), ["stranger-text"], "text from the item it answers is not copied from elsewhere");
    assert.deepEqual(flagsOf({ ...ARGS, body: `Quote: ${other}` }, reads, `${goal} Quote: ${other}`).map((f) => f.code), ["stranger-text"], "words the person gave are theirs");
    assert.deepEqual(flagsOf({ ...ARGS, body: "short" }, reads).map((f) => f.code), ["stranger-text"], "a short text copies nothing worth naming");
  });

  it("says that the task has read what strangers wrote, but not for what only the person could have written", () => {
    const reads = new ReadLog();
    assert.equal(reads.tainted, false);
    reads.record(true, null, "{\"login\":\"aleff\"}");
    assert.equal(reads.tainted, false, "who the token belongs to is not a stranger's text");
    assert.deepEqual(codes(ARGS, reads), []);
    reads.record(false, null, "an issue anybody could have written");
    assert.equal(reads.tainted, true);
    assert.deepEqual(codes(ARGS, reads), ["stranger-text"]);
  });

  it("flags characters that cannot be seen", () => {
    assert.deepEqual(codes({ ...ARGS, body: "Fixed‮ in 0.27." }), ["hidden-characters"]);
    assert.deepEqual(codes({ ...ARGS, body: "line one\nline two\ttabbed" }), [], "a newline and a tab are not hidden");
  });
});
