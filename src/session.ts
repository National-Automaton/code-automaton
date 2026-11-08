import { Agent, AgentEvent } from "./agent.js";
import type { AttachedImage } from "./image.js";
import { Config } from "./config.js";
import { SessionLock, acquireLock, describeHolder } from "./lock.js";
import { redact } from "./secrets.js";

/**
 * Append a streamed agent event to a transcript.
 *
 * Extracted from `Session.run` so the scrubbing can be tested directly: every
 * path that puts agent output into the entry list goes through here, and each
 * one redacts. A credential that reached `entries` would be written to the
 * session file on disk and re-sent to the model as history on every later turn,
 * so this is the boundary that matters most.
 *
 * `buf` holds the assistant bubble currently being appended to; it is returned
 * (possibly a new one) so the caller keeps accumulating into the same entry.
 */
export function applyEvent(
  entries: Entry[],
  ev: AgentEvent,
  buf: Entry | null
): Entry | null {
  switch (ev.type) {
    case "text": {
      const target = buf ?? { role: "assistant", text: "" };
      if (!buf) entries.push(target);
      target.text += redact(ev.text);
      return target;
    }
    case "tool_start":
      entries.push({ role: "tool", name: ev.name, text: redact(JSON.stringify(ev.args)) });
      return null;
    case "steer":
      entries.push({ role: "user", text: redact(`(mid-turn) ${ev.text}`) });
      return null;
    case "tool_result": {
      const last = entries[entries.length - 1];
      if (last && last.role === "tool" && last.name === ev.name) {
        last.ok = ev.ok;
        last.text = redact(ev.output);
      }
      return buf;
    }
    case "done":
    case "error":
      return null;
    default:
      return buf;
  }
}
import {
  DEFAULT_TITLE,
  Entry,
  SessionRecord,
  deriveTitle,
  newId,
  remove,
  save,
} from "./store.js";

/**
 * A live session: one Agent, its transcript entries, and its current status.
 * Output is buffered here so switching away from a busy session and back
 * again shows everything that accumulated.
 */
export class Session {
  readonly id: string;
  title: string;
  readonly cwd: string;
  entries: Entry[];
  status: "idle" | "thinking" = "idle";
  /**
   * Tool calls currently in flight, for the status bar.
   *
   * Delegated to the agent rather than counted from this session's own events:
   * a turn that started before the user switched to this session emits into
   * *that* view, so a local counter would sit at 0 while tools were plainly
   * running. A single response can ask for several tools at once, and
   * read-only ones run concurrently (see `runToolCalls`), so this is a count
   * rather than a flag.
   */
  get runningTools(): number {
    return this.agent.runningTools;
  }

  /**
   * Bumped whenever this session's tool count changes -- a call starts or
   * finishes.
   *
   * The status bar keeps the last tool count on screen for a moment after the
   * calls finish (see `Screen.stickyToolCount`). That number must be discarded
   * the moment new work starts, or the next run's first frame would show the
   * previous run's count. Comparing this id is how the screen tells "quiet"
   * from "stale": consecutive tools sit idle for a few milliseconds between
   * calls, and that gap must not clear the display.
   */
  get toolActivitySeq(): number {
    return this.agent.toolSeq;
  }

  /** Most tool calls in flight at once during the current run; see `Agent.toolPeak`. */
  get toolPeak(): number {
    return this.agent.toolPeak;
  }
  createdAt: number;
  updatedAt: number;
  private agent: Agent;
  /**
   * The advisory lock this terminal holds on the session, once taken. Null
   * until `acquire()` succeeds; a session only acquires when this terminal
   * actually takes it over (see `App`), so a session merely present in the
   * picker list does not lock it away from other terminals.
   */
  private lock: SessionLock | null = null;
  /**
   * Whether this session has ever been written to disk.
   *
   * A brand-new session is not, so it is absent from `loadAll()` -- and the
   * picker's disk reconcile has to keep it regardless of what is in its
   * transcript. It used to test `entries.length === 0` to spot such a
   * placeholder, but anything that writes a note into a fresh session (a
   * `/help` listing, `/image` feedback) gives it an entry, at which point the
   * reconcile read it as "deleted in another terminal" and dropped the session
   * the user was typing into. Loaded records and saved sessions count as
   * persisted, so only genuinely new ones are exempt.
   */
  persisted: boolean;

  constructor(
    private config: Config,
    rec?: SessionRecord
  ) {
    this.id = rec?.id ?? newId();
    this.cwd = rec?.cwd ?? process.cwd();
    this.entries = rec?.entries ?? [];
    this.createdAt = rec?.createdAt ?? Date.now();
    this.updatedAt = rec?.updatedAt ?? Date.now();
    this.title = rec?.title ?? DEFAULT_TITLE;
    this.persisted = rec !== undefined;
    this.agent = new Agent(config, rec?.messages);
  }

  /** True once this terminal holds the session's lock. */
  get lockHeld(): boolean {
    return this.lock !== null;
  }

  /**
   * The model routing for this session, for the `/model` overlay.
   *
   * Delegated to the agent because only it knows whether the history holds an
   * image, and therefore which model the next request will actually reach.
   */
  get route(): ReturnType<Agent["currentRoute"]> {
    return this.agent.currentRoute();
  }

  /** Choose this session's text and image models. Null restores config. */
  setModels(text: string | null, vision: string | null): void {
    this.agent.setModels(text, vision);
  }

  /**
   * Take the session's lock so a second coda cannot open it at the same time.
   * Idempotent: already holding it is success.
   *
   * Returns the holder's description when the lock is taken elsewhere, so the
   * caller can say who has it. A stale lock (dead process, stopped heartbeat)
   * is taken over rather than refused.
   */
  async acquire(): Promise<{ ok: true } | { ok: false; heldBy: string }> {
    if (this.lock) return { ok: true };
    const res = await acquireLock(this.id);
    if (res.ok) {
      this.lock = res.holder;
      return { ok: true };
    }
    return { ok: false, heldBy: describeHolder(res.heldBy) };
  }

  /** Give up the lock, if this session still holds it. Safe to call twice. */
  async release(): Promise<void> {
    const l = this.lock;
    this.lock = null;
    if (l) await l.release();
  }

  /**
   * Run a user turn. Emits changes via onUpdate so the UI can redraw.
   * Safe to call only when status === "idle".
   */
  /**
   * Fold text typed during a running turn into that turn. Lands at the next
   * point the agent re-sends history -- between tool calls -- so it shapes the
   * work in progress instead of waiting for the turn to end.
   */
  steer(text: string): void {
    this.agent.steer(text);
  }

  async run(
    input: string,
    onUpdate: () => void,
    images: AttachedImage[] = [],
    confirm?: (summary: string, secrets: string[]) => Promise<"yes" | "no" | "always">,
    askSecret?: (name: string, label: string, hidden: boolean) => Promise<string | null>
  ): Promise<void> {
    this.status = "thinking";
    // The approval prompt belongs to the UI, not to the agent: `Agent` has no
    // terminal. Installing it here means a turn started from the app can ask,
    // while a programmatic run (tests, tooling) simply cannot approve anything
    // and `use_secret` refuses.
    this.agent.setConfirm(confirm ?? null);
    // Same reasoning: collecting a credential the task needs is a UI job.
    this.agent.setAskSecret(askSecret ?? null);
    // Show the attachment in the transcript so it is clear what was sent; the
    // pixels themselves never go in the entry list.
    const label = images.length
      ? input + (input ? " " : "") + images.map((i) => `[image: ${i.path}]`).join(" ")
      : input;
    this.entries.push({ role: "user", text: label });
    // Give an untitled session its title from the first user message. Existing
    // titles are left alone so a long-running session keeps its identity.
    if (this.title === DEFAULT_TITLE) {
      this.title = deriveTitle([{ role: "user", content: input }]);
    }
    onUpdate();

    let assistantBuf: Entry | null = null;

    const emit = (ev: AgentEvent) => {
      assistantBuf = applyEvent(this.entries, ev, assistantBuf);
      onUpdate();
    };

    try {
      await this.agent.send(input, emit, images);
    } catch (err: any) {
      this.entries.push({
        role: "assistant",
        text: `error: ${err?.message ?? String(err)}`,
      });
    } finally {
      this.status = "idle";
      this.updatedAt = Date.now();
      await this.persist();
      onUpdate();
    }
  }

  /**
   * Take on the state of a record read from disk, so a change made in another
   * terminal (a rename, another turn) shows up here too.
   *
   * Only the fields a refresh should follow are adopted -- title, transcript,
   * updatedAt and the agent's history. `createdAt` and `cwd` stay put: they
   * describe where this session began and moving them would make an older
   * record look newer than it is.
   *
   * The caller is responsible for not calling this on a running session; a
   * turn in flight owns `entries` and `messages` and adopting over it would
   * drop the output it has not persisted yet.
   */
  adopt(rec: SessionRecord): void {
    this.title = rec.title;
    this.entries = rec.entries;
    this.updatedAt = rec.updatedAt;
    this.agent.messages = rec.messages;
  }

  toRecord(): SessionRecord {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      messages: this.agent.messages,
      entries: this.entries,
    };
  }

  /**
   * Give the session a user-chosen title. Clearing it to the default title
   * re-arms auto-titling, so the next turn names the session from its first
   * message again.
   */
  async rename(title: string): Promise<void> {
    const trimmed = title.trim();
    this.title = trimmed || DEFAULT_TITLE;
    this.updatedAt = Date.now();
    await this.persist();
  }

  async persist(): Promise<void> {
    // Nothing to save for a brand-new, untouched session -- unless it has been
    // named. A title is a deliberate act and has to outlive the terminal it was
    // typed in, so a session renamed before its first message is written on that
    // basis alone. Without this the rename was applied in memory and dropped by
    // the early return here, so the name vanished the moment the session was
    // reopened; it looked as though renaming a fresh session did nothing.
    //
    // Once written the record is kept up to date rather than abandoned: clearing
    // the name back to the default re-arms auto-titling (`rename`), and if the
    // guard stopped here the file on disk would still hold the old name while
    // this copy said otherwise.
    if (this.entries.length === 0 && this.title === DEFAULT_TITLE && !this.persisted) return;
    await save(this.toRecord());
    this.persisted = true;
  }

  async delete(): Promise<void> {
    // Drop the lock first: once the session file is gone the lock file would be
    // orphaned, and a stale lock left behind would block a future session that
    // happened to reuse the id (it should not, but be tidy).
    await this.release();
    await remove(this.id);
  }
}
