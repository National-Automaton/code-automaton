/**
 * Headless mode: run one prompt, unattended, and exit with a meaningful code.
 *
 * The TUI is only a *view* over `Agent`; the turn itself needs no terminal. So
 * this file adds a second caller of `Session.run`, not a second agent:
 *
 *   - a tool the run was not explicitly allowed to use is refused, and the
 *     refusal is an ordinary tool result so the model can adapt — a permission
 *     question is not an API error, and the model should be told "no" rather
 *     than crashed;
 *   - a wall-clock deadline ends a stuck run, because a job that hangs forever
 *     is worse than one that fails;
 *   - the process exits non-zero on any failure, so cron has something to mail.
 *
 * The exit code is the contract. Cron, Task Scheduler and CI all judge a job by
 * it, and a job that exits 0 after the model errored teaches you to ignore it.
 *
 * Enforcement is in two places, deliberately:
 *
 *  - `setToolPolicy` (see `tools.ts`) covers *every* tool at the point it runs,
 *    so an unattended run cannot reach `bash` merely because the approval gate
 *    never considers it; and
 *  - the approval callback passed to `Session.run` covers the gated tools the
 *    agent does ask about (`use_secret`, `new_session`, `request_secret`).
 *
 * A tool added later is refused by both until it is named in `--allow`.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { AgentEvent } from "./agent.js";
import type { Config } from "./config.js";
import { Session } from "./session.js";
import { DEFAULT_TITLE, deriveTitle, loadAll } from "./store.js";
import { describePolicy, MUTATING_TOOLS } from "./headless-args.js";
import type { HeadlessOptions } from "./headless-args.js";
import { setToolPolicy } from "./tools.js";

/**
 * Exit codes. Distinct numbers rather than 1 for everything, so a wrapper can
 * tell "the model failed" from "it timed out" from "it tried something it was
 * not allowed to" without parsing stderr.
 *
 * 0/1 keep their usual meaning, 2 is the conventional "bad usage", and 124 is
 * what `timeout(1)` uses for a deadline.
 */
export const EXIT = {
  ok: 0,
  /** The turn failed: API error, dropped connection, or no final answer. */
  failed: 1,
  /** Bad flags, or no API key. */
  usage: 2,
  /** A tool was refused by policy and `--deny-ok` was not given. */
  denied: 3,
  /** The deadline passed with the turn still running. */
  timeout: 124,
} as const;

/** A prompt-derived session title, for a run that did not name one. */
function titleFor(prompt: string): string {
  return deriveTitle([{ role: "user", content: prompt }]);
}

/**
 * Find the session to resume, or make a new one.
 *
 * `--session` names a session. If a saved session already carries that title,
 * the newest one is resumed so a long-running job accumulates context;
 * `--no-resume` starts fresh, which is what a *reproducible* report wants —
 * last week's errors must not ride along in the history.
 *
 * Matching on the title rather than an id keeps the command line readable: a
 * cron entry should say `--session weekly-dementia-report`, not a uuid. Titles
 * are not unique in coda, so "the newest with this name" is the rule, and
 * `--no-resume` is the escape hatch when that is the wrong one.
 */
export async function resolveSession(
  config: Config,
  opts: HeadlessOptions
): Promise<{ session: Session; resumed: boolean }> {
  const name = opts.session ?? titleFor(opts.prompt);

  if (!opts.noResume && opts.session) {
    // loadAll is newest-first, so the first title match is the most recent.
    const found = (await loadAll()).find((r) => r.title === name);
    if (found) return { session: new Session(config, found), resumed: true };
  }
  const session = new Session(config);
  // Named up front rather than left to auto-titling: the title is how the next
  // run finds this session again.
  session.title = name || DEFAULT_TITLE;
  return { session, resumed: false };
}

/** `path`/`command` summary of a tool call, for verbose logging. */
function describeArgs(args: any): string {
  if (!args || typeof args !== "object") return "";
  for (const key of ["path", "command"]) {
    const v = (args as any)[key];
    if (typeof v === "string") return ` ${v.slice(0, 200)}`;
    if (Array.isArray(v)) return ` ${v.join(" ").slice(0, 200)}`;
  }
  return "";
}

/** The last assistant prose entry: what the model finally said. */
export function lastAssistantText(entries: { role: string; text: string }[]): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].role === "assistant") return entries[i].text;
  }
  return "";
}

/**
 * Run one headless turn and return the exit code.
 *
 * Deliberately does not call `process.exit`: the caller owns the exit, so a
 * test can drive this in-process.
 */
export async function runHeadless(opts: HeadlessOptions): Promise<number> {
  const config = loadConfig();
  const log = (msg: string) => process.stderr.write(msg + "\n");

  // Install the policy for this run. Nothing may use a tool outside it, however
  // the model asks. Restored afterwards so an embedding or a test does not stay
  // restricted.
  setToolPolicy(opts.allow);
  try {
    return await runTurn(config, opts, log);
  } finally {
    setToolPolicy(null);
  }
}

async function runTurn(
  config: Config,
  opts: HeadlessOptions,
  log: (msg: string) => void
): Promise<number> {
  if (opts.verbose) {
    log(`coda headless: ${describePolicy(opts)}`);
    log(`coda headless: timeout ${Math.round(opts.timeoutMs / 1000)}s`);
  }

  const { session, resumed } = await resolveSession(config, opts);
  if (opts.verbose) {
    log(`coda headless: ${resumed ? "resuming" : "new session"} "${session.title}"`);
  }

  // Take the lock so a headless run cannot race an interactive session editing
  // the same file. Refuse rather than clobber: the whole session file is
  // rewritten on save, so whichever finished second would erase the other.
  const lock = await session.acquire();
  if (!lock.ok) {
    log(
      `coda headless: session "${session.title}" is open in ${lock.heldBy}. ` +
        `Let it finish, or pass --no-resume to start a fresh session.`
    );
    return EXIT.failed;
  }

  /**
   * Set by the deadline timer. A turn cannot be aborted — `Agent.send` holds no
   * cancellation — so the deadline takes effect at the next event, where
   * throwing unwinds `Session.run` and the agent's own `finally` blocks leave
   * the session consistent. A model that is working emits events constantly, so
   * in practice this lands within a chunk or two of the deadline.
   *
   * A run that is stuck with *no* event at all (a socket that never answers)
   * cannot be interrupted this way. That case is left to the caller's `timeout`
   * in the scheduler — see the README — rather than to a hard `process.exit`
   * here, which would skip the session save.
   */
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
  }, opts.timeoutMs);
  timer.unref?.();

  /** The model's answer: the last assistant prose written to the transcript. */
  let answer = "";

  const emit = (ev: AgentEvent) => {
    switch (ev.type) {
      case "text":
        if (opts.verbose) process.stderr.write(ev.text);
        break;
      case "tool_start":
        if (opts.verbose) log(`  -> ${ev.name}${describeArgs(ev.args)}`);
        break;
      case "tool_result":
        if (opts.verbose) log(`  <- ${ev.name} ${ev.ok ? "ok" : "failed"}`);
        break;
      case "done":
        answer = lastAssistantText(session.entries);
        break;
      case "error":
        log(`coda headless: ${ev.message}`);
        break;
    }
  };

  try {
    await session.run(
      opts.prompt,
      () => {
        // `Session.run` calls this on every event as well as at the start and
        // end of the turn, which is the closest thing to a heartbeat available.
        if (expired) throw new Error(`timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
      },
      [],
      // The approval gate. A headless run has nobody to ask, so every answer is
      // resolved here: "yes" only for a tool the allowlist already named. The
      // command-level policy has already refused everything else before this is
      // ever consulted, so this is the narrow path for `use_secret` and
      // `new_session` — both refused unless explicitly allowed.
      async (summary) => (approvable(summary, opts) ? "yes" : "no"),
      // Nobody is here to type a credential.
      async () => null
    );
  } catch (err: any) {
    log(`coda headless: ${err?.message ?? String(err)}`);
    return expired ? EXIT.timeout : EXIT.failed;
  } finally {
    clearTimeout(timer);
    await session.release();
  }

  if (expired) {
    log(`coda headless: timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
    return EXIT.timeout;
  }
  return finish(session, opts, answer, log);
}

/**
 * Whether the approval gate may answer "yes".
 *
 * `Agent` reuses one confirmation callback for spending a credential and for
 * opening a session, so the text of the summary is what tells them apart. It is
 * generated by the agent itself (see `runOneTool`/`openNewSession`), not by the
 * model, so matching on it is safe.
 */
export function approvable(summary: string, opts: HeadlessOptions): boolean {
  if (/^Use credential/.test(summary)) return opts.allow.has("use_secret");
  if (/^Open a new session/.test(summary)) return opts.allow.has("new_session");
  // An unrecognised prompt is refused, not approved: a gate that answers "yes"
  // to something it does not recognise is exactly the bug worth avoiding.
  return false;
}

/** Judge a finished turn, enforcing `--report-path`. */
function finish(
  session: Session,
  opts: HeadlessOptions,
  answer: string,
  log: (msg: string) => void
): number {
  // A turn that ended in an error entry is a failure even though `run` returned:
  // `Session.run` records a failed turn in the transcript rather than throwing,
  // so this is the only place it is visible.
  const failed = session.entries.find(
    (e) => e.role === "assistant" && e.text.startsWith("error: ")
  );
  if (failed) {
    log(`coda headless: ${failed.text}`);
    return EXIT.failed;
  }

  if (!answer.trim()) {
    log("coda headless: the turn ended without a final answer from the model");
    return EXIT.failed;
  }

  const refused = session.entries.filter(
    (e) => e.role === "tool" && e.text.includes("refused")
  );
  if (refused.length) {
    log(
      `coda headless: ${refused.length} tool call(s) were refused by policy ` +
        `(${describePolicy(opts)})`
    );
    if (opts.failOnDenied) return EXIT.denied;
  }

  if (opts.reportPath) {
    const code = enforceReport(opts.reportPath, session, answer, log);
    if (code !== EXIT.ok) return code;
  }

  if (opts.verbose) log(`coda headless: done (${answer.trim().length} chars)`);
  return EXIT.ok;
}

/**
 * Enforce `--report-path`.
 *
 * The report is the point of the run, so a run that was asked for one and did
 * not produce one is a failure, even though the model answered fine. Three
 * outcomes:
 *
 *  - the model wrote the file during this run: success;
 *  - it only answered in prose: the answer is written out here. Recovering is
 *    better than failing — the text is already the report, just in the wrong
 *    place, and re-running would spend a whole turn on it;
 *  - the file predates the run: failure. Last week's report still sitting there
 *    is indistinguishable from success, and that is the one failure a weekly job
 *    must not have.
 */
export function enforceReport(
  reportPath: string,
  session: Session,
  answer: string,
  log: (msg: string) => void
): number {
  const target = path.resolve(reportPath);

  // Anything in this run that could have written a file.
  const couldWrite = session.entries.some(
    (e) =>
      e.role === "tool" &&
      MUTATING_TOOLS.includes(e.name as (typeof MUTATING_TOOLS)[number])
  );

  const stat = statOrNull(target);
  const fresh = stat !== null && stat.size > 0 && stat.mtimeMs >= session.updatedAt - 1000;

  if (!fresh) {
    if (stat && stat.size > 0) {
      log(
        `coda headless: ${target} exists but was not modified by this run ` +
          `(mtime ${new Date(stat.mtimeMs).toISOString()})`
      );
      return EXIT.failed;
    }
    if (couldWrite) {
      log(`coda headless: the run could write files but did not write ${target}`);
      return EXIT.failed;
    }
    log(`coda headless: the model wrote no file; saving its answer to ${target}`);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, answer.replace(/\s+$/, "") + "\n", {
        encoding: "utf8",
        mode: 0o644,
      });
    } catch (err: any) {
      log(`coda headless: cannot write ${target}: ${err?.message ?? err}`);
      return EXIT.failed;
    }
  }

  log(`coda headless: report at ${target} (${fs.statSync(target).size} bytes)`);
  return EXIT.ok;
}

function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}
