/**
 * A connection that drops mid-reply must not lose the turn.
 *
 * `terminated` is what undici reports when the socket closes under a streaming
 * response. It carries no HTTP status, so `createWithRetry` -- which retries
 * 503/429/500 on the *initial* request -- cannot help: by the time it fires the
 * reply is already partly on the user's screen, and re-sending the whole
 * request would print that text twice.
 *
 * The agent therefore keeps the partial text, commits it to the history, and
 * asks for the rest. These tests drive a real `Agent` against a stubbed
 * `fetch`: `Agent` builds its own OpenAI client but passes `globalThis.fetch`,
 * read at construction, so replacing it before the agent is made exercises the
 * same code path a dropped connection takes.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import type { Config } from "../src/config.js";

process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { Agent } = await import("../src/agent.js");

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

/** One SSE `data:` frame carrying assistant text. */
const textFrame = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const doneFrame = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`;

/**
 * A response whose body yields `chunks` and then either ends (`ok`) or throws
 * (`drop`), imitating a socket closed mid-stream.
 */
function streamResponse(chunks: string[], drop: boolean): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
        return;
      }
      if (drop) {
        // This is the shape undici surfaces to the consumer of the stream.
        controller.error(new TypeError("terminated"));
        return;
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Stub `globalThis.fetch`, returning each response in turn. */
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
    // --- a drop after some text is resumed, not repeated -------------------
    {
      const calls = stubFetch([
        // First attempt: two frames arrive, then the socket dies.
        () => streamResponse([textFrame("Hello "), textFrame("there")], true),
        // Continuation: finishes the reply.
        () => streamResponse([textFrame(" friend"), doneFrame], false),
      ]);
      const agent = new Agent(cfg);
      let shown = "";
      const events: string[] = [];
      await agent.send("hi", (ev: any) => {
        events.push(ev.type);
        if (ev.type === "text") shown += ev.text;
      });

      assert.equal(calls.calls, 2, "the turn should have been resumed exactly once");
      // The continued text is present, and the first attempt's text is not sent
      // again -- it arrived once and is in the history for the model to build on.
      assert.ok(shown.includes("Hello there"), `first attempt's text must survive, got ${JSON.stringify(shown)}`);
      assert.ok(shown.includes(" friend"), `continuation text should appear, got ${JSON.stringify(shown)}`);
      assert.equal(
        shown.split("Hello").length - 1,
        1,
        `the partial text must not be repeated: ${JSON.stringify(shown)}`
      );
      assert.ok(
        shown.includes("connection dropped mid-reply"),
        "the interruption should be visible in the transcript"
      );
      assert.ok(events.includes("done"), "the turn should finish normally after resuming");
    }

    // --- a drop with nothing received rethrows for the existing retry ------
    //
    // With no partial text there is nothing to continue from, so the error
    // propagates and `createWithRetry` (or the caller) deals with it. Retrying
    // the whole request is safe here because nothing was shown.
    {
      const calls = stubFetch([() => streamResponse([], true), () => streamResponse([textFrame("ok"), doneFrame], false)]);
      const agent = new Agent(cfg);
      await assert.rejects(
        () => agent.send("hi", () => {}),
        (err: any) => err?.message === "terminated",
        "a drop before any content should surface the transport error"
      );
      assert.equal(calls.calls, 1, "nothing was received, so no continuation is attempted");
    }

    // --- repeated drops fail the turn rather than looping ------------------
    {
      const calls = stubFetch([() => streamResponse([textFrame("x")], true)]);
      const agent = new Agent(cfg);
      await assert.rejects(
        () => agent.send("hi", () => {}),
        (err: any) => /connection dropped .* times mid-reply/.test(String(err?.message)),
        "a connection that keeps dying should fail explicitly"
      );
      // Bounded: one initial attempt plus MAX_INTERRUPTIONS resumes.
      assert.equal(calls.calls, 4, `expected 4 attempts (1 + 3), got ${calls.calls}`);
    }
  } finally {
    (globalThis as any).fetch = realFetch;
  }

  console.log("stream-interrupt: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
