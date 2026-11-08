/**
 * A handover arrives as the new session's first message, not staged in its
 * input.
 *
 * The point is possession: only what is in `messages` reaches the model, and
 * text parked in the input buffer reaches nothing until the user presses Enter.
 * A handover sitting in the input box is therefore both invisible to the agent
 * and a demand that the user review and send something they did not write.
 *
 * So `new_session` seeds it into the history once, at creation. From then on it
 * is ordinary history: sent with each request like any other message, but never
 * re-read from disk or rebuilt.
 *
 * What matters here:
 *
 *  - it lands in `messages` (so the model has it) and in `entries` (so it is
 *    visible when scrolling back);
 *  - it is labelled as a handover, not passed off as the user's own words;
 *  - seeding does not start a turn -- the session stays idle;
 *  - the session is no longer "empty", so nothing prunes it as a placeholder.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";

import { mkdirSync } from "node:fs";

// Isolate on-disk state: this test writes a real session record, which must not
// land in the user's live ~/.coda/sessions.
const dir = `${process.env.TMPDIR ?? "/tmp"}/coda-handover-${process.pid}`;
process.env.CODA_SECRETS_DIR = dir;
process.env.CODA_SESSIONS_DIR = `${dir}/sessions`;
mkdirSync(process.env.CODA_SESSIONS_DIR, { recursive: true });
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { Session } = await import("../src/session.js");
const { SESSIONS_DIR, loadAll } = await import("../src/store.js");

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

// --- the handover is in the history and in the transcript ----------------

{
  const s = new Session(config);
  const before = s.history.length;

  await s.seedHandover("PR #58 is open. Do not merge it.");

  assert.equal(
    s.history.length,
    before + 1,
    "exactly one message is added"
  );
  const msg: any = s.history[s.history.length - 1];
  assert.equal(msg.role, "user", "the handover rides as a user message");
  assert.ok(
    msg.content.includes("PR #58 is open. Do not merge it."),
    "the handover text is present verbatim"
  );
  assert.ok(
    /\[handover from the previous session\]/.test(msg.content),
    `the handover must be labelled as such: ${JSON.stringify(msg.content.slice(0, 60))}`
  );

  // The transcript is what gets drawn, so the handover must NOT be in it: it is
  // context the session needs, not something the user asked to see.
  assert.deepEqual(
    s.entries,
    [],
    `the handover must not be drawn in the transcript, got ${JSON.stringify(s.entries)}`
  );

  assert.equal(s.status, "idle", "seeding must not start a turn");
  await s.release();
}

// --- an empty or blank handover adds nothing -----------------------------

{
  const s = new Session(config);
  const before = s.history.length;
  await s.seedHandover("   \n  ");
  assert.equal(s.history.length, before, "a blank handover is ignored");
  assert.equal(s.entries.length, 0);
  await s.release();
}

// --- a seeded session still persists, despite having no entries ----------
//
// A seeded session looks untouched: no entries, default title. `persist` used
// to skip that, which silently dropped the handover on reload. Removing the
// transcript entry must not bring that back.

{
  const { loadAll } = await import("../src/store.js");
  const s = new Session(config);
  await s.seedHandover("context that must survive");
  const rec = (await loadAll()).find((r) => r.id === s.id);
  assert.ok(
    rec,
    "the seeded session was written even though it has no entries"
  );
  await s.delete();
}

// --- the handover survives a reload --------------------------------------
//
// It is injected once, from `seedHandover`, and nothing re-creates it later.
// If it were not written to disk immediately it would be lost by restarting
// before the first message, with no second copy to recover it from.

{
  const s = new Session(config);
  // No explicit persist: seeding must write the record itself, because it is
  // the only injection point and nothing re-creates the handover later.
  await s.seedHandover("do not merge PR #58");

  const all = await loadAll();
  const rec = all.find((r) => r.id === s.id);
  assert.ok(rec, "the seeded session was written to disk");
  assert.equal(
    rec!.entries.length,
    0,
    "the handover is not written into the transcript"
  );
  const stored: any[] = rec!.messages;
  assert.ok(
    stored.some(
      (m: any) => m.role === "user" && String(m.content).includes("do not merge PR #58")
    ),
    "the handover message survives in the history"
  );

  // Reopening yields the same context, without re-seeding it.
  const reopened = new Session(config, rec!);
  assert.ok(
    reopened.history.some(
      (m: any) => m.role === "user" && String(m.content).includes("do not merge PR #58")
    ),
    "a reopened session still holds the handover"
  );

  await s.delete();
}

// --- a prompt in a seeded session runs there, not in a new session --------
//
// The handover lives in `messages`, never `entries`, so a seeded session has no
// entries -- the same shape as an untouched placeholder. `submitPrompt` used to
// treat any session with no entries as a placeholder and route the prompt to
// `startNewSessionWith`, which opens a second session and makes the prompt its
// first message. The handover was silently dropped and the user was moved.
//
// This pins the predicate that routing rests on: `entries.length === 0 &&
// !seeded`. A seeded session must be distinguishable from a bare placeholder by
// the property `submitPrompt` actually tests.
{
  const seeded = new Session(config);
  await seeded.seedHandover("context the next message must not lose");

  assert.equal(
    seeded.entries.length,
    0,
    "a seeded session still has no entries, so entries alone cannot decide"
  );
  assert.equal(seeded.seeded, true, "seeded marks it as not-a-placeholder");

  const placeholder = new Session(config);
  assert.equal(placeholder.entries.length, 0);
  assert.equal(
    placeholder.seeded,
    false,
    "a truly new session is not seeded, so it still routes to a new session"
  );

  // Ordinary typing must not make a session look seeded.
  await placeholder.seedHandover("   ");
  assert.equal(
    placeholder.seeded,
    false,
    "a blank handover seeds nothing and must not mark the session"
  );

  await seeded.delete();
  await placeholder.delete();
}

// --- the marker survives a restart ---------------------------------------
//
// This is the case that actually bit: the session is created, the handover is
// seeded, coda is restarted before the user types anything, and the session is
// rebuilt from its record. If `seeded` were an in-memory flag set only by
// `seedHandover`, the reloaded session would come back with `seeded === false`
// and no entries -- indistinguishable from a placeholder -- so the user's first
// prompt would open a second session and lose the handover again.
{
  const s = new Session(config);
  await s.seedHandover("do not merge PR #58");
  await s.release();

  const rec = (await loadAll()).find((r) => r.id === s.id);
  assert.ok(rec, "the seeded session reached disk");

  const reopened = new Session(config, rec!);
  assert.equal(
    reopened.entries.length,
    0,
    "the handover is still not drawn after a reload"
  );
  assert.equal(
    reopened.seeded,
    true,
    "a reloaded seeded session is still seeded, so its first prompt runs here"
  );
  assert.equal(
    reopened.entries.length === 0 && !reopened.seeded,
    false,
    "a reloaded seeded session must not route its first prompt to a new session"
  );

  await reopened.delete();
}

console.log("handover-seeded: ok");
