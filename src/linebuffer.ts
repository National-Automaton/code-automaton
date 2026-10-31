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
