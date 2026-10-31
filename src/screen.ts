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
   * `query` is the typed text; when non-empty, Enter starts a new session
   * using it. It does not filter the list.
   */
  picker: {
    items: PickerItem[];
    index: number;
    query: string;
    /** Title of the session awaiting delete confirmation, if any. */
    confirmDelete: string | null;
    /**
     * Set while a session title is being edited: the session's current title
     * (for the prompt) and the edit buffer with its caret.
     */
    rename: { title: string; value: string; cursor: number } | null;
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
  /** Rows actually visible for the transcript in the last render. */
  private lastViewportRows = 0;
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

  /**
   * Rows the chat input occupies once wrapped. The input is drawn `width - 2`
   * wide (a 2-column prompt gutter). An exact multiple of the width still fits
   * in that many rows, since the caret rests at the end of the filled row
   * rather than starting a new one.
   */
  private inputRows(input: string, width: number): number {
    const inputWidth = Math.max(10, width - 2);
    if (input.length === 0) return 1;
    return Math.max(1, Math.ceil(input.length / inputWidth));
  }

  /** Rows available for the transcript (excludes header/input/status chrome). */
  get viewportRows(): number {
    // Rows actually used by the last frame, so scroll clamping matches what is
    // on screen when a wrapped input (or the picker) shrinks the transcript.
    if (this.lastViewportRows > 0) return this.lastViewportRows;
    // header(1) + blank(1) + blank(1) + input(1) + status(1)
    return Math.max(3, this.rows - 5);
  }

  /**
   * Transcript rows for this frame. Shrinks as the input wraps so the frame
   * never exceeds the terminal height: header(1) + blank(1) + transcript +
   * blank(1) + input(N) + status(1).
   */
  private viewportRowsFor(input: string, width: number): number {
    const chrome = 4 + this.inputRows(input, width);
    return Math.max(1, this.rows - chrome);
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
    // The picker overlays its own chrome (separator, title, query, list and
    // hint), so it gets a much smaller transcript budget than the chat view;
    // otherwise the frame overflows and the query line scrolls off-screen.
    // On a very short terminal the chrome alone can exceed the height, so the
    // list shrinks first (down to 0) to keep header + query + hint on screen.
    // Extra rows the wrapped query occupies beyond its first line, so a long
    // message does not push the list off the bottom.
    const pickerFieldLen = s.picker ? (s.picker.rename?.value.length ?? s.picker.query.length) : 0;
    const pickerQueryExtra = s.picker
      ? Math.max(0, Math.ceil(pickerFieldLen / Math.max(10, width - 2)) - 1)
      : 0;
    const pickerFixedChrome = 1 + 1 + 6 + pickerQueryExtra; // header + transcript-blank + chrome
    const pickerSpace = s.picker ? Math.max(0, height - pickerFixedChrome - 2) : 0;
    const pickerListHeight = s.picker
      ? Math.max(0, Math.min(s.picker.items.length || 1, Math.floor(height / 3), pickerSpace))
      : 0;
    const pickerChrome = s.picker ? 6 + pickerListHeight + pickerQueryExtra : 0;
    const viewport = s.picker
      ? Math.max(0, height - 2 - pickerChrome)
      : this.viewportRowsFor(s.input, width);

    const all = this.styledEntries(s.entries, width);
    this.lastTotalLines = all.length;
    this.lastViewportRows = viewport;

    // Scroll: 0 follows the tail; otherwise look `scrollOffset` lines back.
    const maxOffset = Math.max(0, all.length - viewport);
    const offset = Math.max(0, Math.min(s.scrollOffset, maxOffset));
    const endIdx = all.length - offset;
    const startIdx = Math.max(0, endIdx - viewport);
    const visible = all.slice(startIdx, Math.max(startIdx, endIdx));
    while (visible.length < viewport) visible.unshift("");
    // A brand-new session has no transcript at all; say what you can do rather
    // than showing an empty frame. Sits at the top so it is scrolled away by
    // the first message like any other history.
    if (all.length === 0 && visible.length > 0) {
      visible[0] = DIM + "New session. Type a message, or press ← to open a saved one." + RESET;
    }

    const header =
      BOLD +
      ` coda ` +
      RESET +
      DIM +
      `session ${s.sessionIndex + 1}/${s.sessionCount} · ${s.title}` +
      (offset > 0 ? ` · ${YELLOW}▲ scrolled back ${offset}${RESET}` : "") +
      RESET;

    // Content lines only -- CLEAR is written separately before them, so it
    // cannot shift the frame down by one row.
    const out: string[] = [];
    out.push(header);
    out.push("");
    for (const line of visible) out.push(line.slice(0, width * 4));

    if (s.picker) {
      out.push("");
      out.push(DIM + "─".repeat(width) + RESET);

      const p = s.picker;
      out.push(
        BOLD +
          "Sessions" +
          RESET +
          DIM +
          (s.picker.rename ? " (editing title)" : " (↑/↓ to move, Enter to open)") +
          RESET
      );

      const listHeight = pickerListHeight;
      const start =
        p.items.length === 0
          ? 0
          : Math.max(
              0,
              Math.min(p.index - Math.floor(listHeight / 2), p.items.length - listHeight)
            );
      for (let i = start; i < Math.min(start + listHeight, p.items.length); i++) {
        const item = p.items[i];
        // Always show the highlight: the query no longer filters the list, so
        // suppressing the highlight while typing made the selection invisible.
        const active = p.items.length > 0 && i === p.index;
        const prefix = active ? REVERSE + "▸ " : "  ";
        const labelWidth = Math.max(10, width - 20);
        const label = `${item.label}`.padEnd(labelWidth).slice(0, labelWidth);
        const line = prefix + label + " " + DIM + item.detail + RESET;
        out.push(active ? REVERSE + line.padEnd(width) + RESET : line);
      }
      if (p.items.length === 0 && listHeight > 0) {
        out.push(DIM + "  (no sessions)" + RESET);
      }
      out.push(DIM + "─".repeat(width) + RESET);

      // Entry field sits below the list, directly above the hint/status line.
      // Typed text becomes the first message of a new session on Enter; it does
      // not filter the list. Wrapped hard so a long message cannot overrun the
      // width and push the rest of the frame down when the terminal soft-wraps.
      // While renaming, the same field edits the session title instead.
      const fieldValue = p.rename ? p.rename.value : p.query;
      const queryRowIdx = out.length;
      const queryRows = wrapHard(fieldValue, Math.max(10, width - 2));
      for (let i = 0; i < queryRows.length; i++) {
        out.push((i === 0 ? CYAN + "> " + RESET : "  ") + queryRows[i]);
      }
      if (p.rename) {
        out.push(
          DIM +
            `rename "${p.rename.title}" · Enter save · Esc cancel · empty resets to auto-title` +
            RESET
        );
      } else if (p.confirmDelete !== null) {
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
            " · d delete · r rename · Esc cancel" +
            RESET
        );
      }

      stdout.write(CLEAR + out.join("\n"));

      // Place the cursor at the end of the typed text, accounting for wrapping.
      // Same end-of-row rule as the chat input: when the text exactly fills a
      // row the caret stays on that row rather than jumping to the next.
      const qWidth = Math.max(10, width - 2);
      const qLen = p.rename
        ? Math.max(0, Math.min(p.rename.cursor, p.rename.value.length))
        : p.query.length;
      const qAtEnd = qLen > 0 && qLen % qWidth === 0;
      const qRow = qAtEnd ? qLen / qWidth - 1 : Math.floor(qLen / qWidth);
      const qCol = qAtEnd ? qWidth : qLen % qWidth;
      this.placeCursor(width, queryRowIdx + qRow, 2 + qCol);
      return;
    }

    // ---- Chat input: wrapped, with a real cursor at the edit position ----
    out.push("");
    const inputWidth = Math.max(10, width - 2);
    const wrapped = wrapHard(s.input, inputWidth);
    // Which visual row/col does the cursor land on? When the text exactly fills
    // a row the caret belongs at the end of that filled row, not at column 1 of
    // the next one (which would make it jump a line ahead of the text).
    const clampedCursor = Math.max(0, Math.min(s.cursor, s.input.length));
    const before = s.input.slice(0, clampedCursor);
    const atRowEnd = before.length > 0 && before.length % inputWidth === 0;
    const curRow = atRowEnd ? before.length / inputWidth - 1 : Math.floor(before.length / inputWidth);
    const curCol = atRowEnd ? inputWidth : before.length % inputWidth;

    // Cap the input to the rows actually available, scrolling so the caret row
    // stays visible. Without this a very long input pushes the frame past the
    // terminal height and the status line scrolls away.
    const maxInputRows = Math.max(1, height - 5); // header+blank+blank+status + >=1 transcript
    const firstVisibleRow = Math.max(0, Math.min(curRow - (maxInputRows - 1), wrapped.length - maxInputRows));
    for (let i = firstVisibleRow; i < Math.min(wrapped.length, firstVisibleRow + maxInputRows); i++) {
      // Only the very first visual row carries the prompt gutter.
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

    stdout.write(CLEAR + out.join("\n"));

    // Content starts at row 0 (CLEAR is no longer part of the joined frame):
    // header(0), blank(1), transcript(2..viewport+1), blank(viewport+2),
    // then the input from viewport+3.
    const inputFirstRow = viewport + 3;
    this.placeCursor(width, inputFirstRow + (curRow - firstVisibleRow), 2 + curCol);
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
