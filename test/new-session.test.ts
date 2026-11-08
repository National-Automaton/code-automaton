/**
 * `new_session`: the agent opening a fresh session, as Ctrl+T does.
 *
 * The reason this exists: a change to the standing instructions does not reach
 * a session already in progress, because the old text is already baked into its
 * history as the system prompt. Until now the only way to pick up the new rules
 * was for the user to press Ctrl+T and retype the handover by hand.
 *
 * What matters here:
 *
 *  - nothing is created without the user agreeing -- the tool reports the
 *    request and the *app* acts on it, so a session with no way to ask must
 *    refuse rather than pretend;
 *  - a decline is a readable tool result the model can adapt to, not a throw;
 *  - the confirmation shows the title and the size of the handover, not the
 *    handover itself (it is about to be put in front of the user anyway);
 *  - the request carries the title and preamble back out untouched;
 *  - `runTool` -- which has no terminal -- refuses rather than lying.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";

const dir = `${process.env.TMPDIR ?? "/tmp"}/coda-new-session-${process.pid}`;
process.env.CODA_SECRETS_DIR = dir;
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { Agent } = await import("../src/agent.js");
const { runTool } = await import("../src/tools.js");

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

/** Reach the private gate; it is the unit under test. */
const gate = (a: any, name: string, args: any, emit: any = () => {}) =>
  (a as any).runOneTool(name, args, emit);

// --- no prompt installed: refuse, create nothing --------------------------

{
  const a: any = new Agent(config);
  const res = await gate(a, "new_session", { title: "x" });
  assert.equal(res.ok, false, "a session with no way to ask must not open one");
  assert.ok(/cannot ask the user/.test(res.output), res.output);
  assert.ok(/Ctrl\+T/.test(res.output), "the model is told how the user can do it instead");
  assert.equal(res.newSession, undefined, "nothing was requested");
}

// --- decline: readable, and nothing requested -----------------------------

{
  const a: any = new Agent(config);
  let asked: { summary: string } | null = null;
  a.setConfirm(async (summary: string) => {
    asked = { summary };
    return "no";
  });

  const res = await gate(a, "new_session", { title: "handover", preamble: "SECRET-PLAN" });
  assert.equal(res.ok, false, "a declined call fails");
  assert.ok(/declined/.test(res.output), res.output);
  assert.ok(/Do not ask again/.test(res.output), "the model is told not to retry blindly");
  assert.equal(res.newSession, undefined, "a decline must not create a session");

  assert.ok(asked, "the user was asked");
  assert.ok((asked as any).summary.includes("handover"), "the title is shown");
  assert.ok(
    !(asked as any).summary.includes("SECRET-PLAN"),
    "the handover text is not dumped into the yes/no box"
  );
  assert.ok(
    /11-character/.test((asked as any).summary),
    `the size of the handover is shown: ${(asked as any).summary}`
  );
}

// --- approve: the request comes back out, untouched -----------------------

{
  const a: any = new Agent(config);
  a.setConfirm(async () => "yes");
  const res = await gate(a, "new_session", {
    title: "  website work  ",
    preamble: "line one\nline two",
  });
  assert.equal(res.ok, true, res.output);
  assert.deepEqual(
    res.newSession,
    { title: "website work", preamble: "line one\nline two" },
    "the title is trimmed and the preamble preserved verbatim"
  );
}

// --- an empty title means "name it from the first message" ----------------

{
  const a: any = new Agent(config);
  a.setConfirm(async () => "yes");
  const res = await gate(a, "new_session", { title: "   ", preamble: "" });
  assert.equal(res.ok, true, res.output);
  assert.equal(res.newSession.title, undefined, "a blank title is not a title");
  assert.equal(res.newSession.preamble, undefined, "a blank preamble is not a handover");
}

// --- approve with no arguments at all: a plain Ctrl+T ---------------------

{
  const a: any = new Agent(config);
  a.setConfirm(async () => "yes");
  const res = await gate(a, "new_session", {});
  assert.equal(res.ok, true, res.output);
  assert.deepEqual(res.newSession, { title: undefined, preamble: undefined });
}

// --- `runTool` has no terminal: it must refuse, not claim success ---------

{
  const res = await runTool("new_session", { title: "nope" });
  assert.equal(res.ok, false, "runTool cannot make a session");
  assert.ok(/no UI attached/.test(res.output), res.output);
  assert.equal(res.newSession, undefined);
}

// --- the tool is serialised, never batched with readers -------------------

{
  const { writesSomething } = await import("../src/tools.js");
  assert.equal(
    writesSomething("new_session"),
    true,
    "an unknown tool counts as a writer; new_session must not run in a parallel batch"
  );
}

console.log("new-session: ok");
