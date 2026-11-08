// The tour of what is new in Ancilla, recorded one clip at a time. Usage: node tour.mjs <clip>...
// Clips: intro meeting memory run research crew usage outro. Each clip fades up from the brand's forest colour and back
// into it, so the clips join with a plain copy.
import { clip, sleep } from "./tour-lib.mjs";

const begin = async (S, wait = 400) => { await S.veil(0, 700); await sleep(wait); };
const end = async (S) => { await S.captionOff(); await S.cursorVis(false); await S.veil(1, 600); await sleep(700); };

const clips = {
  intro: () => clip("intro", {}, async (S) => {
    await S.card("title", { sub: "A workspace for Muse Code. Now with an assistant that remembers." });
    await S.veil(0, 600);
    await sleep(4000);
    await S.veil(1, 600);
    await sleep(700);
  }),

  meeting: () => clip("meeting", { query: "assistant=new" }, async (S) => {
    await begin(S, 300);
    await S.caption("Meet your assistant", "A first meeting: you choose its face, its voice and its name.");
    await sleep(1300);
    await S.click({ selector: 'button[aria-label^="Meet your assistant"]', sidebar: true }, { ms: 700 });
    await sleep(700);
    await S.captionOff();
    await S.click({ selector: 'input[type="text"]' }, { ms: 600 });
    await S.select();
    await S.type("Vesper", 55);
    await sleep(200);
    await S.click({ text: "Let's begin" }, { ms: 550 });
    await sleep(600);
    await S.caption("Choose a face", "Five forms, any colour you like.");
    for (const form of ["Hologram", "Critter", "Optic"]) { await S.click({ text: form, has: true }, { ms: 400, pause: 40 }); await sleep(450); }
    for (const hue of ["Amber", "Teal"]) { await S.click({ text: hue }, { ms: 350, pause: 40 }); await sleep(420); }
    await S.click({ text: "Next" }, { ms: 500, pause: 50 });
    await sleep(500);
    await S.caption("Give it a voice", "Eight temperaments and five dials.");
    for (const voice of ["Playful", "Dry"]) { await S.click({ text: voice, starts: true }, { ms: 450, pause: 50 }); await sleep(800); }
    await S.click({ text: "Next" }, { ms: 600, pause: 50 });
    await sleep(500);
    await S.caption("Decide how far it may go", "Ask first, suggest, or act within limits.");
    await sleep(1100);
    await S.click({ text: "Wake", starts: true }, { ms: 650 });
    await S.captionOff();
    await sleep(900);
    await S.caption("Now it is yours", "A face in the sidebar, on its own page and beside the composer.");
    await sleep(2600);
    await end(S);
  }),

  memory: () => clip("memory", { hash: "#/assistant" }, async (S) => {
    await begin(S, 300);
    await S.caption("It is there when you need it", "Its face shows when something is waiting for you.");
    await sleep(1300);
    await S.captionOff();
    await S.click({ text: "Memory", starts: true }, { ms: 650 });
    await sleep(450);
    await S.caption("It remembers, and shows where from", "Each note says who said it and when, and you can correct it.");
    await sleep(1200);
    await S.scrollBy(440, 1300);
    await sleep(1100);
    await S.click({ text: "Tasks", starts: true }, { ms: 650 });
    await sleep(450);
    await S.caption("It works on what you approve", "A task counts as done only when a check that reads a file passes.");
    await sleep(1000);
    await S.scrollBy(420, 1300);
    await sleep(1400);
    await end(S);
  }),

  run: () => clip("run", { query: "crew=turn&speed=12", settle: 700 }, async (S) => {
    await begin(S, 300);
    await S.caption("A calm card for every prompt", "The plan is folded in. No clock, no guesses.", "top");
    await sleep(1800);
    // The card rests above the composer, its title on the first line; whatever the title says at the moment, that is the head.
    await S.click({ leafRe: "\\S", minY: 745, maxY: 790, minX: 500, maxX: 1500 }, { ms: 800 });
    await S.cursorVis(false);
    await sleep(2400);
    await S.caption("Its face stays beside you", "Working while a turn runs, pleased when it lands.", "top");
    const done = await S.waitText("^Turn finished", 24000);
    console.log("turn finished seen:", done);
    await sleep(500);
    await S.captionOff();
    const face = await S.find({ selector: 'svg[role="img"]', minY: 960, maxX: 900 });
    console.log("face at:", JSON.stringify(face));
    // Push in on the finished card, the composer and the face with what it says, leaving the sidebar out of the frame.
    if (face) await S.camera(1173, 900, 1.7, 1000, 1000, 540);
    await sleep(3300);
    await end(S);
  }),

  research: () => clip("research", { query: "view=research" }, async (S) => {
    await begin(S, 300);
    await S.caption("Deep research", "A question becomes a cited report. Watch the workers read.");
    await sleep(2100);
    await S.captionOff();
    await S.scrollToText("^Short answer", 150, 1600);
    await sleep(300);
    await S.caption("Cited and exportable", "Every source is linked. Save it as PDF, Word or a web page.");
    await sleep(700);
    const cite = await S.find({ selector: "sup a, sup button, a sup, sup" });
    if (cite && cite.y > 150 && cite.y < 700) { await S.moveTo(cite.x, cite.y, 800); await sleep(1100); }
    // The export buttons sit under the report: bring them up from behind the composer, then open the menu.
    await S.scrollToText("^Show all", 380, 1000);
    await sleep(300);
    await S.click({ text: "Download", has: true }, { ms: 750 });
    await sleep(2000);
    await S.key("Escape");
    await sleep(300);
    await end(S);
  }),

  crew: () => clip("crew", { query: "crew=running&panel=crew" }, async (S) => {
    await begin(S, 300);
    await S.caption("Every agent in view", "What runs, what needs you, what failed.");
    await sleep(2200);
    await S.click({ text: "Failed1", starts: true, sidebar: true }, { ms: 800 });
    await sleep(1400);
    await S.click({ text: "All11", starts: true, sidebar: true }, { ms: 500 });
    await sleep(900);
    await end(S);
  }),

  usage: () => clip("usage", { query: "view=usage" }, async (S) => {
    await begin(S, 300);
    await S.caption("Your plan limits, honestly", "5-hour and weekly windows, and the last reading when Meta is quiet.");
    await sleep(2800);
    await S.captionOff();
    await S.scrollBy(520, 1800);
    await sleep(1100);
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
