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

// --- every tool result is committed before the turn ends ------------------
//
// Regression: the loop that commits results used to `return` from *inside* the
// for-loop when a `new_session` approval appeared. With the approval first in a
// batch, the later tool results were never written, so the turn's `assistant`
// message was left carrying tool calls with no `tool` reply -- a history shape
// providers reject outright. The session then ended on a dangling `tool` entry
// and appeared to go idle.
//
// These drive a real `Agent.send` against a stubbed `fetch`, so the assertions
// cover the commit loop itself rather than a copy of it.

/** One SSE frame carrying a complete tool call. */
const toolFrame = (index: number, id: string, name: string, args: any) =>
  `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            { index, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  })}\n\n`;
const stopFrame = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`;

/** A one-shot 200 SSE response over the given frames. */
function framesResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < frames.length) controller.enqueue(encoder.encode(frames[i++]));
      else controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Stub `globalThis.fetch`, serving each response in turn. */
function stubFetch(responses: (() => Response)[]): { calls: number } {
  const state = { calls: 0 };
  (globalThis as any).fetch = async () => {
    const make = responses[Math.min(state.calls, responses.length - 1)];
    state.calls++;
    return make();
  };
  return state;
}

const realFetch = globalThis.fetch;

try {
  // `new_session` first, then two ordinary tools in the same batch.
  //
  // The batch runs serially (new_session is a writer), so the approval is seen
  // before the later results are pushed -- the case that used to truncate.
  {
    stubFetch([
      () =>
        framesResponse([
          toolFrame(0, "call_a", "new_session", { title: "next" }),
          toolFrame(1, "call_b", "read_file", { path: "/etc/hostname" }),
          toolFrame(2, "call_c", "list_dir", { path: "/tmp" }),
          stopFrame,
        ]),
      () => framesResponse([stopFrame]),
    ]);

    const a: any = new Agent(config);
    a.setConfirm(async () => "yes");
    const out = await a.send("start a session", () => {});

    assert.deepEqual(out.newSession, { title: "next", preamble: undefined });

    // The assistant turn that asked for three tools, and the three replies.
    const assistant = [...a.messages].reverse().find((m: any) => m.tool_calls?.length);
    assert.ok(assistant, "the turn should have recorded a tool-calling assistant message");
    const askedIds = assistant.tool_calls.map((c: any) => c.id);
    assert.deepEqual(askedIds, ["call_a", "call_b", "call_c"]);

    const repliedIds = a.messages
      .filter((m: any) => m.role === "tool")
      .map((m: any) => m.tool_call_id);
    assert.deepEqual(
      repliedIds,
      askedIds,
      `every tool call must have a matching result; got ${JSON.stringify(repliedIds)}`
    );

    // Ending on a `tool` message is expected here: the turn returns instead of
    // asking the model for another reply. What must never happen is an
    // assistant tool call with no matching `tool` result, asserted above.
  }

  // A second approval in one batch still opens exactly one session.
  {
    stubFetch([
      () =>
        framesResponse([
          toolFrame(0, "call_a", "new_session", { title: "dup" }),
          toolFrame(1, "call_b", "new_session", { title: "dup" }),
          stopFrame,
        ]),
      () => framesResponse([stopFrame]),
    ]);

    const a: any = new Agent(config);
    let asked = 0;
    a.setConfirm(async () => {
      asked++;
      return "yes";
    });
    const out = await a.send("open", () => {});
    assert.deepEqual(out.newSession, { title: "dup", preamble: undefined });
    // The second call is refused without prompting: the request is spent.
    assert.equal(asked, 1, "only the first call reaches the user");
    const replies = a.messages.filter((m: any) => m.role === "tool");
    assert.equal(replies.length, 2, "both results are still committed");
  }
} finally {
  (globalThis as any).fetch = realFetch;
}

// --- a conversation may open one session, not many ------------------------
//
// Regression: without this guard, every later turn that called `new_session`
// was honoured, and each one moved the user out of the session they were in.
// Seen in practice as a session list filling with shells and the user's next
// prompt landing somewhere they did not expect.

{
  const a: any = new Agent(config);
  let asked = 0;
  a.setConfirm(async () => {
    asked++;
    return "yes";
  });

  const first = await gate(a, "new_session", { title: "handover", preamble: "PLAN" });
  assert.equal(first.ok, true, first.output);
  assert.deepEqual(first.newSession, { title: "handover", preamble: "PLAN" });

  const second = await gate(a, "new_session", { title: "again" });
  assert.equal(second.ok, false, "a second session must not be opened");
  assert.equal(second.newSession, undefined, "nothing must be requested");
  assert.equal(asked, 1, "the user must not be asked twice");
  assert.ok(/already been opened/.test(second.output), second.output);
}

// --- a decline does not spend the one session ----------------------------

{
  const a: any = new Agent(config);
  let answer: "yes" | "no" = "no";
  a.setConfirm(async () => answer);

  const declined = await gate(a, "new_session", { title: "x" });
  assert.equal(declined.ok, false);
  assert.equal(a.openedSession, false, "a decline must not spend the request");

  answer = "yes";
  const accepted = await gate(a, "new_session", { title: "x" });
  assert.equal(accepted.ok, true, "a later request may still succeed");
  assert.equal(a.openedSession, true);
}

console.log("new-session: ok");

