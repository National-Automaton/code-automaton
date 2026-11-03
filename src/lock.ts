/**
 * Advisory per-session lock files.
 *
 * Two `coda` processes driving the same session would otherwise overwrite each
 * other: the whole session file is rewritten on every save, so the second
 * writer to finish simply erases the first one's work. The lock is advisory --
 * it only stops a second *cooperating* coda from opening the session, which is
 * the case that matters -- and it is per session, not per sessions directory.
 *
 * A lock is a small JSON file beside the session:
 *
 *     ~/.coda/sessions/<id>.lock  ->  { token, pid, host, beat }
 *
 * `token` is a random id unique to this particular acquisition, so releasing a
 * lock can check it still owns the file before deleting it. That matters after
 * a steal: the original owner must not delete the new owner's lock on exit.
 *
 * Ownership is kept alive by a heartbeat (`beat`, a ms timestamp) refreshed on
 * an interval. A lock whose heartbeat has stopped is stale -- its holder crashed,
 * was killed, or the machine went to sleep -- and may be taken over. Checking the
 * pid as well covers the same-host case precisely, where the OS can tell us the
 * process is gone; the heartbeat covers the cross-host case (a shared home
 * directory), where it cannot.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SESSIONS_DIR } from "./store.js";

/** What is written to a lock file. */
interface LockInfo {
  /** Unique per acquisition; whoever's token is in the file owns the lock. */
  token: string;
  pid: number;
  host: string;
  /** ms timestamp of the last heartbeat. */
  beat: number;
}

/**
 * Heartbeat period and staleness threshold.
 *
 * The threshold is several heartbeat intervals so a single missed beat (a GC
 * pause, a loaded machine) does not make a live lock look abandoned. It is also
 * the worst-case wait before a crashed holder's session can be reopened, so it
 * is kept to tens of seconds rather than minutes.
 */
const HEARTBEAT_MS = 5_000;
const STALE_MS = 30_000;

const HOST = os.hostname();

function lockPath(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.lock`);
}

/** True if a process with this pid exists on this host. Signal 0 probes. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM: the process exists but belongs to another user -- still alive.
    return err?.code === "EPERM";
  }
}

/** Read a lock file, or null if it is missing or unreadable. */
async function readLock(id: string): Promise<LockInfo | null> {
  try {
    const raw = await fs.readFile(lockPath(id), "utf8");
    const val = JSON.parse(raw);
    if (val && typeof val.token === "string" && typeof val.beat === "number") {
      return val as LockInfo;
    }
  } catch {
    // missing, half-written, or corrupt: treat as no lock
  }
  return null;
}

/**
 * Is this lock stale -- its holder is gone or has stopped beating?
 *
 * Same host: the pid is definitive, so a dead pid means stale immediately.
 * Different host (a shared sessions dir): the pid means nothing here, so fall
 * back to the heartbeat age alone.
 */
function isStale(info: LockInfo, now: number): boolean {
  if (info.host === HOST && !pidAlive(info.pid)) return true;
  return now - info.beat > STALE_MS;
}

/** The reasons a session cannot be opened. */
export type LockResult =
  | { ok: true; holder: SessionLock }
  | { ok: false; heldBy: LockInfo };

/** A held lock. Call `release()` to give it up (idempotent). */
export class SessionLock {
  private timer: NodeJS.Timeout | null = null;
  private released = false;

  constructor(
    readonly id: string,
    private token: string
  ) {}

  /**
   * Start beating. `unref` keeps the timer from holding the process open, so a
   * forgotten lock cannot stop coda from exiting.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.beat(), HEARTBEAT_MS);
    this.timer.unref?.();
  }

  /** Rewrite the heartbeat, but only if we still own the file. */
  private async beat(): Promise<void> {
    try {
      const cur = await readLock(this.id);
      if (!cur || cur.token !== this.token) {
        // Someone stole it (we were presumed dead). Stop beating; we no longer
        // own this session and must not keep writing to it.
        this.stopTimer();
        return;
      }
      await fs.writeFile(lockPath(this.id), JSON.stringify({ ...cur, beat: Date.now() }));
    } catch {
      // Best effort: a failed beat ages the lock, which is the safe direction.
    }
  }

  /**
   * Release the lock. Deletes the file only if it still holds our token, so a
   * process that lost the lock to a steal does not delete the new owner's file.
   */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.stopTimer();
    try {
      const cur = await readLock(this.id);
      if (cur && cur.token === this.token) {
        await fs.unlink(lockPath(this.id));
      }
    } catch {
      // already gone
    }
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Try to take the lock for `id`.
 *
 * The create is `O_EXCL`, so there is no race between two processes: exactly
 * one wins the create, the other sees EEXIST and is told who holds it. If the
 * existing lock is stale it is removed and the acquire is retried once -- once,
 * because a second failure means another process won the retry, and looping
 * would just spin.
 */
export async function acquireLock(id: string): Promise<LockResult> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true, mode: 0o700 }).catch(() => {});
  const token = randomUUID();
  const mine: LockInfo = { token, pid: process.pid, host: HOST, beat: Date.now() };
  const body = JSON.stringify(mine);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await fs.open(lockPath(id), "wx", 0o600);
      try {
        await fh.writeFile(body, "utf8");
      } finally {
        await fh.close();
      }
      const held = new SessionLock(id, token);
      held.start();
      return { ok: true, holder: held };
    } catch (err: any) {
      if (err?.code !== "EEXIST") {
        // Cannot create at all (permissions, bad path). Do not block the user
        // out of their own session over an unwritable lock directory: surface
        // it as a lock the caller can decide to ignore.
        return { ok: false, heldBy: { token: "", pid: 0, host: "", beat: 0 } };
      }
      const cur = await readLock(id);
      if (!cur) {
        // Either the file vanished between EEXIST and read (somebody released
        // it), or it is present but corrupt/unreadable. Those need different
        // handling: a vanished file just needs a retry, while a corrupt one has
        // to be removed or the retry will collide with it forever. Probe which.
        const exists = await fs
          .access(lockPath(id))
          .then(() => true)
          .catch(() => false);
        if (!exists) continue; // vanished: retry the create
        // Corrupt: treat exactly like a stale lock -- remove and retry.
        await fs.unlink(lockPath(id)).catch(() => {});
        continue;
      }
      if (!isStale(cur, Date.now())) {
        return { ok: false, heldBy: cur };
      }
      // Stale: remove and retry. If another process removes it first, our
      // unlink fails harmlessly and the retry simply races on the create.
      await fs.unlink(lockPath(id)).catch(() => {});
    }
  }
  const cur = await readLock(id);
  return { ok: false, heldBy: cur ?? { token: "", pid: 0, host: "", beat: 0 } };
}

/** Human-readable description of a lock holder, for the error message. */
export function describeHolder(info: LockInfo): string {
  if (!info.token) return "another coda process";
  const where = info.host && info.host !== HOST ? ` on ${info.host}` : "";
  return info.pid ? `pid ${info.pid}${where}` : `another coda process${where}`;
}
