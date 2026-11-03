/**
 * Which tool calls may run concurrently, and that they actually do.
 *
 * Two layers:
 *
 *  1. `parallelBatch` is a pure function over the model's requested calls, so
 *     the safety rule is tested directly: read-only calls batch, anything that
 *     writes -- or a repeated path -- falls back to serial order.
 *  2. `runToolCalls` is the scheduler `Agent.send` uses. Its tool runner is
 *     injected, so real overlap can be measured with fake tools instead of
 *     doing real I/O.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import {
  MAX_TOOL_OUTPUT_CHARS,
  clampOutput,
  looksBinary,
  parallelBatch,
  runTool,
  writesSomething,
} from "../src/tools.js";
import { Agent, runToolCalls, trimHistory } from "../src/agent.js";
import type { Config } from "../src/config.js";
import type { AgentEvent, ParsedToolCall } from "../src/agent.js";
import type { ToolResult } from "../src/tools.js";

const log = (s: string) => process.stderr.write(s + "\n");

// ---------------------------------------------------------------- the rule --

// Read-only calls, in different files or touching nothing: batch together.
assert.deepEqual(
  parallelBatch([
    { name: "read_file", args: { path: "a.ts" } },
    { name: "read_file", args: { path: "b.ts" } },
    { name: "list_dir", args: { path: "src" } },
  ]),
  [0, 1, 2],
  "independent reads should batch"
);

// A writer ends the batch at its own index; the reads before it still batch.
assert.deepEqual(
  parallelBatch([
    { name: "read_file", args: { path: "a.ts" } },
    { name: "read_file", args: { path: "b.ts" } },
    { name: "edit_file", args: { path: "a.ts", old_string: "x", new_string: "y" } },
  ]),
  [0, 1],
  "a writer should end the batch, not be included"
);

// A writer first means nothing batches at all: order matters from row 0.
assert.deepEqual(
  parallelBatch([
    { name: "write_file", args: { path: "a.ts", content: "x" } },
    { name: "read_file", args: { path: "b.ts" } },
  ]),
  [],
  "a leading writer should disable batching for the request"
);

// Same path twice: stop at the repeat.
assert.deepEqual(
  parallelBatch([
    { name: "read_file", args: { path: "a.ts" } },
    { name: "read_file", args: { path: "a.ts" } },
  ]),
  [0],
  "repeated paths should end the batch"
);

// An unknown tool counts as a writer, so a tool added later is serialised
// until it is explicitly listed as read-only.
assert.equal(writesSomething("some_future_tool"), true, "unknown tools are writers");

assert.deepEqual(parallelBatch([]), [], "no calls, no batch");

// bash batches: it is deliberately classed as read-only (see READ_ONLY_TOOLS).
assert.deepEqual(
  parallelBatch([
    { name: "bash", args: { command: "grep -r foo src" } },
    { name: "bash", args: { command: "git status" } },
  ]),
  [0, 1],
  "bash calls should batch"
);

// ------------------------------------------------------- the scheduler --

/** A call that resolves after `ms`, recording when it started and finished. */
function timed(
  log: Array<{ name: string; at: "start" | "end"; t: number }>,
  name: string,
  output: string,
  ms: number
) {
  return async (): Promise<ToolResult> => {
    log.push({ name, at: "start", t: Date.now() });
    await new Promise((r) => setTimeout(r, ms));
    log.push({ name, at: "end", t: Date.now() });
    return { ok: true, output };
  };
}

function calls(specs: Array<[string, string]>): ParsedToolCall[] {
  return specs.map(([name, path], i) => ({ id: `call-${i}`, name, args: { path } }));
}

const noopEmit = () => {};

// Independent reads overlap: all three start before any of them finishes.
{
  const log: Array<{ name: string; at: "start" | "end"; t: number }> = [];
  const runners = new Map([
    ["a.ts", timed(log, "a", "A", 40)],
    ["b.ts", timed(log, "b", "B", 40)],
    ["c.ts", timed(log, "c", "C", 40)],
  ]);
  const startedAt = Date.now();
  const results = await runToolCalls(
    calls([
      ["read_file", "a.ts"],
      ["read_file", "b.ts"],
      ["read_file", "c.ts"],
    ]),
    noopEmit,
    (_name, args) => runners.get(args.path)!()
  );
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(
    results.map((r) => r.output),
    ["A", "B", "C"],
    "results should come back in request order"
  );
  // Every call began before the first one ended -- that is real overlap.
  const firstEnd = log.findIndex((e) => e.at === "end");
  const startsBeforeFirstEnd = log.slice(0, firstEnd).filter((e) => e.at === "start").length;
  assert.equal(startsBeforeFirstEnd, 3, "all three reads should start before any finishes");
  assert.ok(elapsed < 100, `three 40ms reads took ${elapsed}ms; serial would be ~120ms`);
}

// A slow first call must not let a fast later result jump the queue.
{
  const delay = new Map([
    ["slow.ts", 60],
    ["fast1.ts", 1],
    ["fast2.ts", 1],
  ]);
  const emitted: AgentEvent[] = [];
  const results = await runToolCalls(
    calls([
      ["read_file", "slow.ts"],
      ["read_file", "fast1.ts"],
      ["read_file", "fast2.ts"],
    ]),
    (ev) => emitted.push(ev),
    async (_name, args) => {
      await new Promise((r) => setTimeout(r, delay.get(args.path)));
      return { ok: true, output: args.path };
    }
  );
  assert.deepEqual(
    results.map((r) => r.output),
    ["slow.ts", "fast1.ts", "fast2.ts"],
    "a slow first result must not let later ones overtake it"
  );
  // Both tool_starts are announced up front, then results in order.
  const kinds = emitted.map((e) => (e.type === "tool_start" ? "start" : e.type));
  assert.deepEqual(
    kinds,
    ["start", "start", "start", "tool_result", "tool_result", "tool_result"],
    "all calls are announced before any result is emitted"
  );
  const resultNames = emitted
    .filter((e): e is Extract<AgentEvent, { type: "tool_result" }> => e.type === "tool_result")
    .map((e) => e.output);
  assert.deepEqual(resultNames, ["slow.ts", "fast1.ts", "fast2.ts"], "events keep request order");
}

// A writer forces serial execution: the second call cannot start until the
// first has finished.
{
  const log: Array<{ name: string; at: "start" | "end"; t: number }> = [];
  const runners = new Map([
    ["a.ts", timed(log, "a", "A", 20)],
    ["b.ts", timed(log, "b", "B", 1)],
  ]);
  await runToolCalls(
    calls([
      ["read_file", "a.ts"],
      ["edit_file", "b.ts"],
    ]),
    noopEmit,
    (_name, args) => runners.get(args.path)!()
  );
  const aEnd = log.findIndex((e) => e.name === "a" && e.at === "end");
  const bStart = log.findIndex((e) => e.name === "b" && e.at === "start");
  assert.ok(
    aEnd < bStart,
    "the edit_file must not start until the read_file before it has finished"
  );
}

// With `parallel` false nothing overlaps, even for independent reads.
{
  const log: Array<{ name: string; at: "start" | "end"; t: number }> = [];
  const runners = new Map([
    ["a.ts", timed(log, "a", "A", 20)],
    ["b.ts", timed(log, "b", "B", 1)],
  ]);
  await runToolCalls(
    calls([
      ["read_file", "a.ts"],
      ["read_file", "b.ts"],
    ]),
    noopEmit,
    (_name, args) => runners.get(args.path)!(),
    false
  );
  const aEnd = log.findIndex((e) => e.name === "a" && e.at === "end");
  const bStart = log.findIndex((e) => e.name === "b" && e.at === "start");
  assert.ok(aEnd < bStart, "CODA_PARALLEL_TOOLS=off must run every call serially");
}

// ------------------------------------------------------- the running count --

// The status bar reads this count, so it must rise as calls start and come back
// to 0, without ever going negative or getting stuck.
{
  const seen: number[] = [];
  const callsList: ParsedToolCall[] = [
    { id: "a", name: "read_file", args: { path: "a.ts" } },
    { id: "b", name: "read_file", args: { path: "b.ts" } },
    { id: "c", name: "read_file", args: { path: "c.ts" } },
  ];
  await runToolCalls(
    callsList,
    noopEmit,
    async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, output: "x" };
    },
    true,
    (running) => seen.push(running)
  );
  // All three batch at once, so the count starts at 3 and steps down to 0.
  assert.equal(seen[0], 3, `expected 3 in flight at the start, saw ${JSON.stringify(seen)}`);
  assert.equal(seen[seen.length - 1], 0, "the count must return to 0 when the batch ends");
  assert.ok(
    seen.every((n) => n >= 0 && n <= 3),
    `count went out of range: ${JSON.stringify(seen)}`
  );
}

// Serial calls (a writer in the request) never have more than one in flight.
{
  const seen: number[] = [];
  await runToolCalls(
    [
      { id: "a", name: "read_file", args: { path: "a.ts" } },
      { id: "b", name: "edit_file", args: { path: "b.ts" } },
    ],
    noopEmit,
    async () => ({ ok: true, output: "x" }),
    true,
    (running) => seen.push(running)
  );
  assert.ok(
    seen.every((n) => n <= 1),
    `serial calls must never overlap: ${JSON.stringify(seen)}`
  );
  assert.equal(seen[seen.length - 1], 0, "serial run must also end at 0");
}

// A failing tool still decrements, so the count cannot stick above zero.
{
  const seen: number[] = [];
  await runToolCalls(
    [{ id: "a", name: "read_file", args: { path: "a.ts" } }],
    noopEmit,
    async () => ({ ok: false, output: "boom" }),
    true,
    (running) => seen.push(running)
  );
  assert.equal(seen[seen.length - 1], 0, "a failed call must not leave the count stuck");
}

// ---- The agent resets its live count when a turn ends ------------------
//
// The status bar reads `agent.runningTools`, so a turn must not leave a stale
// count behind once `send` has resolved. The agent is driven against a stub
// client that asks for one real tool call, then reports the turn as done.
{
  const agent = new Agent({
    apiKey: "test",
    baseURL: "http://localhost",
    model: "test-model",
    visionModel: "test-model",
    visionBaseURL: "http://localhost",
    visionApiKey: "test",
    mouse: false,
    parallelTools: true,
  } as Config);
  let request = 0;
  (agent as any).client = {
    chat: {
      completions: {
        async create() {
          request++;
          const delta =
            request === 1
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      function: {
                        // A real, slow-enough shell command: the count is read
                        // while the child process runs, which is long enough to
                        // observe without racing `runToolCalls`' own bookkeeping.
                        name: "bash",
                        arguments: JSON.stringify({ command: "sleep 0.15" }),
                      },
                    },
                  ],
                }
              : {};
          return (async function* () {
            yield { choices: [{ delta }] };
          })();
        },
      },
    },
  };
  // A timer samples the count while the `bash` child is still running; that is
  // the value the status bar shows during the tool phase.
  let inFlight = -1;
  const sampler = setInterval(() => {
    inFlight = Math.max(inFlight, agent.runningTools);
  }, 5);
  await agent.send("go", () => {});
  clearInterval(sampler);
  assert.equal(inFlight, 1, "the count should read 1 while the tool is in flight");
  assert.equal(agent.runningTools, 0, "a finished turn must leave the live tool count at 0");
  // The peak is what the status bar lingers: with no frame drawn while the call
  // was running, `runningTools` is never observed non-zero, but the peak still
  // records that one tool ran.
  assert.equal(agent.toolPeak, 1, "the run's peak should be remembered for the status bar");
}

// ------------------------------------------------- binary reads & clamping --

// A JPEG read as text is what wedged a real session: 2.2 MB of mojibake went
// into the history and was re-sent every step until the provider rejected the
// request for exceeding its context window. `read_file` must refuse it.
{
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "coda-bin-"));
  const jpg = path.join(dir, "shot.jpg");
  // JPEG SOI marker, then bytes that are not valid UTF-8.
  await fs.writeFile(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]));
  const res = await runTool("read_file", { path: jpg });
  assert.equal(res.ok, false, "reading a binary file must fail, not return mojibake");
  assert.match(res.output, /binary file/, "the refusal should say the file is binary");

  // Plain text is unaffected.
  const txt = path.join(dir, "a.txt");
  await fs.writeFile(txt, "hello\n");
  assert.deepEqual(await runTool("read_file", { path: txt }), { ok: true, output: "hello\n" });
  await fs.rm(dir, { recursive: true, force: true });
}

assert.equal(looksBinary(Buffer.from("plain text")), false, "text is not binary");
assert.equal(looksBinary(Buffer.from([0x00, 0x01])), true, "a NUL byte means binary");

// Oversized output is clamped, keeping the head and the tail.
{
  const huge = "H".repeat(300_000) + "MIDDLE" + "T".repeat(300_000);
  const out = clampOutput(huge);
  assert.ok(out.length <= MAX_TOOL_OUTPUT_CHARS, "clamped output must fit the limit");
  assert.ok(out.startsWith("H"), "the head is kept");
  assert.ok(out.endsWith("T"), "the tail is kept");
  assert.match(out, /truncated by coda/, "the drop is explained to the model");
  assert.equal(clampOutput("short"), "short", "small output passes through untouched");
}

// ------------------------------------------------ history stays under budget --

{
  const sys = { role: "system", content: "sys" } as any;
  const msgs: any[] = [sys];
  for (let i = 0; i < 50; i++) {
    msgs.push({ role: "user", content: "u".repeat(1000) });
    msgs.push({ role: "assistant", content: "a".repeat(1000) });
  }
  const trimmed = trimHistory(msgs, 10_000);
  const total = trimmed.reduce((n: number, m: any) => n + JSON.stringify(m).length, 0);
  assert.ok(total <= 10_000 + 2_100, `trimmed history should fit the budget (got ${total})`);
  assert.equal(trimmed[0], sys, "the system prompt is never dropped");
  assert.equal(trimmed[trimmed.length - 1], msgs[msgs.length - 1], "the newest message is kept");

  // Orphaned tool messages are dropped with the assistant turn that owned them.
  const withTools: any[] = [
    sys,
    { role: "user", content: "x".repeat(5000) },
    { role: "assistant", content: null, tool_calls: [{ id: "c1" }] },
    { role: "tool", tool_call_id: "c1", content: "y".repeat(5000) },
    { role: "user", content: "newest" },
  ];
  const t2 = trimHistory(withTools, 6_000);
  assert.notEqual(t2[1]?.role, "tool", "history must not begin with an orphaned tool message");
  assert.equal(t2[t2.length - 1].content, "newest", "the newest message survives trimming");
}

log("tools: parallel batching rules and scheduling hold");
