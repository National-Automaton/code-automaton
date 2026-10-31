import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * Where sessions live on disk. `CODA_SESSIONS_DIR` (or the older
 * `DSC_SESSIONS_DIR`) overrides the default so tests and sandboxed runs never
 * touch the user's real sessions.
 */
export const SESSIONS_DIR = (() => {
  const override = process.env.CODA_SESSIONS_DIR || process.env.DSC_SESSIONS_DIR;
  return override
    ? path.resolve(override)
    : path.join(os.homedir(), ".coda", "sessions");
})();

/** A single rendered transcript entry (what the user sees). */
export interface Entry {
  role: "user" | "assistant" | "tool";
  text: string;
  /** tool name, when role === "tool" */
  name?: string;
  ok?: boolean;
}

/** Serialized form of a session on disk. */
export interface SessionRecord {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatCompletionMessageParam[];
  entries: Entry[];
}

function isRecord(v: any): v is SessionRecord {
  return (
    v &&
    typeof v.id === "string" &&
    Array.isArray(v.messages) &&
    Array.isArray(v.entries)
  );
}

/** Derive a short human title from the first user message. */
export function deriveTitle(messages: ChatCompletionMessageParam[]): string {
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") {
      const firstLine = m.content.trim().split(/\r?\n/)[0].trim();
      if (firstLine) {
        return firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;
      }
    }
  }
  return "(empty session)";
}

export async function ensureDir(): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 });
}

export function newId(): string {
  return randomUUID();
}

/** Load all sessions, newest first. Skips corrupt files. */
export async function loadAll(): Promise<SessionRecord[]> {
  await ensureDir();
  let names: string[];
  try {
    names = await fs.readdir(SESSIONS_DIR);
  } catch {
    return [];
  }
  const records: SessionRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(SESSIONS_DIR, name), "utf8");
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)) records.push(parsed);
    } catch {
      // ignore corrupt / partially written session files
    }
  }
  records.sort((a, b) => b.updatedAt - a.updatedAt);
  return records;
}

/** Atomically write a session to disk. */
export async function save(rec: SessionRecord): Promise<void> {
  await ensureDir();
  const file = path.join(SESSIONS_DIR, `${rec.id}.json`);
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(rec, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function remove(id: string): Promise<void> {
  try {
    await fs.unlink(path.join(SESSIONS_DIR, `${id}.json`));
  } catch {
    // already gone
  }
}
