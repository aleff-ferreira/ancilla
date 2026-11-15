import { randomUUID } from "node:crypto";
import type { MemoryStore } from "../assistant/store.js";
import type { ChatMessage } from "./brain.js";
import type { TranscriptEntry } from "./host.js";

/**
 * What was said to the assistant, in a call or typed, kept as words so that the next call goes on from where the last
 * one stopped and the text box shows the same conversation. It lives in the assistant's own database, beside the notes,
 * so it is exported, rolled back and deleted with them. No audio is ever stored: the sound is gone the moment it has been
 * heard, and what remains is the transcript, which the person can read, rename and delete.
 */

export interface ConversationSummary {
  id: string;
  title: string;
  project: string | null;
  startedAt: number;
  updatedAt: number;
  turns: number;
}

export interface StoredUtterance {
  id: number;
  turn: number;
  role: "user" | "assistant";
  source: "voice" | "text" | "event";
  text: string;
  heard: string | null;
  interrupted: boolean;
  at: number;
}

const TITLE_CHARS = 60;

function titleOf(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= TITLE_CHARS ? flat : `${flat.slice(0, TITLE_CHARS - 1).trimEnd()}…`;
}

function toSummary(row: Record<string, unknown>): ConversationSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    project: row.project === null || row.project === undefined ? null : String(row.project),
    startedAt: Number(row.started_at),
    updatedAt: Number(row.updated_at),
    turns: Number(row.turns),
  };
}

export class ConversationStore {
  constructor(
    private readonly store: MemoryStore,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts a conversation, and returns its id. */
  create(project: string | null): string {
    const id = `cv_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const at = this.now();
    this.store.run("INSERT INTO conversations (id, title, project, started_at, updated_at, turns) VALUES (?, '', ?, ?, ?, 0)", [id, project, at, at]);
    return id;
  }

  exists(id: string): boolean {
    return this.store.get("SELECT 1 AS x FROM conversations WHERE id = ?", [id]) !== undefined;
  }

  /** The Muse thread this conversation goes on in, when Muse has been its model. */
  museSession(id: string): string | null {
    const row = this.store.get("SELECT muse_session FROM conversations WHERE id = ?", [id]);
    return row && row.muse_session !== null && row.muse_session !== undefined ? String(row.muse_session) : null;
  }

  setMuseSession(id: string, sessionId: string): void {
    this.store.run("UPDATE conversations SET muse_session = ? WHERE id = ?", [sessionId, id]);
  }

  /** The conversation touched last, the one a call picks up when it is not told which. */
  latest(): ConversationSummary | null {
    const row = this.store.get("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 1");
    return row ? toSummary(row) : null;
  }

  list(limit = 50): ConversationSummary[] {
    return this.store.all("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?", [Math.max(1, Math.min(200, Math.floor(limit)))]).map(toSummary);
  }

  get(id: string): ConversationSummary | null {
    const row = this.store.get("SELECT * FROM conversations WHERE id = ?", [id]);
    return row ? toSummary(row) : null;
  }

  rename(id: string, title: string): boolean {
    if (!this.exists(id)) return false;
    this.store.run("UPDATE conversations SET title = ? WHERE id = ?", [titleOf(title) || "Conversation", id]);
    return true;
  }

  remove(id: string): boolean {
    if (!this.exists(id)) return false;
    this.store.write(() => {
      this.store.run("DELETE FROM utterances WHERE conversation_id = ?", [id]);
      this.store.run("DELETE FROM conversations WHERE id = ?", [id]);
    });
    return true;
  }

  /** Deletes conversations not touched since `before`, or every one when `before` is null. Returns how many went. */
  purge(before: number | null): number {
    const rows = before === null ? this.store.all("SELECT id FROM conversations") : this.store.all("SELECT id FROM conversations WHERE updated_at < ?", [before]);
    this.store.write(() => {
      for (const row of rows) {
        this.store.run("DELETE FROM utterances WHERE conversation_id = ?", [String(row.id)]);
        this.store.run("DELETE FROM conversations WHERE id = ?", [String(row.id)]);
      }
    });
    return rows.length;
  }

  append(conversationId: string, entry: TranscriptEntry): void {
    if (entry.text.trim() === "" && !entry.interrupted) return;
    this.store.write(() => {
      this.store.run("INSERT INTO utterances (conversation_id, turn, role, source, text, heard, interrupted, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [
        conversationId,
        entry.turn,
        entry.role,
        entry.source,
        entry.text,
        entry.heard ?? null,
        entry.interrupted ? 1 : 0,
        entry.at,
      ]);
      const turns = entry.role === "user" ? 1 : 0;
      this.store.run("UPDATE conversations SET updated_at = ?, turns = turns + ? WHERE id = ?", [this.now(), turns, conversationId]);
      const row = this.store.get("SELECT title FROM conversations WHERE id = ?", [conversationId]);
      if (row && String(row.title) === "" && entry.role === "user") this.store.run("UPDATE conversations SET title = ? WHERE id = ?", [titleOf(entry.text), conversationId]);
    });
  }

  utterances(conversationId: string, limit = 400): StoredUtterance[] {
    const rows = this.store.all("SELECT * FROM (SELECT * FROM utterances WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC", [conversationId, Math.max(1, Math.min(2000, Math.floor(limit)))]);
    return rows.map((r) => ({
      id: Number(r.id),
      turn: Number(r.turn),
      role: r.role === "assistant" ? "assistant" : "user",
      source: r.source === "text" || r.source === "event" ? r.source : "voice",
      text: String(r.text),
      heard: r.heard === null || r.heard === undefined ? null : String(r.heard),
      interrupted: Number(r.interrupted) === 1,
      at: Number(r.at),
    }));
  }

  /** The conversation as a model is given it: what the person said, and of what the assistant said, what they heard. */
  history(conversationId: string, limit = 40): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const u of this.utterances(conversationId, limit)) {
      if (u.role === "user") {
        out.push({ role: "user", content: u.text });
      } else if (u.interrupted) {
        const heard = (u.heard ?? "").trim();
        out.push({ role: "assistant", content: heard === "" ? "[the user interrupted before you said anything]" : `${heard} [the user interrupted here]` });
      } else {
        out.push({ role: "assistant", content: u.text });
      }
    }
    return out;
  }
}
