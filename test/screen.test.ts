/**
 * Frame invariants for the renderer.
 *
 * `Screen.render` writes ANSI straight to stdout, so the only honest way to
 * test it is to capture the bytes it emits and assert on them. That matters
 * here because the two layouts -- the chat view and the full-screen picker --
 * share one method, and the bugs worth guarding against live in the
 * *transitions* between them, not in either frame on its own:
 *
 *   -   A picker frame painted the caret at the top-left (1;1) and only then
 *       moved it to the entry field, so the cursor flashed in the corner on
 *       every keystroke.
 *   -   A picker frame left `lastViewportRows` at 0, so the first chat frame
 *       after closing the picker laid the input and status lines out against a
 *       flat-out wrong budget and they jumped into place a frame later.
 *
 * Neither showed up when a frame was inspected in isolation, so the cases below
 * always walk chat -> picker -> chat and compare consecutive frames.
 *
 * Run with `npm test` (uses tsx; no build needed).
 */
import { strict as assert } from "node:assert";
import { Screen, toolCount } from "../src/screen.js";
import type { Entry } from "../src/store.js";

const ESC = "\u001b[";
/**
 * Everything the terminal control sequences occupy, for measuring a row.
 *
 * Note: only ever use this with `String.replace` -- in ES2022 (what
 * tsconfig targets) `replaceAll` throws if the pattern is global.
 */
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
/** The caret placement: ESC[<row>;<col>H then show-cursor. */
const CARET = new RegExp(`^\\u001b\\[(\\d+);(\\d+)H\\u001b\\[\\?25h$`);
const strip = (s: string) => s.replace(ANSI, "");

/** A frame as the terminal would apply it. */
interface Frame {
  /** Painted rows, in order, exactly as `draw()` joined them. */
  rows: string[];
  /** Caret position from the last cursor placement, 1-based, or null. */
  caret: { row: number; col: number } | null;
  /** How many full-frame paints the render emitted. Cells: one paint per frame. */
  paints: number;
}

/**
 * Render one state and capture what reached stdout.
 *
 * `process.stdout.write` is swapped out for the duration of the render, so the
 * test never touches the real terminal. The size is re-applied here as well as
 * in `screenAt` because `draw()` and `placeCursor()` re-read `this.rows`/
 * `this.cols`, which the screen cached when it was constructed.
 */
function renderAt(cols: number, rows: number, screen: Screen, state: Parameters<Screen["render"]>[0]): Frame {
  const stdout = process.stdout as unknown as { columns: number; rows: number; write: unknown };
  const realColumns = stdout.columns;
  const realRows = stdout.rows;
  const realWrite = stdout.write;
  const writes: string[] = [];
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.write = (chunk: string) => {
    // Only colour sequences are removed: those end in "m". Everything the test
    // looks for -- ESC[H and ESC[<row>;<col>H -- ends in "H" and is kept.
    writes.push(String(chunk).replace(/\x1b\[[0-9;?]*m/g, ""));
    return true;
  };

  try {
    screen.render(state);
  } finally {
    stdout.write = realWrite;
    stdout.columns = realColumns;
    stdout.rows = realRows;
  }

  // A paint is the write that homes the cursor and repaints the frame; the
  // small writes around it are the cursor park and the caret placement.
  const paintWrites = writes.filter((w) => w.startsWith(ESC + "H"));
  const caretWrites = writes.filter((w) => CARET.test(w));
  assert.ok(
    caretWrites.length <= 1,
    `a frame should place the caret at most once, got ${caretWrites.length}`
  );
  const match = caretWrites[0] ? CARET.exec(caretWrites[0]) : null;

  return {
    rows: paintWrites.join("").split("\r\n"),
    caret: match ? { row: Number(match[1]), col: Number(match[2]) } : null,
    paints: paintWrites.length,
  };
}

/**
 * Build a Screen *at* the given terminal size.
 *
 * `Screen` caches `stdout.columns`/`rows` when it is constructed, so the size
 * has to be in place first; setting it on an existing screen does nothing.
 * Process-lifetime side effects are never started (`start()` is not called), so
 * nothing here touches the real terminal.
 */
function screenAt(cols: number, rows: number): Screen {
  const stdout = process.stdout as unknown as { columns: number; rows: number };
  stdout.columns = cols;
  stdout.rows = rows;
  return new Screen(true, "1.6.2");
}

interface Case {
  cols: number;
  rows: number;
}

const SIZES: Case[] = [
  { cols: 80, rows: 24 },
  { cols: 70, rows: 16 },
  { cols: 40, rows: 12 },
  { cols: 120, rows: 40 },
];

const entries: Entry[] = [
  { role: "user", text: "hello there" },
  { role: "assistant", text: "hi" },
];

const items = Array.from({ length: 8 }, (_, i) => ({
  label: `session title ${i}`,
  detail: "3 msgs · idle · 11/1/2025, 10:00:00 AM",
}));

/** The chat view, with the picker closed. */
function chatState(input = "hi", cursor = 2, runningTools = 0, status = "idle", tools = {}) {
  return {
    entries,
    input,
    cursor,
    status,
    runningTools,
    toolSeq: 0,
    toolPeak: 0,
    ...tools,
    title: "a session",
    sessionIndex: 0,
    sessionCount: 8,
    scrollOffset: 0,
    picker: null,
    rename: null,
  };
}

/** The chat view with the picker open at `index`. */
function pickerState(index = 0, query = "abc", cursor = 3) {
  return {
    ...chatState(),
    picker: { items, index, query, cursor, renaming: false, help: null, helpTop: 0 },
  };
}

/** Rows the input line occupies for `input`, mirroring `Screen.inputRows`. */
function inputRowsFor(input: string, cols: number): number {
  if (input.length === 0) return 1;
  return Math.max(1, Math.ceil(input.length / Math.max(10, cols - 3)));
}

/**
 * Transcript rows a chat frame budgets: the terminal less its reserved bottom
 * row, less header + blank + blank + input + status.
 */
function expectedViewport(rows: number, cols: number, input: string): number {
  return Math.max(1, rows - 1 - 4 - inputRowsFor(input, cols));
}

/**
 * Common invariants for any frame at `cols` x `rows`.
 *
 *  - exactly one paint, so a frame is never drawn twice;
 *  - at most the terminal's height, so nothing scrolls past the top (which is
 *    what pushed the header out of view in earlier bugs);
 *  - no row reaching the last column, which puts the terminal in its
 *    pending-wrap state and shifts every row after it down one.
 */
function checkFrame(frame: Frame, { cols, rows }: Case, label: string): void {
  assert.equal(frame.paints, 1, `${label}: expected exactly one paint`);
  assert.ok(
    frame.rows.length <= rows,
    `${label}: frame is ${frame.rows.length} rows, terminal is ${rows} -- it would scroll`
  );
  frame.rows.forEach((row, i) => {
    assert.ok(
      strip(row).length <= cols - 1,
      `${label}: row ${i} is ${strip(row).length} cols wide, max is ${cols - 1}: ${JSON.stringify(strip(row))}`
    );
  });
  // Every frame must place the caret itself; a frame that leaves it where
  // `draw()` parked it (1;1) is the bug that made the cursor flash in the
  // top-left corner.
  assert.ok(frame.caret, `${label}: no caret was placed`);
}

/** Every row that begins with the prompt gutter. */
function gutterRows(frame: Frame): number[] {
  const rows: number[] = [];
  frame.rows.forEach((row, i) => {
    if (strip(row).startsWith("> ")) rows.push(i);
  });
  return rows;
}

/**
 * Index of the chat view's input row, or -1.
 *
 * The transcript draws user messages with the same "> " gutter, so the input
 * line is the *last* gutter row -- the one after the transcript, its blank
 * spacer and the blank above the input.
 */
function chatInputRow(frame: Frame): number {
  const rows = gutterRows(frame);
  return rows.length === 0 ? -1 : rows[rows.length - 1];
}

/**
 * Index of the picker's entry field, or -1.
 *
 * With the transcript hidden there is a single gutter row (the field's first
 * line), so the *first* one is the field -- and unlike the chat view it stays
 * correct when the query wraps onto further rows.
 */
function pickerFieldRow(frame: Frame): number {
  const rows = gutterRows(frame);
  return rows.length === 0 ? -1 : rows[0];
}

for (const size of SIZES) {
  const label = (s: string) => `${size.cols}x${size.rows} ${s}`;

  // ---- The chat view: caret on the input row, transcript budgeted correctly --
  {
    const screen = screenAt(size.cols, size.rows);
    const state = chatState();
    const frame = renderAt(size.cols, size.rows, screen, state);
    checkFrame(frame, size, label("chat"));
    const inputRow = chatInputRow(frame);
    assert.ok(inputRow >= 0, label("chat: no input row drawn"));
    assert.equal(
      frame.caret!.row,
      inputRow + 1,
      label("chat: caret is not on the input row")
    );
    assert.equal(
      screen.viewportRows,
      expectedViewport(size.rows, size.cols, state.input),
      label("chat: transcript viewport does not match the height budget")
    );
  }

  // ---- The picker: full screen, caret in the entry field --------------------
  {
    const screen = screenAt(size.cols, size.rows);
    const state = pickerState();
    const frame = renderAt(size.cols, size.rows, screen, state);
    checkFrame(frame, size, label("picker"));
    assert.equal(
      frame.caret!.row,
      pickerFieldRow(frame) + 1,
      label("picker: caret is not in the entry field")
    );
    // The list takes every row the fixed chrome leaves instead of being capped
    // at a third of the terminal (the old behaviour). Its rows are filled out
    // with blanks, so what proves it has the height is that the chrome -- the
    // rows that are neither sessions nor filler -- stays a small fixed block
    // however many sessions there are.
    const sessionRows = frame.rows.filter((r) => strip(r).includes("session title")).length;
    // Blank filler rows are not "chrome" -- they are the list using its height.
    const blankRows = frame.rows.filter((r) => strip(r).trim() === "").length;
    const chromeRows = frame.rows.length - sessionRows - blankRows;

    // Everything that is neither a session row nor blank filler: header, the
    // two rules, the heading, the entry field (including its "> " gutter row,
    // which does not mention a session), the closing rule and the hint -- eight
    // rows in all.
    assert.ok(
      chromeRows <= 8,
      label(`picker: ${chromeRows} non-session rows -- the list is not using the extra height`)
    );
    assert.ok(
      sessionRows >= 3,
      label(`picker: only ${sessionRows} session rows drawn, list is not filling the height`)
    );
    // The picker owns the frame from row 2 down, so nothing from the previous
    // conversation may survive on screen at all.
    assert.ok(
      !frame.rows.some((r) => strip(r).includes("hello there")),
      label("picker: transcript text is visible inside the picker frame")
    );
  }

  // ---- Closing the picker: the chat frame must not reflow ------------------
  //
  // This is the transition that broke: a picker frame that reported a zero
  // transcript budget made the *next* chat frame lay out against a full
  // terminal, so the input and status lines were drawn in the wrong rows and
  // jumped on the frame after.
  {
    const screen = screenAt(size.cols, size.rows);
    const state = chatState();
    const before = renderAt(size.cols, size.rows, screen, state);
    renderAt(size.cols, size.rows, screen, pickerState());
    const after = renderAt(size.cols, size.rows, screen, state);
    assert.equal(
      chatInputRow(after),
      chatInputRow(before),
      label("chat: the input row moved after opening and closing the picker")
    );
    assert.deepEqual(after.caret, before.caret, label("chat: the caret moved after the picker"));
    assert.equal(
      screen.viewportRows,
      expectedViewport(size.rows, size.cols, state.input),
      label("chat: the transcript viewport is wrong after the picker closed")
    );
  }

  // ---- A picker frame reports the chat view's budget, not zero ------------
  {
    const screen = screenAt(size.cols, size.rows);
    const state = chatState();
    renderAt(size.cols, size.rows, screen, pickerState());
    assert.equal(
      screen.viewportRows,
      expectedViewport(size.rows, size.cols, state.input),
      label("picker: the frame left a wrong transcript viewport behind")
    );
  }

  // ---- A wrapped query keeps the caret in the field ----------------------
  {
    const screen = screenAt(size.cols, size.rows);
    const query = "a long first message ".repeat(6);
    const frame = renderAt(
      size.cols,
      size.rows,
      screen,
      pickerState(2, query, query.length)
    );
    checkFrame(frame, size, label("picker/wrapped"));
    // The query wraps over several rows, so the caret sits on the last of them
    // -- the row above the closing rule.
    const wrappedRows = Math.ceil(query.length / Math.max(10, size.cols - 3));
    assert.equal(
      frame.caret!.row,
      pickerFieldRow(frame) + wrappedRows,
      label("picker/wrapped: caret is not on the last row of the entry field")
    );
  }
}

// ---- A terminal too short for the picker's chrome must still fit ----------
{
  const size = { cols: 15, rows: 7 };
  const screen = screenAt(size.cols, size.rows);
  const frame = renderAt(size.cols, size.rows, screen, pickerState());
  checkFrame(frame, size, "15x7 picker");
  assert.equal(
    frame.caret!.row,
    pickerFieldRow(frame) + 1,
    "15x7 picker: caret is not in the entry field"
  );
}

// ---- The status line: a live tool count, not keyboard hints --------------
//
// `async` because the linger-expiry case below has to wait out a real timer.
await (async () => {
  // Pluralisation: one tool is the common case and the easiest to get wrong.
  assert.equal(toolCount(1), "1 tool");
  assert.equal(toolCount(5), "5 tools");
  assert.equal(toolCount(0), "0 tools");

  const size = { cols: 80, rows: 24 };
  const statusLine = (frame: Frame) => strip(frame.rows[frame.rows.length - 2]).trim();
  // The "· N tool(s)" segment, or "" when there is none.
  const toolSegment = (frame: Frame) => /· \d+ tools?/.exec(statusLine(frame))?.[0].slice(2) ?? "";

  // Idle, nothing running: the session alone is 1 tool, and none of the old
  // key hints are back.
  {
    const screen = screenAt(size.cols, size.rows);
    const frame = renderAt(size.cols, size.rows, screen, chatState());
    const line = statusLine(frame);
    assert.ok(line.startsWith("○ idle"), `idle status line was ${JSON.stringify(line)}`);
    assert.equal(
      toolSegment(frame),
      "1 tool",
      `a session on its own should read "1 tool", got ${JSON.stringify(line)}`
    );
    for (const gone of ["← sessions", "Ctrl+C exit", "↑↓ scroll"]) {
      assert.ok(
        !frame.rows.some((r) => strip(r).includes(gone)),
        `status bar still shows the old hint ${JSON.stringify(gone)}`
      );
    }
  }

  // The count is of tools *in use*, counting the session. Two calls running at
  // once reads 2 -- not 3 (session + 2), and not 2 as "calls launched" either:
  // the session is one of the two.
  {
    const screen = screenAt(size.cols, size.rows);
    const frame = renderAt(
      size.cols,
      size.rows,
      screen,
      chatState("", 0, 2, "thinking", { toolSeq: 1, toolPeak: 2 })
    );
    const line = statusLine(frame);
    assert.ok(line.includes("● thinking"), `thinking status line was ${JSON.stringify(line)}`);
    // Compare the segment exactly: the transcript above the status line can
    // contain "session title 2", so a substring check is not enough.
    assert.equal(toolSegment(frame), "2 tools", `status line was ${JSON.stringify(line)}`);
  }

  // One call alongside the session *still* reads "1 tool": that call is the
  // session's own work, so it does not raise the total. This is the case that
  // must not read "2 tools".
  {
    const screen = screenAt(size.cols, size.rows);
    const frame = renderAt(
      size.cols,
      size.rows,
      screen,
      chatState("", 0, 1, "thinking", { toolSeq: 1, toolPeak: 1 })
    );
    assert.equal(
      toolSegment(frame),
      "1 tool",
      `a lone call must not raise the count, got ${JSON.stringify(statusLine(frame))}`
    );
  }

  // THE POINT OF THE LINGER: a tool that finished before any frame was drawn
  // still gets counted. Rendering is frame-based, so a fast batch can begin and
  // end between two frames -- and a count that only appeared *while* a call was
  // in flight would never be seen. Here the run is already over and the frame
  // must still include it.
  {
    const screen = screenAt(size.cols, size.rows);
    const frame = renderAt(
      size.cols,
      size.rows,
      screen,
      chatState("", 0, 0, "idle", { toolSeq: 1, toolPeak: 1 })
    );
    assert.equal(
      toolSegment(frame),
      "1 tool",
      "a finished single-call run leaves the session at 1 tool"
    );
  }

  // A batch reports its peak: five calls finishing between frames read as 5.
  {
    const screen = screenAt(size.cols, size.rows);
    const frame = renderAt(
      size.cols,
      size.rows,
      screen,
      chatState("", 0, 0, "idle", { toolSeq: 1, toolPeak: 5 })
    );
    assert.equal(toolSegment(frame), "5 tools", "a finished 5-call batch must read 5");
  }

  // A gap between runs keeps the count up; it must not blink off. Two calls are
  // used so the value is distinguishable from the floor of 1.
  {
    const screen = screenAt(size.cols, size.rows);
    renderAt(size.cols, size.rows, screen, chatState("", 0, 0, "thinking", { toolSeq: 1, toolPeak: 2 }));
    const frame = renderAt(
      size.cols,
      size.rows,
      screen,
      chatState("", 0, 0, "thinking", { toolSeq: 2, toolPeak: 2 })
    );
    assert.equal(toolSegment(frame), "2 tools", "the count must survive the gap between calls");
  }

  // A new run replaces the old count immediately rather than lingering.
  {
    const screen = screenAt(size.cols, size.rows);
    renderAt(size.cols, size.rows, screen, chatState("", 0, 0, "thinking", { toolSeq: 1, toolPeak: 2 }));
    const frame = renderAt(
      size.cols,
      size.rows,
      screen,
      chatState("", 0, 0, "thinking", { toolSeq: 2, toolPeak: 4 })
    );
    assert.equal(toolSegment(frame), "4 tools", "a new batch must show its own size, not the previous one");
  }

  // The count is not permanent: once the linger expires it falls back to the
  // session alone. This needs a real wait, so it is the one time-based case.
  {
    const screen = screenAt(size.cols, size.rows);
    const run = chatState("", 0, 0, "idle", { toolSeq: 1, toolPeak: 2 });
    const during = renderAt(size.cols, size.rows, screen, run);
    assert.equal(toolSegment(during), "2 tools", "the count should show right after the run");

    // Wait out the linger (1.5s, plus margin) and redraw the same state.
    await new Promise((r) => setTimeout(r, 1600));
    const after = renderAt(size.cols, size.rows, screen, run);
    assert.equal(
      toolSegment(after),
      "1 tool",
      `after the linger it should fall back to the session alone, got ${JSON.stringify(toolSegment(after))}`
    );
  }

  // A session locked by another coda says so on its row, and the hint explains
  // the remedy. Without this the refusal was invisible: it went to the
  // transcript, which the full-screen picker does not draw.
  {
    const screen = screenAt(size.cols, size.rows);
    const lockedItems = [
      { label: "free session", detail: "3 msgs · idle", locked: null },
      { label: "held session", detail: "9 msgs · idle", locked: "pid 4027" },
    ];
    const frame = renderAt(size.cols, size.rows, screen, {
      ...chatState(),
      picker: { items: lockedItems, index: 0, query: "", cursor: 0, renaming: false, help: null, helpTop: 0 },
    });
    const rows = frame.rows.map(strip);
    const heldRow = rows.find((r) => r.includes("held session"));
    assert.ok(heldRow, "the locked session should be listed");
    assert.ok(
      heldRow!.includes("open in pid 4027"),
      `the locked row should say who holds it, got ${JSON.stringify(heldRow)}`
    );
    // Its own detail is replaced by the lock message -- the count is not useful
    // for a row that cannot be opened.
    assert.ok(!heldRow!.includes("9 msgs"), "the locked row should show the lock, not its stats");
    // A free row keeps its detail and gains no marker.
    const freeRow = rows.find((r) => r.includes("free session"))!;
    assert.ok(freeRow.includes("3 msgs"), "an unlocked row keeps its detail");
    assert.ok(!freeRow.includes("open in"), "an unlocked row must not be marked locked");
    // The hint explains the remedy, and the whole frame still fits.
    assert.ok(
      rows.some((r) => r.includes("open in another coda")),
      "the hint should explain why the row cannot be opened"
    );
    checkFrame(frame, size, `picker/locked ${size.cols}x${size.rows}`);
  }

  // No locked rows: no note, and nothing invented.
  {
    const screen = screenAt(size.cols, size.rows);
    const frame = renderAt(size.cols, size.rows, screen, pickerState());
    assert.ok(
      !frame.rows.some((r) => strip(r).includes("open in another coda")),
      "the lock note must not appear when nothing is locked"
    );
  }

  // The rename editor keeps its own hint: Enter and Esc mean something else
  // there, so dropping it would make it easy to discard an edit by accident.
  {
    const screen = screenAt(size.cols, size.rows);
    const state = { ...chatState("", 0), rename: { title: "old", value: "new", cursor: 3 } };
    const frame = renderAt(size.cols, size.rows, screen, state);
    const line = statusLine(frame);
    assert.ok(line.includes("Enter save"), `rename hint missing from ${JSON.stringify(line)}`);
  }
})();

// ---- Help shown over the picker -----------------------------------------
//
// `/help` typed into the picker shows the reference between the list and the
// entry field rather than closing the overlay, so the highlighted row stays put
// while it is read. Help is asked for deliberately, so it takes the rows it
// needs first and the list is shortened -- the reader is looking at the block,
// not the list, while it is open.
const HELP = [
  "Commands:",
  "  /help, /?           Show this list",
  "  /quit, /exit        Exit and save sessions",
  "",
  "Keys:",
  "  Enter               Send the line",
  "  Ctrl+R              Open the session picker",
  "  Ctrl+T / Ctrl+X     New session / close current session",
  "  Alt+R               Rename the current session",
  "  In the picker:  ↑/↓ move · Enter open · Ctrl+X delete",
  "  Ctrl+V              Attach a clipboard image",
  "  Ctrl+C              Exit",
];

const helpState = (help: string[] | null, helpTop = 0) => ({
  ...pickerState(0, "", 0),
  picker: { ...pickerState().picker!, help, helpTop },
});

for (const size of SIZES) {
  const screen = screenAt(size.cols, size.rows);
  const frame = renderAt(size.cols, size.rows, screen, helpState(HELP));
  checkFrame(frame, size, "picker+help");
  const text = frame.rows.map(strip).join("\n");
  // Help is an overlay on the picker, not a replacement: the list must still be
  // there to go back to when the block is dismissed.
  assert.ok(/session title/.test(text), `${size.cols}x${size.rows}: help hid the list entirely`);
  // The block starts at its first line and is never drawn with rows missing in
  // the middle -- a block that silently skips lines is worse than a short one.
  assert.ok(text.includes(HELP[0]), `${size.cols}x${size.rows}: help block missing`);
  // Blank lines are shared with the rest of the frame, so match only content.
  // Both sides are trimmed: the reference is indented for display, and a row
  // may also be cut short by a narrow terminal.
  const wanted = HELP.filter((l) => l.trim()).map((l) => l.trim());
  const drawn = frame.rows
    .map(strip)
    .map((r) => r.trim())
    .filter((r) => r && wanted.includes(r));
  const fromStart = wanted.slice(0, drawn.length);
  assert.deepEqual(
    drawn,
    fromStart,
    `${size.cols}x${size.rows}: help rows are not the first ${drawn.length} lines, in order`
  );
}

// On a normal terminal the whole reference fits: no scrolling needed, and no
// truncated block that reads as the complete list.
for (const size of [
  { cols: 80, rows: 24 },
  { cols: 120, rows: 40 },
]) {
  const screen = screenAt(size.cols, size.rows);
  const frame = renderAt(size.cols, size.rows, screen, helpState(HELP));
  const text = frame.rows.map(strip).join("\n");
  const missing = HELP.filter((l) => l && !text.includes(l));
  assert.equal(
    missing.length,
    0,
    `${size.cols}x${size.rows}: help should fit whole, missing ${JSON.stringify(missing)}`
  );
}

// Scrolling: `helpTop` picks the first line drawn, and the block is clamped so
// scrolling past the end shows the tail rather than a blank screen.
//
// A short terminal is used deliberately: at 80x24 the whole reference fits, so
// there is nothing to scroll and `helpTop` is correctly clamped to 0.
{
  const size = { cols: 70, rows: 16 };
  const screen = screenAt(size.cols, size.rows);
  const top = renderAt(size.cols, size.rows, screen, helpState(HELP, 0));
  assert.ok(strip(top.rows.join("\n")).includes(HELP[0]), "top of block should start at line 0");

  const scrolled = renderAt(size.cols, size.rows, screen, helpState(HELP, 3));
  const text = strip(scrolled.rows.join("\n"));
  assert.ok(!text.includes(HELP[0]), "scrolling down should drop the first line");
  assert.ok(text.includes(HELP[3]), "scrolling to 3 should draw line 3 first");

  // Past the end the renderer clamps: the last line stays visible.
  const past = renderAt(size.cols, size.rows, screen, helpState(HELP, 999));
  checkFrame(past, size, "picker+help scrolled past end");
  const pastText = strip(past.rows.join("\n"));
  assert.ok(
    pastText.includes(HELP[HELP.length - 1]),
    "scrolled past the end, the last line must still be drawn"
  );
  assert.ok(pastText.includes(HELP[0]) === false, "the first line should be gone after scrolling");
}

// The hint row names the way out while the block is open. Without it the
// standing picker hint describes keys that are scrolling help rather than the
// list, and nothing on screen says how to get back.
{
  const size = { cols: 80, rows: 24 };
  const screen = screenAt(size.cols, size.rows);
  const statusLine = (f: Frame) => strip(f.rows[f.rows.length - 2]).trim();

  const withHelp = renderAt(size.cols, size.rows, screen, helpState(HELP));
  assert.ok(
    statusLine(withHelp).includes("Esc to close"),
    `hint should say how to close the help block, got ${JSON.stringify(statusLine(withHelp))}`
  );

  const withoutHelp = renderAt(size.cols, size.rows, screen, helpState(null));
  assert.ok(
    !statusLine(withoutHelp).includes("Esc to close"),
    "the plain picker hint must not mention closing help"
  );
  assert.ok(
    statusLine(withoutHelp).includes("pick"),
    "the plain picker hint should be back once help is dismissed"
  );
}

// Esc dismisses the help and returns to the list, rather than closing the
// picker -- opening help was a detour from picking a session. What is checked
// here is the rendering side: clearing `help` gives the list its rows back.
{
  const size = { cols: 80, rows: 24 };
  const screen = screenAt(size.cols, size.rows);
  const withHelp = renderAt(size.cols, size.rows, screen, helpState(HELP));
  const withoutHelp = renderAt(size.cols, size.rows, screen, helpState(null));
  const listRows = (f: Frame) => f.rows.map(strip).filter((r) => /session title/.test(r)).length;
  assert.ok(
    listRows(withoutHelp) > listRows(withHelp),
    "dismissing help should give the list its rows back"
  );
  assert.ok(
    !strip(withoutHelp.rows.join("\n")).includes(HELP[0]),
    "help must be gone once `help` is null"
  );
}

process.stderr.write("screen: all frame invariants hold\n");
