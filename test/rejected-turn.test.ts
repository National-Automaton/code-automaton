/**
 * A turn the provider refuses before it starts must leave no trace.
 *
 * When a request is rejected with a 4xx before any stream event, the turn never
 * ran: no reply was started, so nothing was lost. But `Agent.send` has already
 * pushed the user message into the history by then, and `Session.run` persists
 * in a `finally` -- so the rejected message was written to disk anyway. Every
 * retry added another one, to a conversation the provider kept refusing: a
 * session damaged by an unanswered tool call grew a message per attempt, which
 * hid the fault and made the file steadily worse (#66).
 *
 * These tests pin both halves: the history is rolled back, and the *successful*
 * path -- including a mid-reply drop, which must still keep its message -- is
 * unchanged.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import type { Config } from "../src/config.js";

process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { Agent, isMalformedHistoryError, isRequestRejection } = await import("../src/agent.js");

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

const textFrame = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const doneFrame = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`;

/** A well-formed SSE reply. */
function okResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
        return;
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * A 400 in the shape the provider uses when the history holds an unanswered
 * tool call -- the exact failure that started this. The OpenAI SDK reads the
 * JSON body and raises an `APIError` carrying `status`.
 */
function rejectedResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MALFORMED =
  "An assistant message with 'tool_calls' must be followed by tool messages " +
  "responding to each 'tool_call_id'. (insufficient tool messages following tool_calls message)";

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

async function main() {
  try {
    // --- a rejected request leaves the history untouched -------------------
    {
      const calls = stubFetch([() => rejectedResponse(400, MALFORMED)]);
      const agent = new Agent(cfg);
      const before = agent.messages.length;

      await assert.rejects(
        () => agent.send("ok, let's get back to work", () => {}),
        (err: any) => isRequestRejection(err),
        "a request-level rejection should be tagged for the caller"
      );

      assert.equal(
        agent.messages.length,
        before,
        "the rejected turn's user message must not stay in the history"
      );
      assert.equal(calls.calls, 1, "a 400 is not retried: re-sending the same history cannot work");
    }

    // --- retrying does not grow the history --------------------------------
    {
      stubFetch([() => rejectedResponse(400, MALFORMED)]);
      const agent = new Agent(cfg);
      const before = agent.messages.length;
      for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(() => agent.send("try again", () => {}), (err: any) =>
          isRequestRejection(err)
        );
      }
      assert.equal(
        agent.messages.length,
        before,
        "three attempts must leave the history exactly as it started, not add three messages"
      );
    }

    // --- the rejection is reported as a malformed history -----------------
    {
      stubFetch([() => rejectedResponse(400, MALFORMED)]);
      const agent = new Agent(cfg);
      await assert.rejects(
        () => agent.send("hi", () => {}),
        (err: any) => {
          assert.ok(isMalformedHistoryError(err), "the caller needs to know the history is at fault");
          assert.equal(err.status, 400);
          return true;
        }
      );
    }

    // --- the successful path still keeps its message ----------------------
    {
      stubFetch([() => okResponse([textFrame("Hello"), doneFrame])]);
      const agent = new Agent(cfg);
      const before = agent.messages.length;
      await agent.send("hi", () => {});
      assert.equal(
        agent.messages.length,
        before + 2,
        "a normal turn keeps both its user message and its reply"
      );
    }

    // --- a mid-reply drop still keeps the message (must not regress) ------
    //
    // A transport death after the request was accepted is *not* a rejection:
    // the turn genuinely happened, so its user message belongs in the history.
    {
      const encoder = new TextEncoder();
      let sent = 0;
      (globalThis as any).fetch = async () => {
        sent++;
        if (sent > 1) {
          // Continuation: finishes the reply.
          return okResponse([textFrame("resumed"), doneFrame]);
        }
        let i = 0;
        const chunks = [textFrame("partial ")];
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (i < chunks.length) {
              controller.enqueue(encoder.encode(chunks[i++]));
              return;
            }
            // Drop only after text has arrived, so the turn keeps it.
            controller.error(new TypeError("terminated"));
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };

      const agent = new Agent(cfg);
      const before = agent.messages.length;
      await agent.send("hi", () => {});
      assert.ok(
        agent.messages.length > before,
        "a turn whose connection dropped still keeps its user message and reply"
      );
      assert.equal(sent, 2, "the dropped turn is resumed rather than discarded");
    }

    // --- statuses the retry helper owns are not treated as rejections -----
    //
    // 429/500/503 are upstream failures: the turn is in doubt rather than
    // plainly refused, and `createWithRetry` handles them. They must not be
    // tagged, or a transient blip would silently discard the user's message.
    for (const status of [429, 500, 503]) {
      const err = Object.assign(new Error("upstream"), { status });
      assert.equal(
        isRequestRejection(err),
        false,
        `${status} is transient and must not roll the turn back`
      );
    }

    // A plain transport error carries no status at all.
    assert.equal(isRequestRejection(new Error("terminated")), false, "no status is not a rejection");
    assert.equal(isRequestRejection(new TypeError("terminated")), false);
  } finally {
    (globalThis as any).fetch = realFetch;
  }
}

await main();
console.log("rejected-turn: a refused request leaves the session unchanged");
