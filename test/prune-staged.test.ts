/**
 * A staged session must survive the creation of the next session.
 *
 * `new_session` creates an empty session whose input holds an unsent handover
 * and sets `staged = true`. `newSession()` calls `pruneEmptySessions()` first,
 * and that used to delete every session with no entries and no work in flight --
 * including the staged one the user was about to review. Creating session B
 * therefore destroyed staged session A before it was ever looked at.
 *
 * The `staged` flag exists exactly to say "empty, but not a placeholder", and
 * `submitPrompt` already honours it. This asserts `pruneEmptySessions` does too.
 *
 * `App` itself needs a terminal, so this drives the private method on an object
 * carrying `App.prototype`: the method only reads `this.sessions` and
 * `this.activeId`, both set here.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";

const dir = `${process.env.TMPDIR ?? "/tmp"}/coda-prune-${process.pid}`;
process.env.CODA_SECRETS_DIR = dir;
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { App } = await import("../src/app.js");
const { Session } = await import("../src/session.js");

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

/** An `App` with no terminal, holding just the state the prune reads. */
function bareApp(sessions: any[], activeId: string | null): any {
  const a: any = Object.create(App.prototype);
  a.sessions = sessions;
  a.activeId = activeId;
  return a;
}

// --- a staged session is kept, an untouched placeholder is dropped --------

{
  const staged = new Session(config);
  staged.staged = true;
  const placeholder = new Session(config);
  const a = bareApp([placeholder, staged], staged.id);

  a.pruneEmptySessions();

  assert.deepEqual(
    a.sessions.map((s: any) => s.id),
    [staged.id],
    "the staged session survives; the bare placeholder is pruned"
  );
  assert.equal(a.activeId, staged.id, "the active session is untouched");
  await staged.release();
}

// --- a session with entries is never pruned, staged or not ---------------

{
  const worked = new Session(config);
  worked.entries.push({ role: "user", content: "hi" } as any);
  const a = bareApp([worked], worked.id);

  a.pruneEmptySessions();

  assert.equal(a.sessions.length, 1, "a session with entries is kept");
  await worked.release();
}

// --- pruning the active session re-points activeId ------------------------

{
  const placeholder = new Session(config);
  const other = new Session(config);
  other.staged = true;
  const a = bareApp([other, placeholder], placeholder.id);

  a.pruneEmptySessions();

  assert.deepEqual(
    a.sessions.map((s: any) => s.id),
    [other.id],
    "only the placeholder goes"
  );
  assert.equal(
    a.activeId,
    other.id,
    "activeId must not point at a pruned session"
  );
  await other.release();
}

console.log("prune-staged: ok");
