import {
  Agent,
  AgentEvent,
  isMalformedHistoryError,
  isRequestRejection,
} from "./agent.js";
import type { AttachedImage } from "./image.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
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
 * Marker `seedHandover` puts at the head of a handover message.
 *
 * Labelled rather than left bare: the text is a previous agent's notes, and
 * presenting it as the user's own words would misrepresent an instruction the
 * user never gave. It doubles as the way a seeded session is recognised --
 * see `Session.seeded`.
 */
const HANDOVER_MARKER = "[handover from the previous session]";

/** True when a message body is a seeded handover rather than real user text. */
function isHandoverText(content: ChatCompletionMessageParam["content"]): boolean {
  return typeof content === "string" && content.startsWith(HANDOVER_MARKER);
}

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
  /**
   * True when a handover has been seeded into the history.
   *
   * A seeded session has no entries -- the handover is history, not transcript,
   * so it is never drawn -- and that makes it look untouched: `persist` would
   * skip the write and lose the handover on reload, and `submitPrompt` would
   * read it as an empty placeholder and open a *second* session for the user's
   * first message, dropping the handover. Both have to tell the two apart.
   *
   * Derived from the history rather than recorded as a flag, because a flag has
   * to be written to disk and restored to survive a restart, and every path
   * that builds a session from a record would have to remember to restore it.
   * Deriving it from the message `seedHandover` writes means a reloaded session
   * is seeded for the same reason a fresh one is, and the two can never drift.
   */
  get seeded(): boolean {
    return this.agent.messages.some(
      (m) => m.role === "user" && isHandoverText(m.content)
    );
  }

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

  /**
   * Seed a freshly created session with a handover from the session it was
   * opened from.
   *
   * The handover goes in as an ordinary first user message rather than into the
   * input box, for two reasons. It is *possessed* either way -- only what is in
   * the messages reaches the model, and text parked in the input buffer reaches
   * nothing until Enter is pressed -- whereas the input box asks the user to
   * review and send something they did not write. Putting it in the history
   * also means it is read exactly once, at creation, and from then on is just
   * part of the conversation: it is never re-read from disk or rebuilt.
   *
   * The transcript gets no matching entry: the handover is context the session
   * needs, not something the user asked to see. The stored messages keep it, so
   * it survives a reload without ever being drawn.
   *
   * Labelled as a handover, not left bare: it is text a previous agent wrote,
   * and presenting it as the user's own words would misrepresent an instruction
   * the user never gave.
   */
  /**
   * The history this session will send, for callers that need to inspect it
   * (tests, and anything checking what a session actually holds).
   *
   * Read-only: mutating it from outside would bypass `persist`, so the array is
   * copied. `seedHandover` is the one supported way to add to it.
   */
  get history(): ChatCompletionMessageParam[] {
    return [...this.agent.messages];
  }

  async seedHandover(preamble: string): Promise<void> {
    const text = preamble.trim();
    if (!text) return;
    const body = `${HANDOVER_MARKER}\n\n${text}`;
    // Deliberately NOT added to `entries`: the transcript is what is drawn on
    // screen, and the handover is context the new session needs, not something
    // the user asked to see. Printing it put a wall of the previous session's
    // notes in front of them every time a session was opened. The message alone
    // is what reaches the model; `toRecord` saves `messages` and `entries`
    // independently, so the handover still survives a reload without being
    // drawn.
    //
    // Stored directly rather than sent through `run`, which would put the
    // session into a turn and spend a request before the user has asked for
    // anything. `Agent` exposes the history it will send.
    this.agent.messages.push({ role: "user", content: body });
    this.updatedAt = Date.now();
    // Written out now, not on the first turn. The handover is injected exactly
    // once, from this call, so if it were only persisted when a message was
    // sent it would be lost by restarting first -- and there is no second copy
    // to recover it from.
    await this.persist();
  }

  async run(
    input: string,
    onUpdate: () => void,
    images: AttachedImage[] = [],
    confirm?: (summary: string, secrets: string[]) => Promise<"yes" | "no" | "always">,
    askSecret?: (name: string, label: string, hidden: boolean) => Promise<string | null>
  ): Promise<{ newSession?: { title?: string; preamble?: string } }> {
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

    let newSession: { title?: string; preamble?: string } | undefined;
    try {
      ({ newSession } = await this.agent.send(input, emit, images));
    } catch (err: any) {
      // The provider refused the request, so the turn never ran: undo the
      // transcript row for this message as well as the history entry. Leaving
      // it would show a message the agent never saw -- and set the session
      // title from it -- while the history no longer contains it.
      if (isRequestRejection(err)) {
        this.entries.pop();
        if (this.title === deriveTitle([{ role: "user", content: input }])) {
          this.title = DEFAULT_TITLE;
        }
      }
      this.entries.push({
        role: "assistant",
        text: isMalformedHistoryError(err)
          ? `error: ${err?.message ?? String(err)}\n\n` +
            `This session's history is malformed, so every request will fail ` +
            `until it is repaired. Nothing was added to it. Report this — the ` +
            `history needs repair, not another attempt.`
          : `error: ${err?.message ?? String(err)}`,
      });
    } finally {
      this.status = "idle";
      this.updatedAt = Date.now();
      await this.persist();
      onUpdate();
    }
    // Returned rather than acted on: a session cannot create a sibling, and
    // only the app knows about the terminal. Persisted first (in `finally`), so
    // the turn that asked for the new session is already safe on disk.
    return { newSession };
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
    if (
      this.entries.length === 0 &&
      this.title === DEFAULT_TITLE &&
      !this.persisted &&
      !this.seeded
    )
      return;
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
