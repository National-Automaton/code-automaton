import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { stripImagesForStorage, restoreImagesForLoad } from "./image.js";
import { isValidJson } from "./agent.js";

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

/**
 * Placeholder title for a session that has not been named yet. A session still
 * carrying this title gets an automatic one from its first user message; once
 * renamed, the title is left alone (renaming back to this re-arms auto-titling).
 */
export const DEFAULT_TITLE = "new session";

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

/**
 * Remove tool calls whose `arguments` were truncated, and the replies to them.
 *
 * A call cut off at the output-token cap holds invalid JSON, and providers
 * validate every call in the history on every request -- one of them makes each
 * later send fail with a bare "400 invalid argument", so the session is stranded
 * and cannot be recovered through the UI. New turns are checked before they are
 * committed (see `Agent.send`); this repairs histories written before that
 * check existed, and any damaged by another client.
 *
 * The assistant's prose is kept even when its calls go: it may be the only
 * record of what the model said. A turn left with neither text nor calls is
 * dropped rather than sent as an empty message.
 *
 * Returns the same array when nothing is wrong, so a healthy history is not
 * needlessly copied on every load.
 */
export function repairMalformedToolCalls(
  messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  const isBad = (m: any) =>
    m?.role === "assistant" &&
    Array.isArray(m.tool_calls) &&
    m.tool_calls.some((c: any) => !isValidJson(c?.function?.arguments));

  if (!messages.some(isBad)) return messages;

  const out: ChatCompletionMessageParam[] = [];
  // Ids of the calls being removed, so the matching `tool` replies go with them.
  const dropped = new Set<string>();

  for (const m of messages as any[]) {
    if (m?.role === "tool" && dropped.has(m.tool_call_id)) continue;

    if (!isBad(m)) {
      out.push(m);
      continue;
    }

    const kept = m.tool_calls.filter((c: any) => {
      if (isValidJson(c?.function?.arguments)) return true;
      if (c?.id) dropped.add(c.id);
      return false;
    });

    const hasText = typeof m.content === "string" && m.content.trim() !== "";
    if (kept.length === 0 && !hasText) continue;

    const { tool_calls, ...rest } = m;
    out.push({
      ...rest,
      ...(kept.length ? { tool_calls: kept } : {}),
    } as ChatCompletionMessageParam);
  }
  return out;
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
      if (isRecord(parsed)) {
        // Re-read any screenshots referenced by placeholder text so a reloaded
        // session still lets the model see what it was asked about.
        parsed.messages = repairMalformedToolCalls(parsed.messages);
        parsed.messages = await Promise.all(
          parsed.messages.map(async (m: any) =>
            Array.isArray(m?.content)
              ? { ...m, content: await restoreImagesForLoad(m.content) }
              : m
          )
        );
        records.push(parsed);
      }
    } catch {
      // ignore corrupt / partially written session files
    }
  }
  records.sort((a, b) => b.updatedAt - a.updatedAt);
  return records;
}

/**
 * Atomically write a session to disk.
 *
 * Image parts are replaced with a `[image: path]` placeholder first. Keeping
 * the base64 would put ~1.4 MB of text in the file for every 1 MB screenshot,
 * and the bytes are re-read from disk when the session is loaded.
 */
export async function save(rec: SessionRecord): Promise<void> {
  await ensureDir();
  const file = path.join(SESSIONS_DIR, `${rec.id}.json`);
  const tmp = file + ".tmp";
  const stored = {
    ...rec,
    messages: rec.messages.map((m) => {
      const content = (m as any).content;
      if (!Array.isArray(content)) return m;
      return { ...m, content: stripImagesForStorage(content) } as typeof m;
    }),
  };
  await fs.writeFile(tmp, JSON.stringify(stored, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function remove(id: string): Promise<void> {
  try {
    await fs.unlink(path.join(SESSIONS_DIR, `${id}.json`));
  } catch {
    // already gone
  }
}
