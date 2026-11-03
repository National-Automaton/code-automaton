import { Config } from "./config.js";
import { Key, KeyReader } from "./keys.js";
import { LineBuffer } from "./linebuffer.js";
import { Screen, PickerItem } from "./screen.js";
import { Session } from "./session.js";
import { loadAll } from "./store.js";
import type { SessionRecord } from "./store.js";
import { attachImage, clipboardContents, clipboardImagePath, ImageError } from "./image.js";
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
  /** Picker state: highlighted row and the "start a new session" field. */
  private picker: { index: number; query: LineBuffer } | null = null;
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
  /** Lines scrolled back from the tail of the transcript. */
  private scroll = 0;
  private screen: Screen;
  private keys = new KeyReader();
  private quitting = false;
  /** Images attached with /image, waiting to ride along with the next message. */
  private pendingImages: AttachedImage[] = [];
  private renderQueued = false;

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
    });
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
    if (this.rename) this.onRenameKey(k);
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

  private onPickerKey(k: Key): void {
    const p = this.picker!;
    const items = this.pickerSessions();
    const n = items.length;
    const q = p.query;

    switch (k.type) {
      // Clamp at the ends rather than wrapping. Wrapping from the last row to
      // the first is a silent jump to a different session: press Up at the top
      // (or Down at the bottom) and the highlight reappears on a row you did
      // not move to, so Enter opens something else. Stopping dead at the end
      // makes it obvious you have reached it.
      case "up":
        if (n > 0) p.index = Math.max(0, p.index - 1);
        this.requestRender();
        return;
      case "down":
        if (n > 0) p.index = Math.min(n - 1, p.index + 1);
        this.requestRender();
        return;
      case "escape":
        this.picker = null;
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
      case "home":
        q.home();
        this.requestRender();
        return;
      case "end":
        q.end();
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
          const ran = this.runSlashCommand(text, true);
          if (ran) {
            this.picker = null;
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
              this.picker = { index: p.index, query: p.query };
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
        // Scroll keys keep working over the overlay: the transcript is still
        // drawn above the picker, and a wheel notch or PgUp while the list is
        // open should move it rather than doing nothing at all.
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
    this.scroll = 0;
    if (session.status === "idle") {
      void session.run(text, () => this.requestRender(), images);
    }
  }

  /**
   * Drop untouched placeholder sessions (no turns yet). Called before making a
   * new session so empty shells don't accumulate in the list.
   */
  private pruneEmptySessions(): void {
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const s = this.sessions[i];
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
    this.scroll = 0;
    this.requestRender();

    const res = await session.acquire();
    if (!res.ok) {
      // Could not take the lock: put the user back where they were rather than
      // leaving them in a session another terminal owns.
      this.systemNote(
        `session "${session.title}" is open in another terminal (${res.heldBy}); ` +
          `close it there, or wait for it to go stale`
      );
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
          this.scroll = 0;
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
      case "up":
        this.scrollBy(1);
        return;
      case "down":
        this.scrollBy(-1);
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
  private showHelp(): void {
    this.systemNote(
      [
        "Commands:",
        "  /help, /?           Show this list",
        "  /quit, /exit        Exit and save sessions (same as quit / exit, or Ctrl+C)",
        "  /paste              Attach the image on the Windows clipboard (WSL)",
        "  /image <path>       Attach an image file to your next message",
        "  /rename <title>     Rename the current session (no title: edit it interactively)",
        "",
        "Keys:",
        "  Enter               Send the line (mid-turn, fold it into the running turn)",
        "  ←                   Empty input: open session picker",
        "  Ctrl+R              Open the session picker",
        "  Ctrl+T / Ctrl+X     New session / close current session",
        "  Alt+R               Rename the current session",
        "  In the picker:  ↑/↓ move · Enter open · Ctrl+X delete · Alt+R rename",
        "  Ctrl+V              Attach a clipboard image (image-only clipboard)",
        "  ↑ / ↓  PgUp / PgDn  Scroll transcript · End returns to the newest output",
        "  Ctrl+C              Exit",
      ].join("\n")
    );
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
    this.current().entries.push({ role: "tool", name: "coda", ok: true, text });
    // The note lands at the tail. If the reader has deliberately scrolled back
    // into history, leave their offset alone: a note arriving (an attachment, a
    // status message) should not yank the transcript out from under them.
    this.requestRender();
  }

  /** Scroll the transcript by `delta` lines (positive = back in history). */
  private scrollBy(delta: number): void {
    const maxOffset = Math.max(
      0,
      this.screen.totalLines - this.screen.viewportRowsForInput(this.input.value)
    );
    this.scroll = Math.max(0, Math.min(this.scroll + delta, maxOffset));
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
    };
    // A reopened picker starts at the top of the list; the window otherwise
    // keeps wherever the last one was scrolled to.
    this.screen.resetPickerWindow();
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
    // pruneEmptySessions keeps placeholders that have no file at all, so those
    // (never persisted, so never in `onDisk`) must survive too.
    const kept = this.sessions.filter(
      (s) => onDisk.has(s.id) || s.status === "thinking" || s.entries.length === 0
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
    this.scroll = 0;
    this.requestRender();
  }

  private closeActive(): void {
    this.closeSession(this.current());
    this.input.clear();
    this.scroll = 0;
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
      this.scroll = 0;
      this.requestRender();
      return;
    }

    // If the active session is still the untouched placeholder, this text
    // starts a fresh session rather than living in an empty one.
    const images = this.pendingImages;
    this.pendingImages = [];

    if (session.entries.length === 0) {
      // startNewSessionWith runs the turn; hand it the attachments so the
      // image rides along with the first message rather than being lost --
      // and so the turn is started once, not once here and once below.
      this.startNewSessionWith(text, images);
    } else {
      this.input.clear();
      this.scroll = 0; // jump back to the tail so you see the reply
      void session.run(text, () => this.requestRender(), images);
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
      if (!fromPicker) this.input.clear();
    };
    // `/image <path>` attaches a screenshot to the next message instead of
    // sending it. Images cannot travel through a tool result, so they are
    // attached to the user message itself.
    // `/paste` pulls an image straight off the Windows clipboard. Windows
    // Terminal cannot hand image data to a program through the paste stream,
    // so the clipboard is read from the Windows side instead.
    if (text === "/help" || text === "/?") {
      clrInput();
      this.showHelp();
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
