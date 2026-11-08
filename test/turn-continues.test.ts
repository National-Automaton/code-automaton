/**
 * A turn must continue after a tool call, not end there.
 *
 * Regression: the tool-batch path in `send` ended with a bare `return {}`,
 * inside the `while (true)` loop. Every turn that used a tool therefore
 * returned immediately after that batch instead of letting the model carry on
 * from the results -- the agent ran one command, stopped, and went idle, and
 * the user had to prompt again for each step. The released code had no such
 * `return`; it simply fell through to the next iteration.
 *
 * This drives a real `Agent.send` against a stubbed stream: the first response
 * asks for a tool, the second is the model's continuation. If the turn stops
 * after the tool, the second response is never requested.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";

process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { Agent } = await import("../src/agent.js");

const cfg = {
  apiKey: "sk-test",
  baseURL: "https://example.invalid",
  model: "text-model",
  visionModel: "vision-model",
  visionBaseURL: "https://example.invalid",
  visionApiKey: "sk-test",
  mouse: false,
  parallelTools: true,
  compact: false,
} as any;

const textFrame = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
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
  // One tool call, then a text answer. The turn must make two requests.
  const calls = stubFetch([
    () =>
      framesResponse([
        toolFrame(0, "call_1", "read_file", { path: "/etc/hostname" }),
        stopFrame,
      ]),
    () => framesResponse([textFrame("Done: "), textFrame("hostname read."), stopFrame]),
  ]);

  const a: any = new Agent(cfg);
  let shown = "";
  const out = await a.send("read the hostname", (ev: any) => {
    if (ev.type === "text") shown += ev.text;
  });

  assert.equal(
    calls.calls,
    2,
    `the turn must continue after the tool call; made ${calls.calls} request(s)`
  );
  assert.ok(
    shown.includes("Done: hostname read."),
    `the model's continuation must be shown, got ${JSON.stringify(shown)}`
  );
  assert.deepEqual(out, {}, "an ordinary turn resolves with no new-session request");

  // The continuation's text is committed after the tool result.
  const roles = a.messages.map((m: any) => m.role);
  const toolIdx = roles.lastIndexOf("tool");
  const lastAssistant = roles.lastIndexOf("assistant");
  assert.ok(
    lastAssistant > toolIdx,
    `the final assistant reply must follow the tool result; roles: ${JSON.stringify(roles)}`
  );
} finally {
  (globalThis as any).fetch = realFetch;
}

console.log("turn-continues: ok");
