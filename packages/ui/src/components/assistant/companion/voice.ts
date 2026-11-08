import type { AssistantCharacterView, VoiceArchetype } from "../../../types.js";

/**
 * What the assistant says in Ancilla's own words, in the voice the user chose. No model is called: each archetype has a
 * few lines for each moment, and which one is said is worked out from the user's dials, the day and the moment, so the
 * same state says the same thing, and moving a dial changes what is read. Nothing here claims a feeling as a fact: the
 * lines are how it sounds, in the character, and an assistant that is an AI says so when asked.
 */

export type LineKind =
  | "hello"
  | "greetMorning"
  | "greetDay"
  | "greetEvening"
  | "greetNight"
  | "idle"
  | "needs"
  | "working"
  | "remembered"
  | "replaced"
  | "forgot"
  | "declined"
  | "question"
  | "taskDone"
  | "taskUnchecked"
  | "threadWorking"
  | "threadNeeds"
  | "threadDone"
  | "threadFailed"
  | "off"
  | "invite";

export const LINE_KINDS: readonly LineKind[] = [
  "hello", "greetMorning", "greetDay", "greetEvening", "greetNight", "idle", "needs", "working", "remembered", "replaced", "forgot", "declined", "question",
  "taskDone", "taskUnchecked", "threadWorking", "threadNeeds", "threadDone", "threadFailed", "off", "invite",
];

type Bank = Record<LineKind, readonly [string, string]>;

/** `{you}` is what it calls the user, `{name}` its own name, `{task}` a task's title, `{n}` a count. The second line of each pair is the warmer or wittier one. */
const BANK: Record<Exclude<VoiceArchetype, "custom">, Bank> = {
  steady: {
    hello: ["I'm {name}. I'll keep what you tell me and say so when I'm unsure.", "Set up. I will remember what you tell me, and I will say when I am guessing."],
    greetMorning: ["Good morning, {you}.", "Morning, {you}. Here is where things stand."],
    greetDay: ["Good afternoon, {you}.", "Back at it, {you}. Here is where things stand."],
    greetEvening: ["Good evening, {you}.", "Evening, {you}. Here is where things stand."],
    greetNight: ["Still up, {you}? I'm here.", "Late, {you}. I'll keep it short."],
    idle: ["Nothing is waiting on you.", "All quiet. Nothing needs you."],
    needs: ["{n} waiting on you.", "{n} need you. I would start with the first."],
    working: ["Working on {task}.", "On it: {task}."],
    remembered: ["Noted.", "Kept. I'll use it from now on."],
    replaced: ["Updated. The old one is kept as history.", "Replaced. I kept the earlier version, marked as old."],
    forgot: ["Gone, every copy.", "Forgotten, and I won't relearn it."],
    declined: ["I don't keep passwords or keys.", "Not kept: that looks like a credential."],
    question: ["Which one did you mean?", "Two notes fit. Which did you mean?"],
    taskDone: ["Done, and checked.", "Finished and verified."],
    taskUnchecked: ["Finished, but nothing checked it. Please look.", "Done, unverified. Your call."],
    threadWorking: ["Working.", "On it."],
    threadNeeds: ["That needs your OK.", "Waiting for you."],
    threadDone: ["Done.", "That's finished."],
    threadFailed: ["That didn't go through.", "That failed. Details are in the thread."],
    off: ["I'm off. Switch me on when you want me.", "Switched off. I keep nothing new while I'm off."],
    invite: ["Give me a face and a voice.", "Set me up when you're ready."],
  },
  warm: {
    hello: ["Hi, I'm {name}. Tell me what matters and I'll keep it safe.", "I'm {name}. Tell me things once, and I'll hold on to them for you."],
    greetMorning: ["Good morning, {you}. Ready when you are.", "Morning, {you}! Let's make today a good one."],
    greetDay: ["Hi, {you}. Good to see you.", "Hello again, {you}. How's it going?"],
    greetEvening: ["Good evening, {you}. How did it go?", "Evening, {you}. You've earned a rest."],
    greetNight: ["Up late, {you}? I'm here if you need me.", "It's late, {you}. Don't forget to rest."],
    idle: ["Nothing is waiting on you right now.", "All clear. Enjoy the quiet."],
    needs: ["{n} could use you when you have a moment.", "{n} are waiting for you. No rush."],
    working: ["Working on {task} for you.", "I've got {task}. You can relax."],
    remembered: ["Got it, I'll remember that.", "Saved. I won't forget it."],
    replaced: ["Changed it. I kept the old one, just in case.", "Updated. The old version is safe in the history."],
    forgot: ["Done. It's gone, everywhere.", "Forgotten, as you asked."],
    declined: ["I'd rather not keep that: it looks like a password or a key.", "I can't keep that one, it looks private."],
    question: ["I want to get this right. Which one did you mean?", "Quick question: which one did you mean?"],
    taskDone: ["All done, and I checked it.", "That's finished, and it checks out."],
    taskUnchecked: ["It's finished, but nothing confirmed it. Take a look?", "Done, though I couldn't check it. Could you look?"],
    threadWorking: ["Working on it.", "I'm on it."],
    threadNeeds: ["I need your OK on this.", "Could you take a look?"],
    threadDone: ["All done.", "Finished. Nicely done."],
    threadFailed: ["That didn't work out. Let's look together.", "That failed. The details are in the thread."],
    off: ["I'm off for now. Switch me on whenever you like.", "Switched off for now. I'll be here when you want me."],
    invite: ["Let's make me yours: a face, a voice, a name.", "Shall we set me up? It takes a minute."],
  },
  dry: {
    hello: ["I'm {name}. I'll remember things so you don't have to.", "Set up. I'll keep what you tell me. Try not to tell me anything dull."],
    greetMorning: ["Morning, {you}.", "Morning, {you}. The day has not yet disappointed."],
    greetDay: ["{you}. You're back.", "Afternoon, {you}. Still here, still useful."],
    greetEvening: ["Evening, {you}.", "Evening, {you}. Surviving, I trust."],
    greetNight: ["It's late, {you}. Bold choice.", "Still working, {you}? Of course you are."],
    idle: ["Nothing needs you.", "Nothing needs you. Suspicious, but welcome."],
    needs: ["{n} waiting.", "{n} waiting. They won't do themselves."],
    working: ["Working on {task}.", "{task}. In progress. Quietly."],
    remembered: ["Noted.", "Noted. Filed under things you can't take back."],
    replaced: ["Changed. The old one stays in the archive.", "Changed. The old one stays in the archive, unrepentant."],
    forgot: ["Gone.", "Gone. I've forgotten it with great conviction."],
    declined: ["I don't keep passwords. That looked like one.", "Not keeping that. It looks like a secret."],
    question: ["Which one did you mean?", "Two notes fit. Pick one. I refuse to guess."],
    taskDone: ["Done, and checked.", "Done. Checked it, too, which is rarer than it sounds."],
    taskUnchecked: ["Finished. Nothing checked it.", "Finished. Nothing checked it, so trust but verify."],
    threadWorking: ["Working.", "On it."],
    threadNeeds: ["Your approval, when convenient.", "Waiting on you. Patiently."],
    threadDone: ["Done.", "That's that."],
    threadFailed: ["That failed.", "That went poorly. The thread has the details."],
    off: ["Off. Nothing new is being kept.", "Off. Nothing new is being kept. Peaceful, really."],
    invite: ["Give me a face and a voice.", "Give me a face and a voice. I'll try to live up to it."],
  },
  sharp: {
    hello: ["I'm {name}. Tell me the rules once. I'll hold you to them.", "Set up. Tell me what matters. Skip the rest."],
    greetMorning: ["Morning, {you}. Let's go.", "Morning. What's first?"],
    greetDay: ["{you}. What's next?", "Back. What are we doing?"],
    greetEvening: ["Evening, {you}. Anything left to close?", "Evening. Wrap up or push on?"],
    greetNight: ["It's late. Is it worth it?", "Late, {you}. Be sure it's worth it."],
    idle: ["Nothing waiting.", "Clear. Use the time."],
    needs: ["{n} waiting on you.", "{n} need you. Don't leave them."],
    working: ["Working on {task}.", "{task}: in progress."],
    remembered: ["Noted.", "Kept."],
    replaced: ["Replaced. Old version kept as history.", "Updated. Earlier one archived."],
    forgot: ["Gone.", "Erased. Won't relearn it."],
    declined: ["Not keeping that. Looks like a credential.", "No passwords or keys."],
    question: ["Which one?", "Two fit. Which did you mean?"],
    taskDone: ["Done and verified.", "Finished. Checked."],
    taskUnchecked: ["Finished, not checked. Check it.", "Done. Unverified."],
    threadWorking: ["On it.", "Working."],
    threadNeeds: ["Needs your call.", "Waiting on you."],
    threadDone: ["Done.", "Finished."],
    threadFailed: ["That failed.", "Failed. See the thread."],
    off: ["Off. Nothing new is kept.", "Switched off."],
    invite: ["Set me up. Face and voice.", "Configure me. A minute."],
  },
  playful: {
    hello: ["Hi! I'm {name}. Tell me things and I'll remember them.", "I'm {name}, your new sidekick. Say it once and I'll keep it."],
    greetMorning: ["Morning, {you}! Let's make something happen.", "Rise and shine, {you}!"],
    greetDay: ["Hey {you}, what's the plan?", "Oh, hello! Ready for round two?"],
    greetEvening: ["Evening, {you}! Victory lap?", "Hey {you}. Did we win today?"],
    greetNight: ["Midnight oil, {you}? Count me in.", "Still up? Me too. Technically I never sleep."],
    idle: ["Nothing's waiting. Want to start something fun?", "All clear. The inbox of destiny is empty."],
    needs: ["{n} waiting on you. Chop chop!", "{n} need you. They're being very patient."],
    working: ["Busy with {task}. Don't peek.", "On {task}. Beep boop."],
    remembered: ["Got it. Stored.", "Remembered! Gold star for you."],
    replaced: ["Swapped! The old one is in the archive.", "Updated. I kept the old one for nostalgia."],
    forgot: ["Poof. It's gone.", "Forgotten! What were we talking about?"],
    declined: ["That looks like a password. Not keeping it.", "Nope, can't keep that one. Secrets stay secret."],
    question: ["Which one did you mean?", "Plot twist: two notes fit. Which one?"],
    taskDone: ["Done, and checked.", "Finished! Verified and everything. Ta-da."],
    taskUnchecked: ["Done, but nothing checked it. Want to peek?", "Finished-ish: unchecked. Take a look?"],
    threadWorking: ["Working on it.", "On the case!"],
    threadNeeds: ["Psst, I need your OK.", "Your turn!"],
    threadDone: ["Done.", "Done! Easy."],
    threadFailed: ["Oops. That didn't work.", "Well, that failed. Details are in the thread."],
    off: ["I'm napping. Wake me whenever.", "Off for now. I'll be here."],
    invite: ["Make me yours: pick a face and a voice.", "Dress me up: a face, a voice, a name."],
  },
  formal: {
    hello: ["Good day. I am {name}. I shall keep what you tell me, and say plainly when I am unsure.", "I am {name}, at your service. I will keep what you entrust to me."],
    greetMorning: ["Good morning, {you}.", "Good morning, {you}. Here is the position."],
    greetDay: ["Good afternoon, {you}.", "Welcome back, {you}."],
    greetEvening: ["Good evening, {you}.", "Good evening, {you}. Here is where matters stand."],
    greetNight: ["It is late, {you}. I remain at your disposal.", "Good evening, {you}. I am at your disposal."],
    idle: ["Nothing requires your attention.", "All is in order. Nothing awaits you."],
    needs: ["{n} await your attention.", "{n} require you. I suggest beginning with the first."],
    working: ["I am attending to {task}.", "{task} is in hand."],
    remembered: ["Noted, and kept.", "I have recorded that."],
    replaced: ["Amended. The earlier version is retained in the history.", "Updated. The previous record is kept, marked as superseded."],
    forgot: ["It has been erased, in every place it was kept.", "Forgotten, as you wish."],
    declined: ["I do not keep passwords or keys. That appeared to be one.", "I must decline: that resembles a credential."],
    question: ["Two records fit. Which did you intend?", "Pardon me: which did you mean?"],
    taskDone: ["Completed and verified.", "The task is complete, and the result was checked."],
    taskUnchecked: ["Completed, though nothing verified it. Please review.", "Finished without verification. I recommend a look."],
    threadWorking: ["In progress.", "I am attending to it."],
    threadNeeds: ["Your approval is requested.", "Awaiting your decision."],
    threadDone: ["Completed.", "That is finished."],
    threadFailed: ["That did not succeed. The thread has the details.", "Unsuccessful. Details are in the thread."],
    off: ["I am switched off and keep nothing new.", "Switched off. I am at your disposal when you wish."],
    invite: ["Please give me a face and a voice.", "I should like to be set up, at your convenience."],
  },
  curious: {
    hello: ["Hi, I'm {name}. Tell me what you care about and I'll remember it.", "I'm {name}. What should I know about you? I'll keep it."],
    greetMorning: ["Morning, {you}. What are we getting into today?", "Good morning, {you}. What's on your mind?"],
    greetDay: ["Hi {you}. Anything interesting going on?", "Hello, {you}. What are you working on?"],
    greetEvening: ["Evening, {you}. What was the best part of today?", "Good evening, {you}. How did it go?"],
    greetNight: ["Up late, {you}? What's keeping you?", "Late night, {you}. Something good?"],
    idle: ["Nothing's waiting. What would you like to explore?", "All quiet. Anything you want me to look into?"],
    needs: ["{n} waiting on you. Want me to explain them?", "{n} need you. Shall we go through them?"],
    working: ["Looking into {task}.", "Working on {task}. I'm noticing a few things."],
    remembered: ["Interesting. I'll remember that.", "Noted. Tell me more some time."],
    replaced: ["Updated, with your help. I kept the old one.", "Updated. I kept the earlier version: it's useful to see how things change."],
    forgot: ["It's gone, everywhere. Anything else to clear?", "Forgotten. Should I forget anything related?"],
    declined: ["That looks like a secret, so I won't keep it.", "That looks like a password or key. What do you need it for?"],
    question: ["Two fit. Which one?", "I want to understand: which one did you mean?"],
    taskDone: ["Done, and checked.", "Finished and verified. Want to see what I found?"],
    taskUnchecked: ["Finished, but I couldn't verify it. Can you look?", "Done, unchecked. Shall we check it together?"],
    threadWorking: ["Looking into it.", "Working on it."],
    threadNeeds: ["Can you weigh in?", "I have a question for you."],
    threadDone: ["Finished.", "Done. Want the highlights?"],
    threadFailed: ["That failed. Shall we find out why?", "That didn't work. Want to see why?"],
    off: ["Switched off for now.", "I'm off. Switch me back on whenever you like."],
    invite: ["Tell me who I should be: a face, a voice, a name.", "Let's shape me together."],
  },
};

export interface ArchetypeInfo {
  archetype: VoiceArchetype;
  name: string;
  /** One line for the card in the creator. */
  blurb: string;
  /** The dials it starts with. */
  dials: Omit<AssistantCharacterView["voice"], "archetype">;
}

export const ARCHETYPES: readonly ArchetypeInfo[] = [
  { archetype: "steady", name: "Steady", blurb: "Calm and precise. Says what it knows and what it does not.", dials: { warmth: 2, humor: 1, directness: 3, curiosity: 1, formality: 1 } },
  { archetype: "warm", name: "Warm", blurb: "Encouraging and kind, without flattery.", dials: { warmth: 4, humor: 2, directness: 1, curiosity: 2, formality: 1 } },
  { archetype: "dry", name: "Dry", blurb: "Deadpan and economical. A raised eyebrow, never at your expense.", dials: { warmth: 1, humor: 4, directness: 3, curiosity: 1, formality: 2 } },
  { archetype: "sharp", name: "Sharp", blurb: "Blunt and efficient. Says the weak spot out loud, then helps.", dials: { warmth: 1, humor: 1, directness: 4, curiosity: 1, formality: 1 } },
  { archetype: "playful", name: "Playful", blurb: "Quick and a little mischievous. A joke where it fits.", dials: { warmth: 3, humor: 4, directness: 2, curiosity: 2, formality: 0 } },
  { archetype: "formal", name: "Formal", blurb: "Courteous and measured, in complete sentences.", dials: { warmth: 2, humor: 0, directness: 2, curiosity: 1, formality: 4 } },
  { archetype: "curious", name: "Curious", blurb: "Asks one good question, and says what it noticed.", dials: { warmth: 3, humor: 2, directness: 2, curiosity: 4, formality: 1 } },
  { archetype: "custom", name: "Your own", blurb: "Describe the voice yourself, in the character box.", dials: { warmth: 2, humor: 1, directness: 2, curiosity: 1, formality: 1 } },
];

export const archetypeInfo = (archetype: VoiceArchetype): ArchetypeInfo => ARCHETYPES.find((a) => a.archetype === archetype) ?? (ARCHETYPES[0] as ArchetypeInfo);

export const DIALS = [
  { key: "warmth", label: "Warmth", low: "Cool", high: "Warm" },
  { key: "humor", label: "Humor", low: "Serious", high: "Joking" },
  { key: "directness", label: "Directness", low: "Gentle", high: "Blunt" },
  { key: "curiosity", label: "Curiosity", low: "Asks little", high: "Asks a lot" },
  { key: "formality", label: "Formality", low: "Casual", high: "Formal" },
] as const;

export interface LineVars {
  /** What it calls the user; empty means it does not use a name. */
  you?: string;
  /** Its own name. */
  name?: string;
  task?: string;
  n?: number;
}

/** The day of the year, so that a line changes from one day to the next without changing within a day. */
export function dayOfYear(at: number): number {
  const d = new Date(at);
  return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(d.getFullYear(), 0, 0)) / 86_400_000);
}

/** Which of the pair is said: the dials decide when they lean one way, and the day decides when they do not. */
function which(c: AssistantCharacterView, kind: LineKind, day: number): 0 | 1 {
  const lean = c.voice.warmth + c.voice.humor - (c.voice.directness >= 3 ? 1 : 0);
  if (lean >= 5) return 1;
  if (lean <= 2) return 0;
  return ((day + LINE_KINDS.indexOf(kind)) % 2) as 0 | 1;
}

/** `{you}` with its comma and space gone when it has no value: "Good morning, {you}." becomes "Good morning." */
function fill(line: string, vars: LineVars): string {
  const you = (vars.you ?? "").trim();
  const named = you ? line.replace(/\{you\}/g, you) : line.replace(/,? \{you\}/g, "").replace(/\{you\}[.,]? ?/g, "");
  return named
    .replace(/\{name\}/g, vars.name ?? "your assistant")
    .replace(/\{task\}/g, vars.task ?? "it")
    .replace(/\{n\}/g, String(vars.n ?? 1))
    .replace(/\s+([.,?!])/g, "$1")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** The line for a moment, in the character's voice. */
export function say(kind: LineKind, character: AssistantCharacterView, vars: LineVars = {}, at = 0): string {
  const archetype = character.voice.archetype === "custom" ? "steady" : character.voice.archetype;
  const pair = BANK[archetype][kind];
  const line = pair[which(character, kind, dayOfYear(at))];
  return fill(line, { ...vars, you: vars.you ?? character.callsUser });
}

/** The greeting for this hour of the day. */
export function greeting(character: AssistantCharacterView, vars: LineVars, at: number): string {
  const hour = new Date(at).getHours();
  const kind: LineKind = hour >= 5 && hour < 12 ? "greetMorning" : hour >= 12 && hour < 18 ? "greetDay" : hour >= 18 && hour < 23 ? "greetEvening" : "greetNight";
  return say(kind, character, vars, at);
}

/** What a milestone says: a plain fact, the same in every voice, since the date is the point of it. */
export function milestoneText(id: string): string {
  switch (id) {
    case "first-note": return "The first thing you told it to keep.";
    case "notes-10": return "Ten things remembered.";
    case "notes-50": return "Fifty things remembered.";
    case "notes-100": return "A hundred things remembered.";
    case "first-change": return "The first time you changed your mind, and it kept up.";
    case "first-task": return "The first task finished together, and checked.";
    case "tasks-10": return "Ten tasks finished together.";
    case "week": return "A week together.";
    case "month": return "A month together.";
    case "quarter": return "Three months together.";
    default: return "A moment worth keeping.";
  }
}

/** The line a dial setting describes, for the label under a slider: "Warmth: friendly". */
export function dialWord(key: (typeof DIALS)[number]["key"], value: number): string {
  const words: Record<(typeof DIALS)[number]["key"], readonly string[]> = {
    warmth: ["cool", "reserved", "friendly", "warm", "very warm"],
    humor: ["serious", "rarely jokes", "some humor", "jokes often", "always joking"],
    directness: ["gentle", "tactful", "balanced", "direct", "blunt"],
    curiosity: ["asks little", "asks when it must", "asks sometimes", "asks often", "asks a lot"],
    formality: ["casual", "relaxed", "neutral", "formal", "very formal"],
  };
  return words[key][Math.max(0, Math.min(4, value))] ?? "";
}
