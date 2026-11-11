import { looksSecret } from "./secrets.js";
import type { AssistantCharacter, AssistantProfile, AvatarForm, AvatarLook, Autonomy, CharacterPresence, FigureSpec, Goal, VoiceArchetype } from "./types.js";

/**
 * The assistant's configurable identity: what it is called, how it talks, how much it may do alone and how much it
 * may spend. Everything that crosses the HTTP boundary is read through these functions, so a bad value is refused
 * with a reason instead of stored, and a missing value falls back to the safe default (the assistant starts off,
 * asks before it acts, and may not write or run anything on its own).
 */

export const ASSISTANT_ID = "default";

export const AVATAR_FORMS: readonly AvatarForm[] = ["halo", "optic", "hologram", "critter", "cipher"];
export const ARCHETYPES: readonly VoiceArchetype[] = ["steady", "warm", "dry", "sharp", "playful", "formal", "curious", "custom"];
const PRESENCES: readonly CharacterPresence[] = ["off", "tone", "full"];
/** How many habits a character may have, and how long each may be. */
export const MAX_QUIRKS = 4;
export const MAX_QUIRK = 80;

/**
 * The shape of a figure part's id, not its membership: the catalogue lives in the interface, and a pack made by a newer
 * Ancilla must survive an older server, which draws the plain part for an id it does not know.
 */
export const PART_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;
/** The id of a built-in companion: checked by shape so a newer interface's companion survives an older server. */
export const COMPANION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** The id of a saved avatar, the same shape every assistant entity's id has. */
export const PACK_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const FIGURE_PARTS = ["body", "top", "eyes", "mouth", "mark", "gear", "aura", "finish"] as const;
const FIGURE_KEYS: readonly string[] = [...FIGURE_PARTS, "accent", "shade"];

export const DEFAULT_CHARACTER: AssistantCharacter = {
  avatar: { form: "halo", hue: 232, glow: 60, detail: 1, seed: 1, look: { kind: "sigil" } },
  voice: { archetype: "steady", warmth: 2, humor: 1, directness: 3, curiosity: 1, formality: 1 },
  callsUser: "",
  quirks: [],
  presence: "tone",
  showBond: true,
  setupAt: null,
};

export const DEFAULT_PROFILE: AssistantProfile = {
  id: ASSISTANT_ID,
  enabled: false,
  name: "Ancilla",
  persona: "",
  character: DEFAULT_CHARACTER,
  communication: { verbosity: "balanced", tone: "plain", language: "", notes: "" },
  autonomy: "ask",
  policy: { allowReadOnly: true, allowProjectWrites: false, maxConcurrent: 3, maxTurnsPerTask: 12, maxMinutesPerTask: 30, maxTasksPerDay: 10 },
  capturePaused: false,
  contextBudgetTokens: 900,
  updatedAt: 0,
};

export class ValidationError extends Error {
  readonly code = "invalid";
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const VERBOSITY = ["concise", "balanced", "detailed"] as const;
const TONES = ["plain", "warm", "formal"] as const;
const AUTONOMY: readonly Autonomy[] = ["ask", "suggest", "act"];

type Obj = Record<string, unknown>;

export function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A text field as the user typed it, less control characters, within `max`, and never a credential. Shared with the avatar names. */
export function textField(value: unknown, field: string, max: number): string {
  return text(value, field, max);
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new ValidationError(field, `${field} must be text`);
  // A control character has no business in a name or a note, and would break the one-line form the model sees.
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (clean.length > max) throw new ValidationError(field, `${field} is longer than ${max} characters`);
  // These words are added to every prompt, so a credential written here would be sent with each one.
  const secret = looksSecret(clean);
  if (secret) throw new ValidationError(field, `${field} looks like it contains a ${secret}. Ancilla does not keep credentials.`);
  return clean;
}

function whole(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ValidationError(field, `${field} must be a number`);
  const n = Math.round(value);
  if (n < min || n > max) throw new ValidationError(field, `${field} must be between ${min} and ${max}`);
  return n;
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new ValidationError(field, `${field} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function flag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError(field, `${field} must be true or false`);
  return value;
}

const clamp = (v: unknown, lo: number, hi: number, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback);
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === "string" && allowed.includes(v as T) ? (v as T) : fallback);
const str = (v: unknown, max: number, fallback: string): string => (typeof v === "string" ? v.slice(0, max) : fallback);
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** A whole number within a range, as the strict parsers want it: no rounding, so 2.5 is refused rather than guessed at. */
export function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new ValidationError(field, `${field} must be a whole number`);
  if (value < min || value > max) throw new ValidationError(field, `${field} must be between ${min} and ${max}`);
  return value;
}

/** A figure as stored, or null when it is not one: every one of its ten fields must be present and well formed. Never throws. */
export function normalizeFigure(raw: unknown): FigureSpec | null {
  if (!isObj(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== FIGURE_KEYS.length || !FIGURE_KEYS.every((k) => keys.includes(k))) return null;
  const parts: Partial<Record<(typeof FIGURE_PARTS)[number], string>> = {};
  for (const part of FIGURE_PARTS) {
    const v = raw[part];
    if (typeof v !== "string" || !PART_ID.test(v)) return null;
    parts[part] = v;
  }
  const accent = raw.accent;
  if (accent !== null && !(typeof accent === "number" && Number.isInteger(accent) && accent >= 0 && accent <= 359)) return null;
  const shade = raw.shade;
  if (typeof shade !== "number" || !Number.isInteger(shade) || shade < 0 || shade > 4) return null;
  return { ...(parts as Record<(typeof FIGURE_PARTS)[number], string>), accent: accent as number | null, shade };
}

/** A figure from the user, checked field by field: a missing or unknown field is refused with its name. */
export function parseFigure(raw: unknown, field: string): FigureSpec {
  if (!isObj(raw)) throw new ValidationError(field, `${field} must be an object`);
  for (const key of Object.keys(raw)) if (!FIGURE_KEYS.includes(key)) throw new ValidationError(`${field}.${key}`, `unknown field ${field}.${key}`);
  for (const key of FIGURE_KEYS) if (!(key in raw)) throw new ValidationError(`${field}.${key}`, `${field}.${key} is required`);
  const parts: Partial<Record<(typeof FIGURE_PARTS)[number], string>> = {};
  for (const part of FIGURE_PARTS) {
    const v = raw[part];
    if (typeof v !== "string" || !PART_ID.test(v)) throw new ValidationError(`${field}.${part}`, `${field}.${part} must be a part id: lower-case letters, digits and dashes, up to 24 characters`);
    parts[part] = v;
  }
  const accent = raw.accent === null ? null : integer(raw.accent, `${field}.accent`, 0, 359);
  const shade = integer(raw.shade, `${field}.shade`, 0, 4);
  return { ...(parts as Record<(typeof FIGURE_PARTS)[number], string>), accent, shade };
}

/** What the assistant wears, as stored: anything malformed is the sigil, so an old or damaged profile still has a face. Never throws. */
export function normalizeLook(raw: unknown): AvatarLook {
  if (!isObj(raw)) return { kind: "sigil" };
  if (raw.kind === "sigil") return { kind: "sigil" };
  if (raw.kind === "companion") {
    return typeof raw.id === "string" && COMPANION_ID.test(raw.id) ? { kind: "companion", id: raw.id } : { kind: "sigil" };
  }
  if (raw.kind === "figure") {
    const figure = normalizeFigure(raw.figure);
    return figure ? { kind: "figure", figure } : { kind: "sigil" };
  }
  if (raw.kind === "pack") {
    if (typeof raw.id !== "string" || !PACK_ID.test(raw.id)) return { kind: "sigil" };
    const rev = typeof raw.rev === "number" && Number.isInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0;
    return { kind: "pack", id: raw.id, rev };
  }
  return { kind: "sigil" };
}

/**
 * A look from the user. A pack's `rev` is not the user's to set (it is the pack's own `updatedAt`, stamped where the
 * database is reachable), so one sent along is ignored; whether the pack exists is checked there too.
 */
function parseLook(raw: unknown, field: string): AvatarLook {
  if (!isObj(raw)) throw new ValidationError(field, `${field} must be an object`);
  const kind = raw.kind;
  if (kind === "sigil") {
    for (const key of Object.keys(raw)) if (key !== "kind") throw new ValidationError(`${field}.${key}`, `unknown field ${field}.${key}`);
    return { kind: "sigil" };
  }
  if (kind === "companion") {
    for (const key of Object.keys(raw)) if (key !== "kind" && key !== "id") throw new ValidationError(`${field}.${key}`, `unknown field ${field}.${key}`);
    if (typeof raw.id !== "string" || !COMPANION_ID.test(raw.id)) throw new ValidationError(`${field}.id`, `${field}.id must be a companion id: lower-case letters, digits and dashes, up to 32 characters`);
    return { kind: "companion", id: raw.id };
  }
  if (kind === "figure") {
    for (const key of Object.keys(raw)) if (key !== "kind" && key !== "figure") throw new ValidationError(`${field}.${key}`, `unknown field ${field}.${key}`);
    return { kind: "figure", figure: parseFigure(raw.figure, `${field}.figure`) };
  }
  if (kind === "pack") {
    for (const key of Object.keys(raw)) if (key !== "kind" && key !== "id" && key !== "rev") throw new ValidationError(`${field}.${key}`, `unknown field ${field}.${key}`);
    if (typeof raw.id !== "string" || !PACK_ID.test(raw.id)) throw new ValidationError(`${field}.id`, `${field}.id must be the id of a saved avatar`);
    return { kind: "pack", id: raw.id, rev: 0 };
  }
  throw new ValidationError(`${field}.kind`, `${field}.kind must be one of sigil, companion, figure, pack`);
}

/** The character as stored, completed with defaults and brought inside the limits. Never throws. */
export function normalizeCharacter(raw: unknown): AssistantCharacter {
  const d = DEFAULT_CHARACTER;
  const r = isObj(raw) ? raw : {};
  const av = isObj(r.avatar) ? r.avatar : {};
  const vo = isObj(r.voice) ? r.voice : {};
  const quirks = Array.isArray(r.quirks)
    ? r.quirks.filter((q): q is string => typeof q === "string").map((q) => q.replace(CONTROL, "").trim().slice(0, MAX_QUIRK)).filter((q) => q !== "").slice(0, MAX_QUIRKS)
    : [];
  return {
    avatar: {
      form: pick(av.form, AVATAR_FORMS, d.avatar.form),
      hue: clamp(av.hue, 0, 359, d.avatar.hue),
      glow: clamp(av.glow, 0, 100, d.avatar.glow),
      detail: clamp(av.detail, 0, 3, d.avatar.detail),
      seed: clamp(av.seed, 0, 2_147_483_647, d.avatar.seed),
      look: normalizeLook(av.look),
    },
    voice: {
      archetype: pick(vo.archetype, ARCHETYPES, d.voice.archetype),
      warmth: clamp(vo.warmth, 0, 4, d.voice.warmth),
      humor: clamp(vo.humor, 0, 4, d.voice.humor),
      directness: clamp(vo.directness, 0, 4, d.voice.directness),
      curiosity: clamp(vo.curiosity, 0, 4, d.voice.curiosity),
      formality: clamp(vo.formality, 0, 4, d.voice.formality),
    },
    callsUser: str(r.callsUser, 40, "").replace(CONTROL, "").trim(),
    quirks,
    presence: pick(r.presence, PRESENCES, d.presence),
    showBond: r.showBond !== false,
    setupAt: typeof r.setupAt === "number" && Number.isFinite(r.setupAt) && r.setupAt > 0 ? r.setupAt : null,
  };
}

/** The profile as stored, completed with defaults for anything missing and brought inside the limits. Never throws. */
export function normalizeProfile(raw: unknown): AssistantProfile {
  const d = DEFAULT_PROFILE;
  const r = isObj(raw) ? raw : {};
  const comm = isObj(r.communication) ? r.communication : {};
  const pol = isObj(r.policy) ? r.policy : {};
  return {
    id: ASSISTANT_ID,
    enabled: r.enabled === true,
    name: str(r.name, 60, d.name).trim() || d.name,
    persona: str(r.persona, 1000, d.persona),
    character: normalizeCharacter(r.character),
    communication: {
      verbosity: pick(comm.verbosity, VERBOSITY, d.communication.verbosity),
      tone: pick(comm.tone, TONES, d.communication.tone),
      language: str(comm.language, 40, d.communication.language),
      notes: str(comm.notes, 600, d.communication.notes),
    },
    autonomy: pick(r.autonomy, AUTONOMY, d.autonomy),
    policy: {
      allowReadOnly: typeof pol.allowReadOnly === "boolean" ? pol.allowReadOnly : d.policy.allowReadOnly,
      allowProjectWrites: typeof pol.allowProjectWrites === "boolean" ? pol.allowProjectWrites : d.policy.allowProjectWrites,
      maxConcurrent: clamp(pol.maxConcurrent, 1, 8, d.policy.maxConcurrent),
      maxTurnsPerTask: clamp(pol.maxTurnsPerTask, 1, 50, d.policy.maxTurnsPerTask),
      maxMinutesPerTask: clamp(pol.maxMinutesPerTask, 1, 240, d.policy.maxMinutesPerTask),
      maxTasksPerDay: clamp(pol.maxTasksPerDay, 1, 100, d.policy.maxTasksPerDay),
    },
    capturePaused: r.capturePaused === true,
    contextBudgetTokens: clamp(r.contextBudgetTokens, 300, 4000, d.contextBudgetTokens),
    updatedAt: typeof r.updatedAt === "number" && Number.isFinite(r.updatedAt) ? r.updatedAt : 0,
  };
}

/** What may change about the character. `configured` says the user has made it theirs (true) or wants to be asked again (false). */
export type CharacterPatch = {
  avatar?: Partial<AssistantCharacter["avatar"]>;
  voice?: Partial<AssistantCharacter["voice"]>;
  callsUser?: string;
  quirks?: string[];
  presence?: CharacterPresence;
  showBond?: boolean;
  configured?: boolean;
};

export type ProfilePatch = {
  enabled?: boolean;
  name?: string;
  persona?: string;
  character?: CharacterPatch;
  communication?: Partial<AssistantProfile["communication"]>;
  autonomy?: Autonomy;
  policy?: Partial<AssistantProfile["policy"]>;
  capturePaused?: boolean;
  contextBudgetTokens?: number;
};

function parseCharacterPatch(raw: unknown): CharacterPatch {
  if (!isObj(raw)) throw new ValidationError("character", "character must be an object");
  for (const key of Object.keys(raw)) if (!["avatar", "voice", "callsUser", "quirks", "presence", "showBond", "configured"].includes(key)) throw new ValidationError(`character.${key}`, `unknown field character.${key}`);
  const out: CharacterPatch = {};
  if ("avatar" in raw) {
    if (!isObj(raw.avatar)) throw new ValidationError("character.avatar", "character.avatar must be an object");
    const a = raw.avatar;
    for (const key of Object.keys(a)) if (!["form", "hue", "glow", "detail", "seed", "look"].includes(key)) throw new ValidationError(`character.avatar.${key}`, `unknown field character.avatar.${key}`);
    const avatar: NonNullable<CharacterPatch["avatar"]> = {};
    if ("form" in a) avatar.form = oneOf(a.form, "character.avatar.form", AVATAR_FORMS);
    if ("hue" in a) avatar.hue = whole(a.hue, "character.avatar.hue", 0, 359);
    if ("glow" in a) avatar.glow = whole(a.glow, "character.avatar.glow", 0, 100);
    if ("detail" in a) avatar.detail = whole(a.detail, "character.avatar.detail", 0, 3);
    if ("seed" in a) avatar.seed = whole(a.seed, "character.avatar.seed", 0, 2_147_483_647);
    // The look is one value, replaced whole: a figure's parts are not merged with the last figure's.
    if ("look" in a) avatar.look = parseLook(a.look, "character.avatar.look");
    out.avatar = avatar;
  }
  if ("voice" in raw) {
    if (!isObj(raw.voice)) throw new ValidationError("character.voice", "character.voice must be an object");
    const v = raw.voice;
    const dials = ["warmth", "humor", "directness", "curiosity", "formality"] as const;
    for (const key of Object.keys(v)) if (key !== "archetype" && !(dials as readonly string[]).includes(key)) throw new ValidationError(`character.voice.${key}`, `unknown field character.voice.${key}`);
    const voice: NonNullable<CharacterPatch["voice"]> = {};
    if ("archetype" in v) voice.archetype = oneOf(v.archetype, "character.voice.archetype", ARCHETYPES);
    for (const dial of dials) if (dial in v) voice[dial] = whole(v[dial], `character.voice.${dial}`, 0, 4);
    out.voice = voice;
  }
  if ("callsUser" in raw) out.callsUser = text(raw.callsUser, "character.callsUser", 40);
  if ("quirks" in raw) {
    if (!Array.isArray(raw.quirks)) throw new ValidationError("character.quirks", "character.quirks must be a list");
    if (raw.quirks.length > MAX_QUIRKS) throw new ValidationError("character.quirks", `a character has at most ${MAX_QUIRKS} habits`);
    out.quirks = raw.quirks.map((q, i) => text(q, `character.quirks[${i}]`, MAX_QUIRK)).filter((q) => q !== "");
  }
  if ("presence" in raw) out.presence = oneOf(raw.presence, "character.presence", PRESENCES);
  if ("showBond" in raw) out.showBond = flag(raw.showBond, "character.showBond");
  if ("configured" in raw) out.configured = flag(raw.configured, "character.configured");
  return out;
}

/** What the user asked to change, checked field by field. Unknown fields are refused so a typo is not silently ignored. */
export function parseProfilePatch(raw: unknown): ProfilePatch {
  if (!isObj(raw)) throw new ValidationError("body", "the profile change must be an object");
  const out: ProfilePatch = {};
  const known = new Set(["enabled", "name", "persona", "character", "communication", "autonomy", "policy", "capturePaused", "contextBudgetTokens"]);
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new ValidationError(key, `unknown field ${key}`);
  if ("enabled" in raw) out.enabled = flag(raw.enabled, "enabled");
  if ("name" in raw) {
    const name = text(raw.name, "name", 60);
    if (!name) throw new ValidationError("name", "name cannot be empty");
    out.name = name;
  }
  if ("persona" in raw) out.persona = text(raw.persona, "persona", 1000);
  if ("autonomy" in raw) out.autonomy = oneOf(raw.autonomy, "autonomy", AUTONOMY);
  if ("capturePaused" in raw) out.capturePaused = flag(raw.capturePaused, "capturePaused");
  if ("contextBudgetTokens" in raw) out.contextBudgetTokens = whole(raw.contextBudgetTokens, "contextBudgetTokens", 300, 4000);
  if ("character" in raw) out.character = parseCharacterPatch(raw.character);
  if ("communication" in raw) {
    if (!isObj(raw.communication)) throw new ValidationError("communication", "communication must be an object");
    const c = raw.communication;
    const comm: NonNullable<ProfilePatch["communication"]> = {};
    for (const key of Object.keys(c)) if (!["verbosity", "tone", "language", "notes"].includes(key)) throw new ValidationError(`communication.${key}`, `unknown field communication.${key}`);
    if ("verbosity" in c) comm.verbosity = oneOf(c.verbosity, "communication.verbosity", VERBOSITY);
    if ("tone" in c) comm.tone = oneOf(c.tone, "communication.tone", TONES);
    if ("language" in c) comm.language = text(c.language, "communication.language", 40);
    if ("notes" in c) comm.notes = text(c.notes, "communication.notes", 600);
    out.communication = comm;
  }
  if ("policy" in raw) {
    if (!isObj(raw.policy)) throw new ValidationError("policy", "policy must be an object");
    const p = raw.policy;
    const pol: NonNullable<ProfilePatch["policy"]> = {};
    for (const key of Object.keys(p)) if (!["allowReadOnly", "allowProjectWrites", "maxConcurrent", "maxTurnsPerTask", "maxMinutesPerTask", "maxTasksPerDay"].includes(key)) throw new ValidationError(`policy.${key}`, `unknown field policy.${key}`);
    if ("allowReadOnly" in p) pol.allowReadOnly = flag(p.allowReadOnly, "policy.allowReadOnly");
    if ("allowProjectWrites" in p) pol.allowProjectWrites = flag(p.allowProjectWrites, "policy.allowProjectWrites");
    if ("maxConcurrent" in p) pol.maxConcurrent = whole(p.maxConcurrent, "policy.maxConcurrent", 1, 8);
    if ("maxTurnsPerTask" in p) pol.maxTurnsPerTask = whole(p.maxTurnsPerTask, "policy.maxTurnsPerTask", 1, 50);
    if ("maxMinutesPerTask" in p) pol.maxMinutesPerTask = whole(p.maxMinutesPerTask, "policy.maxMinutesPerTask", 1, 240);
    if ("maxTasksPerDay" in p) pol.maxTasksPerDay = whole(p.maxTasksPerDay, "policy.maxTasksPerDay", 1, 100);
    out.policy = pol;
  }
  return out;
}

function applyCharacterPatch(current: AssistantCharacter, patch: CharacterPatch | undefined, now: number): AssistantCharacter {
  if (!patch) return current;
  const { configured, avatar, voice, ...rest } = patch;
  return {
    ...current,
    ...rest,
    avatar: { ...current.avatar, ...(avatar ?? {}) },
    voice: { ...current.voice, ...(voice ?? {}) },
    setupAt: configured === undefined ? current.setupAt : configured ? (current.setupAt ?? now) : null,
  };
}

export function applyProfilePatch(current: AssistantProfile, patch: ProfilePatch, now: number): AssistantProfile {
  const { character, ...others } = patch;
  return normalizeProfile({
    ...current,
    ...others,
    character: applyCharacterPatch(current.character, character, now),
    communication: { ...current.communication, ...(patch.communication ?? {}) },
    policy: { ...current.policy, ...(patch.policy ?? {}) },
    updatedAt: now,
  });
}

export interface GoalInput {
  text: string;
  priority?: number;
  status?: Goal["status"];
}

export function parseGoalInput(raw: unknown, partial = false): Partial<GoalInput> {
  if (!isObj(raw)) throw new ValidationError("body", "the goal must be an object");
  const out: Partial<GoalInput> = {};
  for (const key of Object.keys(raw)) if (!["text", "priority", "status"].includes(key)) throw new ValidationError(key, `unknown field ${key}`);
  if ("text" in raw || !partial) {
    const value = text(raw.text, "text", 400);
    if (!value) throw new ValidationError("text", "a goal needs some words");
    out.text = value;
  }
  if ("priority" in raw) out.priority = whole(raw.priority, "priority", 0, 100);
  if ("status" in raw) out.status = oneOf(raw.status, "status", ["active", "paused", "done"] as const);
  return out;
}
