import { Config } from "./config.js";
import { Key, KeyReader } from "./keys.js";
import { LineBuffer, PromptRecall } from "./linebuffer.js";
import type { RecalledPrompt } from "./linebuffer.js";
import { Screen, PickerItem } from "./screen.js";
import { Session } from "./session.js";
import { lockHolder } from "./lock.js";
import { loadAll } from "./store.js";
import type { SessionRecord } from "./store.js";
import { loadCatalog, bareId } from "./models.js";
import {
  globalInstructionsPath,
  loadInstructions,
  projectInstructionsPath,
} from "./instructions.js";
import type { ModelCatalog } from "./models.js";
import {
  deleteSecret,
  describe,
  hasSecret,
  isValidName,
  listSecrets,
  normaliseName,
  redact,
  SECRETS_DIR,
  setSecret,
  trackSecret,
} from "./secrets.js";
import {
  attachImage,
  clipboardContents,
  clipboardImagePath,
  imagePathsIn,
  imagePathsInText,
  pruneImageCache,
  ImageError,
} from "./image.js";
import type { AttachedImage } from "./image.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * package.json's version, for the header. Read here rather than hardcoded so
 * `npm version` is still the only place it changes; dist/app.js sits one level
 * under the package root in both a clone and a global install.
 */
function readVersion(): string {
  try {
    const pkgPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json"
    );
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version as string;
  } catch {
    return "";
  }
}

/**
 * Owns the whole TUI: the list of live sessions, which one is active, and the
 * picker overlay. Left-arrow (or Ctrl+R) opens the picker without leaving the
 * running app, so several sessions stay live at once.
 */
export class App {
  private sessions: Session[] = [];
  /**
   * Which session is active, held by **id** rather than by index.
   *
   * `sessions` is mutated underneath us -- a picker refresh appends records and
   * drops ones deleted in another terminal, and the picker is drawn from a
   * *sorted copy* of it. An index into that array therefore stops meaning what
   * it did as soon as anything inserts, removes or reorders: the active session
   * would silently become a different one. Holding the id instead makes the
   * active session independent of array position, which is the property the
   * picker actually needs.
   */
  private activeId: string | null = null;
  private input = new LineBuffer();
  /**
   * The prompts ↑/↓ walk back through, and the draft being edited.
   *
   * Reset whenever the input is cleared for a reason other than sending -- a
   * new session, closing one, opening a picker entry -- because the draft it
   * holds belongs to the session it was typed in.
   */
  private recall = new PromptRecall<string>();
  /** Picker state: highlighted row and the "start a new session" field. */
  private picker: {
    index: number;
    query: LineBuffer;
    /** Help reference shown over the list, or null. See `showPickerHelp`. */
    help: string[] | null;
    /** First help line drawn; the block scrolls while it is open. */
    helpTop: number;
  } | null = null;
  /**
   * Title editor, non-null while a session's title is being edited (Alt+R).
   * It holds the target session and the edit buffer, which starts pre-filled
   * with the current title.
   *
   * `fromPicker` records where the edit began. Renaming the highlighted session
   * from the picker must leave you in the picker when it finishes -- the
   * editor overlays the list, so you keep your place -- whereas an Alt+R in the
   * chat view returns to the chat. Without this the picker was torn down on
   * Alt+R and Enter dropped you into the *active* session, which is often not
   * the one whose title you were editing.
   */
  private rename: { id: string; buffer: LineBuffer; fromPicker: boolean } | null = null;
  /**
   * The secret prompt, when open.
   *
   * Kept separate from `rename` and the other modals because a secret must not
   * go through the same paths: the value lives in this buffer only, is never
   * copied into the chat input, and is discarded on Esc. `buffer` is a
   * LineBuffer like the others, but everything that reads it renders masked
   * (see `Screen`'s `password` state).
   */
  private secretPrompt: {
    name: string;
    /** What the user is being asked for; shown above the field. */
    label: string;
    /** False for a non-secret such as a username, so it is echoed visibly. */
    hidden: boolean;
    buffer: LineBuffer;
    /**
     * Resolves the caller waiting on this value, or null when the prompt was
     * opened by `/secret add` (where there is nobody to hand the result back
     * to beyond storing it).
     */
    resolve: ((value: string | null) => void) | null;
  } | null = null;
  /**
   * A pending `use_secret` approval, when the agent is waiting on the user.
   *
   * The resolver is the promise the agent is blocked on: nothing runs until it
   * is called, so the value cannot be spent by accident. Kept as state rather
   * than a plain await because the answer arrives through the key handler.
   */
  private approval: {
    summary: string;
    secrets: string[];
    resolve: (answer: "yes" | "no" | "always") => void;
  } | null = null;
  /**
   * Lines scrolled back from the tail of the transcript.
   *
   * Kept for the key handling, which thinks in "lines back". The *view* is not
   * anchored to this value: an offset from the tail moves whenever a reply
   * appends a line, so a turn still being written dragged the reader back to
   * the bottom. `scrollTop` holds the position instead, and this is recomputed
   * from it before each frame.
   */
  private scroll = 0;
  /**
   * First transcript line to draw, counted from the top; -1 follows the tail.
   *
   * Anchoring to a line index rather than a distance from the end is what lets
   * someone read old context while the model is still writing: new lines land
   * below the anchor and the view stays where it was.
   */
  private scrollTop = -1;
  private screen: Screen;
  private keys = new KeyReader();
  private quitting = false;
  /** Images attached with /image, waiting to ride along with the next message. */
  private pendingImages: AttachedImage[] = [];
  private renderQueued = false;
  /**
   * Sessions whose lock another coda holds: session id -> holder description.
   *
   * `render()` is synchronous and must not await a filesystem probe, so the
   * picker's "locked by …" markers are served from this cache. It is filled by
   * `refreshLockHolders()`, which runs when the picker opens and again on each
   * refresh -- the same points at which the sessions list is re-read.
   */
  private heldByOther = new Map<string, string>();
  /**
   * The `/model` overlay, when open.
   *
   * `catalog` is the fetched list plus which models accept images; `index` is
   * the highlighted chat model, and `visionIndex` the image model chosen with
   * Left/Right. The selection is only committed on Enter, so Esc leaves the
   * session's routing exactly as it was -- arrows move a draft, not the app.
   */
  private modelPicker: {
    catalog: ModelCatalog;
    index: number;
    visionIndex: number;
  } | null = null;

  constructor(private config: Config) {
    // The version shown in the header comes from package.json, so `npm version`
    // remains the single place it is set (index.ts reads it for --version).
    this.screen = new Screen(config.mouse, readVersion());
  }

  async start(): Promise<void> {
    // History is loaded newest-first, but new sessions are appended -- so the
    // last index is the *oldest* stored record, not the newest one. Rather than
    // guess, start on a fresh session: opening one you did not pick (and were
    // then typing into) was the wrong default. Past sessions stay one keypress
    // away via the picker, which Esc returns from to this new session.
    const records = await loadAll();

    // Collect the images those records still refer to and drop any cache file
    // nothing mentions. Done here because the records are already parsed --
    // reading the corpus a second time on startup just to find a handful of
    // paths would be wasted work. Fire-and-forget: nothing waits on it, and a
    // failure only leaves files for the next run.
    void pruneImageCache(
      new Set(records.flatMap((rec) => imagePathsIn(rec.messages as any)))
    ).catch(() => {});

    for (const rec of records) this.sessions.push(new Session(this.config, rec));
    const fresh = new Session(this.config);
    this.sessions.push(fresh);
    this.setActive(fresh);
    // Only the session this terminal starts on is locked. The rest are merely
    // listed; locking them would deny other terminals every saved session.
    this.claimActive();

    this.screen.start();
    this.keys.onKey((k) => this.onKey(k));
    this.keys.start();

    // Restore the terminal on any exit path (Ctrl+C handled as a key too).
    const cleanup = () => {
      this.screen.stop();
      this.keys.stop();
    };
    const flushAndExit = () => {
      cleanup();
      Promise.all(
        this.sessions.map((s) =>
          Promise.all([s.persist().catch(() => {}), s.release()]).catch(() => {})
        )
      ).finally(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    };
    process.once("SIGTERM", flushAndExit);
    process.once("SIGINT", flushAndExit);
    process.once("exit", cleanup);

    this.render();
  }

  private current(): Session {
    // Resolve by id, falling back only when the id is gone (the active session
    // was deleted elsewhere): a stale id must never read past the end of the
    // array, and the last session is the safest thing to show.
    const found = this.sessions.find((s) => s.id === this.activeId);
    if (found) return found;
    const fallback = this.sessions[this.sessions.length - 1];
    this.activeId = fallback?.id ?? null;
    return fallback;
  }

  /**
   * Make `session` the active one. Every place that used to assign an index
   * calls this instead, so the id and the array position can never disagree.
   */
  private setActive(session: Session): void {
    this.activeId = session.id;
  }

  /** Coalesce redraws so a fast stream doesn't block on I/O. */
  private requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    setImmediate(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  private render(): void {
    const pickerList = this.pickerSessions();
    const items: PickerItem[] = pickerList.map((s) => ({
      label: s.title,
      detail:
        `${s.entries.length} msgs · ${s.status === "thinking" ? "● thinking" : "idle"} · ` +
        new Date(s.updatedAt).toLocaleString(),
      // A session this terminal already holds is openable, so only report a
      // lock held by somebody else.
      locked: s.lockHeld ? null : (this.heldByOther.get(s.id) ?? null),
    }));

    this.screen.render({
      entries: this.current().entries,
      input: this.input.value,
      cursor: this.input.cursor,
      status: this.current().status,
      runningTools: this.current().runningTools,
      toolSeq: this.current().toolActivitySeq,
      toolPeak: this.current().toolPeak,
      title: this.current().title,
      // Report the session's position in the SAME order the picker lists, so
      // the header's "session N" names the row the user actually picked. The
      // active session is now held by id, so this lookup is stable regardless
      // of how `sessions` has been reordered underneath; the index is only
      // computed here, for display. `pickerSessions()` always contains the
      // active session, so the fallback to row 1 is only a guard.
      sessionIndex: Math.max(0, pickerList.findIndex((s) => s.id === this.activeId)),
      sessionCount: this.sessions.length,
      scrollOffset: this.scroll,
      // The anchor is passed as a line index, not an offset: only the renderer
      // knows how long the transcript is this frame, and a reply still being
      // written changes that between frames.
      scrollTop: this.scrollTop,
      picker: this.picker
        ? {
            items,
            index: this.picker.index,
            // A rename started from the picker is edited in the picker's own
            // entry field, in place under the highlighted row, rather than
            // kicking the view back to the chat and showing some other
            // session's transcript while you edit this one's title.
            query:
              this.rename && this.rename.fromPicker
                ? this.rename.buffer.value
                : this.picker.query.value,
            cursor:
              this.rename && this.rename.fromPicker
                ? this.rename.buffer.cursor
                : this.picker.query.cursor,
            renaming: !!(this.rename && this.rename.fromPicker),
            help: this.picker.help,
            helpTop: this.picker.helpTop,
          }
        : null,
      rename:
        this.rename && !this.picker
          ? {
              title: this.sessions.find((s) => s.id === this.rename!.id)?.title ?? "",
              value: this.rename.buffer.value,
              cursor: this.rename.buffer.cursor,
            }
          : null,
      modelPicker: this.modelPicker
        ? this.modelPickerState(this.modelPicker)
        : null,
      // Only the length crosses into the renderer: the value itself never
      // leaves the buffer, so it cannot be drawn even by mistake.
      approval: this.approval ? { summary: this.approval.summary } : null,
      password: this.secretPrompt
        ? {
            label: this.secretPrompt.label,
            // A non-hidden prompt shows the value, so the caret and the text
            // are drawn normally; only the masked one hides it.
            length: this.secretPrompt.buffer.value.length,
            cursor: this.secretPrompt.buffer.cursor,
            hidden: this.secretPrompt.hidden,
          }
        : null,
    });
  }

  /** Build the screen's view of the `/model` overlay from the app's state. */
  private modelPickerState(
    m: NonNullable<App["modelPicker"]>
  ): NonNullable<Parameters<Screen["render"]>[0]["modelPicker"]> {
    const route = this.current().route;
    // The image column offers models believed to accept images, plus the one
    // in force even when its name does not advertise it (it is configured, so
    // it is known to work).
    const vision = m.catalog.chat.filter((c) => c.vision).map((c) => c.id);
    const current = route.visionModel ? bareId(route.visionModel) : "";
    if (current && !vision.includes(current)) vision.push(current);
    return {
      models: m.catalog.chat.map((c) => ({ id: c.id, vision: c.vision })),
      index: m.index,
      selected: bareId(route.textModel),
      vision,
      // `m.visionIndex` is already an index into this list. It is clamped, not
      // re-resolved through `indexOf`: round-tripping it through the name meant
      // a move was undone whenever the resolved name did not match, and left
      // the cursor stuck on the model that was already active.
      visionIndex: Math.max(0, Math.min(m.visionIndex, vision.length - 1)),
      usingVision: route.usingVision,
      notice: m.catalog.fetched ? "from model endpoint" : `config only: ${m.catalog.error ?? "not fetched"}`,
    };
  }

  /**
   * Sessions shown in the picker -- the whole list, in order.
   *
   * Typing no longer reorders or hides entries. Filtering the list against the
   * query made the highlighted row jump around as you typed, and the query line
   * is where the caret rendering went wrong; selection is by arrow keys only.
   * The text box remains, but purely as "start a new session with this message".
   *
   * Nothing else may claim a typed character, either: since the query never
   * filters, a keystroke can only ever be text for the new session. That is
   * why the old "empty prompt + `d`/`r`" shortcuts are gone (see
   * `onPickerKey`).
   */
  private pickerSessions(): Session[] {
    // Canonical order: most recently updated first. The underlying `sessions`
    // array is NOT in this order -- records load newest-first, while new
    // sessions and sessions discovered by a refresh are appended -- so two
    // terminals that had done different things listed the same saved sessions
    // in different rows. Sorting here, at the single point the list is read for
    // both rendering and `items[index]` lookups, makes every terminal agree on
    // the order of the sessions they can both see.
    //
    // A sort of a copy, not of `this.sessions`: the array's own order is what
    // `active` and the picker index are stored against, and reordering it
    // underneath them would move the highlight to a different session.
    return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Keep the picker index inside the list.
   *
   * Deleting an entry (Ctrl+X) splices it out, so the rows after it shift up.
   * Clamping alone would leave the *same numeric* index selected -- now the
   * session after the one deleted -- so after a delete the highlight is pulled
   * back by the amount the list shrank. That keeps the caret on the row that
   * took the deleted one's place, which is where the eye already is, and it
   * still can't leave an empty list selected.
   */
  private clampPickerIndex(shrunk = false): void {
    if (!this.picker) return;
    const n = this.pickerSessions().length;
    if (shrunk && this.picker.index > n - 1) this.picker.index = Math.max(0, this.picker.index - 1);
    this.picker.index = n === 0 ? 0 : Math.min(this.picker.index, n - 1);
    if (this.picker.index < 0) this.picker.index = 0;
  }

  private onKey(k: Key): void {
    if (this.quitting) return;
    if (this.approval) this.onApprovalKey(k);
    else if (this.secretPrompt) this.onSecretKey(k);
    else if (this.modelPicker) this.onModelPickerKey(k);
    else if (this.rename) this.onRenameKey(k);
    else if (this.picker) this.onPickerKey(k);
    else this.onChatKey(k);
  }

  /** Begin editing a session's title, pre-filled with the current one. */
  private startRename(session: Session, fromPicker = false): void {
    const buffer = new LineBuffer();
    buffer.set(session.title);
    this.rename = { id: session.id, buffer, fromPicker };
    this.requestRender();
  }

  /**
   * Keys while a title is being edited: Enter saves, Esc cancels, and the rest
   * are ordinary line editing. Every key is consumed here so nothing typed
   * into a title can reach the chat view.
   */
  private onRenameKey(k: Key): void {
    const r = this.rename!;
    const b = r.buffer;
    const target = this.sessions.find((s) => s.id === r.id);

    switch (k.type) {
      case "enter":
        // A picker rename overlays the list rather than replacing it, so the
        // picker is still set: clearing `rename` just returns to it, with the
        // highlight where it was. A chat-view rename has no picker to return
        // to and simply lands back in the chat view.
        this.rename = null;
        if (target) void target.rename(b.value);
        break;
      case "escape":
        this.rename = null; // discard the edit (and return to the picker if it began there)
        break;
      case "left":
        b.left();
        break;
      case "right":
        b.right();
        break;
      case "home":
        b.home();
        break;
      case "end":
        b.end();
        break;
      case "backspace":
        b.backspace();
        break;
      case "delete":
        b.deleteForward();
        break;
      case "paste":
        b.insert(k.text.replace(/\r?\n/g, " "));
        break;
      case "alt":
        if (k.ch === "b") b.wordLeft();
        else if (k.ch === "f") b.wordRight();
        else if (k.ch === "d") b.deleteWordRight();
        else if (k.ch === "backspace") b.deleteWordLeft();
        break;
      case "ctrl":
        if (k.ch === "c") { this.quit(); return; }
        else if (k.ch === "a") b.home();
        else if (k.ch === "e") b.end();
        else if (k.ch === "u") b.deleteToStart();
        else if (k.ch === "k") b.deleteToEnd();
        else if (k.ch === "w") b.deleteWordLeft();
        break;
      case "char":
        b.insert(k.ch);
        break;
      // up/down/tab/pageup/pagedown have no meaning while editing a title.
    }
    this.requestRender();
  }

  /**
   * Move the help block by `delta` lines, clamped to the block's ends.
   *
   * The visible height comes from the screen, which has just drawn the block:
   * scrolling past the end would otherwise leave the last screenful blank, and
   * a silent no-op at the bottom is clearer than either.
   */
  private scrollPickerHelp(delta: number): void {
    const p = this.picker;
    if (!p?.help) return;
    const visible = this.screen.helpRows;
    const maxTop = Math.max(0, p.help.length - Math.max(1, visible));
    p.helpTop = Math.max(0, Math.min(p.helpTop + delta, maxTop));
  }

  /** Lines per page press in the help block; at least one. */
  private pickerHelpPage(): number {
    return Math.max(1, this.screen.helpRows - 1);
  }

  /**
   * Keys while the `/model` overlay is open.
   *
   * Up/Down move the text-model highlight, Left/Right the image model, Enter
   * commits both to this session and closes, and Esc discards. Every key is
   * consumed: nothing typed here may reach the chat input behind the overlay.
   *
   * The image column is only editable when the highlighted model is also the
   * one in force, because the image model belongs to the session rather than to
   * a row -- changing it while highlighting a model you have not selected yet
   * would be changing a setting for a model that is not in use.
   */
  private onModelPickerKey(k: Key): void {
    const m = this.modelPicker!;
    const models = m.catalog.chat;
    const vision = this.modelPickerState(m).vision;

    switch (k.type) {
      case "up":
        if (models.length) m.index = Math.max(0, m.index - 1);
        break;
      case "down":
        if (models.length) m.index = Math.min(models.length - 1, m.index + 1);
        break;
      case "left":
        if (vision.length) m.visionIndex = Math.max(0, m.visionIndex - 1);
        break;
      case "right":
        if (vision.length) m.visionIndex = Math.min(vision.length - 1, m.visionIndex + 1);
        break;
      case "escape":
        // Discard: the arrows only moved a draft, so the session's routing is
        // untouched and closing is all that is left to do.
        this.modelPicker = null;
        this.requestRender();
        return;
      case "enter": {
        const chosen = models[m.index]?.id;
        if (chosen) {
          const visionChoice = vision[m.visionIndex] ?? this.current().route.visionModel;
          // Store null when the choice matches config, so a later config change
          // is picked up rather than shadowed by a stale explicit selection.
          const text = bareId(chosen) === bareId(this.config.model) ? null : chosen;
          const img =
            !visionChoice || bareId(visionChoice) === bareId(this.config.visionModel)
              ? null
              : visionChoice;
          this.current().setModels(text, img);
          this.systemNote(
            `model: ${bareId(chosen)}` +
              (visionChoice ? ` · images: ${bareId(visionChoice)}` : " · images: none") +
              (this.current().route.usingVision
                ? "  (history has an image, so the image model answers)"
                : "")
          );
        }
        this.modelPicker = null;
        this.requestRender();
        return;
      }
      case "ctrl":
        if (k.ch === "c") {
          this.quit();
          return;
        }
        break;
      default:
        // Any other key is swallowed rather than typed: the overlay owns the
        // keyboard while it is up.
        break;
    }
    this.requestRender();
  }

  /**
   * Open the `/model` overlay.
   *
   * The list is fetched, but never awaited to the point of blocking the UI: it
   * degrades to the configured models when the endpoint cannot be reached, so
   * an offline machine can still see and reselect what it is running.
   */
  private async openModelPicker(): Promise<void> {
    const catalog = await loadCatalog(this.config);
    const route = this.current().route;
    const current = bareId(route.textModel);
    const idx = Math.max(0, catalog.chat.findIndex((c) => c.id === current));

    // Start the image cursor on the model actually in force, resolved against
    // the same list the overlay will draw (which may append the configured
    // model when its name does not advertise image support).
    const vision = catalog.chat.filter((c) => c.vision).map((c) => c.id);
    const activeVision = route.visionModel ? bareId(route.visionModel) : "";
    if (activeVision && !vision.includes(activeVision)) vision.push(activeVision);
    const visionIndex = Math.max(0, vision.indexOf(activeVision));

    this.modelPicker = { catalog, index: idx, visionIndex };
    this.screen.resetModelWindow();
    this.requestRender();
  }

  /**
   * Keys while the secret prompt is open.
   *
   * Everything here exists to keep the value out of sight. Paste is refused: a
   * pasted credential would sit in the terminal's own paste stream and in the
   * clipboard history, which defeats the prompt. The value is never echoed, is
   * not rendered (the screen draws bullets), and is not put in the transcript
   * on Enter -- only that a secret was saved.
   */
  private onSecretKey(k: Key): void {
    const p = this.secretPrompt!;
    const b = p.buffer;

    switch (k.type) {
      case "enter": {
        const value = b.value;
        this.secretPrompt = null;
        if (value === "") {
          this.systemNote(`secret ${p.name}: cancelled (nothing entered)`);
          p.resolve?.(null);
          this.requestRender();
          return;
        }
        if (p.resolve) {
          // Opened by the agent (`request_secret`): hand the value back and
          // store nothing here. The agent tracks and stores it so the ordering
          // (track, then write) is in one place.
          this.systemNote(`secret ${p.name}: entered`);
          p.resolve(value);
          this.requestRender();
          return;
        }
        // Track before storing: if the write fails, the value is still masked
        // from the transcript for the rest of this process.
        trackSecret(value);
        const ok = setSecret(p.name, value);
        this.systemNote(
          ok
            ? `secret ${p.name}: saved (${value.length} chars, mode 600)`
            : `secret ${p.name}: could not be saved`
        );
        this.requestRender();
        return;
      }
      case "escape":
        this.secretPrompt = null;
        this.systemNote(`secret ${p.name}: cancelled`);
        p.resolve?.(null);
        this.requestRender();
        return;
      case "backspace":
        b.backspace();
        break;
      case "delete":
        b.deleteForward();
        break;
      case "left":
        b.left();
        break;
      case "right":
        b.right();
        break;
      case "home":
        b.home();
        break;
      case "end":
        b.end();
        break;
      case "ctrl":
        if (k.ch === "c") {
          this.quit();
          return;
        }
        if (k.ch === "a") b.home();
        else if (k.ch === "e") b.end();
        else if (k.ch === "u") b.deleteToStart();
        else if (k.ch === "k") b.deleteToEnd();
        else if (k.ch === "w") b.deleteWordLeft();
        break;
      case "alt":
        if (k.ch === "b") b.wordLeft();
        else if (k.ch === "f") b.wordRight();
        else if (k.ch === "d") b.deleteWordRight();
        else if (k.ch === "backspace") b.deleteWordLeft();
        break;
      case "char":
        b.insert(k.ch);
        break;
      case "paste":
        // Refused deliberately -- see the method comment. Say so, or it looks
        // like the terminal is broken.
        this.systemNote("secret: paste is disabled here; type the value");
        break;
      // up/down/tab/wheel do nothing while a secret is being typed.
    }
    this.requestRender();
  }

  /** Open the prompt for a named secret. */
  private promptSecret(name: string): void {
    const n = normaliseName(name);
    if (!isValidName(n)) {
      this.systemNote(
        `invalid secret name: ${JSON.stringify(name)}  (lowercase letters, digits, . _ -; max 64)`
      );
      this.requestRender();
      return;
    }
    this.secretPrompt = {
      name: n,
      label: `secret "${n}" — value hidden:`,
      hidden: true,
      buffer: new LineBuffer(),
      resolve: null,
    };
    this.requestRender();
  }

  /**
   * The prompt handed to the agent for `request_secret`.
   *
   * One secret per call, in sequence: collecting several at once would mean
   * juggling which field is active, and the agent can call the tool repeatedly.
   * Resolves to the typed value, or null if cancelled.
   */
  private askSecretInput(
    name: string,
    label: string,
    hidden: boolean
  ): Promise<string | null> {
    return new Promise((resolve) => {
      this.secretPrompt = {
        name,
        label: `${label}:`,
        hidden,
        buffer: new LineBuffer(),
        resolve,
      };
      this.requestRender();
    });
  }

  /**
   * Report the standing instructions and where they are read from.
   *
   * Shows the *text*, not just the paths, because the failure this feature
   * exists to prevent is a rule that was never loaded -- showing what the model
   * actually received is the only way to tell "not written" from "not read".
   */
  private showInstructions(): void {
    const global = globalInstructionsPath();
    const project = projectInstructionsPath(process.cwd());
    const text = loadInstructions(process.cwd());
    if (!text) {
      this.systemNote(
        "no standing instructions.\n" +
          `  global:  ${global}\n` +
          `  project: ${project}\n` +
          "Create either file with markdown; it is added to the system prompt of " +
          "every new session."
      );
      this.requestRender();
      return;
    }
    this.systemNote(
      "standing instructions in force:\n\n" +
        text +
        `\n\n(global: ${global}\n project: ${project})`
    );
  }

  /** `/secret` — list, add, remove. Values are never printed. */
  private handleSecretCommand(arg: string): void {
    const [sub, ...rest] = arg.split(/\s+/).filter(Boolean);
    const name = rest.join(" ");

    if (!sub || sub === "list") {
      const names = listSecrets();
      if (names.length === 0) {
        this.systemNote(
          "credentials vault is empty.   /secret add <name>  to add one\n" +
            `vault: ${SECRETS_DIR}  (mode 700, files 600)`
        );
      } else {
        const lines = names.map((n) => {
          const d = describe(n);
          return `  ${d.name.padEnd(24)} ${d.chars} chars`;
        });
        this.systemNote(`credentials vault (${SECRETS_DIR}):\n` + lines.join("\n"));
      }
      this.requestRender();
      return;
    }

    if (sub === "add" || sub === "set") {
      if (!name) {
        this.systemNote("usage: /secret add <name>   (the value is asked for at a hidden prompt)");
        this.requestRender();
        return;
      }
      // `--force` is a flag, not part of the name.
      const words = rest.filter((w) => w !== "--force");
      const target = words[0] ?? "";
      const force = words.length !== rest.length;
      if (words.length !== 1) {
        this.systemNote(
          "usage: /secret add <name> [--force]   (a name is one word: lowercase letters, digits, . _ -)"
        );
        this.requestRender();
        return;
      }
      if (hasSecret(target) && !force) {
        this.systemNote(
          `secret ${normaliseName(target)} already exists.  ` +
            `/secret add ${target} --force  to replace it`
        );
        this.requestRender();
        return;
      }
      this.promptSecret(target);
      return;
    }

    if (sub === "remove" || sub === "delete" || sub === "rm") {
      if (!name) {
        this.systemNote("usage: /secret remove <name>");
        this.requestRender();
        return;
      }
      const n = normaliseName(name);
      const ok = deleteSecret(n);
      this.systemNote(ok ? `secret ${n}: removed` : `secret ${n}: not found`);
      this.requestRender();
      return;
    }

    if (sub === "exists" || sub === "has") {
      const n = normaliseName(name);
      this.systemNote(hasSecret(n) ? `secret ${n}: present` : `secret ${n}: absent`);
      this.requestRender();
      return;
    }

    this.systemNote(
      "usage: /secret [list | add <name> [--force] | remove <name> | exists <name>]"
    );
    this.requestRender();
  }

  /**
   * Keys while a credential approval is pending.
   *
   * `y` approves once, `a` approves for the rest of this session, anything that
   * is not a yes (`n`, `Esc`, `Ctrl+C`) refuses. Refusing on an unrecognised key
   * is deliberate: this prompt blocks a credential being spent, so the safe
   * default for an ambiguous keypress is "no".
   */
  private onApprovalKey(k: Key): void {
    const a = this.approval!;
    let answer: "yes" | "no" | "always" | null = null;

    if (k.type === "char") {
      const c = k.ch.toLowerCase();
      if (c === "y") answer = "yes";
      else if (c === "a") answer = "always";
      else if (c === "n") answer = "no";
    } else if (k.type === "enter") {
      answer = "no"; // Enter is not a yes: it is too easy to hit by reflex
    } else if (k.type === "escape") {
      answer = "no";
    } else if (k.type === "ctrl" && k.ch === "c") {
      answer = "no";
    }

    if (answer === null) return; // ignore other keys and keep waiting

    this.approval = null;
    if (answer === "always") {
      this.systemNote(`approved ${a.secrets.join(", ")} for this session`);
    } else if (answer === "no") {
      this.systemNote(`declined ${a.secrets.join(", ")}`);
    } else {
      this.systemNote(`approved ${a.secrets.join(", ")} (once)`);
    }
    a.resolve(answer);
    this.requestRender();
  }

  /** The prompt handed to the agent: shows what is about to run, then waits. */
  private askApproval(
    summary: string,
    secrets: string[]
  ): Promise<"yes" | "no" | "always"> {
    return new Promise((resolve) => {
      this.approval = { summary, secrets, resolve };
      this.requestRender();
    });
  }

  private onPickerKey(k: Key): void {    const p = this.picker!;
    const items = this.pickerSessions();
    const n = items.length;
    const q = p.query;

    switch (k.type) {
      // Clamp at the ends rather than wrapping. Wrapping from the last row to
      // the first is a silent jump to a different session: press Up at the top
      // (or Down at the bottom) and the highlight reappears on a row you did
      // not move to, so Enter opens something else. Stopping dead at the end
      // makes it obvious you have reached it.
      // While the help block is open the arrows scroll it rather than the
      // list: the block is what the reader is looking at, and moving the
      // highlight underneath it would change what Enter opens behind their
      // back. Esc closes the block and gives the keys back to the list.
      case "up":
        if (p.help) this.scrollPickerHelp(-1);
        else if (n > 0) p.index = Math.max(0, p.index - 1);
        this.requestRender();
        return;
      case "down":
        if (p.help) this.scrollPickerHelp(1);
        else if (n > 0) p.index = Math.min(n - 1, p.index + 1);
        this.requestRender();
        return;
      case "escape":
        // With the help reference open, Esc dismisses the help and returns to
        // the list rather than closing the picker: opening help was a detour
        // from picking a session, so the way back is to the list. A second Esc
        // then closes the picker as usual.
        if (p.help) {
          p.help = null;
        } else {
          this.picker = null;
        }
        this.requestRender();
        return;
      case "left":
        q.left();
        this.requestRender();
        return;
      case "right":
        q.right();
        this.requestRender();
        return;
      // Home/End jump the help block to its ends while it is open; otherwise
      // they move within the entry line, as before.
      case "home":
        if (p.help) p.helpTop = 0;
        else q.home();
        this.requestRender();
        return;
      case "end":
        if (p.help) this.scrollPickerHelp(Number.MAX_SAFE_INTEGER);
        else q.end();
        this.requestRender();
        return;
      case "backspace":
        q.backspace();
        this.clampPickerIndex();
        this.requestRender();
        return;
      case "delete":
        q.deleteForward();
        this.clampPickerIndex();
        this.requestRender();
        return;
      case "enter": {
        const text = q.value.trim();
        if (this.looksLikeCommand(text)) {
          // Slash input is a coda command, not the new session's first
          // message. Run it here, then close the picker and show the result
          // in the transcript -- otherwise "/help" would create a session
          // named after it and hand it to the model as a prompt.
          //
          // A command that did not run (an unknown one) leaves the picker
          // open, so the message is still on screen and can be corrected
          // instead of disappearing along with the overlay.
          // A command may decide the overlay should stay up (`/help` shows its
          // reference over the list), in which case `runSlashCommand` has left a
          // non-null `picker` holding the state to redraw, and the query has
          // already been cleared.
          const ran = this.runSlashCommand(text, true);
          if (ran) {
            if (!this.picker?.help) this.picker = null;
            q.clear();
          } else {
            q.home();
          }
          this.requestRender();
          return;
        }
        if (text) {
          // Typed something => start a brand-new session with it.
          this.startNewSessionWith(text);
        } else if (n > 0) {
          // Nothing typed => open the highlighted session. A session locked by
          // another terminal refuses the switch; keep the picker open so the
          // note (and the list) stay visible and another row can be chosen.
          //
          // `items[p.index]` is resolved here, at the keypress, not at the
          // render that drew the highlight -- the two can differ if the list
          // shrank between them. If the index no longer names a row, say so
          // rather than falling back to the first entry, which would open a
          // session the user never selected.
          const target = items[p.index];
          if (!target) {
            this.systemNote("that session is no longer in the list");
            this.clampPickerIndex();
            this.requestRender();
            return;
          }
          this.picker = null;
          void this.openSession(target).then((opened) => {
            if (!opened) {
              this.picker = { index: p.index, query: p.query, help: p.help, helpTop: p.helpTop };
              this.requestRender();
            }
          });
          this.requestRender();
          return;
        }
        this.picker = null;
        this.requestRender();
        return;
      }
      case "paste":
        q.insert(k.text.replace(/\r?\n/g, " "));
        this.clampPickerIndex();
        this.requestRender();
        return;
      case "alt": {
        if (k.ch === "b") q.wordLeft();
        else if (k.ch === "f") q.wordRight();
        else if (k.ch === "d") q.deleteWordRight();
        else if (k.ch === "r") {
          // Rename the highlighted session, not the active one: the list is
          // what you are looking at, and the chat view's Alt+R is one keypress
          // away for the session you already have open. The picker stays set
          // underneath the title editor -- it is what `fromPicker` restores on
          // Enter/Esc, so renaming never drops you into another session.
          if (n > 0) {
            this.startRename(items[p.index], true);
          }
        }
        this.requestRender();
        return;
      }
      case "char":
        // Every printable key is text for the new session's first message.
        //
        // It used to be that `d` and `r` on an empty prompt meant delete and
        // rename. Those were not commands any user could discover, and they
        // silently broke the one job the field has: typing "debug ..." armed a
        // delete confirmation, and typing "refactor ..." opened a rename editor
        // pre-filled with the highlighted session's title. The highlighted
        // title then appeared in the field as if it had been typed, and Enter
        // renamed that session instead of starting a new one. Since the query
        // never filters the list, a character can only ever be text here.
        // Rename is Alt+R and delete is Ctrl+X, in both this overlay and the
        // chat view -- modifier chords, so they never collide with typing.
        q.insert(k.ch);
        this.clampPickerIndex();
        this.requestRender();
        return;
      case "ctrl":
        if (k.ch === "c") this.quit();
        else if (k.ch === "a") { q.home(); this.requestRender(); }
        else if (k.ch === "e") { q.end(); this.requestRender(); }
        else if (k.ch === "u") { q.deleteToStart(); this.clampPickerIndex(); this.requestRender(); }
        else if (k.ch === "k") { q.deleteToEnd(); this.clampPickerIndex(); this.requestRender(); }
        else if (k.ch === "w") { q.deleteWordLeft(); this.clampPickerIndex(); this.requestRender(); }
        else if (k.ch === "x") {
          // Delete the highlighted session, not the active one. closeSession()
          // already refuses to kill a turn that is still running, so this is a
          // no-op on a "thinking" row rather than an error. Pass fromPicker so
          // the highlight follows the row that shifts into the deleted slot.
          if (n > 0) {
            this.closeSession(items[p.index], true);
            this.requestRender();
          }
        }
        else if (k.ch === "v") void this.pasteImageFromClipboard();
        return;
      default:
        // Scroll keys reach the help block when it is open, and otherwise keep
        // working over the overlay: the transcript is still drawn above the
        // picker, and a wheel notch or PgUp while the list is open should move
        // it rather than doing nothing at all.
        if (p.help) {
          if (k.type === "pageup") this.scrollPickerHelp(-this.pickerHelpPage());
          else if (k.type === "pagedown") this.scrollPickerHelp(this.pickerHelpPage());
          else if (k.type === "wheel") this.scrollPickerHelp(k.direction * 3);
          else return;
          this.requestRender();
          return;
        }
        if (k.type === "pageup") this.scrollPage(1);
        else if (k.type === "pagedown") this.scrollPage(-1);
        else if (k.type === "wheel") this.scrollBy(k.direction * 3);
        return;
    }
  }

  /**
   * Create a session and immediately send `text` as its first message.
   * `images` ride along with that first message (a screenshot attached with
   * `/image` or `/paste` and then sent on an empty session).
   */
  private startNewSessionWith(text: string, images: AttachedImage[] = []): void {
    // Belt and braces: slashes are commands. Every caller already checks, but
    // the one thing this method must never do is hand a command to the model
    // as a new session's opening prompt.
    if (this.looksLikeCommand(text.trim())) {
      this.runSlashCommand(text.trim());
      return;
    }
    this.pruneEmptySessions();
    const leaving = this.current();
    const session = new Session(this.config);
    this.sessions.push(session);
    this.setActive(session);
    if (leaving) void leaving.release();
    this.claimActive();
    this.input.clear();
    this.recall.reset();
    this.scrollToTail();
    if (session.status === "idle") {
      void session.run(
        text,
        () => this.requestRender(),
        images,
        (summary, secrets) => this.askApproval(summary, secrets),
        (name, label, hidden) => this.askSecretInput(name, label, hidden)
      ).then((res) => this.afterTurn(res))
        .catch(() => {});
    }
  }

  /**
   * React to a finished turn -- currently, the agent asking for a new session.
   *
   * This is the one place a `new_session` tool call becomes real. It has to be
   * the app: sessions are owned here, `Agent` has no terminal, and `runTool`
   * runs without one. The tool call itself only decided and asked; see
   * `Agent.openNewSession`.
   *
   * Like Ctrl+T, the old session is left alone rather than closed: the reason
   * the user wanted a new one might not work out, and Ctrl+X is still there if
   * they want it gone. `startNewSessionWith` would send the handover, so it is
   * not used -- the handover goes in the input unsent, to be reviewed.
   */
  private async afterTurn(res: { newSession?: { title?: string; preamble?: string } }): Promise<void> {
    this.requestRender();
    const req = res.newSession;
    if (!req) return;
    this.newSession();
    const fresh = this.current();
    if (req.title) void fresh.rename(req.title);
    if (req.preamble) {
      // Seeded into the new session's history rather than left in the input
      // box. The handover is context the new session needs, and only what is
      // in the messages is actually available to the model -- staged input
      // reaches nothing until the user presses Enter. Done once, here: from
      // then on it is ordinary history and is never rebuilt or re-read.
      await fresh.seedHandover(req.preamble);
    }
    this.scrollToTail();
    this.requestRender();
  }

  /**
   * Drop untouched placeholder sessions (no turns yet). Called before making a
   * new session so empty shells don't accumulate in the list.
   */
  private pruneEmptySessions(): void {
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const s = this.sessions[i];
      // A session created by `new_session` is seeded with its handover as a
      // real entry, so it is never empty and never reaches this branch.
      if (s.entries.length === 0 && s.status === "idle") {
        // An empty placeholder may still hold a lock (the startup session this
        // terminal began on). Drop it, or the session id stays locked until the
        // stale timeout even though the session is gone from this terminal.
        void s.release();
        this.sessions.splice(i, 1);
        // If that was the active session, `current()` would now be resolving a
        // missing id. Point the id at the last remaining session; if none is
        // left the caller is about to add one and set the id itself.
        if (s.id === this.activeId) {
          this.activeId = this.sessions[this.sessions.length - 1]?.id ?? null;
        }
      }
    }
  }

  /**
   * Take the lock for the session that just became active, for the paths that
   * switch directly rather than through `openSession` (startup, a new session).
   *
   * Best-effort: the caller has already made the session active, so a failure
   * here cannot undo the switch. For a brand-new session this only fails on a
   * UUID collision or a stale lock file, and the note explains which.
   */
  private claimActive(): void {
    const s = this.current();
    void s.acquire().then((res) => {
      if (!res.ok) {
        this.systemNote(
          `session "${s.title}" is open in another terminal (${res.heldBy})`
        );
      }
    });
  }

  /**
   * Switch to `session`, taking its lock first.
   *
   * The lock is taken when a session becomes active, not when it is merely
   * listed: a terminal that is only showing the picker should not lock every
   * session away from other terminals. Switching away releases the lock on the
   * session being left, so the same session can be opened elsewhere.
   *
   * If the target is locked by another live coda, refuse the switch and say who
   * has it, leaving the user where they were rather than silently opening a
   * session that two processes would then fight over.
   */
  private async openSession(session: Session): Promise<boolean> {
    if (session === this.current() && session.lockHeld) {
      return true;
    }
    // Switch to the session *before* awaiting the lock. The await yields to the
    // event loop, and a refresh triggered by opening the picker can run in that
    // gap and mutate `sessions`; leaving the active id set only afterwards meant
    // the frame drawn in the meantime showed the old session. Setting it first
    // makes the picked session the active one immediately, whatever the refresh
    // does next -- and because it is an id, the refresh cannot invalidate it.
    const leaving = this.current();
    this.setActive(session);
    this.input.clear();
    this.recall.reset();
    this.scrollToTail();
    this.requestRender();

    const res = await session.acquire();
    if (!res.ok) {
      // Could not take the lock: put the user back where they were rather than
      // leaving them in a session another terminal owns.
      //
      // The note goes to the transcript, which is right when this happens in
      // the chat view -- but the picker covers the transcript, so the picker
      // also marks the row itself (see `RenderState.picker.items[].locked`).
      // The marker is what makes a refusal visible when it happens *in* the
      // picker; this note is for the case where the chat view is showing.
      this.systemNote(
        `session "${session.title}" is open in another terminal (${res.heldBy}); ` +
          `close it there, or wait for it to go stale`
      );
      // Reflect the refusal in the picker immediately: `acquire` has just
      // read the lock, so the marker can be set without another probe.
      this.heldByOther.set(session.id, res.heldBy);
      if (leaving) this.setActive(leaving);
      this.requestRender();
      return false;
    }
    // Release the lock on the session we are leaving, now that we hold the new
    // one.
    if (leaving && leaving !== session) void leaving.release();
    return true;
  }

  /**
   * Delete a session by reference, keeping indices valid.
   *
   * `fromPicker` tells the clamp that the picker list just shrank, so the
   * highlight should follow the row that moved into the deleted one's place
   * rather than staying on the same numeric index.
   */
  private closeSession(session: Session, fromPicker = false): void {
    if (session.status === "thinking") return; // don't kill a running turn
    const idx = this.sessions.indexOf(session);
    if (idx === -1) return;
    const wasActive = session.id === this.activeId;
    void session.delete(); // also releases its lock
    this.sessions.splice(idx, 1);
    if (this.sessions.length === 0) this.sessions.push(new Session(this.config));
    // Closing the session you were on makes another session active. Point the
    // id at it (the array has shrunk, so an index would be meaningless) and take
    // its lock, or this terminal would work in a session it does not hold.
    if (wasActive) {
      this.setActive(this.sessions[Math.min(idx, this.sessions.length - 1)]);
      this.claimActive();
    }
    this.clampPickerIndex(fromPicker);
  }

  private onChatKey(k: Key): void {
    const b = this.input;
    switch (k.type) {
      // ← opens the picker only when the input is empty; otherwise it edits.
      case "left":
        if (b.value === "") this.openPicker();
        else { b.left(); this.requestRender(); }
        return;
      case "ctrl":
        if (k.ch === "c") this.quit();
        else if (k.ch === "t") this.newSession();
        else if (k.ch === "x") this.closeActive();
        else if (k.ch === "r") this.openPicker();
        else if (k.ch === "a") { b.home(); this.requestRender(); }
        else if (k.ch === "e") { b.end(); this.requestRender(); }
        else if (k.ch === "u") { b.deleteToStart(); this.requestRender(); }
        else if (k.ch === "k") { b.deleteToEnd(); this.requestRender(); }
        else if (k.ch === "w") { b.deleteWordLeft(); this.requestRender(); }
        else if (k.ch === "v") void this.pasteImageFromClipboard();
        // Ctrl+E is end-of-line, so renaming lives on Alt+R: it acts on the
        // whole session rather than the line, and the picker's own `r` is gone.
        return;
      case "alt":
        if (k.ch === "b") { b.wordLeft(); this.requestRender(); }
        else if (k.ch === "f") { b.wordRight(); this.requestRender(); }
        else if (k.ch === "d") { b.deleteWordRight(); this.requestRender(); }
        else if (k.ch === "r") this.startRename(this.current());
        return;
      case "escape":
        b.clear();
        // Abandoning the line also ends the walk, so a later ↑ starts from
        // an empty draft rather than resurrecting the one just discarded.
        this.recall.reset();
        this.requestRender();
        return;
      case "right":
        b.right();
        this.requestRender();
        return;
      case "home":
        b.home();
        this.requestRender();
        return;
      case "end":
        // While scrolled back into history, End returns to the tail -- which is
        // what the status bar hint has always promised. Otherwise it is the
        // ordinary end-of-line key.
        if (this.scroll > 0) {
          this.scrollToTail();
          this.requestRender();
          return;
        }
        b.end();
        this.requestRender();
        return;
      case "backspace":
        b.backspace();
        this.requestRender();
        return;
      case "delete":
        b.deleteForward();
        this.requestRender();
        return;
      // ↑/↓ are prompt recall, not transcript scrolling: they walk back
      // through the messages already sent in this session and edit what they
      // bring up. Reading the transcript is PgUp/PgDn (and the wheel), which
      // do the whole page at a time and are left where they were.
      case "up":
        this.recallUp();
        return;
      case "down":
        this.recallDown();
        return;
      case "pageup":
        this.scrollPage(1);
        return;
      case "pagedown":
        this.scrollPage(-1);
        return;
      // The mouse wheel reports one event per notch; three lines per notch is
      // the usual terminal pace and keeps a long transcript quick to traverse.
      case "wheel":
        this.scrollBy(k.direction * 3);
        return;
      case "enter":
        this.submit();
        return;
      case "paste":
        b.insert(k.text.replace(/\r?\n/g, " "));
        this.requestRender();
        return;
      case "char":
        b.insert(k.ch);
        this.requestRender();
        return;
    }
  }

  /** Attach a screenshot to the next message; errors are shown in the transcript. */
  private async attachImage(p: string): Promise<void> {
    if (!p) {
      this.systemNote("usage: /image <path>   (attach a screenshot to your next message)");
      return;
    }
    try {
      const img = await attachImage(p);
      this.pendingImages.push(img);
      // Small images would otherwise round to "0 KB".
      const kb = img.bytes < 1024
        ? `${img.bytes} bytes`
        : `${Math.round(img.bytes / 1024)} KB`;
      this.systemNote(`attached ${img.path} (${img.mime}, ${kb}) — send your message when ready`);
    } catch (err: any) {
      this.systemNote(err instanceof ImageError ? err.message : `could not attach ${p}: ${err?.message ?? err}`);
    }
  }

  /**
   * Ctrl+V: attach the clipboard image, but only when the clipboard holds an
   * image and no text.
   *
   * A clipboard can hold both at once (a chart copied from Excel, an image with
   * a URL attached), and hijacking Ctrl+V there would swallow an ordinary text
   * paste. When text is present this does nothing and the terminal's own paste
   * binding (Ctrl+Shift+V in Windows Terminal) is left to handle it.
   */
  private async pasteImageFromClipboard(): Promise<void> {
    const contents = await clipboardContents();
    if (!contents) return; // not WSL / no PowerShell: stay out of the way
    if (contents.image && !contents.text) {
      await this.pasteFromClipboard();
    }
  }

  /** Attach whatever image is on the Windows clipboard. */
  private async pasteFromClipboard(): Promise<void> {
    this.systemNote("reading image from clipboard…");
    const p = await clipboardImagePath();
    if (!p) {
      this.systemNote(
        "no image on the clipboard (or PowerShell is unavailable). " +
          "Copy a screenshot, or use /image <path>."
      );
      return;
    }
    try {
      const img = await attachImage(p);
      this.pendingImages.push(img);
      this.systemNote(`attached clipboard image (${img.mime}, ${(img.bytes / 1024).toFixed(1)} KB) — send your message when ready`);
    } catch (err: any) {
      this.systemNote(err instanceof ImageError ? err.message : `could not attach clipboard image: ${err?.message ?? err}`);
    }
  }

  /** Print the command reference into the transcript. */
  /** The command and key reference, shared by `/help` and the picker overlay. */
  private helpLines(): string[] {
    return [
        "Commands:",
        "  /help, /?           Show this list",
        "  /quit, /exit        Exit and save sessions (same as quit / exit, or Ctrl+C)",
        "  /paste              Attach the image on the Windows clipboard (WSL)",
        "  /image <path>       Attach an image file to your next message",
        "  /rename <title>     Rename the current session (no title: edit it interactively)",
        "  /model              Choose this session's text and image model",
        "  /secret <add|list|remove>  Manage the credentials vault (values entered hidden)",
        "  /instructions       Show standing instructions and where they are read from",
        "  /prune-images       Delete cached screenshots no session refers to",
        "",
        "Keys:",
        "  Enter               Send the line (mid-turn, fold it into the running turn)",
        "  ←                   Empty input: open session picker",
        "  Ctrl+R              Open the session picker",
        "  Ctrl+T / Ctrl+X     New session / close current session",
        "                      (the agent can also ask to open one, with a name and handover)",
        "  Alt+R               Rename the current session",
        "  In the picker:  ↑/↓ move · Enter open · Ctrl+X delete · Alt+R rename",
        "  Ctrl+V              Attach a clipboard image (image-only clipboard)",
        "  ↑ / ↓               Recall a previous prompt (edits in place; ↓ back to the draft)",
        "  PgUp / PgDn         Scroll the transcript a page · wheel also scrolls",
        "  End                 While scrolled back, return to the newest output",
        "  Ctrl+C              Exit",
    ];
  }

  private showHelp(): void {
    this.systemNote(this.helpLines().join("\n"));
  }

  /**
   * Report a line that starts with `/` but is not a known command. The text is
   * left in the input so it can be corrected (or clear it with Esc) rather than
   * being fired off to the model as a prompt.
   */
  private unknownCommand(text: string): void {
    const name = text.split(/\s+/)[0];
    this.systemNote(
      `unknown command: ${name}   (type /help for the list)`
    );
    this.requestRender();
  }

  /** Append a local, informational line to the current transcript. */
  private systemNote(text: string): void {
    // Redacted on the way in: a note is transcript text, it is saved to the
    // session file, and it is re-sent to the model as history. Scrubbing here
    // covers every note, including ones built from a command's output.
    this.current().entries.push({ role: "tool", name: "coda", ok: true, text: redact(text) });
    // The note lands at the tail. If the reader has deliberately scrolled back
    // into history, leave their offset alone: a note arriving (an attachment, a
    // status message) should not yank the transcript out from under them.
    this.requestRender();
  }

  /**
   * Return the view to the tail of the transcript.
   *
   * Clears the anchored line index as well as the offset: the two are kept in
   * step by hand, and leaving a stale anchor behind pins the view in history
   * after an action that was meant to bring it back.
   */
  private scrollToTail(): void {
    this.scroll = 0;
    this.scrollTop = -1;
  }

  /**
   * The prompts from this session that ↑/↓ can walk back through, newest
   * first, each paired with the paths of the images it was sent with.
   *
   * Built from the session's transcript on every keypress rather than kept in
   * a list of its own. The transcript is what the user saw go out, it is
   * already saved and restored with the session, and rebuilding it costs
   * nothing next to a keystroke -- whereas a parallel list would have to be
   * appended to on every send path (a new session, the picker, a steer) and
   * could quietly drift out of step.
   *
   * Two things are left out. Slash commands never became prompts, so recalling
   * `/model` with ↑ would put a command in the input dressed up as a message.
   * Mid-turn steers are prefixed in the transcript with `(mid-turn)` -- a label
   * for the reader, not part of what was typed -- so it is stripped off.
   *
   * `Session.run` writes the attachments into the entry as `[image: <path>]`
   * labels, which is the one place the transcript still remembers them. They
   * are read back out so a recalled prompt is not silently restored as the
   * same words with the screenshot quietly dropped. Paths, not `AttachedImage`
   * objects: the bytes are re-read from the cached copy on restore, which is
   * what `attachImage` expects anyway.
   */
  private recallItems(): RecalledPrompt<string>[] {
    const items: RecalledPrompt<string>[] = [];
    for (const e of this.current().entries) {
      if (e.role !== "user") continue;
      const text = e.text.replace(/^\(mid-turn\) /, "");
      if (!text.trim() || text.startsWith("/")) continue;
      items.push({ text, images: imagePathsInText(text) });
    }
    return items.reverse();
  }

  /** ↑: recall the previous prompt into the input. */
  private recallUp(): void {
    this.recall.setItems(this.recallItems());
    const next = this.recall.up(this.input.value, this.input.cursor);
    if (!next) {
      // At the oldest prompt. Say so rather than doing nothing silently: a key
      // that appears broken is worse than one that explains itself.
      if (this.recall.active) this.systemNote("oldest prompt in this session");
      return;
    }
    this.restoreRecalled(next);
  }

  /** ↓: come forward again, past the newest prompt to the draft. */
  private recallDown(): void {
    if (!this.recall.active) return; // a fresh draft: nothing to walk out of
    this.recall.setItems(this.recallItems());
    const next = this.recall.down(this.input.value);
    if (!next) return;
    this.restoreRecalled(next);
  }

  /**
   * Put a recalled prompt in the input, replacing whatever is there.
   *
   * The staged attachments are replaced, not merged: the recalled message is
   * the whole message, and a screenshot left over from the draft would go out
   * with a prompt it was never meant to accompany.
   *
   * Re-attaching is asynchronous -- the bytes come off the image cache -- but
   * the text is not made to wait on it. A keypress that did not paint until a
   * multi-megabyte screenshot had been read would feel stuck, and the image
   * only has to be in place by the time Enter is pressed.
   */
  private restoreRecalled(p: { text: string; cursor: number; images: string[] }): void {
    this.input.set(p.text, p.cursor);
    this.pendingImages = [];
    this.requestRender();
    if (!p.images.length) return;
    // Tagged with the text they belong to. Recall can run again before the
    // read finishes (a fast ↑↑, or ↓ back to the draft), and the late result
    // must not land on whatever is in the input by then.
    const forText = p.text;
    void Promise.all(p.images.map((path) => attachImage(path).catch(() => null)))
      .then((loaded) => {
        if (this.input.value !== forText) return;
        this.pendingImages = loaded.filter((i): i is AttachedImage => i !== null);
        this.requestRender();
      })
      .catch(() => {});
  }

  private scrollBy(delta: number): void {
    const lines = this.screen.totalLines;
    const maxOffset = Math.max(0, lines - this.screen.viewportRowsForInput(this.input.value));
    // While anchored, `scroll` is only a record of the last offset and goes
    // stale as a reply appends lines -- the anchor is the source of truth. Work
    // from the frame that was actually drawn so one keypress moves one line,
    // whatever has arrived since the reader last scrolled.
    const from = this.scrollTop >= 0 ? Math.max(0, lines - this.scrollTop) : this.scroll;
    this.scroll = Math.max(0, Math.min(from + delta, maxOffset));
    // Scrolling is the moment the reader picks a position, so the anchor is
    // recomputed from the offset just chosen.
    this.scrollTop = this.scroll === 0 ? -1 : Math.max(0, lines - this.scroll);
    this.requestRender();
  }

  /** Jump the transcript by a screenful. */
  private scrollPage(direction: 1 | -1): void {
    this.scrollBy(direction * Math.max(1, this.screen.viewportRowsForInput(this.input.value) - 1));
  }

  private openPicker(): void {
    // Highlight the session you are in. The index must be found in the *sorted*
    // picker list, since that is what `picker.index` counts against -- looking
    // it up in `this.sessions` (whose order differs) put the highlight on the
    // wrong row.
    const cur = this.current();
    const idx = this.pickerSessions().findIndex((s) => s.id === cur.id);
    this.picker = {
      index: Math.max(0, idx),
      query: new LineBuffer(),
      help: null,
      helpTop: 0,
    };
    // A reopened picker starts at the top of the list; the window otherwise
    // keeps wherever the last one was scrolled to.
    this.screen.resetPickerWindow();
    void this.refreshLockHolders();
    this.requestRender();
    // Pull in changes made by other terminals. The picker is already on screen
    // with the list we have, so the refresh lands as a second frame rather than
    // making the key feel slow on a large sessions directory.
    void this.refreshSessionsFromDisk();
  }

  /**
   * Reconcile the in-memory session list with the sessions directory, so work
   * done in another terminal -- a new session, a rename, a deleted session --
   * is reflected in the picker.
   *
   * Three things happen, all by session id:
   *
   *  - **Drop** sessions whose file is gone (deleted in another terminal). A
   *    session that is still `thinking` here is kept: its turn owns the
   *    transcript and will persist on completion, which re-creates the file.
   *  - **Update** idle sessions whose on-disk record is newer than the copy in
   *    memory (renamed or advanced elsewhere). A running session is left alone
   *    for the same reason as above.
   *  - **Add** records we have never seen, so a session started elsewhere shows
   *    up.
   *
   * Updates are last-writer-wins for two terminals that hold the same session
   * without locking (a lock that was stolen after going stale). With the
   * advisory lock in place a second terminal cannot open a session another one
   * holds, so this path normally only sees sessions nobody is driving.
   */
  private async refreshSessionsFromDisk(): Promise<void> {
    let records: SessionRecord[];
    try {
      records = await loadAll();
    } catch {
      return; // unreadable directory: keep the list we have
    }

    const byId = new Map(this.sessions.map((s) => [s.id, s]));
    const onDisk = new Set(records.map((r) => r.id));

    // Remember what the user is looking at *by id*, not by index. Rows are
    // about to appear and disappear, so an index remembered across the
    // reconcile would land on whichever session happens to inherit that row
    // number -- for the picker highlight that meant the selection silently
    // jumping to a different session after a refresh.
    const activeIdBefore = this.current()?.id;
    // Index into the *sorted* picker list, which is what `picker.index` counts
    // against -- not `this.sessions`, whose order differs (see pickerSessions).
    const highlightedIdBefore = this.picker
      ? this.pickerSessions()[this.picker.index]?.id
      : undefined;

    // Drop sessions that vanished from disk, keeping any that are mid-turn.
    // A session this terminal has never managed to save has no file yet, so it
    // is absent from `onDisk` for a reason that is not deletion and must
    // survive -- testing "has no entries" used to stand in for that, until a
    // note from `/help` gave a fresh session an entry and it was dropped.
    const kept = this.sessions.filter(
      (s) => onDisk.has(s.id) || s.status === "thinking" || !s.persisted
    );
    const removedCount = this.sessions.length - kept.length;
    if (removedCount > 0) {
      // Sessions dropped here were deleted in another terminal, so they are no
      // longer ours to hold: release any lock this terminal had on them rather
      // than leaving the id locked until the stale timeout.
      const dropped = this.sessions.filter((s) => !kept.includes(s));
      for (const s of dropped) void s.release();
      this.sessions = kept;
      // Keep the active session if it survived; otherwise fall back to the end.
      const stillThere = this.sessions.some((s) => s.id === activeIdBefore);
      if (!stillThere) {
        this.setActive(this.sessions[this.sessions.length - 1]);
      }
    }

    // Update existing sessions and add the ones we have not seen. A record is
    // newer only if its updatedAt moved forward; equal stamps mean nothing
    // changed, and an older stamp means our copy is ahead (we have not written
    // it yet), so neither is adopted.
    for (const rec of records) {
      const existing = byId.get(rec.id);
      if (existing) {
        if (existing.status === "idle" && rec.updatedAt > existing.updatedAt) {
          existing.adopt(rec);
        }
      } else {
        this.sessions.push(new Session(this.config, rec));
      }
    }

    // A refresh can shrink, grow or reorder the list under the picker.
    // Re-anchor the highlight to the same session it was on (now at a possibly
    // different row in the sorted list), and only fall back to clamping when
    // that session was itself removed.
    if (this.picker) {
      const p = this.picker;
      const moved = highlightedIdBefore
        ? this.pickerSessions().findIndex((s) => s.id === highlightedIdBefore)
        : -1;
      if (moved >= 0) p.index = moved;
      this.clampPickerIndex();
    }
    void this.refreshLockHolders();
    this.requestRender();
  }

  /**
   * Refresh the "locked by another terminal" markers the picker draws.
   *
   * `render()` is synchronous, so it cannot probe the lock files itself; this
   * fills the cache it reads. Only sessions whose lock this terminal does not
   * already hold are probed -- the rest are openable by definition.
   *
   * A stale lock is reported as unlocked (see `lockHolder`), because `acquire`
   * would steal it: saying "locked" there would send the user looking for a
   * process that no longer exists.
   */
  private async refreshLockHolders(): Promise<void> {
    const next = new Map<string, string>();
    await Promise.all(
      this.sessions
        .filter((s) => !s.lockHeld)
        .map(async (s) => {
          const holder = await lockHolder(s.id).catch(() => null);
          if (holder) next.set(s.id, holder);
        })
    );
    this.heldByOther = next;
    this.requestRender();
  }

  private newSession(): void {
    this.pruneEmptySessions();
    const leaving = this.current();
    const fresh = new Session(this.config);
    this.sessions.push(fresh);
    this.setActive(fresh);
    if (leaving) void leaving.release();
    this.claimActive();
    this.input.clear();
    this.recall.reset();
    this.scrollToTail();
    this.requestRender();
  }

  private closeActive(): void {
    this.closeSession(this.current());
    this.input.clear();
    this.recall.reset();
    this.scrollToTail();
    this.requestRender();
  }

  /**
   * True for any line that is a command rather than a prompt: it begins with
   * "/" (with something after it).
   *
   * A lone "/" is exempt. That is plausibly the start of a pasted absolute
   * path, or of prose the user meant to send, so it stays a prompt.
   *
   * Every path that turns typed text into a message must consult this. Slash
   * input is a coda command, and must never reach the model as a prompt or be
   * used to name a new session.
   */
  private looksLikeCommand(text: string): boolean {
    return text.startsWith("/") && text.length > 1;
  }

  private submit(): void {
    const text = this.input.value.trim();
    if (!text) return;

    // Slash input is always a command, never a prompt.
    if (this.looksLikeCommand(text)) {
      this.runSlashCommand(text);
      return;
    }

    // The bare words are the long-standing spelling of /quit and /exit.
    if (text === "exit" || text === "quit") {
      this.quit();
      return;
    }

    const session = this.current();
    if (session.status === "thinking") {
      // A turn is running: hand the text to it rather than dropping it. It
      // rides along with the next request the agent sends, which for a turn
      // running tools is only moments away.
      session.steer(text);
      this.input.clear();
      this.recall.reset();
      this.scrollToTail();
      this.requestRender();
      return;
    }

    // If the active session is still the untouched placeholder, this text
    // starts a fresh session rather than living in an empty one.
    const images = this.pendingImages;
    this.pendingImages = [];

    // A session holding a seeded handover has no entries either -- the handover
    // is history, not transcript, so it is never drawn -- but it is not an
    // untouched placeholder. Sending it to `startNewSessionWith` would open a
    // second session and hand it the user's prompt as its first message,
    // silently dropping the handover along the way. `seeded` distinguishes the
    // two; the prompt belongs in this session, so run it here.
    if (session.entries.length === 0 && !session.seeded) {
      // startNewSessionWith runs the turn; hand it the attachments so the
      // image rides along with the first message rather than being lost --
      // and so the turn is started once, not once here and once below.
      this.startNewSessionWith(text, images);
    } else {
      this.input.clear();
      this.recall.reset();
      this.scrollToTail(); // jump back to the tail so you see the reply
      void session.run(
        text,
        () => this.requestRender(),
        images,
        (summary, secrets) => this.askApproval(summary, secrets),
        (name, label, hidden) => this.askSecretInput(name, label, hidden)
      ).then((res) => this.afterTurn(res))
        .catch(() => {});
    }
    this.requestRender();
  }

  /**
   * Run a slash command. Called with text already known to start with "/",
   * from the chat input and from the session picker alike.
   */
  private runSlashCommand(text: string, fromPicker = false): boolean {
    // Commands run from the picker must not clear the chat input: the text in
    // it belongs to the session behind the overlay (a half-typed draft), not
    // to the command line the command was typed on. `clrInput` therefore only
    // clears when the command came from the chat input itself.
    const clrInput = () => {
      if (fromPicker) return;
      this.input.clear();
      this.recall.reset();
    };
    // `/image <path>` attaches a screenshot to the next message instead of
    // sending it. Images cannot travel through a tool result, so they are
    // attached to the user message itself.
    // `/paste` pulls an image straight off the Windows clipboard. Windows
    // Terminal cannot hand image data to a program through the paste stream,
    // so the clipboard is read from the Windows side instead.
    // `/help` asked from the picker is shown over the list rather than closing
    // it: the reason for opening the picker (finding a session) is still live,
    // and dropping the overlay lost the highlighted row. From the chat input it
    // still lands in the transcript.
    if (text === "/help" || text === "/?") {
      clrInput();
      if (fromPicker && this.picker) {
        this.picker.help = this.helpLines();
        this.picker.helpTop = 0;
        this.picker.query.clear();
      } else {
        this.showHelp();
      }
      return true;
    }
    if (text === "/paste") {
      clrInput();
      void this.pasteFromClipboard();
      return true;
    }
    // `/image <path>` — match the command word only, so `/imagefoo` is not
    // swallowed as an `/image` command with argument "foo".
    if (text === "/image" || text.startsWith("/image ")) {
      const arg = text.slice("/image".length).trim();
      clrInput();
      void this.attachImage(arg);
      return true;
    }
    // `/rename <title>` renames the current session outright. `/rename` alone
    // opens the interactive title editor instead (same as Alt+R), so the title
    // can be edited in place rather than retyped from scratch.
    if (text === "/rename" || text.startsWith("/rename ")) {
      const title = text.slice("/rename".length).trim();
      clrInput();
      if (title) void this.current().rename(title);
      else this.startRename(this.current());
      this.requestRender();
      return true;
    }
    // `/prune-images` sweeps the image cache by hand. The same sweep runs at
    // startup, so this is for when the user wants to reclaim space without
    // restarting, or to see what it did.
    if (text === "/prune-images") {
      clrInput();
      void this.pruneImages();
      return true;
    }
    if (text === "/model") {
      clrInput();
      void this.openModelPicker();
      return true;
    }
    // `/instructions` shows the standing instructions in force and where they
    // live. Editing is deliberately not offered: these are the user's rules,
    // and a tool that rewrites its own instructions can change its own limits.
    if (text === "/instructions") {
      clrInput();
      this.showInstructions();
      return true;
    }
    // `/secret` manages credentials. The value is always entered at a masked
    // prompt, never as an argument: an argument would be echoed into the
    // input line, kept in the session's transcript, and saved to disk.
    if (text === "/secret" || text.startsWith("/secret ")) {
      const arg = text.slice("/secret".length).trim();
      clrInput();
      this.handleSecretCommand(arg);
      return true;
    }
    if (text === "/quit" || text === "/exit") {
      this.quit();
      return true;
    }
    // Anything else beginning with "/" is a mistyped or unsupported command.
    // Sending it to the model as a prompt is never what was intended, so we
    // say so rather than guessing at the intent.
    this.unknownCommand(text);
    return false;
  }

  /**
   * Sweep the image cache from the command line.
   *
   * References come from the sessions this terminal knows about, which is the
   * same set the startup sweep uses. A session open in another terminal that
   * has an unsaved attachment would not be counted -- but such an image is
   * still inside the prune's age guard, so it is not at risk.
   */
  private async pruneImages(): Promise<void> {
    // References come from the chat histories, not the transcript `entries`:
    // the `[image: ...]` markers live in message content, and a session open in
    // this terminal has not been persisted yet, so the file on disk may be
    // stale. In-memory sessions first, then whatever else is on disk.
    const referenced = new Set<string>();
    for (const s of this.sessions) {
      for (const p of imagePathsIn(s.toRecord().messages as any)) referenced.add(p);
    }
    for (const rec of await loadAll().catch(() => [])) {
      for (const p of imagePathsIn(rec.messages as any)) referenced.add(p);
    }
    this.systemNote("sweeping the image cache…");
    const removed = await pruneImageCache(referenced).catch(() => []);
    this.systemNote(
      removed.length === 0
        ? "image cache: nothing to remove"
        : `image cache: removed ${removed.length} unused image${removed.length === 1 ? "" : "s"}`
    );
  }

  private quit(): void {
    if (this.quitting) return;
    this.quitting = true;
    this.screen.stop();
    this.keys.stop();
    // Give any in-flight saves a moment to land before exiting, and drop the
    // locks we hold so the sessions can be opened in another terminal at once
    // rather than waiting out the stale timeout.
    Promise.all(
      this.sessions.map((s) =>
        Promise.all([s.persist().catch(() => {}), s.release()]).catch(() => {})
      )
    ).finally(() => process.exit(0));
    // Safety net in case a save or release hangs.
    setTimeout(() => process.exit(0), 500).unref();
  }
}
