// The tour of Ancilla as a harness for Muse Code, recorded one clip at a time. Usage: node scripts/media/tour.mjs <clip>...
// Clips, in the order of the film: intro assistant ask report crew plan diffs usage outro. The assistant is only the opening;
// the rest is the harness: Deep Research from the composer to the exported report, every agent in view with a live
// approval, the plan card, diffs and files beside the work, and the plan usage meter. Each clip fades up from the brand's
// forest colour and back into it, so the clips join with a plain copy.
import { clip, sleep } from "./tour-lib.mjs";

const begin = async (S, wait = 400) => { await S.veil(0, 700); await sleep(wait); };
const end = async (S) => { await S.captionOff(); await S.cursorVis(false); await S.veil(1, 600); await sleep(700); };

const clips = {
  intro: () => clip("intro", {}, async (S) => {
    await S.card("title", { sub: "The harness around Muse Code: deep research, agent monitoring, approvals and usage." });
    await S.veil(0, 600);
    await sleep(4200);
    await S.veil(1, 600);
    await sleep(700);
  }),

  // Only the opening: an assistant of your own, in a few clicks.
  assistant: () => clip("assistant", { query: "assistant=new" }, async (S) => {
    await begin(S, 300);
    await S.caption("First, an assistant of your own", "Opt-in: it remembers, and has a face and a voice you choose.");
    await sleep(1000);
    await S.click({ selector: 'button[aria-label^="Meet your assistant"]', sidebar: true }, { ms: 550 });
    await sleep(400);
    await S.click({ text: "Let's begin" }, { ms: 450, pause: 40 });
    await sleep(400);
    for (const form of ["Hologram", "Critter"]) { await S.click({ text: form, has: true }, { ms: 360, pause: 40 }); await sleep(420); }
    await S.click({ text: "Next" }, { ms: 420, pause: 40 });
    await sleep(380);
    await S.click({ text: "Next" }, { ms: 420, pause: 40 });
    await sleep(380);
    await S.click({ text: "Wake", starts: true }, { ms: 420 });
    await sleep(1300);
    await end(S);
  }),

  // Deep Research from the composer: research mode, the question, the scope, the run with its workers.
  ask: () => clip("ask", { query: "view=home" }, async (S) => {
    await begin(S, 300);
    await S.caption("Deep research", "Ask a question. Muse workers investigate in parallel.");
    await sleep(1000);
    await S.chord("R", "KeyR", 82, 10);
    await sleep(700);
    await S.click({ selector: "textarea" }, { ms: 600 });
    await S.type("How do Radix, Primer and Material 3 choose muted text colours for dark themes?", 32);
    await sleep(500);
    await S.caption("Set the scope", "A time window, how many workers run at once, and what Stop does.");
    await S.click({ selector: 'button[aria-label="Research options"]' }, { ms: 650 });
    await sleep(1900);
    await S.key("Escape");
    await sleep(400);
    await S.click({ selector: 'button[aria-label="Start the research"]' }, { ms: 650 });
    await S.caption("Every worker in view", "Searches, pages read and sources counted as they happen.");
    S.speed(4); // the queue: a spinner and no sources yet
    await sleep(8000);
    S.speed(1); // the workers appear, round by round
    await sleep(4500);
    await S.caption("You stay in control", "Stop any time and still get a report from what was found.");
    // The chevron beside Stop opens the other ways to stop; the menu is only looked at, never chosen from.
    await S.click({ selector: 'button[aria-label="Other ways to stop"]' }, { ms: 750 });
    await sleep(2500);
    await S.key("Escape");
    await sleep(400);
    S.speed(3);
    await sleep(11000);
    S.speed(1);
    await sleep(400);
    await end(S);
  }),

  // The report: citations that point at pages the workers opened, and the export.
  report: () => clip("report", { query: "view=research" }, async (S) => {
    await begin(S, 300);
    await S.scrollToText("^Short answer", 150, 1500);
    await S.caption("A report with traceable sources", "Numbered citations link to pages the workers opened.");
    await sleep(700);
    const cite = await S.find({ selector: "sup a, sup button, a sup, sup" });
    if (cite && cite.y > 150 && cite.y < 700) { await S.moveTo(cite.x, cite.y, 800); await sleep(1300); }
    await S.caption("Export it, or run it again", "PDF, Word or a web page; edit the question and rerun.");
    // The export buttons sit under the report: bring them up from behind the composer, then open the menu.
    await S.scrollToText("^Show all", 380, 1000);
    await sleep(300);
    await S.click({ text: "Download", has: true }, { ms: 750 });
    await sleep(2200);
    await S.key("Escape");
    await sleep(300);
    await end(S);
  }),

  // Crew: the board, a filter, and a request that waits for a decision until it is made.
  crew: () => clip("crew", { query: "crew=running&panel=crew" }, async (S) => {
    await begin(S, 300);
    await S.caption("Every agent in view", "Phases, a timeline, who needs you, what failed.");
    await sleep(2600);
    await S.click({ text: "Failed1", starts: true, sidebar: true }, { ms: 800 });
    await sleep(1200);
    await S.click({ text: "All11", starts: true, sidebar: true }, { ms: 500 });
    await sleep(500);
    await S.caption("Nothing runs until you decide", "Muse's request waits: allow it once, always, or reject it.");
    await sleep(1200);
    await S.click({ text: "Allow once" }, { ms: 800 });
    await sleep(2800);
    await end(S);
  }),

  // The card of an ordinary prompt: the plan folded in, ticked off as Muse reports it, until the turn finishes.
  plan: () => clip("plan", { query: "crew=turn&speed=18", settle: 700 }, async (S) => {
    await begin(S, 300);
    await S.caption("A calm card for every prompt", "The plan is folded in; progress moves only when Muse reports.", "top");
    await sleep(1200);
    // The card rests above the composer, its title on the first line; whatever the title says at the moment, that is the head.
    await S.click({ leafRe: "\\S", minY: 745, maxY: 790, minX: 500, maxX: 1500 }, { ms: 700 });
    await S.cursorVis(false);
    const done = await S.waitText("^Turn finished", 24000);
    console.log("turn finished seen:", done);
    await sleep(1800);
    await end(S);
  }),

  // A finished coding thread: an inline diff from its chip, and the file browser beside it.
  diffs: () => clip("diffs", { query: "view=diff" }, async (S) => {
    await begin(S, 300);
    await S.scrollTop(0, 600);
    await S.caption("The work, in the thread", "Inline diffs, approvals, and a file browser beside it.");
    await sleep(1400);
    // Resting on a chip opens the file's diff in a card; a click would close it again, so only rest.
    await S.hover({ text: "cursor.ts", starts: true }, { ms: 700 });
    await sleep(2600);
    await S.moveTo(S.pos.x + 40, S.pos.y + 150, 500);
    await sleep(400);
    await S.click({ selector: 'button[aria-label="Show files"]', noScroll: true }, { ms: 700 });
    await sleep(2400);
    await end(S);
  }),

  usage: () => clip("usage", { query: "view=usage" }, async (S) => {
    await begin(S, 300);
    await S.caption("Your plan limits, honestly", "5-hour and weekly windows, and the last reading when Meta is quiet.");
    await sleep(2400);
    await S.captionOff();
    await S.scrollBy(520, 1500);
    await sleep(900);
    await end(S);
  }),

  outro: () => clip("outro", {}, async (S) => {
    await S.card("outro");
    await S.veil(0, 600);
    await sleep(4200);
    await S.veil(1, 600);
    await sleep(700);
  }),
};

for (const name of process.argv.slice(2)) {
  if (!clips[name]) { console.log(`no clip ${name}`); continue; }
  try { await clips[name](); } catch (e) { console.log(`${name} failed: ${e.message}`); process.exitCode = 1; }
}
