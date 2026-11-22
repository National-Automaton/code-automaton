/**
 * `!command`: running a command yourself, without the agent.
 *
 * The escape hatch. Two shapes under one syntax, chosen by what the command
 * does rather than by its name -- a name list is what went stale in #88:
 *
 *  - a normal command runs in a shell with its output captured;
 *  - one that produces nothing and fails is *offered* the terminal, because
 *    that is the shape of a command waiting for a prompt.
 *
 * The property that matters most: output is redacted. Without that, `!` would
 * be the one path in coda that can put a vault credential into a transcript
 * that is saved to disk and re-sent as history.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "coda-bang-"));
process.env.CODA_SECRETS_DIR = path.join(dir, "secrets");
process.env.CODA_SESSIONS_DIR = path.join(dir, "sessions");
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { App } = await import("../src/app.js");
const { Session } = await import("../src/session.js");
const { setSecret } = await import("../src/secrets.js");

const SECRET = "tok-BANG-SENTINEL-4c5d6e";

const cfg = {
  apiKey: "sk-test-placeholder", baseURL: "https://example.invalid", model: "m",
  visionModel: "", visionBaseURL: "https://example.invalid",
  visionApiKey: "sk-test-placeholder", endpoints: [], mouse: false,
  parallelTools: true, compact: false,
} as any;

/** An App with one active session. */
function app(): any {
  const a: any = new App(cfg);
  const s = new Session(cfg);
  a.sessions.push(s);
  a.activeId = s.id;
  return a;
}

const transcript = (a: any) =>
  a.current().entries.map((e: any) => e.text ?? "").join("\n");

const lastNote = (a: any) => {
  const e = a.current().entries;
  return e[e.length - 1]?.text ?? "";
};

// --- a normal command runs and shows its output ---------------------------

{
  const a = app();
  await a.runBangCommand("!echo hello-from-bang");
  assert.ok(/hello-from-bang/.test(transcript(a)), "the output reaches the transcript");
  assert.ok(/\$ echo hello-from-bang/.test(transcript(a)), "and the command is echoed");
}

// --- output is redacted ---------------------------------------------------

{
  setSecret("bangtest", SECRET);
  const a = app();
  // A command that prints a stored credential must not put it in the history.
  await a.runBangCommand(`!sh -c 'printf %s ${SECRET}'`);
  assert.ok(!transcript(a).includes(SECRET), "a known secret is masked in `!` output");
  assert.ok(/redacted/i.test(transcript(a)), "and the mask is visible");
}

// --- a failing command with no output offers the terminal ----------------

{
  const a = app();
  // Reads stdin, which is /dev/null here, so it exits at once with nothing.
  await a.runBangCommand("!read -r line < /dev/null; false");
  const t = transcript(a);
  assert.ok(/may need a terminal/i.test(t), `the handover is offered: ${t}`);
  assert.ok(/!terminal/.test(t), "and it says how");
}

// --- a silent command that is still running is offered, not killed --------

{
  const a = app();
  const started = Date.now();
  // Silent for longer than the 3s silence window, then finishes on its own.
  await a.runBangCommand("!sleep 4; echo done-after-sleep");
  const elapsed = Date.now() - started;

  const t = transcript(a);
  assert.ok(/no output for a few seconds/i.test(t),
    "the offer appears while it is still running");
  assert.ok(/done-after-sleep/.test(t),
    `and the command was NOT killed -- it finished: ${t}`);
  assert.ok(elapsed >= 3_500, `it ran to completion (${elapsed}ms)`);
  assert.ok(/finished/.test(t), "and the end is reported");
}

// --- a chatty command is never flagged, however long it runs --------------

{
  const a = app();
  // Prints every second for 3.5s: each line resets the silence window, so the
  // "waiting for input" offer must never appear. This is the case a flat
  // deadline would have got wrong.
  await a.runBangCommand("!for i in 1 2 3; do echo tick-$i; sleep 1; done");
  const t = transcript(a);
  assert.ok(/tick-3/.test(t), "it ran to the end");
  assert.ok(!/no output for a few seconds/i.test(t),
    `a command producing output is not treated as waiting: ${t}`);
}

// --- a successful command with no output does not -------------------------

{
  const a = app();
  await a.runBangCommand("!true");
  const t = transcript(a);
  assert.ok(!/may need a terminal/i.test(t),
    "a command that simply succeeds quietly is not treated as wanting a tty");
}

// --- empty input is explained ---------------------------------------------

{
  const a = app();
  await a.runBangCommand("!");
  assert.ok(/usage/i.test(lastNote(a)), lastNote(a));
}

// --- submit() routes `!` to the shell, never to the model ------------------

{
  const a = app();
  let prompted: string | null = null;
  // If this ever reaches the model, the test would see a prompt.
  a.startNewSessionWith = (text: string) => {
    prompted = text;
  };
  a.input.insert("!echo routed-to-shell");
  a.submit();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(prompted, null, "a `!` line is not sent to the agent as a prompt");
  assert.ok(/routed-to-shell/.test(transcript(a)), "and it ran in the shell");
}

// --- `!` as a session's first message is also a shell command -------------

{
  const a = app();
  let prompted: string | null = null;
  const orig = a.current().agent.run;
  a.current().agent.run = async () => {
    prompted = "started a turn";
    return {};
  };
  a.startNewSessionWith("!echo first-message");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(prompted, null, "the first message of a session is not silently promoted to a prompt");
  a.current().agent.run = orig;
}

console.log("bang.test.ts: ok");
