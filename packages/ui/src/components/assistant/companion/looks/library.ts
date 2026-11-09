import { useCallback, useState } from "react";
import { useAssistantCall, useAssistantData } from "../../api.js";
import type { AvatarPackKind, AvatarPackMeta, AvatarPackView, FigurePackData, FigureSpec, ImagePackData, PixelData } from "../../../../types.js";
import { normalizeFigure } from "../figure/parts.js";
import { usePackStore } from "../packs.js";

/**
 * The avatars the user made or brought: what the server keeps, how to read and change it, and the small file format an
 * avatar travels in when it is shared. The server decides what is acceptable (it checks every rule again), so what is
 * checked here is only what is needed to say something helpful before a file is sent.
 */

export interface AvatarLimits {
  count: number;
  perAvatarBytes: number;
  totalBytes: number;
  used: number;
  total: number;
}

/** An avatar to be kept: what the server asks for when it makes one. */
export type NewAvatar = { name: string } & ({ kind: "figure"; data: FigurePackData } | { kind: "pixel"; data: PixelData } | { kind: "image"; data: ImagePackData });

/** A copy of an avatar under another name. */
export function copyOf(pack: AvatarPackView, name: string): NewAvatar {
  if (pack.kind === "figure") return { name, kind: "figure", data: pack.data };
  if (pack.kind === "pixel") return { name, kind: "pixel", data: pack.data };
  return { name, kind: "image", data: pack.data };
}

export interface Library {
  avatars: AvatarPackMeta[];
  limits: AvatarLimits | null;
  loading: boolean;
  error: string | null;
  create(input: NewAvatar): Promise<AvatarPackView>;
  update(id: string, patch: { name?: string; data?: AvatarPackView["data"] }, expectedUpdatedAt?: number): Promise<AvatarPackView>;
  remove(id: string): Promise<void>;
  reload(): void;
}

/** The user's saved avatars, kept in step with the server and with the cache the faces draw from. */
export function useAvatarLibrary(): Library {
  const call = useAssistantCall();
  const packs = usePackStore();
  const [bump, setBump] = useState(0);
  const { data, error, loading } = useAssistantData<{ avatars: AvatarPackMeta[]; limits: AvatarLimits }>("/avatars", bump);
  const reload = useCallback(() => setBump((n) => n + 1), []);

  const create = useCallback(
    async (input: NewAvatar): Promise<AvatarPackView> => {
      const out = await call<{ avatar: AvatarPackView }>("POST", "/avatars", input);
      packs.put(out.avatar);
      reload();
      return out.avatar;
    },
    [call, packs, reload],
  );
  const update = useCallback(
    async (id: string, patch: { name?: string; data?: AvatarPackView["data"] }, expectedUpdatedAt?: number): Promise<AvatarPackView> => {
      const out = await call<{ avatar: AvatarPackView }>("PATCH", `/avatars/${id}`, { ...patch, ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }) });
      packs.put(out.avatar);
      reload();
      return out.avatar;
    },
    [call, packs, reload],
  );
  const remove = useCallback(
    async (id: string): Promise<void> => {
      await call("DELETE", `/avatars/${id}`);
      packs.drop(id);
      reload();
    },
    [call, packs, reload],
  );
  return { avatars: data?.avatars ?? [], limits: data?.limits ?? null, loading, error, create, update, remove, reload };
}

// ------------------------------------------------------------------------------------------------ sharing

/** What an avatar looks like as a file: plain JSON, so it can be read, shared and checked by eye. */
export interface AvatarFile {
  format: "ancilla.avatar";
  version: 1;
  name: string;
  kind: AvatarPackKind;
  data: AvatarPackView["data"];
}

export const AVATAR_FILE_FORMAT = "ancilla.avatar";

export function toAvatarFile(pack: Pick<AvatarPackView, "name" | "kind" | "data">): AvatarFile {
  return { format: AVATAR_FILE_FORMAT, version: 1, name: pack.name, kind: pack.kind, data: pack.data };
}

/** A file name for the avatar: its name, lower case and safe, then what it is. */
export function avatarFileName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${slug || "avatar"}.ancilla-avatar.json`;
}

/** The biggest avatar file read: the server refuses more than its own limit, and a file far bigger than that is not an avatar. */
export const MAX_AVATAR_FILE_BYTES = 1_000_000;

export type ParsedAvatarFile = { ok: true; avatar: NewAvatar } | { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * An avatar file read back. The first things wrong with it are said in words; everything else is left to the server, which
 * checks each rule, so a file this app takes is one the server will take too (and one it does not take is refused there).
 */
export function parseAvatarFile(text: string): ParsedAvatarFile {
  if (text.length > MAX_AVATAR_FILE_BYTES) return { ok: false, error: "That file is too large to be an avatar." };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file is not an avatar: it is not readable as JSON." };
  }
  if (!isObject(raw) || raw["format"] !== AVATAR_FILE_FORMAT) return { ok: false, error: "That file is not an Ancilla avatar." };
  if (raw["version"] !== 1) return { ok: false, error: "That avatar was made by a newer Ancilla. Update Ancilla to use it." };
  const name = typeof raw["name"] === "string" ? raw["name"].trim().slice(0, 40) : "";
  const kind = raw["kind"];
  const data = raw["data"];
  if (kind !== "figure" && kind !== "pixel" && kind !== "image") return { ok: false, error: "That avatar is of a kind this Ancilla does not know." };
  if (!isObject(data)) return { ok: false, error: "That avatar has no drawing in it." };
  if (kind === "figure") {
    const figure = normalizeFigure(isObject(data["figure"]) ? (data["figure"] as Partial<FigureSpec>) : null);
    const hue = typeof data["hue"] === "number" && Number.isFinite(data["hue"]) ? Math.min(359, Math.max(0, Math.round(data["hue"]))) : 232;
    const glow = typeof data["glow"] === "number" && Number.isFinite(data["glow"]) ? Math.min(100, Math.max(0, Math.round(data["glow"]))) : 60;
    return { ok: true, avatar: { name: name || "Imported avatar", kind, data: { figure, hue, glow } } };
  }
  // Pixel art and pictures are left for the server to read: it decodes every frame and every byte, and says what is wrong.
  if (kind === "pixel") return { ok: true, avatar: { name: name || "Imported avatar", kind, data: data as unknown as PixelData } };
  return { ok: true, avatar: { name: name || "Imported avatar", kind, data: data as unknown as ImagePackData } };
}

/** Saves text as a file in the user's downloads, the way the assistant's export does. */
export function downloadText(fileName: string, text: string, type = "application/json"): void {
  downloadBlob(fileName, new Blob([text], { type }));
}

export function downloadBlob(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** "1.2 MB", "340 KB": how much room an avatar takes. */
export function bytesLabel(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1000) return `${Math.round(bytes / 1000)} KB`;
  return `${bytes} B`;
}
