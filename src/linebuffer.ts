/**
 * A single-line text buffer with a cursor. Indices are in UTF-16 code units so
 * they line up with String#slice, but movement steps whole code points so
 * emoji and other astral characters are never split.
 */

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}_]/u.test(ch);
}

/** Move an index left by one code point (safe across surrogate pairs). */
function stepLeft(s: string, i: number): number {
  if (i <= 0) return 0;
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) return i - 2; // low surrogate
  return i - 1;
}

/** Move an index right by one code point. */
function stepRight(s: string, i: number): number {
  if (i >= s.length) return s.length;
  const c = s.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) return i + 2;
  return i + 1;
}

export class LineBuffer {
  private text = "";
  private pos = 0;

  get value(): string {
    return this.text;
  }

  get cursor(): number {
    return this.pos;
  }

  set(text: string, cursor = text.length): void {
    this.text = text;
    this.pos = Math.max(0, Math.min(cursor, text.length));
  }

  clear(): void {
    this.text = "";
    this.pos = 0;
  }

  insert(str: string): void {
    this.text = this.text.slice(0, this.pos) + str + this.text.slice(this.pos);
    this.pos += str.length;
  }

  /** Backspace: delete the code point before the cursor. */
  backspace(): void {
    if (this.pos === 0) return;
    const start = stepLeft(this.text, this.pos);
    this.text = this.text.slice(0, start) + this.text.slice(this.pos);
    this.pos = start;
  }

  /** Delete: remove the code point under the cursor. */
  deleteForward(): void {
    if (this.pos >= this.text.length) return;
    const end = stepRight(this.text, this.pos);
    this.text = this.text.slice(0, this.pos) + this.text.slice(end);
  }

  left(): void {
    this.pos = stepLeft(this.text, this.pos);
  }

  right(): void {
    this.pos = stepRight(this.text, this.pos);
  }

  home(): void {
    this.pos = 0;
  }

  end(): void {
    this.pos = this.text.length;
  }

  /** Move to the start of the previous word. */
  wordLeft(): void {
    let i = this.pos;
    while (i > 0 && !isWordChar(this.text[stepLeft(this.text, i)])) i = stepLeft(this.text, i);
    while (i > 0 && isWordChar(this.text[stepLeft(this.text, i)])) i = stepLeft(this.text, i);
    this.pos = i;
  }

  /** Move to the end of the next word. */
  wordRight(): void {
    let i = this.pos;
    while (i < this.text.length && !isWordChar(this.text[i])) i = stepRight(this.text, i);
    while (i < this.text.length && isWordChar(this.text[i])) i = stepRight(this.text, i);
    this.pos = i;
  }

  /** Delete from the cursor back to the start of the previous word. */
  deleteWordLeft(): void {
    const end = this.pos;
    this.wordLeft();
    this.text = this.text.slice(0, this.pos) + this.text.slice(end);
  }

  /** Delete from the cursor to the end of the next word. */
  deleteWordRight(): void {
    const start = this.pos;
    this.wordRight();
    this.text = this.text.slice(0, start) + this.text.slice(this.pos);
    this.pos = start;
  }

  /** Delete from the start of the line to the cursor. */
  deleteToStart(): void {
    this.text = this.text.slice(this.pos);
    this.pos = 0;
  }

  /** Delete from the cursor to the end of the line. */
  deleteToEnd(): void {
    this.text = this.text.slice(0, this.pos);
  }
}

/**
 * One entry in the recall list: what ↑/↓ walk through, and what to put back
 * when they walk off that entry.
 *
 * A prompt is stored together with the images attached to it, so Up on a
 * message that went out with a screenshot restores the screenshot too --
 * otherwise recalling it would silently resend a different message.
 */
export interface RecalledPrompt<T = unknown> {
  text: string;
  /** Attachments sent with it; restored along with the text. */
  images: T[];
}

/**
 * The prompt history behind ↑/↓, plus the one entry being edited.
 *
 * The walk is index-based and newest-first: `index` 0 is the most recent
 * prompt, and stepping past the last one returns to the draft. Recall is
 * deliberately stateless between calls -- the list is appended to on every
 * message sent, rather than owned here -- so it cannot drift out of step with
 * the session it belongs to.
 *
 * Two rules make it behave the way readline does, which is what the fingers
 * expect:
 *
 *   - The draft survives the walk. Typing half a sentence, pressing ↑ to check
 *     something, and pressing ↓ back past the newest prompt returns the
 *     sentence untouched -- including the caret position, so the next
 *     keystroke goes where it would have.
 *   - An entry edited during the walk is recalled as edited, for the rest of
 *     that walk only. Editing a recalled prompt and stepping further back used
 *     to lose the edit; editing it also cuts the walk off from the draft, since
 *     coming back to text you have moved on from would be a surprise.
 */
export class PromptRecall<T = unknown> {
  /** Newest first, as `setItems` was given them. */
  private items: RecalledPrompt<T>[] = [];
  /** Entries walked to so far this time, newest first; [] when not recalling. */
  private walked: RecalledPrompt<T>[] = [];
  /** What was in the buffer before the walk began, or null when not recalling. */
  private draft: { text: string; cursor: number } | null = null;

  /** True while ↑/↓ are walking history rather than leaving the draft alone. */
  get active(): boolean {
    return this.draft !== null;
  }

  /** How many entries back the walk currently is; 0 when not recalling. */
  get depth(): number {
    return this.walked.length;
  }

  /**
   * Replace the list. Called before every move rather than cached, so a prompt
   * sent mid-walk (a steer folded into a running turn) is recallable at once.
   */
  setItems(items: RecalledPrompt<T>[]): void {
    this.items = items;
  }

  /** Forget the walk, keeping the list. The draft is dropped with it. */
  reset(): void {
    this.items = [];
    this.walked = [];
    this.draft = null;
  }

  /**
   * Step one entry back, older. Returns the text/caret to put in the buffer,
   * or null at the oldest entry -- where the buffer is left exactly as it is,
   * so the message already recalled stays put and can be edited.
   *
   * `current` is the buffer's own text: the draft on the first step, and on
   * later steps it is what tells an edited entry from an untouched one.
   */
  up(current: string, cursor: number): { text: string; cursor: number; images: T[] } | null {
    if (this.draft === null) {
      this.draft = { text: current, cursor };
    } else {
      this.keepEdit(current);
    }
    const next = this.items[this.walked.length];
    if (!next) return null;
    this.walked.push(next);
    return { text: next.text, cursor: next.text.length, images: next.images };
  }

  /**
   * Step one entry forward, newer. Returns a position when there is a newer
   * entry, the draft when the walk steps past the newest one, and null when
   * there is no walk to step out of (so ↓ is a no-op on a fresh draft).
   *
   * `current` is the buffer's own text, so an entry edited during the walk is
   * kept edited if the walk comes back to it.
   */
  down(current: string): { text: string; cursor: number; images: T[] } | null {
    if (this.draft === null) return null;
    this.keepEdit(current);
    this.walked.pop();
    if (this.walked.length === 0) {
      const draft = this.draft;
      this.draft = null;
      return { ...draft, images: [] };
    }
    const next = this.walked[this.walked.length - 1];
    return { text: next.text, cursor: next.text.length, images: next.images };
  }

  /**
   * Record text edited while it was recalled, so it comes back edited next
   * time. Called before every step, since the walk only learns about an edit
   * by comparing the buffer against the entry it put there.
   */
  keepEdit(current: string): void {
    const entry = this.walked[this.walked.length - 1];
    if (!entry || entry.text === current) return;
    entry.text = current;
    // The walk has diverged from the session's copy. Backing out to the draft
    // is still one ↓ away, but the *list* must not absorb the edit: the entry
    // at this depth is the snapshot taken when it was first walked to, and
    // rewriting it would change what a later walk recalls.
  }
}
