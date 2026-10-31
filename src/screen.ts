/**
 * ANSI screen renderer. Owns the terminal: hides/shows the cursor, draws the
 * transcript, the input line, and the status bar, and restores state on exit.
 */
import { stdout } from "node:process";
import { Entry } from "./store.js";

const ESC = "\x1b[";
const CLEAR = ESC + "2J" + ESC + "H";
const HIDE_CURSOR = ESC + "?25l";
const SHOW_CURSOR = ESC + "?25h";
const RESET = ESC + "0m";
const DIM = ESC + "2m";
const BOLD = ESC + "1m";
const REVERSE = ESC + "7m";
const CYAN = ESC + "36m";
const YELLOW = ESC + "33m";
const GREEN = ESC + "32m";
const RED = ESC + "31m";

export interface PickerItem {
  label: string;
  detail: string;
}

export interface RenderState {
  /** Lines of transcript to display (already flattened). */
  entries: Entry[];
  /** Current input buffer. */
  input: string;
  /** Cursor offset within input, in UTF-16 units. */
  cursor: number;
  /** Status line, e.g. "idle" / "thinking". */
  status: string;
  /** Session title shown in header. */
  title: string;
  /** Number of sessions and index of active one. */
  sessionIndex: number;
  sessionCount: number;
  /**
   * Lines scrolled up from the bottom of the transcript. 0 = following the
   * tail (newest output). Positive = looking further back in history.
   */
  scrollOffset: number;
  /**
   * When set, the picker overlay is shown instead of the input line.
   * `query` is the typed filter text; when non-empty, Enter starts a new
   * session using it.
   */
  picker: {
    items: PickerItem[];
    index: number;
    query: string;
    /** Title of the session awaiting delete confirmation, if any. */
    confirmDelete: string | null;
  } | null;
}

/** Strip ANSI from a string so we can measure display width. */
function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Hard-wrap keeping ANSI codes intact per line is complex; we wrap raw text. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= width) {
      out.push(rawLine);
      continue;
    }
    let rest = rawLine;
    while (rest.length > width) {
      let cut = rest.lastIndexOf(" ", width);
      if (cut <= 0) cut = width;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^ /, "");
    }
    if (rest) out.push(rest);
  }
  return out;
}

/** Hard-wrap at exactly `width` chars (no word-boundary logic). */
function wrapHard(text: string, width: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += width) {
    out.push(text.slice(i, i + width));
  }
  if (out.length === 0) out.push("");
  return out;
}

export class Screen {
  private cols = stdout.columns || 80;
  private rows = stdout.rows || 24;
  /** Total transcript lines from the last render, for scroll clamping. */
  private lastTotalLines = 0;
  private resizeHandler = () => {
    this.cols = stdout.columns || 80;
    this.rows = stdout.rows || 24;
  };

  get width(): number {
    return this.cols;
  }

  get height(): number {
    return this.rows;
  }

  /** Number of transcript lines available to scroll through. */
  get totalLines(): number {
    return this.lastTotalLines;
  }

  /** Rows available for the transcript (excludes header/input/status chrome). */
  get viewportRows(): number {
    // header(1) + blank(1) + blank(1) + input(1) + status(1)
    return Math.max(3, this.rows - 5);
  }

  start(): void {
    stdout.on("resize", this.resizeHandler);
    stdout.write(CLEAR + HIDE_CURSOR);
  }

  stop(): void {
    stdout.off("resize", this.resizeHandler);
    stdout.write(SHOW_CURSOR + RESET + "\n");
  }

  /** Build the display lines for the transcript, styling roles. */
  private styledEntries(entries: Entry[], width: number): string[] {
    const lines: string[] = [];
    for (const e of entries) {
      if (e.role === "user") {
        for (const l of wrap(e.text, width - 2)) lines.push(BOLD + CYAN + "> " + l + RESET);
      } else if (e.role === "assistant") {
        for (const l of wrap(e.text, width)) lines.push(l);
      } else {
        const head =
          (e.ok === false ? RED : GREEN) +
          `[${e.name}] ${e.ok === false ? "error" : "ok"}` +
          RESET;
        lines.push(head);
        const body = e.text.length > 1200 ? e.text.slice(0, 1200) + " …" : e.text;
        for (const l of wrap(body, width - 2)) lines.push(DIM + "  " + l + RESET);
      }
      lines.push("");
    }
    return lines;
  }

  render(s: RenderState): void {
    const width = this.cols;
    const height = this.rows;
    const viewport = this.viewportRows;

    const all = this.styledEntries(s.entries, width);
    this.lastTotalLines = all.length;

    // Scroll: 0 follows the tail; otherwise look `scrollOffset` lines back.
    const maxOffset = Math.max(0, all.length - viewport);
    const offset = Math.max(0, Math.min(s.scrollOffset, maxOffset));
    const endIdx = all.length - offset;
    const startIdx = Math.max(0, endIdx - viewport);
    const visible = all.slice(startIdx, Math.max(startIdx, endIdx));
    while (visible.length < viewport) visible.unshift("");

    const header =
      BOLD +
      ` coda ` +
      RESET +
      DIM +
      `session ${s.sessionIndex + 1}/${s.sessionCount} · ${s.title}` +
      (offset > 0 ? ` · ${YELLOW}▲ scrolled back ${offset}${RESET}` : "") +
      RESET;

    const out: string[] = [CLEAR];
    out.push(header);
    out.push("");
    for (const line of visible) out.push(line.slice(0, width * 4));

    if (s.picker) {
      out.push("");
      out.push(DIM + "─".repeat(width) + RESET);

      // Picker prompt: typed text filters, and becomes the first message of a
      // new session if you press Enter with something typed.
      const p = s.picker;
      out.push(BOLD + "New session" + RESET + DIM + " (type a message, or pick a session below)" + RESET);
      const queryRowIdx = out.length; // row index of the query line
      out.push(CYAN + "> " + RESET + p.query);

      const listHeight = Math.max(1, Math.min(p.items.length, Math.floor(height / 3)));
      const start =
        p.items.length === 0
          ? 0
          : Math.max(
              0,
              Math.min(p.index - Math.floor(listHeight / 2), p.items.length - listHeight)
            );
      for (let i = start; i < Math.min(start + listHeight, p.items.length); i++) {
        const item = p.items[i];
        const active = p.items.length > 0 && i === p.index && p.query === "";
        const prefix = active ? REVERSE + "▸ " : "  ";
        const labelWidth = Math.max(10, width - 20);
        const label = `${item.label}`.padEnd(labelWidth).slice(0, labelWidth);
        const line = prefix + label + " " + DIM + item.detail + RESET;
        out.push(active ? REVERSE + line.padEnd(width) + RESET : line);
      }
      if (p.items.length === 0) {
        out.push(DIM + "  (no sessions match)" + RESET);
      }
      out.push(DIM + "─".repeat(width) + RESET);
      if (p.confirmDelete !== null) {
        const label =
          p.confirmDelete.length > 40 ? p.confirmDelete.slice(0, 37) + "..." : p.confirmDelete;
        out.push(
          RED +
            BOLD +
            `Delete "${label}"? ` +
            RESET +
            YELLOW +
            "y to confirm · any other key cancels" +
            RESET
        );
      } else {
        out.push(
          DIM +
            "↑/↓ pick · Enter " +
            (p.query ? "start new session" : "open session") +
            " · d delete · Esc cancel" +
            RESET
        );
      }

      stdout.write(out.join("\n"));

      // Place the cursor inside the picker's query line.
      this.placeCursor(width, queryRowIdx, 2 + p.query.length);
      return;
    }

    // ---- Chat input: wrapped, with a real cursor at the edit position ----
    out.push("");
    const inputWidth = Math.max(10, width - 2);
    const wrapped = wrapHard(s.input, inputWidth);
    // Which visual row/coll does the cursor land on?
    const clampedCursor = Math.max(0, Math.min(s.cursor, s.input.length));
    const before = s.input.slice(0, clampedCursor);
    const curRow = Math.floor(before.length / inputWidth);
    const curCol = before.length % inputWidth;

    for (let i = 0; i < wrapped.length; i++) {
      const prefix = i === 0 ? CYAN + "> " + RESET : "  ";
      out.push(prefix + wrapped[i]);
    }

    const statusTag =
      s.status === "thinking" ? YELLOW + "● thinking" + RESET : DIM + "○ idle" + RESET;
    const scrollHint = offset > 0 ? DIM + " · PgDn/End to return" + RESET : "";
    out.push(
      statusTag +
        DIM +
        "   ← sessions · ↑↓ scroll · Ctrl+T new · Ctrl+X close · Ctrl+C exit" +
        RESET +
        scrollHint
    );

    stdout.write(out.join("\n"));

    // The input starts after header+blank+viewport+blank = viewport + 3 rows.
    const inputFirstRow = viewport + 3;
    this.placeCursor(width, inputFirstRow + curRow, 2 + curCol);
  }

  /**
   * Move the terminal's cursor to a logical (row, col) within the frame we
   * just wrote. Rows/cols are 0-based; ANSI is 1-based.
   */
  private placeCursor(width: number, row: number, col: number): void {
    const r = Math.max(0, Math.min(row, this.rows - 1)) + 1;
    const c = Math.max(0, Math.min(col, width - 1)) + 1;
    stdout.write(ESC + r + ";" + c + "H" + SHOW_CURSOR);
  }
}
