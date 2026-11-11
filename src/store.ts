import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { stripImagesForStorage } from "./image.js";
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

/** Serialised form of a session on disk. */
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
 * Make a loaded history one a provider will accept, without losing what the
 * session actually did.
 *
 * Providers validate the whole history on every request, so one bad turn makes
 * every later send fail with a bare 400 -- and restarting cannot help, because
 * the fault is in the file. A session is then stranded with no way back through
 * the UI. Two faults are possible, both from a process that died mid-turn:
 *
 *  - **A call whose `arguments` were truncated** at the output-token cap. It
 *    holds invalid JSON, so it is removed along with its reply
 *    (`repairTruncatedToolCalls`).
 *  - **A call that never got its reply**, because the process was killed
 *    between issuing it and receiving the result. The call itself is
 *    well-formed, so it is *answered* with a stub rather than dropped
 *    (`answerOrphanedToolCalls`) -- dropping it would rewrite what the model
 *    did, while a stub tells it plainly that the call never returned.
 *
 * The truncated pass runs first: a call it removes must not then be answered.
 * Each pass returns the same array when its fault is absent, so a healthy
 * history is not needlessly copied on every load and repairing twice is a
 * no-op.
 */
export function repairMalformedToolCalls(
  messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  return answerOrphanedToolCalls(repairTruncatedToolCalls(messages));
}

/** Content of the synthetic reply given to a call whose result never arrived. */
export const ORPHANED_TOOL_RESULT =
  "(interrupted: the process ended before this tool returned, so there is no output)";

/**
 * Give a reply to every tool call that never got one.
 *
 * A process killed between issuing a call and receiving its result leaves the
 * call in the history with no reply after it. Providers reject the whole
 * history then -- "an assistant message with 'tool_calls' must be followed by
 * tool messages responding to each 'tool_call_id'" -- so every later send in
 * that session fails with a 400, and restarting cannot help: the fault is in
 * the file, and each retry appends another user message behind the dead call.
 *
 * Unlike a truncated call, this one is perfectly well-formed; only its result
 * is missing. So it is answered rather than dropped. Dropping it would silently
 * edit the model's account of what it did -- it would look as though it never
 * made the call -- whereas a stub tells it plainly that the call never returned.
 *
 * A `tool` reply must sit immediately after the turn that issued the calls, so
 * the stub is inserted there. Any non-tool message that had been appended in
 * the meantime (a user message from a retry) follows it.
 *
 * Returns the same array when nothing is wrong.
 */
function answerOrphanedToolCalls(
  messages: ChatCompletionMessageParam[]
): ChatCompletionMessageParam[] {
  let changed = false;
  const out: ChatCompletionMessageParam[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as any;
    out.push(m);
    if (m?.role !== "assistant" || !Array.isArray(m.tool_calls) || !m.tool_calls.length) {
      continue;
    }

    // The replies that did arrive: everything after this turn that is still a
    // `tool` message. A reply cannot be separated from its call by any other
    // role, so the run ends at the first one that is not `tool`.
    const answered = new Set<string>();
    let j = i + 1;
    for (; j < messages.length; j++) {
      const r = messages[j] as any;
      if (r?.role !== "tool") break;
      answered.add(r.tool_call_id);
    }

    let missing = m.tool_calls.filter((c: any) => c?.id && !answered.has(c.id));
    if (!missing.length) continue;
    changed = true;

    // The stubs go after the replies that did arrive, so the run of `tool`
    // messages stays contiguous and in the order the calls were made. Copying
    // the real replies first and then appending keeps that property; any
    // non-tool message that followed the run comes after them, untouched.
    for (let k = i + 1; k < j; k++) out.push(messages[k]);
    for (const c of missing) {
      out.push({ role: "tool", tool_call_id: c.id, content: ORPHANED_TOOL_RESULT } as any);
    }
    i = j - 1; // the run has been emitted; continue after it
  }

  return changed ? out : messages;
}

/**
 * Remove tool calls whose `arguments` were truncated, and the replies to them.
 */
function repairTruncatedToolCalls(
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
/**
 * Every session on disk, newest first, with the `mtimeMs` each was read at.
 *
 * The mtime is returned rather than left for the caller to stat separately:
 * between a `stat` and a `read` the file can change, and a mismatch there would
 * make the next save either fail spuriously or overwrite a change that arrived
 * in between. Both are taken here, from the same file.
 */
export async function loadAll(): Promise<SessionRecord[]> {
  return (await loadAllWithMtime()).map((r) => r.record);
}

/** As `loadAll`, but keeping the mtime each record was read at. */
export async function loadAllWithMtime(): Promise<
  Array<{ record: SessionRecord; mtimeMs: number | null }>
> {
  await ensureDir();
  let names: string[];
  try {
    names = await fs.readdir(SESSIONS_DIR);
  } catch {
    return [];
  }
  const records: Array<{ record: SessionRecord; mtimeMs: number | null }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const file = path.join(SESSIONS_DIR, name);
      const [raw, mtimeMs] = await Promise.all([fs.readFile(file, "utf8"), mtimeOf(file)]);
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)) {
        // Screenshots are left as the `[image: <path>]` placeholders the save
        // wrote, rather than being re-attached as pixels. An image anywhere in
        // the history routes every request to the vision model, so restoring
        // one on load pinned the session there for good -- restarting could not
        // clear it, because the image came straight back out of the file. The
        // model can ask for one with `view_image` when it actually needs it.
        parsed.messages = repairMalformedToolCalls(parsed.messages);
        records.push({ record: parsed, mtimeMs });
      }
    } catch {
      // ignore corrupt / partially written session files
    }
  }
  records.sort((a, b) => b.record.updatedAt - a.record.updatedAt);
  return records;
}

/**
 * A save that would have discarded a change written by somebody else.
 *
 * `save` writes the whole record from memory, so without a check the last
 * writer wins outright -- including a process that loaded the file hours ago
 * and has not noticed an external repair, another terminal, or a script.
 * Throwing instead lets the caller reload and decide, rather than silently
 * losing whatever the other writer put there.
 */
export class SessionChangedOnDiskError extends Error {
  constructor(
    readonly id: string,
    readonly expectedMtime: number | null,
    readonly actualMtime: number | null
  ) {
    super(
      `session ${id} changed on disk since it was loaded` +
        (actualMtime === null ? " (it was deleted)" : "")
    );
    this.name = "SessionChangedOnDiskError";
  }
}

/**
 * Current `mtimeMs` of a session's file, or null if there is no file.
 *
 * Exported so a caller that has just written a session can record the new
 * baseline without reading the whole record back.
 */
export function mtimeOfSession(id: string): Promise<number | null> {
  return mtimeOf(path.join(SESSIONS_DIR, `${id}.json`));
}

/** Current `mtimeMs` of a session file, or null if there is no file. */
async function mtimeOf(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Atomically write a session to disk.
 *
 * Image parts are replaced with a `[image: path]` placeholder first. Keeping
 * the base64 would put ~1.4 MB of text in the file for every 1 MB screenshot,
 * and the bytes are re-read from disk when the session is loaded.
 *
 * `expectedMtime` is the `mtimeMs` the caller loaded (null for "there was no
 * file"). When given, the write is refused if the file has moved on since --
 * that is what stops a process holding a stale copy from silently discarding
 * an external repair. Omit it only where the caller genuinely owns the file:
 * a brand-new session, or a deliberate overwrite.
 *
 * The comparison and the rename are not atomic together, so two writers racing
 * within the same instant can still interleave. That is a far narrower window
 * than "any two writers, any time apart", which is the case that lost data.
 */
export async function save(
  rec: SessionRecord,
  expectedMtime?: number | null
): Promise<void> {
  await ensureDir();
  const file = path.join(SESSIONS_DIR, `${rec.id}.json`);
  if (expectedMtime !== undefined) {
    const actual = await mtimeOf(file);
    if (actual !== expectedMtime) {
      throw new SessionChangedOnDiskError(rec.id, expectedMtime, actual);
    }
  }
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
