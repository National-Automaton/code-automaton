/**
 * Ctrl+X in the picker deletes the highlighted session -- and says so.
 *
 * Reported as "ctrl+X nothing happened. it was on a thinking session". It was
 * not a dead key: the delete reached `closeSession`, which refuses to kill a
 * turn that is still running and returned without a word. Nothing showed,
 * because the full-screen picker does not draw the transcript, so a note there
 * is invisible at exactly the moment it matters.
 *
 * The same key had a second, quieter fault. `closeSession` was written for
 * closing the session this terminal is *in*: it picks a replacement and takes
 * that session's lock. From the picker that meant one keypress switched the
 * session being worked in and locked one the user had never opened, denying it
 * to another terminal -- whose picker then showed "open in pid N".
 *
 * The rules under test:
 *
 *   - Ctrl+X on a mid-turn row deletes nothing and leaves a refusal the picker
 *     can draw (the hint row), not just a transcript note.
 *   - Ctrl+X on a plain row deletes it, releases its lock, and does not move
 *     the session this terminal is working in -- or lock a different one.
 *   - Ctrl+X on a row this terminal holds is refused rather than deleting the
 *     session out from under the connection using it.
 *   - The highlight lands on the row that took the deleted one's place.
 *   - The refusal clears on the next keypress, so it describes the last action
 *     rather than lingering.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.CODA_SESSIONS_DIR = mkdtempSync(path.join(tmpdir(), "coda-picker-delete-"));
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { App } = await import("../src/app.js");
const { Session } = await import("../src/session.js");
const { LineBuffer } = await import("../src/linebuffer.js");
const { lockHolder } = await import("../src/lock.js");

const config = {
  apiKey: "sk-test",
  baseURL: "https://text.example/v1",
  model: "deepseek-flash",
  visionModel: "gemini-3.6-flash",
  visionBaseURL: "https://vision.example/v1",
  visionApiKey: "sk-vision",
  mouse: false,
  parallelTools: true,
  compact: false,
} as any;

/** An App with `titles` as its sessions, newest first, and the picker open. */
async function appWith(titles: string[]): Promise<any> {
  const app: any = new App(config);
  const base = Date.now();
  titles.forEach((title, i) => {
    const s = new Session(config);
    s.title = title;
    // Newest first: the picker sorts by updatedAt, descending.
    s.updatedAt = base - i * 1000;
    app.sessions.push(s);
  });
  // The session this terminal is working in: not the row under the highlight.
  const active = app.sessions[0];
  app.setActive(active);
  await active.acquire();
  app.requestRender = () => {};
  app.picker = { index: 1, query: new LineBuffer(), help: null, helpTop: 0, notice: null };
  return app;
}

const ctrlX = (app: any) => app.onKey({ type: "ctrl", ch: "x" });
const titlesOnDisk = async (app: any) => app.pickerSessions().map((s: any) => s.title);

// --- a mid-turn row refuses, visibly --------------------------------------

{
  const app = await appWith(["alpha", "bravo", "charlie"]);
  const bravo = app.pickerSessions()[1];
  bravo.status = "thinking";

  ctrlX(app);

  assert.deepEqual(await titlesOnDisk(app), ["alpha", "bravo", "charlie"], "nothing is deleted");
  assert.ok(app.picker, "the picker stays open");
  assert.ok(
    /mid-turn/.test(app.picker.notice ?? ""),
    `the picker is told why nothing happened: ${JSON.stringify(app.picker.notice)}`
  );
  assert.ok(
    app.current().entries.some((e: any) => /mid-turn/.test(e.text)),
    "and it is still in the transcript after Esc"
  );
  assert.ok(
    !app.current().entries.some((e: any) => e.text === "that session is no longer in the list"),
    "the note is about the mid-turn row, not a stale index"
  );

  // The next keypress clears it: the note describes the last action only.
  app.onKey({ type: "down" });
  assert.equal(app.picker.notice, null, "the refusal does not outlive the next keypress");
}

// --- an ordinary row deletes, without disturbing this terminal ------------

{
  const app = await appWith(["alpha", "bravo", "charlie"]);
  const activeBefore = app.current().id;
  const heldBefore = app.current().lockHeld;
  const bravo = app.pickerSessions()[1];
  await bravo.persist();
  assert.equal(await lockHolder(bravo.id), null, "bravo is unlocked to begin with");

  ctrlX(app);

  assert.deepEqual(await titlesOnDisk(app), ["alpha", "charlie"], "the highlighted row is gone");
  assert.equal(app.current().id, activeBefore, "the session being worked in is unchanged");
  assert.equal(app.current().lockHeld, heldBefore, "and it is still the only lock this app holds");
  assert.ok(
    !app.pickerSessions().some((s: any) => s.lockHeld && s.id !== activeBefore),
    "no other session was locked behind the user's back"
  );
  assert.equal(app.picker.index, 1, "the highlight stays on the row that moved up");
  assert.equal(app.pickerSessions()[1].title, "charlie", "which is the one that took its place");
  assert.equal(app.picker.notice, null, "a successful delete has nothing to refuse");
}

// --- a row this terminal holds is not deleted out from under it ----------

{
  const app = await appWith(["alpha", "bravo", "charlie"]);
  app.picker.index = 0; // the active row, which this app holds the lock for

  ctrlX(app);

  assert.deepEqual(await titlesOnDisk(app), ["alpha", "bravo", "charlie"], "still there");
  assert.ok(/open here/.test(app.picker.notice ?? ""), "and the refusal explains how to delete it");
}

// --- deleting the last row leaves the list valid -------------------------

{
  const app = await appWith(["alpha", "bravo"]);
  app.picker.index = 1; // bravo, the only non-active row

  ctrlX(app);
  assert.deepEqual(await titlesOnDisk(app), ["alpha"], "bravo is gone");

  app.picker.index = 1; // now past the end
  ctrlX(app);
  assert.deepEqual(await titlesOnDisk(app), ["alpha"], "a stale index deletes nothing");
  assert.ok(
    /no longer in the list/.test(app.picker.notice ?? ""),
    "and says the row it was pointing at has gone"
  );
}

console.log("picker-delete: ok");
