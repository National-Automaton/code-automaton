/**
 * A save must not silently discard a change somebody else wrote.
 *
 * `save` writes the whole record from memory, so without a check the last
 * writer wins outright -- including a process that loaded the file hours ago
 * and never noticed an external repair, another terminal, or a script. That is
 * exactly how a hand-repair to a damaged session was reverted twice: the
 * session had no lock, so every available signal said "safe to edit", and the
 * next save from an unrelated process put the broken copy back (#64).
 *
 * These tests pin the guard: a save whose file has moved on since it was loaded
 * is refused, the disk copy is reloaded instead of overwritten, and the caller
 * is told. Normal single-terminal use must be entirely unaffected.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

// A scratch sessions directory, set before the store reads it.
const dir = mkdtempSync(path.join(tmpdir(), "coda-clobber-"));
process.env.CODA_SESSIONS_DIR = dir;

const { Session } = await import("../src/session.js");
const { SessionReloadedError } = await import("../src/session.js");
const { loadAll, loadAllWithMtime, save, newId } = await import("../src/store.js");
const { SessionChangedOnDiskError } = await import("../src/store.js");
import type { Config } from "../src/config.js";

const cfg: Config = {
  apiKey: "sk-test",
  baseURL: "https://example.invalid",
  model: "text-model",
  visionModel: "vision-model",
  visionBaseURL: "https://example.invalid",
  visionApiKey: "sk-test",
  mouse: false,
  parallelTools: true,
  compact: false,
} as Config;

const fileOf = (id: string) => path.join(dir, `${id}.json`);

/** An entry the UI would show, so `persist` does not take its early return. */
const note = (text: string) => ({ role: "user" as const, text });

async function writeRecord(id: string, title: string, text: string) {
  const now = Date.now();
  await save({
    id,
    title,
    cwd: "/tmp",
    createdAt: now,
    updatedAt: now,
    messages: [{ role: "user", content: text }],
    entries: [note(text)],
  });
  // mtimes have millisecond resolution; nudge so a later write is genuinely
  // newer rather than landing on the same tick.
  await new Promise((r) => setTimeout(r, 12));
}

async function main() {
  // --- loadAll still returns plain records, newest first ----------------
  {
    const id = newId();
    await writeRecord(id, "plain", "hello");
    const recs = await loadAll();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].id, id);
    assert.ok(!("mtimeMs" in (recs[0] as any)), "loadAll returns records, not wrappers");
    const withM = await loadAllWithMtime();
    assert.equal(typeof withM[0].mtimeMs, "number", "the mtime is reported");
  }

  // --- normal use is unaffected: save, reload, save again ---------------
  {
    const id = newId();
    await writeRecord(id, "normal", "first");
    const [loaded] = await loadAllWithMtime();
    const session = new Session(cfg, loaded.record, loaded.mtimeMs);
    session.entries.push(note("second"));
    await session.persist(); // must not throw: nothing else touched the file
    const after = await loadAll();
    assert.equal(after[0].entries.length, 2, "the ordinary save path still works");
  }

  // --- an external change is detected, not overwritten ------------------
  {
    const id = newId();
    await writeRecord(id, "theirs", "original");

    const [loaded] = await loadAllWithMtime();
    const session = new Session(cfg, loaded.record, loaded.mtimeMs);

    // Somebody else repairs the file while our copy sits in memory.
    await writeRecord(id, "theirs", "repaired externally");

    session.entries.push(note("our new message"));

    let threw: any = null;
    try {
      await session.persist();
    } catch (err) {
      threw = err;
    }
    assert.ok(threw instanceof SessionReloadedError, `expected a reload, got ${threw}`);

    const onDisk = JSON.parse(await fs.readFile(fileOf(id), "utf8"));
    assert.equal(
      onDisk.entries[0].text,
      "repaired externally",
      "the external change must survive, not be clobbered"
    );
    assert.equal(
      onDisk.entries.length,
      1,
      "our stale copy must not have been written over the external change"
    );
  }

  // --- a stale copy is reloaded, and the session reflects the disk ------
  {
    const id = newId();
    await writeRecord(id, "stale", "one");
    const [loaded] = await loadAllWithMtime();
    const session = new Session(cfg, loaded.record, loaded.mtimeMs);
    await writeRecord(id, "stale", "two");
    try {
      await session.persist();
      assert.fail("should have detected the change");
    } catch (err) {
      assert.ok(err instanceof SessionReloadedError);
    }
    assert.equal(
      session.entries[0].text,
      "two",
      "after the reload the session holds what is on disk"
    );
    // And it can be saved again, now that it is back in step.
    session.entries.push(note("three"));
    await session.persist();
    const onDisk = JSON.parse(await fs.readFile(fileOf(id), "utf8"));
    assert.equal(onDisk.entries.length, 2, "the reloaded session saves normally");
  }

  // --- save refuses when the file was deleted underneath us -------------
  {
    const id = newId();
    await writeRecord(id, "gone", "here");
    const [loaded] = await loadAllWithMtime();
    await fs.unlink(fileOf(id));
    let threw: any = null;
    try {
      await save(loaded.record, loaded.mtimeMs);
    } catch (err) {
      threw = err;
    }
    assert.ok(
      threw instanceof SessionChangedOnDiskError,
      `a deleted file must be reported, got ${threw}`
    );
    assert.equal((threw as any).actualMtime, null, "the error says the file is gone");
  }

  // --- an unguarded save still works (new sessions, deliberate writes) --
  {
    const id = newId();
    await writeRecord(id, "unguarded", "a");
    // No expectation passed: the caller owns the file, so no check is made.
    await save({
      id,
      title: "unguarded",
      cwd: "/tmp",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      entries: [],
    });
    const onDisk = JSON.parse(await fs.readFile(fileOf(id), "utf8"));
    assert.equal(onDisk.title, "unguarded");
  }

  await fs.rm(dir, { recursive: true, force: true });
}

await main();
console.log("clobber: a stale save cannot discard an external change");
