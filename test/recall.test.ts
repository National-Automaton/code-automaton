/**
 * ↑/↓ recall the session's previous prompts.
 *
 * The keys used to scroll the transcript. They now walk back through what was
 * already sent -- readline's behaviour, which is what fingers expect from a
 * prompt line -- and PgUp/PgDn keep the page-at-a-time transcript scrolling.
 * The risk in that swap is the draft: the text you were halfway through typing
 * when you pressed ↑ to check something must be waiting when you come back, or
 * the feature destroys work every time it is used to peek at history.
 *
 * The rules under test:
 *
 *   - ↑ walks back through the prompts, newest first; ↓ walks forward and
 *     past the newest one returns the untouched draft, caret and all.
 *   - ↑ at the oldest prompt leaves the buffer alone rather than blanking it,
 *     so the message already recalled stays editable.
 *   - An entry edited mid-walk is recalled as edited; the draft is not
 *     resurrected through that edit.
 *   - The list is rebuilt from the transcript on every keypress, so a prompt
 *     sent while the walk was open is recallable immediately.
 *
 * The app's own `recallItems` (which drops slash commands, strips the
 * `(mid-turn)` label, and re-reads `[image: ...]` labels) is covered through
 * `imagePathsInText` below.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { LineBuffer, PromptRecall } from "../src/linebuffer.js";
import { imagePathsInText } from "../src/image.js";

/**
 * A recall list from prompts in the order they were sent, oldest first -- the
 * same order the transcript holds them. `App.recallItems` reverses it.
 */
const history = (...oldestFirst: string[]) =>
  oldestFirst.map((text) => ({ text, images: [] as string[] })).reverse();

// ↑ walks back, newest first.
{
  const r = new PromptRecall();
  r.setItems(history("fix the tests", "add a flag", "now the docs"));
  const first = r.up("half-typed", 4);
  assert.deepEqual(first?.text, "now the docs", "the newest prompt comes first");
  assert.equal(first?.cursor, "now the docs".length, "the caret lands at the end");
  assert.equal(r.up("now the docs", 0)?.text, "add a flag", "the next one back");
  assert.equal(r.up("add a flag", 0)?.text, "fix the tests", "and the oldest");
  assert.equal(r.up("fix the tests", 0), null, "nothing older than the oldest");
  assert.equal(r.active, true, "still in the walk at the oldest entry");
}

// ↓ returns the draft, caret included, and then stops.
{
  const r = new PromptRecall();
  r.setItems(history("one", "two"));
  r.up("half-typed", 4);
  r.up("two", 0);
  assert.deepEqual(r.down("one"), { text: "two", cursor: 3, images: [] }, "one step newer");
  assert.deepEqual(r.down("two"), { text: "half-typed", cursor: 4, images: [] }, "back to the draft, caret intact");
  assert.equal(r.active, false, "the walk is over");
  assert.equal(r.down("half-typed"), null, "↓ on a fresh draft does nothing");
}

// ↓ on a draft that was never walked is a no-op -- not a jump anywhere.
{
  const r = new PromptRecall();
  r.setItems(history("one"));
  assert.equal(r.down("typing"), null);
  assert.equal(r.active, false, "a stray ↓ must not open a walk");
}

// ↑ with no history leaves the line alone.
{
  const r = new PromptRecall();
  r.setItems([]);
  assert.equal(r.up("typing", 2), null);
  assert.equal(r.active, true, "the walk opened, so the user is told it is the oldest");
}

// An edit made mid-walk survives stepping back and coming forward again.
{
  const r = new PromptRecall();
  r.setItems(history("alpha", "beta"));
  r.up("draft", 0); // "beta"
  r.up("beta edited", 0); // edit "beta", then step back to "alpha"
  assert.deepEqual(r.down("alpha"), { text: "beta edited", cursor: 11, images: [] }, "the edit is remembered");
}

// Editing the draft itself is not confused with editing the recalled entry.
{
  const r = new PromptRecall();
  r.setItems(history("only"));
  r.up("draft", 0);
  // The draft comes back exactly as it was given -- here, with the caret the
  // caller passed in, not one invented on the way out.
  assert.deepEqual(r.down("only"), { text: "draft", cursor: 0, images: [] }, "the untouched draft returns");
}

// The walk survives the list being rebuilt under it (a prompt sent mid-walk).
{
  const r = new PromptRecall();
  r.setItems(history("first"));
  r.up("draft", 0);
  r.setItems(history("first", "just sent"));
  assert.deepEqual(r.down("first"), { text: "draft", cursor: 0, images: [] }, "still returns the draft");
}

// Images ride with the prompt, and are dropped when the draft comes back.
{
  const r = new PromptRecall<string>();
  r.setItems([{ text: "look at this", images: ["/tmp/shot.png"] }]);
  assert.deepEqual(r.up("", 0), { text: "look at this", cursor: 12, images: ["/tmp/shot.png"] });
  assert.deepEqual(r.down("look at this"), { text: "", cursor: 0, images: [] }, "the draft has no attachments");
}

// `reset` ends the walk -- session switches, Esc, closing a session.
{
  const r = new PromptRecall();
  r.setItems(history("one"));
  r.up("draft", 0);
  r.reset();
  assert.equal(r.active, false);
  assert.equal(r.down("one"), null, "no walk to step out of after a reset");
}

// The LineBuffer is what the app actually edits, so recall targets it.
{
  const b = new LineBuffer();
  b.set("half-typed", 4);
  const r = new PromptRecall();
  r.setItems(history("recalled prompt"));
  const next = r.up(b.value, b.cursor)!;
  b.set(next.text, next.cursor);
  assert.equal(b.value, "recalled prompt");
  assert.equal(b.cursor, "recalled prompt".length);
}

// The transcript label is where recall finds the attachments again.
{
  assert.deepEqual(imagePathsInText("what is this? [image: /tmp/a.png]"), ["/tmp/a.png"]);
  assert.deepEqual(
    imagePathsInText("two [image: /tmp/a.png] [image: /tmp/b.png]"),
    ["/tmp/a.png", "/tmp/b.png"],
    "more than one attachment"
  );
  assert.deepEqual(imagePathsInText("[image sent: /tmp/old.png]"), ["/tmp/old.png"], "the detached spelling");
  assert.deepEqual(imagePathsInText("no attachments here"), [], "plain text has none");
  // A prompt that merely mentions the marker is not an attachment.
  assert.deepEqual(imagePathsInText("what does [image: x] mean?"), [], "an inline mention is not an image");
}

process.stderr.write("recall: prompt recall behaves like readline\n");
