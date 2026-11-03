/**
 * Lock probing, for the picker's "open in another coda" markers.
 *
 * `lockHolder` answers a question the picker asks *before* the user presses
 * Enter: is this session held by somebody else? Both wrong answers were seen in
 * practice:
 *
 *  - Reporting a dead holder as locked sends the user hunting for a process
 *    that is gone, and makes an openable session look broken.
 *  - Reporting a live holder as free makes Enter look like a dead keypress,
 *    because the refusal note goes to the transcript, which the full-screen
 *    picker does not draw.
 *
 * Runs against a temporary sessions directory (CODA_SESSIONS_DIR), so it never
 * touches real sessions or locks.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// Must be set before store.js is evaluated: SESSIONS_DIR is read at import.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coda-locktest-"));
process.env.CODA_SESSIONS_DIR = dir;

const { lockHolder, describeHolder } = await import("../src/lock.js");

const log = (s: string) => process.stderr.write(s + "\n");
const HOST = os.hostname();

async function writeLock(id: string, info: { pid: number; host: string; beat: number }) {
  await fs.writeFile(
    path.join(dir, id + ".lock"),
    JSON.stringify({ token: "test-token", ...info }),
    "utf8"
  );
}

// No lock at all.
assert.equal(await lockHolder("free"), null, "a session with no lock file is free");

// A live holder on this host: reported, with its pid.
{
  await writeLock("live", { pid: process.pid, host: HOST, beat: Date.now() });
  const holder = await lockHolder("live");
  assert.ok(holder, "a lock held by a live process must be reported");
  assert.ok(holder.includes("pid " + process.pid), "the holder should be named, got " + JSON.stringify(holder));
}

// A DEAD pid on this host is stale, so the session is openable -- acquireLock
// would steal the lock. This is the case that made a dead terminal look live.
{
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  assert.ok(child.pid, "spawned child must have a pid");
  const deadPid = child.pid;
  await new Promise((r) => child.on("exit", r));

  await writeLock("dead", { pid: deadPid, host: HOST, beat: Date.now() });
  assert.equal(
    await lockHolder("dead"),
    null,
    "a lock whose holder is dead must read as free: acquire() would steal it"
  );
}

// Live pid but a stopped heartbeat: stale on another host.
{
  await writeLock("stale-beat", {
    pid: process.pid,
    host: "some-other-host",
    beat: Date.now() - 120000,
  });
  assert.equal(await lockHolder("stale-beat"), null, "a stopped heartbeat is stale on another host");
}

// A live pid on another host, beating recently: held.
{
  await writeLock("remote", { pid: 1, host: "some-other-host", beat: Date.now() });
  const holder = await lockHolder("remote");
  assert.ok(holder, "a live remote holder must be reported");
  assert.ok(holder.includes("some-other-host"), "the remote host should be named, got " + JSON.stringify(holder));
}

// A corrupt lock reads as free, matching acquireLock; probing runs for every
// listed session, so it must never crash the picker.
{
  await fs.writeFile(path.join(dir, "corrupt.lock"), "not json at all", "utf8");
  assert.equal(await lockHolder("corrupt"), null, "a corrupt lock must not crash or read as held");
}

// describeHolder spellings.
assert.equal(describeHolder({ token: "", pid: 0, host: "", beat: 0 }), "another coda process");
assert.equal(describeHolder({ token: "t", pid: 42, host: HOST, beat: 0 }), "pid 42");
assert.equal(describeHolder({ token: "t", pid: 42, host: "elsewhere", beat: 0 }), "pid 42 on elsewhere");

await fs.rm(dir, { recursive: true, force: true });
log("lock: probing reports live holders and treats stale ones as free");
