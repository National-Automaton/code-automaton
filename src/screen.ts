/**
 * ANSI screen renderer. Owns the terminal: hides/shows the cursor, draws the
 * transcript, the input line, and the status bar, and restores state on exit.
 */
import { stdout } from "node:process";
import { Entry } from "./store.js";

/**
 * How long the last tool count stays on the status line after the tools
 * finish. Long enough for a frame to be drawn and read; short enough that it
 * does not still be showing when the next turn starts.
 */
const TOOL_COUNT_LINGER_MS = 1500;

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
 * Bracketed paste.
 *
 * With this on, the terminal wraps pasted text in `ESC[200~` ... `ESC[201~`,
 * which is the only way to tell a pasted newline from a typed Enter. Without
 * it, pasting the source of an email submitted it one line at a time: ninety
 * separate messages, each a fragment, with words split across them where the
 * terminal had wrapped the line.
 *
 * It is not tied to the mouse: pasting has to work whether or not mouse
 * reporting is enabled.
 */
const PASTE_ON = ESC + "?2004h";
const PASTE_OFF = ESC + "?2004l";
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
  /**
   * Who holds this session's lock, when another coda has it open. Shown on the
   * row so a session that cannot be opened says so *before* it is chosen:
   * the refusal used to go to the transcript, which the full-screen picker does
   * not draw, so pressing Enter on a locked row looked like a dead keypress.
   */
  locked?: string | null;
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
  /**
   * Tool calls currently running in this session, not counting the session
   * itself. 0 when idle.
   *
   * The status line reports tools in use, counting the session: 1 while the
   * session alone works (including when a single call runs alongside it -- that
   * is the session's own work), rising only when several calls are in use at
   * once. So two calls in flight reads "2 tools", not "3".
   *
   * The number is sticky -- it stays on screen for `TOOL_COUNT_LINGER_MS` after
   * the calls finish -- because a fast call can complete in a few milliseconds,
   * between two frames, and a sequential run is idle in the gaps between calls.
   * See `stickyToolCount`.
   */
  runningTools: number;
  /**
   * Changes whenever `runningTools` does (see `Agent.toolSeq`). A different
   * value means new activity, which replaces the sticky count immediately
   * rather than letting the previous run's number linger over it.
   */
  toolSeq: number;
  /**
   * The highest count seen during the current run of activity, i.e. how many
   * calls this run has had in flight at once (again excluding the session).
   *
   * Needed because rendering is frame-based: a whole batch can start and finish
   * between two frames, so the screen never samples `runningTools` while it is
   * non-zero. The agent tracks the peak, and the lingering count shows that --
   * otherwise a five-call batch that ran fast would linger as whatever the
   * previous run's count happened to be.
   */
  toolPeak: number;
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
   * First transcript line to draw, counted from the top; -1 (or undefined)
   * follows the tail.
   *
   * Takes precedence over `scrollOffset`. An offset from the tail moves when a
   * reply appends a line -- each new line pushes the anchored text one line
   * further up -- so a turn still being written dragged a reader out of the
   * history and back to the bottom. A line index from the top is unaffected by
   * content arriving below it.
   */
  scrollTop?: number;
  /**
   * When set, the session picker is shown full-screen: the transcript and the
   * input line are not drawn at all. `query` is the typed text; when non-empty,
   * Enter starts a new session using it. It does not filter the list.
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
    /**
     * Help lines to show over the bottom of the list, or null. `/help` typed
     * into the picker shows them here instead of closing the overlay, so the
     * list and the highlighted row stay put while the reference is read.
     */
    help: string[] | null;
    /** First help line to draw: the block scrolls within its rows. */
    helpTop: number;
    /**
     * A refusal from the last action, shown in place of the hint -- or null.
     *
     * The transcript is not drawn at all while the picker is open, so a note
     * written there is invisible: Ctrl+X on a session that was still mid-turn
     * simply looked like a key that did nothing. This row is the only place a
     * refusal can be seen before the overlay closes.
     */
    notice: string | null;
  } | null;
  /**
   * Set while a session's title is being edited from the chat view (Alt+R).
   * The input line is replaced by the title editor.
   */
  rename: { title: string; value: string; cursor: number } | null;
  /**
   * Set while a secret is being typed (the `/secret` password prompt).
   *
   * The value is masked in the field -- one `•` per character, with a caret at
   * the edit position -- so it is never drawn to the terminal, and therefore
   * never reaches a scrollback buffer or a screenshot. The length is the only
   * thing revealed, which is unavoidable if the caret is to go anywhere.
   */
  password?: {
    label: string;
    length: number;
    cursor: number;
    /** True (default) to mask the value; false to echo it, for a username. */
    hidden?: boolean;
  } | null;
  /**
   * Set while a `use_secret` call is waiting for the user's approval.
   *
   * Drawn instead of the input line, above the status line: nothing the user
   * types here reaches the chat input, so a stray keystroke cannot be sent to
   * the model while a credential is pending.
   */
  approval?: { summary: string } | null;
  /**
   * When set, the `/model` overlay is shown full-screen -- the same frame the
   * session picker takes over.
   *
   * Two columns: the chat models on the left with the selected one ticked, and
   * the image model that goes with each on the right. The image column is a
   * per-session setting rather than a property of the row (coda has one vision
   * slot, not one per text model), so it is drawn once, beside the ticked row,
   * and `visionIndex` names the model chosen for it.
   *
   * Optional so every caller that never opens this overlay is unaffected;
   * absent means "not open".
   */
  modelPicker?: {
    models: { id: string; vision: boolean }[];
    /** Highlighted chat model. */
    index: number;
    /** Model this session currently uses, to place the ✓. */
    selected: string;
    /**
     * Image models to choose between and the one in force. Empty when nothing
     * image-capable is available, in which case the right-hand column is blank
     * and Left/Right do nothing.
     */
    vision: string[];
    visionIndex: number;
    /** First image-model row drawn in the right column; it scrolls on its own. */
    visionTop?: number;
    /** True when history holds an image, so vision routing is actually in use. */
    usingVision: boolean;
    /** Note about where the list came from, or why it is only config. */
    notice: string;
  } | null;
}

/**
 * "1 tool" / "5 tools" for the status line.
 *
 * Exported for the tests: the singular case is easy to get wrong and easy to
 * miss by eye, since a single tool call is the common one.
 */
export function toolCount(n: number): string {
  return `${n} ${n === 1 ? "tool" : "tools"}`;
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
  /**
   * The offset actually drawn last frame, after clamping.
   *
   * The caller keeps its own anchored position (a line index from the top) and
   * converts it back to an offset each frame; it needs to know what was really
   * shown so a resize or a clamp does not silently desynchronise the two.
   */
  private lastOffset = 0;
  /**
   * Rows the help block was drawn in last frame, 0 when it was not shown.
   *
   * Scrolling the block needs its height, and that height is worked out inside
   * `renderPicker` from the row budget. Recording it here keeps the two in step
   * -- recomputing it in the caller would be a second copy of the layout maths,
   * free to drift from the one that actually decides what is on screen.
   */
  private lastHelpRows = 0;
  /**
   * First list row the picker window currently shows.
   *
   * The window used to recentre on the highlight every frame
   * (`index - listHeight/2`), which with more sessions than fit meant the whole
   * list slid up one row every few presses -- so the row on a given screen line
   * changed without any obvious cue, and a quick Down-then-Enter could act on a
   * different session than the one just read. Instead the window is kept as
   * state and only moves when the highlight would leave it, so rows stay put
   * until you actually reach the edge.
   */
  private pickerTop = 0;
  /** First `/model` row drawn; that list scrolls the same way. */
  private modelTop = 0;
  /** First image-model row drawn in the `/model` right column. */
  private visionTop = 0;
  /**
   * The last non-zero tool count, and when it stopped being current.
   *
   * Kept so the status line can show "· 1 tool" for a moment after the call
   * finished; without it the count was only visible while a call was actually
   * in flight, which for anything fast is a few milliseconds. `seq` ties the
   * remembered count to the activity that produced it, so a new run replaces
   * it at once instead of showing a stale number under a fresh status.
   */
  private stickyTools = { count: 0, seq: -1, since: 0 };
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

  /** Lines back from the tail that the last frame actually drew. */
  get scrollOffset(): number {
    return this.lastOffset;
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
  get helpRows(): number {
    return this.lastHelpRows;
  }

  get viewportRows(): number {
    if (this.lastViewportRows > 0) return this.lastViewportRows;
    // header(1) + blank(1) + blank(1) + input(1) + status(1)
    return Math.max(3, this.rows - 5);
  }

  /**
   * Rows the transcript will occupy in the next frame for `input`.
   *
   * Scroll clamping uses this because it runs *before* the render that consumes
   * the offset: the old code read the previous frame's value, so the first
   * PgUp of a turn clamped against a stale budget -- and the very first one
   * clamped against the fallback -- leaving the transcript unable to scroll
   * back.
   */
  viewportRowsForInput(input: string): number {
    return this.viewportRowsFor(input, this.cols, this.rows);
  }

  /**
   * Transcript rows for this frame. Shrinks as the input wraps so the frame
   * never exceeds the height budget: header(1) + blank(1) + transcript +
   * blank(1) + input(N) + status(1).
   *
   * `rows` is the frame budget, which is the terminal height unless a caller
   * asks for less.
   */
  private viewportRowsFor(
    input: string,
    width: number,
    rows = this.rows,
    extraChrome = 0
  ): number {
    const chrome = 4 + this.inputRows(input, width) + extraChrome;
    return Math.max(1, rows - chrome);
  }

  /**
   * `mouse` selects whether terminal mouse reporting is enabled. When false,
   * the wheel is left to the terminal (which keeps drag-to-select working) and
   * coda simply never receives wheel events -- the PgUp/PgDn keys still
   * scroll the transcript (Up/Down are prompt recall, not scrolling).
   *
   * `version` is shown after the brand in the header. It is passed in rather
   * than read from package.json here so the renderer stays free of file I/O.
   */
  constructor(private mouse = true, private version = "") {}

  /**
   * Forget the picker's scroll position so the next frame starts at the top.
   * Called when the picker opens; without it a window scrolled far down would
   * persist into a reopened picker and could leave the highlight off-screen.
   */
  resetPickerWindow(): void {
    this.pickerTop = 0;
  }

  /** Start the `/model` overlay with both columns scrolled to the top. */
  resetModelWindow(): void {
    this.modelTop = 0;
    this.visionTop = 0;
  }

  /**
   * The branded header row: brand (bold) + version (bold) + dim detail, e.g.
   * ` Code Automaton 1.6.2  session 1/3 · title`.
   *
   * Built here so the chat view and the full-screen picker share one wordmark.
   * The detail is truncated to what is left, because a header row that fills
   * the last column triggers the terminal's pending-wrap state and shifts the
   * whole frame down one row (see `render`).
   */
  private headerLine(width: number, detail: string, reserve = 0): string {
    const room = Math.max(0, width - 1 - reserve);
    // The brand is fixed text, so on a narrow terminal it has to give way: a
    // row wider than the terminal soft-wraps, which pushes every row below it
    // down and (on the bottom row) scrolls the frame. Shed detail first, then
    // the version, and only ever truncate the wordmark itself as a last resort.
    const versionText = this.version ? ` ${this.version} ` : "";
    const fullBrand = ` Code Automaton `;
    const brand =
      fullBrand.length + versionText.length <= room
        ? fullBrand + versionText
        : fullBrand.slice(0, Math.max(0, room - versionText.length));
    const bodyRoom = Math.max(0, room - brand.length);
    let body = detail;
    if (body.length > bodyRoom) {
      body = bodyRoom >= 2 ? body.slice(0, bodyRoom - 1) + "…" : body.slice(0, bodyRoom);
    }
    return BOLD + brand + RESET + DIM + body + RESET;
  }

  start(): void {
    stdout.on("resize", this.resizeHandler);
    stdout.write(CLEAR + HIDE_CURSOR + PASTE_ON + (this.mouse ? MOUSE_ON : NO_MOUSE));
  }

  stop(): void {
    stdout.off("resize", this.resizeHandler);
    // Mouse reporting must be turned off or the terminal keeps sending mouse
    // codes to whatever runs next (your shell). Leave the last frame on screen
    // and start a fresh line below it, so the final transcript stays readable
    // (and in the terminal's scrollback) after exit. Only emit the "off"
    // escape when we turned it on, so a shell running under coda never gets a
    // stray mode change.
    stdout.write((this.mouse ? MOUSE_OFF : "") + PASTE_OFF + RESET + SHOW_CURSOR + "\n");
  }

  /**
   * Paint a full frame in place. Homed first, then one ERASE_LINE-prefixed
   * string per row: without the erase, a line shorter than what it replaces
   * (a shrinking status, a deleted character) leaves the old tail visible.
   */
  private draw(lines: string[]): void {
    // Pad with a blank row for the reserved bottom line. `render()` budgets one
    // row less than the terminal and never writes that last row, but the
    // *previous* frame's content is still there, so it has to be erased: a
    // frame that simply stopped short left a stale status line visible below
    // the new one.
    const painted = lines.length < this.rows ? [...lines, ""] : lines;
    // Newlines only separate rows -- no trailing "\r\n" after the last one,
    // which would scroll the viewport on the bottom row.
    const payload = HOME + painted.map((l) => l + ERASE_LINE).join("\r\n");
    stdout.write(payload);
    // Park the cursor on the top row rather than leaving it on the last one:
    // a cursor on the bottom row is in the terminal's pending-wrap state, and
    // the next write there scrolls the screen.
    stdout.write(ESC + "1;1H");
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

  /**
   * The tool count to show on the status line: live while calls are running,
   * and for `TOOL_COUNT_LINGER_MS` afterwards.
   *
   * Two reasons it lingers rather than tracking the live count exactly:
   *
   *  - A fast tool is invisible otherwise. `bash` on a trivial command runs in
   *    a few milliseconds, so a count that only showed while `runningTools > 0`
   *    would usually fall between two frames and never be seen at all.
   *  - A sequential run is idle *between* calls. Three tools in a row are
   *    separated by gaps where the count is genuinely 0; flickering off in each
   *    gap reads as three separate blips rather than one run of three.
   *
   * A new run replaces the remembered count immediately: `seq` changes when the
   * live count does, so the first frame of the next run shows its own count
   * rather than the previous one.
   *
   * Holding the value increases the idle window by `TOOL_COUNT_LINGER_MS`. That
   * includes the window after the turn ends, which is why the count can remain
   * visible next to an `○ idle` status for a moment -- there really is nothing
   * running at that point, and the line is saying "this is what just ran".
   */
  private stickyToolCount(running: number, seq: number, peak: number): number {
    const now = Date.now();

    // `running`/`peak` are *extra* calls, not the total: the count below adds
    // the session itself.
    if (running > 0) {
      this.stickyTools = { count: Math.max(peak, running), seq, since: now };
    } else if (this.stickyTools.seq !== seq) {
      // Idle with changed activity: either new activity or the end of the run
      // we remembered. Either way the clock restarts now, so the drop to zero is
      // the moment the linger begins and a gap between calls keeps showing the
      // count that just finished. The run's peak is taken rather than the last
      // sampled value -- a whole batch can start and finish between two frames
      // (see `RenderState.toolPeak`), and `peak` never drops within a run.
      this.stickyTools = { count: Math.max(this.stickyTools.count, peak), seq, since: now };
    }

    const extra =
      now - this.stickyTools.since < TOOL_COUNT_LINGER_MS ? this.stickyTools.count : 0;
    // The session is itself one of the tools at work, so the count is a floor
    // of 1, not a sum: an open session on its own is "1 tool", and a single
    // call running alongside it *still* reads "1 tool" -- the call is the
    // session's own work, so it does not make the total go up. Only work beyond
    // that (a batch, where several calls really are in use at once) raises the
    // number. Never 0: something is always running while a session is open.
    return Math.max(1, extra);
  }

  render(s: RenderState): void {
    const width = this.cols;
    /**
     * Height budget for the layout: every row except the last.
     *
     * The bottom row of the terminal is reserved and never written to. Writing
     * it -- or leaving the cursor on it -- makes some terminals scroll the view
     * by one line, which silently pushes row 0 (the header) into scrollback:
     * the header is composed and sent correctly but never seen. Reserving the
     * row keeps every frame clear of that edge.
     *
     * `draw()` still paints that reserved row, blank, so the previous frame's
     * last line cannot survive underneath this one.
     */
    const height = Math.max(1, this.rows - 1);

    /*
     * Two layouts share this method.
     *
     * The chat view paints a transcript above the input line. The session
     * picker, whenever it is open, paints a *full-screen* frame instead: the
     * last conversation stays off the screen entirely, so there is nothing
     * above it to read as though it belonged to the highlighted row (or to the
     * session you are about to open). The list is then sized to the whole
     * terminal rather than to a third of it.
     *
     * So the header and the transcript rows are layed out first, and only the
     * no-picker path goes on to draw them: `renderPicker` takes the frame over
     * from row 2 down.
     *
     * The viewport is budgeted even for a picker frame, which draws no
     * transcript at all. `lastViewportRows` describes the chat view to the
     * rest of the app (scroll clamping, and the transcript size the next chat
     * frame will use), so leaving it at 0 here made the chat view, on closing
     * the picker, reflow against a full-terminal budget for one frame: the
     * input line and status line were drawn at the wrong rows and then jumped
     * into place on the next frame -- two carets on screen at once.
     */
    // A password prompt adds a label row above the field, so it is budgeted
    // here too -- otherwise the frame is one row taller than the transcript
    // allowance and the status line scrolls away.
    // An approval prompt replaces the input line and adds its own rows (the
    // summary plus the key hint). Budgeted here or the frame grows past the
    // terminal and scrolls, pushing the header into scrollback.
    const approvalRows = s.approval ? s.approval.summary.split("\n").length + 1 : 0;
    const viewport = this.viewportRowsFor(
      s.input,
      width,
      height,
      (s.password ? 1 : 0) + approvalRows
    );

    const all = this.styledEntries(s.entries, width);
    this.lastTotalLines = all.length;
    this.lastViewportRows = viewport;

    // Scroll: 0 follows the tail; otherwise look `scrollOffset` lines back.
    //
    // `scrollOffset` counts back from the *end*, so a reply still being written
    // moves whatever it is holding: each appended line leaves the same offset
    // pointing one line further on, and a long stream drags the view to the
    // bottom while the reader is up in the history. The caller anchors instead
    // -- `scrollTop` names the first line to draw by its index from the start,
    // which does not move when content is added below it. See `App.scroll`.
    const maxOffset = Math.max(0, all.length - viewport);
    // An anchored line index wins: it is converted to an offset against the
    // length this frame actually has, which is the one thing the caller cannot
    // know when it asks for the frame.
    const requested =
      s.scrollTop !== undefined && s.scrollTop >= 0
        ? Math.max(0, all.length - s.scrollTop)
        : s.scrollOffset;
    const offset = Math.max(0, Math.min(requested, maxOffset));
    this.lastOffset = offset;
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
    // guards against. `headerLine` measures the brand and version first and
    // truncates the detail (session position, title, scroll indicator) into
    // what is left.
    const scrollSuffix = offset > 0 ? ` · ▲ scrolled back ${offset}` : "";
    // The scroll indicator is short and tells you the view is not at the tail,
    // so it is reserved before the title and the title shrinks instead.
    let scrolled = scrollSuffix;
    const fixedHeaderWidth = " Code Automaton ".length + (this.version ? this.version.length + 2 : 0);
    if (fixedHeaderWidth + scrolled.length >= width - 1) scrolled = "";
    const headerDetail =
      `session ${s.sessionIndex + 1}/${s.sessionCount} · ${s.title}` +
      (scrolled ? `${YELLOW}${scrolled}${RESET}${DIM}` : "");
    const header = this.headerLine(width, headerDetail, scrolled.length);

    // Content lines only -- CLEAR is written separately before them, so it
    // cannot shift the frame down by one row.
    const out: string[] = [];
    // Only a picker frame draws a help block; clear the remembered height so a
    // chat frame cannot let a stale value drive scrolling.
    if (!s.picker) this.lastHelpRows = 0;
    // Every row starts from the left margin: the picker paints over the whole
    // terminal, so rows after one left short (the header, say) must not inherit
    // a column from where the previous row ended.
    out.push(header);
    out.push("");
    if (s.modelPicker) {
      this.renderModelPicker(s.modelPicker, out, width, height);
      return;
    }
    if (s.picker) {
      this.renderPicker(s.picker, out, width, height);
      return;
    }
    for (const line of visible) out.push(line.slice(0, width * 4));

    // ---- Chat input: wrapped, with a real cursor at the edit position ----
    // While a title is being edited (Alt+R) the same line edits the title
    // instead, so the caret accounting below serves both.
    out.push("");
    // A password prompt names what it is asking for. Without the label the
    // masked field is indistinguishable from a broken input line.
    if (s.password) {
      out.push(DIM + s.password.label.slice(0, Math.max(1, width - 1)) + RESET);
    }
    // An approval prompt replaces the input line: there is no text field, so a
    // stray keystroke cannot be sent to the model while a credential is
    // pending. The status line below still reports the turn is running.
    if (s.approval) {
      const lines = [
        ...s.approval.summary.split("\n"),
        "run with this credential?   y = once · a = always this session · n / Esc = no",
      ];
      for (const line of lines) {
        out.push(YELLOW + line.slice(0, Math.max(1, width - 1)) + RESET);
      }
    }
    const inputWidth = Math.max(10, width - 3);
    // A password field draws one bullet per character instead of the text, so
    // the credential never reaches the terminal. The caret arithmetic below is
    // unchanged: it works on the same length, only the glyphs differ.
    const fieldText = s.password?.hidden !== false && s.password
      ? "•".repeat(s.password.length)
      : s.rename
        ? s.rename.value
        : s.input;
    const wrapped = wrapHard(fieldText, inputWidth);
    // Which visual row/col does the cursor land on? When the text exactly fills
    // a row the caret belongs at the end of that filled row, not at column 1 of
    // the next one (which would make it jump a line ahead of the text).
    const fieldCursor = s.password
      ? s.password.cursor
      : s.rename
        ? s.rename.cursor
        : s.cursor;
    const clampedCursor = Math.max(
      0,
      Math.min(fieldCursor, fieldText.length)
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
    // The status line carries live information only: the turn status, the
    // number of tool calls in flight, and (while scrolled back) how to return
    // to the tail. The keyboard hints that used to sit here are gone -- they
    // are documented in /help and the README, and repeating them on every
    // frame crowded out information that actually changes.
    //
    // While a title is being edited the line becomes the editor's own hint,
    // since Enter and Esc do something different there and getting that wrong
    // would discard the edit.
    // Always shown: an open session is itself one of the tools in use.
    const tools = this.stickyToolCount(s.runningTools, s.toolSeq, s.toolPeak);
    const toolTag = DIM + ` · ${toolCount(tools)}` + RESET;
    // The status line is one row: an overlong hint (a long title in the rename
    // prompt) would soft-wrap and shift the row the caret is placed on, so the
    // rename hint is clamped to what is left after the status tag.
    const renameHint = "rename · Enter save · Esc cancel · empty resets to auto-title";
    // The password prompt hides what is typed, so the hint has to say what the
    // keys do -- otherwise Enter and Esc are indistinguishable and there is no
    // way to tell whether the value is being accepted.
    const passwordHint =
      s.password?.hidden === false
        ? "secret · Enter save · Esc cancel"
        : "secret · Enter save · Esc cancel · input hidden";
    // The hint is clamped to what the status line has left. Measured in
    // *visible* columns: `statusTag` and `toolTag` carry escape codes, so their
    // raw lengths overstate the space they take and the slice came out too
    // long -- a status line one column over the edge soft-wraps and shifts the
    // frame. The 3 covers the gap before the hint.
    const used = visibleLength(statusTag) + visibleLength(toolTag) + visibleLength(scrollHint);
    const hintWidth = Math.max(0, width - 1 - used - 3);
    out.push(
      statusTag +
        toolTag +
        scrollHint +
        (s.password
          ? DIM + "   " + passwordHint.slice(0, hintWidth) + RESET
          : s.rename
            ? DIM + "   " + renameHint.slice(0, hintWidth) + RESET
            : "")
    );

    this.draw(out);

    // Content starts at row 0 (CLEAR is no longer part of the joined frame):
    // header(0), blank(1), transcript(2..viewport+1), blank(viewport+2),
    // then the input from viewport+3.
    const inputFirstRow = viewport + 3;
    // An approval prompt has no text field, so the caret is parked and hidden
    // rather than left blinking on a line that cannot be typed into.
    if (s.approval) {
      stdout.write(ESC + "1;1H" + HIDE_CURSOR);
      return;
    }
    this.placeCursor(width, inputFirstRow + (curRow - firstVisibleRow), 2 + curCol);
  }

  /**
   * Fill `out` -- already holding the header and its blank row -- with the
   * full-screen session picker and paint it, leaving the cursor in the entry
   * field.
   *
   * `draw()` is called here and not by the caller: it parks the cursor at the
   * top row (1;1), so painting before placing the caret would flash the cursor
   * in the top-left corner on every frame. `renderPicker` therefore owns both
   * the frame and the caret.
   *
   * The picker owns everything from row 2 down: no transcript and no chat
   * input are drawn while it is open, so the previous conversation cannot be
   * mistaken for part of the list. The frame is built to exactly `height`
   * rows: a fixed block (separators, "Sessions" heading, entry field, hint)
   * and a list that takes every row left over, which is what "full screen"
   * buys -- as many sessions visible as the terminal can show.
   *
   * A row that fills the last column leaves the terminal in its pending-wrap
   * state, so the following newline moves down *two* rows and every row after
   * it is drawn shifted. Every row here therefore stays within `width - 1`.
   */
  /**
   * The `/model` overlay: chat models on the left, image model on the right.
   *
   * Shares the picker's frame -- full screen, header, rules -- because both are
   * modal overlays and a second visual language would be noise. The layout is
   * two columns rather than one row per model: the image model is a session
   * setting, not a property of the highlighted text model, so drawing it on
   * every row would imply a pairing the routing does not have. It is shown once,
   * aligned to the ticked row.
   */
  private renderModelPicker(
    p: NonNullable<RenderState["modelPicker"]>,
    out: string[],
    width: number,
    height: number
  ): void {
    const rule = DIM + "─".repeat(Math.max(1, width - 1)) + RESET;
    const rows = p.models.length;
    // Header row + rule + hint + rule, plus the heading line.
    const fixed = 4;
    const listRows = Math.max(0, height - 2 - fixed);
    this.lastHelpRows = 0;

    // Clamped like every other row: an over-long hint soft-wraps, which shifts
    // the whole frame down one row and pushes row 0 into scrollback. Built as
    // plain text and sliced before styling, the way the picker rows are.
    const hint = "Models  (↑/↓ text · ←/→ image · Enter select · Esc cancel)";
    out.push(BOLD + hint.slice(0, Math.max(1, width - 1)) + RESET);
    out.push(rule);

    // Column split: the text column gets everything the image column does not
    // need, so a long Gemini id cannot squeeze the left list to nothing.
    const leftWidth = Math.max(12, Math.min(width - 4, Math.floor((width - 1) * 0.55)));
    const rightWidth = Math.max(0, width - 2 - leftWidth - 1);

    // The window follows the highlight without sliding every press.
    const maxTop = Math.max(0, rows - listRows);
    if (p.index < this.modelTop) this.modelTop = p.index;
    else if (p.index >= this.modelTop + listRows) this.modelTop = p.index - listRows + 1;
    this.modelTop = Math.max(0, Math.min(this.modelTop, maxTop));

    const start = rows === 0 ? 0 : this.modelTop;
    const end = Math.min(start + listRows, rows);

    // The image models are a second, vertical list in the right-hand column.
    // It has its own cursor (a `▸`, and `[ ]` around the name) because a
    // control that only rewrites a label somewhere else looks like a dead key --
    // that was the "only the active model is selectable" report.
    const visionIndex = Math.max(0, Math.min(p.visionIndex, Math.max(0, p.vision.length - 1)));
    const visionLabel = p.vision.length ? p.vision[visionIndex] : "";

    // The image list is drawn from its own top, independent of the text list's
    // scroll: the two columns move under different keys, so scrolling one must
    // not drag the other. The window follows its cursor, kept as state so rows
    // stay put under the cursor instead of the whole column sliding.
    const maxVisionTop = Math.max(0, p.vision.length - listRows);
    if (p.vision.length && listRows > 0) {
      if (visionIndex < this.visionTop) this.visionTop = visionIndex;
      else if (visionIndex >= this.visionTop + listRows)
        this.visionTop = visionIndex - listRows + 1;
    }
    this.visionTop = Math.max(0, Math.min(this.visionTop, maxVisionTop));
    const visionTop = this.visionTop;

    let drawn = 0;
    for (let i = start; i < end; i++) {
      const m = p.models[i];
      const active = i === p.index;
      const isCurrent = m.id === p.selected;
      const mark = isCurrent ? "✓ " : "  ";
      const prefix = active ? "▸ " : "  ";
      const label = (prefix + mark + m.id).slice(0, leftWidth).padEnd(leftWidth);

      // Right column: the image-model list. It is the same list on every row
      // (there is one image setting, not one per text model), drawn in place so
      // ←/→ acts on what is visibly under the cursor.
      let right = "";
      if (rightWidth > 4) {
        const vRow = visionTop + (i - start);
        const name = p.vision[vRow];
        if (name) {
          const isCursor = vRow === visionIndex;
          // Clamped to the column: a row that runs past the terminal width
          // soft-wraps and pushes the whole frame down a line. The cursor is
          // the `▸` alone -- it marks the row in place, so bracketing the name
          // as well would only repeat what the arrow already says.
          right = ((isCursor ? "▸ " : "  ") + name).slice(
            0,
            Math.max(1, rightWidth - 1)
          );
        }
      }
      const rightText = right ? " " + right : "";
      const styled =
        right.startsWith("▸ ") ? label + BOLD + rightText + RESET : label + DIM + rightText + RESET;

      if (active) {
        const plain = (label + rightText).slice(0, width - 1).padEnd(Math.max(1, width - 1));
        out.push(REVERSE + plain + RESET);
      } else {
        out.push(right ? styled : label);
      }
      drawn++;
    }
    if (rows === 0 && listRows > 0) {
      out.push(DIM + "  (no models)" + RESET);
      drawn++;
    }
    for (let i = drawn; i < listRows; i++) out.push("");

    out.push(rule);

    // Routing, stated plainly: with an image in the history the vision model
    // answers whatever the text selection says, so say so rather than let the ✓
    // imply otherwise.
    const routing = p.usingVision
      ? `images in history: requests go to ${visionLabel || "(no image model)"}`
      : "text only: no images in history";
    const note = p.notice ? `${routing} · ${p.notice}` : routing;
    out.push(DIM + note.slice(0, Math.max(1, width - 1)) + RESET);
    this.draw(out);

    // There is no text field here, so the caret is parked on the top row and
    // hidden rather than left where `draw()` put it. A visible caret blinking
    // in the header would read as an editable line that does not exist -- the
    // same complaint the picker's top-left caret caused.
    stdout.write(ESC + "1;1H" + HIDE_CURSOR);
  }

  private renderPicker(
    p: NonNullable<RenderState["picker"]>,
    out: string[],
    width: number,
    height: number
  ): void {
    const rule = DIM + "─".repeat(Math.max(1, width - 1)) + RESET;

    // Entry field: first, so the list can be given whatever is left over. A
    // long message wraps rather than being cut.
    const queryWidth = Math.max(10, width - 3);
    const queryRows = wrapHard(p.query, queryWidth);
    // The generic hint gains a locked-row note when there is one to explain:
    // without it, "open in pid 841" reads as a fact with no remedy.
    // Built below, once the help block's row budget is known: whether the block
    // is on screen decides whether the hint should describe scrolling it.

    // Rows left for the list: the terminal, less the header and its blank row,
    // less the three fixed rows below the list (rule, entry field, rule) and
    // the hint, less the section heading when it is drawn.
    //
    // The heading is only worth a row when a session row fits under it too --
    // on a very short terminal the list matters more than its title.
    const headingRows = height >= 8 ? 1 : 0;
    // Help lines take the rows directly above the entry field, so the block
    // sits next to what it describes and the list keeps the top of the frame.
    // Capped so the list can never be squeezed away entirely by a long
    // reference on a short terminal.
    // Fixed rows: rule + entry field + rule + hint, plus the heading. The list
    // and the help block share everything above them.
    const fixedRows = 3 + queryRows.length + 1 + headingRows;
    const usable = Math.max(0, height - 2 - fixedRows);
    // Help is asked for deliberately, so it takes the rows it needs first and
    // the list is shortened -- reading the reference is why the overlay was
    // opened. The list keeps a small floor so dismissing help (Esc) does not
    // land on an empty screen, but when even that will not fit the block takes
    // everything: a list with no rows is one Esc away from coming back.
    const helpWanted = p.help ? p.help.length : 0;
    // One line, plus the rule drawn above the block.
    const helpFits = helpWanted > 0 && usable >= 2;
    const minListRows = 2;
    const helpRoom = helpFits ? Math.max(1, usable - minListRows - 1) : 0;
    const helpRows = Math.min(helpWanted, helpRoom);
    this.lastHelpRows = helpRows;
    // While the help block is open the arrows scroll it rather than the list,
    // so the standing hint would describe keys that are not doing what it says.
    // Name the scrolling keys and the way out instead -- and mention Esc only
    // when the block is really drawn, or the hint would promise a view that is
    // not on screen.
    const hint = p.renaming
      ? "rename · Enter save · Esc cancel · empty resets to auto-title"
      : helpRows > 0
        ? "↑/↓ PgUp/PgDn scroll · Esc to close"
        : "↑/↓ pick · Enter " +
          (p.query ? "start new session" : "open session") +
          " · type to start a new session · Ctrl+X delete · Alt+R rename";
    const listRows = Math.max(0, usable - (helpRows > 0 ? helpRows + 1 : 0));

    // The entry field's row is reached by counting the rows pushed above it,
    // and that count holds whether or not the list has rows left -- so on a
    // terminal too short to show one, the cursor still lands on the field.
    out.push(rule);
    if (listRows > 0) {
      out.push(BOLD + "Sessions" + RESET + DIM + " (↑/↓ to move, Enter to open)" + RESET);
    }
    // Scroll the window to the highlight. The window is kept as state and only
    // moves when the highlight would leave it, so rows stay put under the
    // cursor instead of the whole list sliding every few presses.
    const maxTop = Math.max(0, p.items.length - listRows);
    if (p.index < this.pickerTop) this.pickerTop = p.index;
    else if (p.index >= this.pickerTop + listRows) this.pickerTop = p.index - listRows + 1;
    this.pickerTop = Math.max(0, Math.min(this.pickerTop, maxTop));

    const start = p.items.length === 0 ? 0 : this.pickerTop;
    const end = Math.min(start + listRows, p.items.length);
    let drawn = 0;
    let lockedCount = 0;
    for (let i = start; i < end; i++) {
      const item = p.items[i];
      // Always show the highlight: the query does not filter the list, so
      // suppressing it while typing made the selection invisible.
      const active = i === p.index;
      // Budget the row: prefix(2) + label + gap(1) + detail, capped at width-1.
      // The label takes whatever the detail does not need -- a hard cap on the
      // detail cut dates off mid-string even when there was room to spare.
      const rowWidth = Math.max(10, width - 1);
      const labelMin = Math.min(20, Math.floor(rowWidth / 3));
      // A locked row says so in place of its detail: the message is the reason
      // Enter will not work, so it is more useful than the message count. It is
      // plain text, so it is measured the same way.
      const detailText = item.locked
        ? `open in ${item.locked} -- press Enter to retry`
        : item.detail;
      const detailWidth = Math.max(0, Math.min(detailText.length, rowWidth - 2 - labelMin - 1));
      const labelWidth = Math.max(4, rowWidth - 2 - detailWidth - 1);
      const label = item.label.padEnd(labelWidth).slice(0, labelWidth);
      const detail = detailText.slice(0, detailWidth);
      const text = ((active ? "▸ " : "  ") + label + " " + detail).slice(0, rowWidth);
      if (active) {
        out.push(REVERSE + text.padEnd(rowWidth) + RESET);
      } else if (item.locked) {
        // Locked rows are dimmed in the message colour rather than the normal
        // detail colour, so an unavailable session is visible at a glance.
        out.push("  " + label + " " + YELLOW + detail + RESET);
      } else {
        out.push("  " + label + " " + DIM + detail + RESET);
      }
      if (item.locked) lockedCount++;
      drawn++;
    }
    if (p.items.length === 0 && listRows > 0) {
      out.push(DIM + "  (no sessions)" + RESET);
      drawn++;
    }
    // Fill the rest of the list so the entry field sits at the bottom of the
    // screen rather than jumping up and down with the number of sessions.
    for (let i = drawn; i < listRows; i++) out.push("");

    // Help block: a rule, then the lines, immediately above the entry field.
    if (helpFits && p.help) {
      // The block scrolls: `helpTop` is clamped by the caller, so this only has
      // to clamp again against a block that shrank between frames.
      const top = Math.max(0, Math.min(p.helpTop, Math.max(0, helpWanted - helpRows)));
      out.push(rule);
      for (let i = 0; i < helpRows; i++) {
        out.push(DIM + p.help[top + i].slice(0, Math.max(1, width - 1)) + RESET);
      }
    }
    out.push(rule);
    const queryRowIdx = out.length;
    for (let i = 0; i < queryRows.length; i++) {
      out.push((i === 0 ? CYAN + "> " + RESET : "  ") + queryRows[i]);
    }
    out.push(rule);
    // The hint row carries a note when some listed session is locked, so the
    // markers on the rows have an explanation and a remedy next to them without
    // spending an extra line: a locked session can be opened as soon as the
    // coda holding it exits or stops beating (its lock then goes stale and is
    // taken over on the next Enter).
    // The note is reserved *before* the hint is clamped, so on a narrow
    // terminal the hint gives way rather than the note being cut to a stray
    // separator. Budget: width - 1 for the row, minus the note and its gap.
    const lockNote =
      lockedCount > 0
        ? `   ·   ${lockedCount === 1 ? "1 session is" : `${lockedCount} sessions are`} ` +
          `open in another coda (wait ~30s)`
        : "";
    // A refusal from the last action (Ctrl+X on a session that is mid-turn, a
    // row that has gone) replaces the standing hint entirely: it is the answer
    // to the key that was just pressed, and the hint would otherwise be the
    // last thing on screen while nothing appeared to happen.
    const refusal = p.notice ?? "";
    const hintText = refusal ? refusal : hint;
    const hintColour = refusal ? YELLOW : DIM;
    // The note gets what it needs first (it is the new information; the hint is
    // standing text), capped so the hint always keeps a readable stub. Without
    // the cap an 80-column terminal would spend the whole row on the note.
    const room = Math.max(1, width - 1);
    const noteRoom = lockNote ? Math.min(lockNote.length, Math.max(0, room - 24)) : 0;
    const hintRoom = Math.max(1, room - noteRoom);
    out.push(
      hintColour +
        hintText.slice(0, hintRoom) +
        RESET +
        (noteRoom > 0 ? YELLOW + lockNote.slice(0, noteRoom) + RESET : "")
    );

    this.draw(out);

    // Place the cursor at the edit position, accounting for wrapping. For an
    // ordinary query that is the end of the typed text; while renaming it is
    // the title editor's own caret, so Left/Home move it within the field.
    // Same end-of-row rule as the chat input: when the text exactly fills a
    // row the caret stays on that row rather than jumping to the next.
    const qLen = p.renaming ? Math.max(0, Math.min(p.cursor, p.query.length)) : p.query.length;
    const qAtEnd = qLen > 0 && qLen % queryWidth === 0;
    const qRow = qAtEnd ? qLen / queryWidth - 1 : Math.floor(qLen / queryWidth);
    const qCol = qAtEnd ? queryWidth : qLen % queryWidth;
    this.placeCursor(width, queryRowIdx + qRow, 2 + qCol);
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
