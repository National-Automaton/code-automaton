import { Config } from "./config.js";
import { Key, KeyReader } from "./keys.js";
import { LineBuffer } from "./linebuffer.js";
import { Screen, PickerItem } from "./screen.js";
import { Session } from "./session.js";
import { loadAll } from "./store.js";
import { attachImage, clipboardContents, clipboardImagePath, ImageError } from "./image.js";
import type { AttachedImage } from "./image.js";

/**
 * Owns the whole TUI: the list of live sessions, which one is active, and the
 * picker overlay. Left-arrow (or Ctrl+R / /resume) opens the picker without
 * leaving the running app, so several sessions stay live at once.
 */
export class App {
  private sessions: Session[] = [];
  private active = 0;
  private input = new LineBuffer();
  /**
   * Picker state. `confirmDelete` holds the id of the session awaiting a
   * delete confirmation, so a stray `d` can't destroy a session. `rename` is
   * non-null while a title is being edited: it holds the target session and
   * the edit buffer, which starts pre-filled with the current title.
   */
  private picker: {
    index: number;
    query: LineBuffer;
    confirmDelete: string | null;
    rename: { id: string; buffer: LineBuffer } | null;
  } | null = null;
  /** Lines scrolled back from the tail of the transcript. */
  private scroll = 0;
  private screen = new Screen();
  private keys = new KeyReader();
  private quitting = false;
  /** Images attached with /image, waiting to ride along with the next message. */
  private pendingImages: AttachedImage[] = [];
  private renderQueued = false;

  constructor(private config: Config) {}

  async start(): Promise<void> {
    // History is loaded newest-first, but new sessions are appended -- so the
    // last index is the *oldest* stored record, not the newest one. Rather than
    // guess, start on a fresh session: opening one you did not pick (and were
    // then typing into) was the wrong default. Past sessions stay one keypress
    // away via the picker, which Esc returns from to this new session.
    const records = await loadAll();
    for (const rec of records) this.sessions.push(new Session(this.config, rec));
    this.sessions.push(new Session(this.config));
    this.active = this.sessions.length - 1;

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
      Promise.all(this.sessions.map((s) => s.persist().catch(() => {}))).finally(() =>
        process.exit(0)
      );
      setTimeout(() => process.exit(0), 500).unref();
    };
    process.once("SIGTERM", flushAndExit);
    process.once("SIGINT", flushAndExit);
    process.once("exit", cleanup);

    this.render();
  }

  private current(): Session {
    return this.sessions[this.active];
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
    const items: PickerItem[] = this.pickerSessions().map((s) => ({
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
      title: this.current().title,
      sessionIndex: this.active,
      sessionCount: this.sessions.length,
      scrollOffset: this.scroll,
      picker: this.picker
        ? {
            items,
            index: this.picker.index,
            query: this.picker.query.value,
            confirmDelete:
              this.sessions.find((s) => s.id === this.picker?.confirmDelete)?.title ?? null,
            rename: this.picker.rename
              ? {
                  title: this.sessions.find((s) => s.id === this.picker!.rename!.id)?.title ?? "",
                  value: this.picker.rename.buffer.value,
                  cursor: this.picker.rename.buffer.cursor,
                }
              : null,
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
   */
  private pickerSessions(): Session[] {
    return this.sessions;
  }

  /** Keep the picker index inside the list. */
  private clampPickerIndex(): void {
    if (!this.picker) return;
    const n = this.pickerSessions().length;
    this.picker.index = n === 0 ? 0 : Math.min(this.picker.index, n - 1);
    if (this.picker.index < 0) this.picker.index = 0;
  }

  private onKey(k: Key): void {
    if (this.quitting) return;
    if (this.picker?.rename) this.onRenameKey(k);
    else if (this.picker) this.onPickerKey(k);
    else this.onChatKey(k);
  }

  /** Begin editing the highlighted session's title, pre-filled with the current one. */
  private startRename(session: Session): void {
    if (!this.picker) return;
    const buffer = new LineBuffer();
    buffer.set(session.title);
    this.picker.rename = { id: session.id, buffer };
    this.picker.confirmDelete = null;
  }

  /**
   * Keys while a title is being edited: Enter saves, Esc cancels, and the rest
   * are ordinary line editing. Every key is consumed here so a stray `d` during
   * a rename edits the title instead of deleting the session.
   */
  private onRenameKey(k: Key): void {
    const r = this.picker!.rename!;
    const b = r.buffer;
    const target = this.sessions.find((s) => s.id === r.id);

    switch (k.type) {
      case "enter":
        this.picker!.rename = null;
        if (target) void target.rename(b.value);
        break;
      case "escape":
        this.picker!.rename = null; // discard the edit
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
      case "up":
        if (n > 0) p.index = (p.index - 1 + n) % n;
        this.requestRender();
        return;
      case "down":
        if (n > 0) p.index = (p.index + 1) % n;
        this.requestRender();
        return;
      case "escape":
        if (p.confirmDelete) {
          p.confirmDelete = null; // cancel just the confirmation
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
        if (text) {
          // Typed something => start a brand-new session with it.
          this.startNewSessionWith(text);
        } else if (n > 0) {
          // Nothing typed => open the highlighted session.
          this.openSession(items[p.index]);
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
        this.requestRender();
        return;
      }
      case "char":
        // A pending delete confirmation swallows the next key.
        if (p.confirmDelete) {
          const target = this.sessions.find((s) => s.id === p.confirmDelete);
          if (k.ch === "y" || k.ch === "d") {
            if (target) this.closeSession(target);
          }
          p.confirmDelete = null;
          this.requestRender();
          return;
        }
        if (k.ch === "d" && q.value === "" && n > 0) {
          p.confirmDelete = items[p.index].id;
        } else if (k.ch === "r" && q.value === "" && n > 0) {
          // `r` renames the highlighted session. Outside rename mode it only
          // acts on an empty prompt, so typing a message that contains "r"
          // still works.
          this.startRename(items[p.index]);
        } else {
          q.insert(k.ch);
          this.clampPickerIndex();
        }
        this.requestRender();
        return;
      case "ctrl":
        if (k.ch === "c") this.quit();
        else if (k.ch === "a") { q.home(); this.requestRender(); }
        else if (k.ch === "e") { q.end(); this.requestRender(); }
        else if (k.ch === "u") { q.deleteToStart(); this.clampPickerIndex(); this.requestRender(); }
        else if (k.ch === "k") { q.deleteToEnd(); this.clampPickerIndex(); this.requestRender(); }
        else if (k.ch === "w") { q.deleteWordLeft(); this.clampPickerIndex(); this.requestRender(); }
        else if (k.ch === "v") void this.pasteImageFromClipboard();
        return;
    }
  }

  /** Create a session and immediately send `text` as its first message. */
  private startNewSessionWith(text: string): void {
    this.pruneEmptySessions();
    const session = new Session(this.config);
    this.sessions.push(session);
    this.active = this.sessions.length - 1;
    this.input.clear();
    this.scroll = 0;
    if (session.status === "idle") {
      void session.run(text, () => this.requestRender());
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
        this.sessions.splice(i, 1);
        if (this.active > i) this.active--;
        else if (this.active === i) this.active = Math.max(0, this.active - 1);
      }
    }
  }

  private openSession(session: Session): void {
    this.active = this.sessions.indexOf(session);
    this.input.clear();
    this.scroll = 0;
  }

  /** Delete a session by reference, keeping indices valid. */
  private closeSession(session: Session): void {
    if (session.status === "thinking") return; // don't kill a running turn
    const idx = this.sessions.indexOf(session);
    if (idx === -1) return;
    void session.delete();
    this.sessions.splice(idx, 1);
    if (this.sessions.length === 0) this.sessions.push(new Session(this.config));
    if (this.active >= this.sessions.length) this.active = this.sessions.length - 1;
    this.clampPickerIndex();
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
        return;
      case "alt":
        if (k.ch === "b") { b.wordLeft(); this.requestRender(); }
        else if (k.ch === "f") { b.wordRight(); this.requestRender(); }
        else if (k.ch === "d") { b.deleteWordRight(); this.requestRender(); }
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
    // Select the current session by identity, not array position. `sessions`
    // mixes two orders -- loaded records are newest-first, while new sessions
    // are appended -- so indexOf() pointed at the wrong row and the highlight
    // landed on the last item instead of the session you were in.
    const cur = this.current();
    const idx = this.sessions.findIndex((s) => s.id === cur.id);
    this.picker = {
      index: Math.max(0, idx),
      query: new LineBuffer(),
      confirmDelete: null,
      rename: null,
    };
    this.requestRender();
  }

  private newSession(): void {
    this.pruneEmptySessions();
    this.sessions.push(new Session(this.config));
    this.active = this.sessions.length - 1;
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

  private submit(): void {
    const text = this.input.value.trim();
    if (!text) return;

    // `/image <path>` attaches a screenshot to the next message instead of
    // sending it. Images cannot travel through a tool result, so they are
    // attached to the user message itself.
    // `/paste` pulls an image straight off the Windows clipboard. Windows
    // Terminal cannot hand image data to a program through the paste stream,
    // so the clipboard is read from the Windows side instead.
    if (text === "/paste" || text === "/paste ") {
      this.input.clear();
      void this.pasteFromClipboard();
      return;
    }
    if (text.startsWith("/image")) {
      const arg = text.slice("/image".length).trim();
      this.input.clear();
      void this.attachImage(arg);
      return;
    }
    if (text === "exit" || text === "quit") {
      this.quit();
      return;
    }
    // `/quit` and `/exit` are the slash-command spelling of the bare words
    // above. Matched exactly (no trailing space handled, since there is no
    // argument) so a message beginning `/quit…` still reaches the model.
    if (text === "/quit" || text === "/exit") {
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
      this.startNewSessionWith(text);
      // startNewSessionWith creates a new session; hand the attachments to it.
      if (images.length) {
        const fresh = this.current();
        this.input.clear();
        this.scroll = 0;
        void fresh.run(text, () => this.requestRender(), images);
      }
    } else {
      this.input.clear();
      this.scroll = 0; // jump back to the tail so you see the reply
      void session.run(text, () => this.requestRender(), images);
    }
    this.requestRender();
  }

  private quit(): void {
    if (this.quitting) return;
    this.quitting = true;
    this.screen.stop();
    this.keys.stop();
    // Give any in-flight saves a moment to land before exiting.
    Promise.all(this.sessions.map((s) => s.persist().catch(() => {}))).finally(() =>
      process.exit(0)
    );
    // Safety net in case a save hangs.
    setTimeout(() => process.exit(0), 500).unref();
  }
}
