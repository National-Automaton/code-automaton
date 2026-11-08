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
  const before = s.agent.messages.length;

  await s.seedHandover("PR #58 is open. Do not merge it.");

  assert.equal(
    s.agent.messages.length,
    before + 1,
    "exactly one message is added"
  );
  const msg: any = s.agent.messages[s.agent.messages.length - 1];
  assert.equal(msg.role, "user", "the handover rides as a user message");
  assert.ok(
    msg.content.includes("PR #58 is open. Do not merge it."),
    "the handover text is present verbatim"
  );
  assert.ok(
    /\[handover from the previous session\]/.test(msg.content),
    `the handover must be labelled as such: ${JSON.stringify(msg.content.slice(0, 60))}`
  );

  assert.equal(s.entries.length, 1, "the transcript shows it too");
  assert.equal(s.entries[0].role, "user");
  assert.ok(s.entries[0].text.includes("PR #58 is open"));

  assert.equal(s.status, "idle", "seeding must not start a turn");
  await s.release();
}

// --- an empty or blank handover adds nothing -----------------------------

{
  const s = new Session(config);
  const before = s.agent.messages.length;
  await s.seedHandover("   \n  ");
  assert.equal(s.agent.messages.length, before, "a blank handover is ignored");
  assert.equal(s.entries.length, 0);
  await s.release();
}

// --- a seeded session is not an empty placeholder ------------------------

{
  const s = new Session(config);
  await s.seedHandover("context");
  assert.notEqual(
    s.entries.length,
    0,
    "a seeded session has entries, so pruneEmptySessions leaves it alone"
  );
  await s.release();
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
  assert.ok(
    rec!.entries.some((e: any) => e.text.includes("do not merge PR #58")),
    "the transcript entry survives"
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
    reopened.agent.messages.some(
      (m: any) => m.role === "user" && String(m.content).includes("do not merge PR #58")
    ),
    "a reopened session still holds the handover"
  );

  await s.delete();
}

console.log("handover-seeded: ok");
