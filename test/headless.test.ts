/**
 * Headless mode: flags, policy, and exit codes.
 *
 * What matters for a scheduled run, in order of how much damage it does when
 * wrong:
 *
 *  - `bash` and `write_file` must be refused unless `--allow` names them. A
 *    cron job that can run shell commands unattended is a shell on a timer;
 *  - a refused tool is an ordinary tool result, not a crash, so the model can
 *    adapt instead of the job dying with a stack trace;
 *  - `--report-path` must not accept last week's file: a stale report exits 0
 *    and looks exactly like success;
 *  - the exit code distinguishes success, failure, refusal and timeout, because
 *    that is the only thing cron reads.
 *
 * The turn is driven through a real `Agent.send` against a stubbed stream, as
 * `turn-continues.test.ts` does, so the policy is exercised where it actually
 * runs rather than through a mock of it.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const root = mkdtempSync(path.join(tmpdir(), "coda-headless-"));
process.env.CODA_SESSIONS_DIR = path.join(root, "sessions");

const { parseHeadlessArgs, DEFAULT_ALLOW } = await import("../src/headless-args.js");
const { setToolPolicy } = await import("../src/tools.js");
const { Agent } = await import("../src/agent.js");
const { enforceReport, approvable, lastAssistantText } = await import("../src/headless.js");

const cfg = {
  apiKey: "sk-test",
  baseURL: "https://example.invalid",
  model: "text-model",
  visionModel: "vision-model",
  visionBaseURL: "https://example.invalid",
  visionApiKey: "sk-test",
  mouse: false,
  parallelTools: false,
  compact: false,
} as any;

// `readFile` is injected into the parser, so the tests use the real one.
const cfgFile = (p: string) => readFileSync(p, "utf8");

// --- flags -----------------------------------------------------------------

{
  const r = parseHeadlessArgs(["-p", "search the news"], cfgFile);
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.options?.prompt, "search the news");
  assert.deepEqual([...r.options!.allow], [...DEFAULT_ALLOW], "reads are allowed by default");
  assert.ok(!r.options!.allow.has("bash"), "bash is not allowed by default");
  assert.ok(!r.options!.allow.has("write_file"), "write_file is not allowed by default");
  assert.equal(r.options!.timeoutMs, 30 * 60 * 1000);
  assert.equal(r.options!.noResume, false, "an unnamed run may resume");
}

{
  const r = parseHeadlessArgs(
    [
      "--print",
      "--session",
      "weekly-report",
      "--no-resume",
      "--report-path",
      "out.md",
      "--allow",
      "read_file,write_file,bash",
      "--timeout",
      "45m",
      "--verbose",
      "do the thing",
    ],
    cfgFile
  );
  assert.equal(r.error, undefined, r.error);
  const o = r.options!;
  assert.equal(o.session, "weekly-report");
  assert.equal(o.noResume, true);
  assert.equal(o.reportPath, "out.md");
  assert.equal(o.timeoutMs, 45 * 60_000);
  assert.equal(o.verbose, true);
  assert.equal(o.prompt, "do the thing", "a positional after the flags is the prompt");
  // The first --allow replaces the default set rather than adding to it, so the
  // flag describes exactly what can run.
  assert.deepEqual([...o.allow].sort(), ["bash", "read_file", "write_file"]);
  assert.ok(!o.allow.has("list_dir"), "--allow=read_file,write_file,bash excludes list_dir");
}

{
  const r = parseHeadlessArgs(["-p", "--allow", "all", "x"], cfgFile);
  assert.ok(r.options!.allow.has("use_secret"), "--allow all includes the vault");
}

{
  // An unknown tool is a usage error, not a silently ignored word: a typo in a
  // cron entry must not quietly widen or narrow the policy.
  const r = parseHeadlessArgs(["-p", "--allow", "bashh", "x"], cfgFile);
  assert.ok(r.error && /unknown tool/.test(r.error), r.error);
}

{
  const r = parseHeadlessArgs(["-p", "--timeout", "soon", "x"], cfgFile);
  assert.ok(r.error && /duration/.test(r.error), r.error);
}

{
  const r = parseHeadlessArgs(["-p"], cfgFile);
  assert.equal(r.missingPrompt, true);
}

{
  const prompts = path.join(root, "prompt.md");
  writeFileSync(prompts, "line one\nline two\n");
  const r = parseHeadlessArgs(["-p", "--prompt-file", prompts], cfgFile);
  assert.equal(r.options?.prompt, "line one\nline two\n", "the file's newlines are kept");

  const both = parseHeadlessArgs(["-p", "inline", "--prompt-file", prompts], cfgFile);
  assert.ok(both.error && /not both/.test(both.error), both.error);
}

{
  // Without -p this is not a headless run at all: the TUI still starts.
  const r = parseHeadlessArgs(["--session", "x"], cfgFile);
  assert.equal(r.options, undefined);
}

// --- the approval gate -----------------------------------------------------

{
  const opts = parseHeadlessArgs(["-p", "x"], cfgFile).options!;
  assert.equal(approvable("Use credential wp to run:\n  cat x", opts), false, "no vault by default");
  assert.equal(approvable('Open a new session named "x"?', opts), false, "no sessions by default");
  assert.equal(approvable("something else entirely", opts), false, "unknown prompts are refused");
}

{
  const opts = parseHeadlessArgs(["-p", "--allow", "use_secret", "x"], cfgFile).options!;
  assert.equal(approvable("Use credential wp to run:\n  cat x", opts), true);
  assert.equal(approvable('Open a new session named "x"?', opts), false, "still only what was named");
}

// --- the tool policy, where it actually runs -------------------------------

const textFrame = (t: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
const toolFrame = (i: number, id: string, name: string, args: any) =>
  `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            { index: i, id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
      },
    ],
  })}\n\n`;
const stopFrame = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`;

function framesResponse(frames: string[]): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < frames.length) c.enqueue(enc.encode(frames[i++]));
      else c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function stub(responses: (() => Response)[]) {
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
  // The model asks for a shell command the run was not allowed to make. The
  // refusal must be a tool result the model can see and work around, and the
  // command must not have run.
  const marker = path.join(root, "should-not-exist");
  stub([
    () =>
      framesResponse([
        toolFrame(0, "c1", "bash", { command: `touch ${marker}` }),
        stopFrame,
      ]),
    () => framesResponse([textFrame("I could not run that."), stopFrame]),
  ]);

  const a: any = new Agent(cfg);
  setToolPolicy(new Set(DEFAULT_ALLOW));
  const events: any[] = [];
  await a.send("touch a file", (ev: any) => events.push(ev));
  setToolPolicy(null);

  assert.equal(existsSync(marker), false, "a refused bash call must not run");
  const result = events.find((e) => e.type === "tool_result");
  assert.ok(result, "the refusal is reported as a tool result");
  assert.equal(result.ok, false, "the refusal is not ok");
  assert.ok(/refused/.test(result.output), result.output);
  assert.ok(
    /restricted to/.test(result.output),
    `the refusal should say what is allowed: ${result.output}`
  );
} finally {
  (globalThis as any).fetch = realFetch;
}

{
  // With no policy installed (the TUI's case) the same call runs as before.
  setToolPolicy(null);
  const out = await (await import("../src/tools.js")).runTool("list_dir", { path: root });
  assert.equal(out.ok, true, "with no policy installed, tools behave as before");
}

try {
  // A tool that was allowed runs.
  stub([
    () =>
      framesResponse([
        toolFrame(0, "c2", "list_dir", { path: root }),
        stopFrame,
      ]),
    () => framesResponse([textFrame("listed."), stopFrame]),
  ]);
  const a: any = new Agent(cfg);
  setToolPolicy(new Set(DEFAULT_ALLOW));
  const events: any[] = [];
  await a.send("list it", (ev: any) => events.push(ev));
  setToolPolicy(null);
  const result = events.find((e) => e.type === "tool_result");
  assert.equal(result?.ok, true, "an allowed tool runs normally");
} finally {
  (globalThis as any).fetch = realFetch;
}

// --- --report-path ---------------------------------------------------------

/** A session-shaped object: `enforceReport` only reads entries/updatedAt. */
const fakeSession = (entries: any[], updatedAt = Date.now()) => ({ entries, updatedAt } as any);

{
  // The model answered in prose and wrote no file: the answer becomes the
  // report rather than the run failing.
  const target = path.join(root, "prose-only", "report.md");
  const s = fakeSession([{ role: "assistant", text: "The week in dementia research." }]);
  const code = enforceReport(target, s, "The week in dementia research.", () => {});
  assert.equal(code, 0);
  assert.match(readFileSync(target, "utf8"), /The week in dementia research/);
}

{
  // The model wrote the file itself: left exactly as written.
  const target = path.join(root, "written.md");
  writeFileSync(target, "# the model's report\n");
  const s = fakeSession([
    { role: "tool", name: "write_file", text: `wrote to ${target}` },
    { role: "assistant", text: "Done, report written." },
  ]);
  const code = enforceReport(target, s, "Done, report written.", () => {});
  assert.equal(code, 0);
  assert.equal(readFileSync(target, "utf8"), "# the model's report\n", "the model's file wins");
}

{
  // A file left over from last week must not count as success.
  const target = path.join(root, "stale.md");
  writeFileSync(target, "# last week\n");
  const old = new Date(Date.now() - 7 * 24 * 3600_000);
  utimesSync(target, old, old);
  const s = fakeSession([{ role: "assistant", text: "this week's answer" }]);
  assert.equal(
    enforceReport(target, s, "this week's answer", () => {}),
    1,
    "a report older than the run is a failure"
  );
  assert.equal(readFileSync(target, "utf8"), "# last week\n", "and is not overwritten");
}

{
  // The run could write files but did not write the one asked for.
  const target = path.join(root, "wrong-name.md");
  const s = fakeSession([
    { role: "tool", name: "write_file", text: "wrote /somewhere/else.md" },
    { role: "assistant", text: "done" },
  ]);
  assert.equal(enforceReport(target, s, "done", () => {}), 1);
}

// --- helpers ---------------------------------------------------------------

{
  assert.equal(lastAssistantText([{ role: "user", text: "q" }]), "");
  assert.equal(
    lastAssistantText([
      { role: "assistant", text: "first" },
      { role: "tool", text: "x" },
      { role: "assistant", text: "last" },
    ]),
    "last"
  );
}

console.log("headless: ok");
