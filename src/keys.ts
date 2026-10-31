/**
 * Minimal raw-mode key reader. Parses the ANSI escape sequences emitted for
 * arrow keys and a few control chords, and hands back a normalized Key.
 *
 * Nothing in here renders; it only decodes stdin into intents.
 */
import { stdin } from "node:process";

export type Key =
  | { type: "char"; ch: string }
  | { type: "enter" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "left" }
  | { type: "right" }
  | { type: "up" }
  | { type: "down" }
  | { type: "home" }
  | { type: "end" }
  | { type: "pageup" }
  | { type: "pagedown" }
  | { type: "escape" }
  | { type: "ctrl"; ch: string } // e.g. "c" for Ctrl+C
  | { type: "alt"; ch: string } // e.g. Alt+b / Alt+f (ESC <char>)
  | { type: "tab" }
  | { type: "paste"; text: string };

/** Map of control byte -> letter, for Ctrl+<letter>. */
function ctrlLetter(byte: number): string | null {
  if (byte >= 1 && byte <= 26) return String.fromCharCode(96 + byte);
  return null;
}

export class KeyReader {
  private buf = "";
  private handlers: ((k: Key) => void)[] = [];
  private dataHandler = (chunk: Buffer) => this.feed(chunk.toString("utf8"));

  start(): void {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", this.dataHandler);
  }

  stop(): void {
    stdin.off("data", this.dataHandler);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  }

  onKey(fn: (k: Key) => void): void {
    this.handlers.push(fn);
  }

  private emit(k: Key): void {
    for (const h of this.handlers) h(k);
  }

  private feed(s: string): void {
    this.buf += s;
    while (this.buf.length > 0) {
      const consumed = this.parseOne();
      if (!consumed) break; // wait for the rest of a multi-byte sequence
    }
  }

  /** Parse one key off the front of the buffer. Returns false if incomplete. */
  private parseOne(): boolean {
    const b = this.buf;

    // Escape sequences (arrows, home/end, etc.)
    if (b[0] === "\x1b") {
      // Bare ESC: only treat as escape if nothing follows.
      if (b.length === 1) {
        this.buf = "";
        this.emit({ type: "escape" });
        return true;
      }
      if (b[1] === "[" || b[1] === "O") {
        // CSI: ESC [ params final
        let i = 2;
        while (i < b.length && /[0-9;]/.test(b[i])) i++;
        if (i >= b.length) return false; // incomplete
        const final = b[i];
        const rest = b.slice(0, i + 1);
        this.buf = b.slice(i + 1);
        const params = b.slice(2, i);
        if (params === "200") {
          // Bracketed paste start: swallow until the end marker.
          const end = this.buf.indexOf("\x1b[201~");
          if (end === -1) return false;
          const text = this.buf.slice(0, end);
          this.buf = this.buf.slice(end + 6);
          this.emit({ type: "paste", text });
          return true;
        }
        switch (final) {
          case "A": this.emit({ type: "up" }); return true;
          case "B": this.emit({ type: "down" }); return true;
          case "C": this.emit({ type: "right" }); return true;
          case "D": this.emit({ type: "left" }); return true;
          case "H": this.emit({ type: "home" }); return true;
          case "F": this.emit({ type: "end" }); return true;
          case "~": {
            if (params === "3") this.emit({ type: "delete" });
            else if (params === "5") this.emit({ type: "pageup" });
            else if (params === "6") this.emit({ type: "pagedown" });
            else if (params === "1" || params === "7") this.emit({ type: "home" });
            else if (params === "4" || params === "8") this.emit({ type: "end" });
            return true;
          }
          default:
            return true; // ignore unknown sequence
        }
      }
      // ESC + one char (alt-key etc.). Emit as an alt chord so callers can
      // use Alt+b / Alt+f for word movement.
      const altCh = b.slice(1, 2);
      this.buf = b.slice(2);
      if (altCh === "\x7f" || altCh === "\b") {
        this.emit({ type: "ctrl", ch: "w" }); // Alt+Backspace = delete word
      } else if (altCh >= " ") {
        this.emit({ type: "alt", ch: altCh });
      }
      return true;
    }

    const ch = b[0];
    this.buf = b.slice(1);

    if (ch === "\r" || ch === "\n") { this.emit({ type: "enter" }); return true; }
    if (ch === "\t") { this.emit({ type: "tab" }); return true; }
    if (ch === "\x7f" || ch === "\b") { this.emit({ type: "backspace" }); return true; }

    const code = ch.charCodeAt(0);
    const ctrl = ctrlLetter(code);
    if (ctrl) {
      this.emit({ type: "ctrl", ch: ctrl });
      return true;
    }

    // Printable — take one full code point (handles astral/surrogate pairs).
    if (code >= 0x20) {
      const cp = String.fromCodePoint(ch.codePointAt(0)!);
      // If this is the high half of a surrogate pair, wait for the low half.
      if (cp.length === 1 && ch >= "\ud800" && ch <= "\udbff") {
        this.buf = ch + this.buf;
        return false;
      }
      this.emit({ type: "char", ch: cp });
      return true;
    }
    return true; // ignore other control bytes
  }
}
