/**
 * A system note must not make a fresh session disappear.
 *
 * `refreshSessionsFromDisk` reconciles the in-memory list against the session
 * directory, so it can pick up edits and deletions made in another terminal.
 * Anything in `this.sessions` that is not on disk is normally treated as
 * deleted elsewhere and dropped -- which is wrong for a session this terminal
 * has never saved, because such a session has no file yet.
 *
 * The exemption used to be `entries.length === 0`, standing in for "new and
 * unsaved". A note written into a fresh session broke that: `/help` in the
 * picker calls `systemNote`, which pushes into `current().entries`, so the
 * startup placeholder went from no entries to one. On the next picker refresh
 * it was no longer empty, no longer on disk, and not mid-turn -- so it was
 * dropped. The user saw the row they had just been typing into vanish.
 *
 * These tests pin the rule the reconcile now uses: a session that has never
 * been persisted survives regardless of its transcript.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { rmSync } from "node:fs";
import type { Config } from "../src/config.js";

// `store.ts` resolves SESSIONS_DIR once, at module load, so the directory has to
// be chosen before anything imports it -- including `session.js`, which pulls it
// in transitively. Those two are therefore imported dynamically, below, after
// the environment is set; a static import would be hoisted above this line and
// point the tests at the real `~/.coda/sessions`.
const dir = `${process.env.TMPDIR ?? "/tmp"}/coda-note-test-${process.pid}`;
process.env.CODA_SESSIONS_DIR = dir;
// `Session` builds an `Agent`, which wants a key. Nothing here sends a request.
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { Session } = await import("../src/session.js");
type Session = InstanceType<typeof Session>;
const { loadAll } = await import("../src/store.js");

const cfg = { compact: false, mouse: false } as unknown as Config;

/** The rule `refreshSessionsFromDisk` applies, as a standalone predicate. */
const survives = (
  s: Session,
  onDisk: Set<string>
): boolean => onDisk.has(s.id) || s.status === "thinking" || !s.persisted;

const diskIds = async (): Promise<Set<string>> =>
  new Set((await loadAll()).map((r) => r.id));

async function main() {
  rmSync(dir, { recursive: true, force: true });

  // --- a fresh session is not persisted until it has something to save -----

  const fresh = new Session(cfg);
  assert.equal(fresh.entries.length, 0, "a new session starts empty");
  assert.equal(fresh.persisted, false, "a new session is not persisted");
  assert.deepEqual([...await diskIds()], [], "a new session writes no file");

  // --- the bug: a note makes it non-empty, and it must still survive -------

  // Exactly what `/help` does: `systemNote` pushes a tool entry into current().
  fresh.entries.push({ role: "tool", name: "coda", ok: true, text: "Commands: ..." });
  assert.equal(fresh.entries.length, 1, "the note gave the session an entry");
  assert.equal(fresh.persisted, false, "a note alone does not persist it");
  assert.ok(
    survives(fresh, await diskIds()),
    "a fresh session with a note must survive a disk reconcile"
  );

  // The rule this replaced would drop it -- the regression being guarded.
  const onDisk = await diskIds();
  const oldRule = (s: Session) =>
    onDisk.has(s.id) || s.status === "thinking" || s.entries.length === 0;
  assert.equal(
    oldRule(fresh),
    false,
    "the previous entries.length rule really did drop a noted fresh session"
  );

  // --- once saved, it is on disk and survives on that basis ----------------

  await fresh.persist();
  assert.equal(fresh.persisted, true, "persist marks the session saved");
  assert.ok((await diskIds()).has(fresh.id), "persist writes the file");
  assert.ok(survives(fresh, await diskIds()), "a saved session is kept via onDisk");

  // --- and a saved session deleted elsewhere is still dropped --------------

  assert.equal(
    survives(fresh, new Set()),
    false,
    "a saved session missing from disk is deletion, not a placeholder"
  );

  // --- a session loaded from disk is persisted from the outset -------------

  const reloaded = new Session(cfg, {
    id: fresh.id,
    title: "x",
    cwd: "/",
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    entries: [{ role: "user", text: "hi" }],
  });
  assert.equal(reloaded.persisted, true, "a loaded record counts as persisted");

  // --- mid-turn is kept whatever else is true ------------------------------

  const running = new Session(cfg);
  running.status = "thinking";
  assert.ok(survives(running, new Set()), "a session mid-turn is kept");

  rmSync(dir, { recursive: true, force: true });
  console.log("session-note: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
