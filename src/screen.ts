/**
 * ANSI screen renderer. Owns the terminal: hides/shows the cursor, draws the
 * transcript, the input line, and the status bar, and restores state on exit.
 */
import { stdout } from "node:process";
import { Entry } from "./store.js";

const ESC = "\x1b[";
const CLEAR = ESC + "2J" + ESC + "H";
/**
 * Home the cursor plus erase-to-end-of-line. Used instead of CLEAR for every
 * frame after the first: a full `ESC[2J` erase on each render (and there is one
 * per streamed token) leaves the terminal with no history to scroll, so the
 * mouse wheel and Shift+PgUp had nothing to show. Repainting in place with
 * ERASE_LINE keeps the frame from leaving stale tails behind without wiping the
 * scrollback the terminal has already accumulated.
 */
const HOME = ESC + "H";
const ERASE_LINE = ESC + "K";
/**
 * Mouse reporting, SGR encoding (1006) on top of button events (1000).
 *
 * The wheel only reports to us when the terminal is told to send it: otherwise
 * the terminal scrolls its own buffer, which for a repainting full-screen app
 * holds little. Turning it on means the wheel arrives as ESC[<64;...M and the
 * app scrolls its own transcript instead. 1000 (not 1003) is deliberate -- we
 * want wheel/drag only, not a stream of motion reports on every mouse move.
 *
 * The cost: while enabled the terminal no longer does its own wheel scrollback
 * or drag-select; most emulators restore select-to-copy with Shift held.
 */
const MOUSE_ON = ESC + "?1000h" + ESC + "?1006h";
const MOUSE_OFF = ESC + "?1006l" + ESC + "?1000l";
/**
 * Nothing to write: mouse reporting stays off. The terminal keeps its own
 * drag-to-select and wheel scrollback, and coda receives no wheel events.
 * Selected with CODA_MOUSE=off for users who would rather select text.
 */
const NO_MOUSE = "";
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
    /**
     * Text in the entry field. Normally the query that (on Enter) starts a new
     * session; while `renaming` it is the title being edited in place.
     */
    query: string;
    /** Caret offset within `query` while `renaming`; ignored otherwise. */
    cursor: number;
    /** True while the highlighted session's title is being edited here. */
    renaming: boolean;
  } | null;
  /**
   * Set while a session's title is being edited from the chat view (Alt+R).
   * The input line is replaced by the title editor.
   */
  rename: { title: string; value: string; cursor: number } | null;
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
   * Rows the chat input occupies once wrapped. The input is drawn `width - 3`
   * wide (a 2-column prompt gutter, leaving the final column free). An exact
   * multiple of the width still fits in that many rows, since the caret rests
   * at the end of the filled row rather than starting a new one.
   *
   * Width is `width - 3`, not `width - 2`: a full edit row is then at most
   * `width - 1` visible columns, so the terminal never auto-wraps it behind our
   * back. Auto-wrapping would add phantom rows the renderer doesn't count,
   * which pushed the caret onto the line below the text it belongs to.
   */
  private inputRows(input: string, width: number): number {
    const inputWidth = Math.max(10, width - 3);
    if (input.length === 0) return 1;
    return Math.max(1, Math.ceil(input.length / inputWidth));
  }

  /**
   * Rows available for the transcript (excludes header/input/status chrome).
   *
   * Prefers the row count the last frame actually used, so it matches what is
   * on screen when a wrapped input (or the picker) shrinks the transcript.
   * Callers clamping a scroll offset should prefer `viewportRowsForInput()`:
   * this value describes the frame already drawn, not the one about to be.
   */
  get viewportRows(): number {
    if (this.lastViewportRows > 0) return this.lastViewportRows;
    // header(1) + blank(1) + blank(1) + input(1) + status(1)
    return Math.max(3, this.rows - 5);
  }

  /**
   * Rows the transcript will occupy in the next frame for `input`.
   *
   * Scroll clamping uses this because it runs *before* the render that consumes
   * the offset: the old code read the previous frame's value, so the first `↑`
   * of a turn clamped against a stale budget -- and the very first one clamped
   * against the fallback -- leaving the transcript unable to scroll back.
   */
  viewportRowsForInput(input: string): number {
    return this.viewportRowsFor(input, this.cols);
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

  /**
   * `mouse` selects whether terminal mouse reporting is enabled. When false,
   * the wheel is left to the terminal (which keeps drag-to-select working) and
   * coda simply never receives wheel events -- the Up/Down/PgUp/PgDn keys still
   * scroll the transcript.
   */
  constructor(private mouse = true) {}

  start(): void {
    stdout.on("resize", this.resizeHandler);
    stdout.write(CLEAR + HIDE_CURSOR + (this.mouse ? MOUSE_ON : NO_MOUSE));
  }

  stop(): void {
    stdout.off("resize", this.resizeHandler);
    // Mouse reporting must be turned off or the terminal keeps sending mouse
    // codes to whatever runs next (your shell). Leave the last frame on screen
    // and start a fresh line below it, so the final transcript stays readable
    // (and in the terminal's scrollback) after exit. Only emit the "off"
    // escape when we turned it on, so a shell running under coda never gets a
    // stray mode change.
    stdout.write((this.mouse ? MOUSE_OFF : "") + RESET + SHOW_CURSOR + "\n");
  }

  /**
   * Paint a full frame in place. Homed first, then one ERASE_LINE-prefixed
   * string per row: without the erase, a line shorter than what it replaces
   * (a shrinking status, a deleted character) leaves the old tail visible.
   */
  private draw(lines: string[]): void {
    stdout.write(HOME + lines.map((l) => l + ERASE_LINE).join("\r\n"));
  }

  /** Build the display lines for the transcript, styling roles. */
  private styledEntries(entries: Entry[], width: number): string[] {
    const lines: string[] = [];
    for (const e of entries) {
      if (e.role === "user") {
        // width - 3, not width - 2: the "> " gutter is added after wrapping, so
        // a width - 2 body plus the 2-column gutter would fill the last column
        // exactly and trigger the pending-wrap shift (see the assistant branch).
        for (const l of wrap(e.text, width - 3)) lines.push(BOLD + CYAN + "> " + l + RESET);
      } else if (e.role === "assistant") {
        // Wrap to width - 1, not width. A row that exactly fills the last
        // column leaves the terminal in its pending-wrap state, so the
        // following "\r\n" wraps *and* newlines and every later row shifts down
        // by one. Word-boundary breaks usually leave a row short, which is why
        // this only showed up when a long word was split at the margin.
        for (const l of wrap(e.text, width - 1)) lines.push(l);
      } else {
        const head =
          (e.ok === false ? RED : GREEN) +
          `[${e.name}] ${e.ok === false ? "error" : "ok"}` +
          RESET;
        lines.push(head);
        const body = e.text.length > 1200 ? e.text.slice(0, 1200) + " …" : e.text;
        // Same 2-column gutter as a user line, so wrap to width - 3.
        for (const l of wrap(body, width - 3)) lines.push(DIM + "  " + l + RESET);
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
    const pickerFieldLen = s.picker ? s.picker.query.length : 0;
    const pickerQueryExtra = s.picker
      ? Math.max(0, Math.ceil(pickerFieldLen / Math.max(10, width - 3)) - 1)
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

    // The header is one row, so it must never exceed `width - 1`: a row that
    // fills the last column triggers the terminal's pending-wrap state and
    // shifts the whole frame down one -- the same hazard the transcript wrap
    // guards against. Only the title is unbounded, so the rest is measured
    // first and the title truncated into what is left. Budgeting the title on
    // its own was not enough: on a very narrow terminal the fixed parts
    // (" coda session 1/1 · ") already fill the row, so any "room left for the
    // title" still produced an over-long header.
    const brand = " coda ";
    const sessionPrefix = `session ${s.sessionIndex + 1}/${s.sessionCount} · `;
    const scrollSuffix = offset > 0 ? ` · ▲ scrolled back ${offset}` : "";
    const room = Math.max(0, width - 1);

    // The scroll indicator is short and tells you the view is not at the tail,
    // so it is reserved before the title and the title shrinks instead. Drop it
    // only when the brand plus the indicator alone fill the row.
    let scrolled = scrollSuffix;
    if (brand.length + scrolled.length >= room) scrolled = "";

    const body = sessionPrefix + s.title;
    const bodyRoom = Math.max(0, room - brand.length - scrolled.length);
    let bodyText = body;
    if (bodyText.length > bodyRoom) {
      bodyText = bodyRoom >= 2 ? bodyText.slice(0, bodyRoom - 1) + "…" : bodyText.slice(0, bodyRoom);
    }

    const header =
      BOLD +
      brand +
      RESET +
      DIM +
      bodyText +
      (scrolled ? ` · ${YELLOW}${scrolled.slice(3)}${RESET}` : "") +
      RESET;

    // Content lines only -- CLEAR is written separately before them, so it
    // cannot shift the frame down by one row.
    const out: string[] = [];
    out.push(header);
    out.push("");
    for (const line of visible) out.push(line.slice(0, width * 4));

    if (s.picker) {
      out.push("");
      out.push(DIM + "─".repeat(Math.max(1, width - 1)) + RESET);

      const p = s.picker;
      out.push(
        BOLD +
          "Sessions" +
          RESET +
          DIM +
          " (↑/↓ to move, Enter to open)" +
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
        // A row must never exceed `width`, or the terminal soft-wraps it onto a
        // second physical line. The cursor is then placed by counting logical
        // rows, so it lands below the entry field it belongs to.
        //
        // Budget the row explicitly: prefix(2) + label + gap(1) + detail, capped
        // at width - 1 so a full row still cannot trigger auto-wrap.
        //
        // The label gets whatever the detail does not need, rather than the
        // detail being fixed at a small width: a hard cap here cut the date off
        // mid-string ("11/1/20…") at every terminal width, even when there was
        // room to spare. Only a genuinely cramped row should truncate.
        const rowWidth = Math.max(10, width - 1);
        const prefix = active ? "▸ " : "  ";
        const detailText = `${item.detail}`;
        const labelText = `${item.label}`;
        // Reserve at least a readable label; give detail the rest, up to its
        // natural length, so a short detail leaves more room for the label.
        const labelMin = Math.min(20, Math.floor(rowWidth / 3));
        const detailWidth = Math.max(0, Math.min(detailText.length, rowWidth - 2 - labelMin - 1));
        const labelWidth = Math.max(4, rowWidth - 2 - detailWidth - 1);
        const label = labelText.padEnd(labelWidth).slice(0, labelWidth);
        const detail = detailText.slice(0, detailWidth);
        const text = (prefix + label + " " + detail).slice(0, rowWidth);
        if (active) {
          out.push(REVERSE + text.padEnd(rowWidth) + RESET);
        } else {
          out.push("  " + label + " " + DIM + detail + RESET);
        }
      }
      if (p.items.length === 0 && listHeight > 0) {
        out.push(DIM + "  (no sessions)" + RESET);
      }
      out.push(DIM + "─".repeat(Math.max(1, width - 1)) + RESET);

      // Entry field sits below the list, directly above the hint/status line.
      // Typed text becomes the first message of a new session on Enter; it does
      // not filter the list. Wrapped hard so a long message cannot overrun the
      // width and push the rest of the frame down when the terminal soft-wraps.
      const queryRowIdx = out.length;
      const queryRows = wrapHard(p.query, Math.max(10, width - 3));
      for (let i = 0; i < queryRows.length; i++) {
        out.push((i === 0 ? CYAN + "> " + RESET : "  ") + queryRows[i]);
      }
      // Hint rows are single lines, so each is clamped to the terminal width.
      // An overlong hint soft-wraps onto a second line, which shifts every row
      // below it -- including the entry field, whose cursor is placed by
      // counting logical rows.
      const fit = (text: string): string => text.slice(0, Math.max(1, width - 1));
      out.push(
        DIM +
          fit(
            p.renaming
              ? "rename · Enter save · Esc cancel · empty resets to auto-title"
              : "↑/↓ pick · Enter " +
                  (p.query ? "start new session" : "open session") +
                  " · type to start a new session · Ctrl+X delete · Alt+R rename"
          ) +
          RESET
      );

      this.draw(out);

      // Place the cursor at the edit position, accounting for wrapping. For an
      // ordinary query that is the end of the typed text; while renaming it is
      // the title editor's own caret, so Left/Home move it within the field.
      // Same end-of-row rule as the chat input: when the text exactly fills a
      // row the caret stays on that row rather than jumping to the next.
      const qWidth = Math.max(10, width - 3);
      const qLen = p.renaming ? Math.max(0, Math.min(p.cursor, p.query.length)) : p.query.length;
      const qAtEnd = qLen > 0 && qLen % qWidth === 0;
      const qRow = qAtEnd ? qLen / qWidth - 1 : Math.floor(qLen / qWidth);
      const qCol = qAtEnd ? qWidth : qLen % qWidth;
      this.placeCursor(width, queryRowIdx + qRow, 2 + qCol);
      return;
    }

    // ---- Chat input: wrapped, with a real cursor at the edit position ----
    // While a title is being edited (Alt+R) the same line edits the title
    // instead, so the caret accounting below serves both.
    out.push("");
    const inputWidth = Math.max(10, width - 3);
    const fieldText = s.rename ? s.rename.value : s.input;
    const wrapped = wrapHard(fieldText, inputWidth);
    // Which visual row/col does the cursor land on? When the text exactly fills
    // a row the caret belongs at the end of that filled row, not at column 1 of
    // the next one (which would make it jump a line ahead of the text).
    const clampedCursor = Math.max(
      0,
      Math.min(s.rename ? s.rename.cursor : s.cursor, fieldText.length)
    );
    const before = fieldText.slice(0, clampedCursor);
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
    const hint = s.rename
      ? "rename · Enter save · Esc cancel · empty resets to auto-title"
      : "← sessions · ↑↓ scroll · Ctrl+T new · Ctrl+X close · Ctrl+C exit";
    // The status line is a single row: an overlong hint (a long title in the
    // rename prompt) would soft-wrap and shift the row the caret is placed on.
    // `statusTag` is plain text here plus escape codes; ASCII only, so its raw
    // length is a safe allowance. The 3 covers the gap after it.
    const hintWidth = Math.max(1, width - 1 - statusTag.length - 3);
    out.push(statusTag + DIM + "   " + hint.slice(0, hintWidth) + RESET + scrollHint);

    this.draw(out);

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
