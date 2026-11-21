/**
 * Rate limits: how long to wait, and what to tell the user.
 *
 * A 429 from Gemini is usually a per-minute rate limit, not a billing problem —
 * but a bare "error: 429" reads as the latter and sends people to check their
 * balance. Worse, coda's retry backoff was 0.5s then 1s, which cannot outlast a
 * 60-second quota window, so the retries could never succeed and the raw 429
 * surfaced anyway.
 *
 * What is pinned here:
 *
 *  - the provider's own guidance is found wherever it puts it;
 *  - an absent hint falls back rather than guessing;
 *  - the wait is capped, so a turn cannot appear to hang;
 *  - the explanation says "rate limit", and only says "billing" when the
 *    provider's own words say so.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";

process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { retryHintMs, explainRejection, providerError } = await import("../src/agent.js");

/** A provider error with optional headers, in the shape the SDK throws. */
function apiError(status: number, message: string, headers: Record<string, string> = {}) {
  return { status, message, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } };
}

// --- where the hint lives -------------------------------------------------

{
  // The standard header.
  assert.equal(retryHintMs(apiError(429, "slow down", { "retry-after": "30" })), 30_000);
  // Fractional, as some providers send.
  assert.equal(retryHintMs(apiError(429, "", { "retry-after": "2.5" })), 2_500);
  // OpenAI-style reset headers, when there is no Retry-After.
  assert.equal(
    retryHintMs(apiError(429, "", { "x-ratelimit-reset-requests": "12" })),
    12_000
  );
}

{
  // Gemini puts it in the message: "Please retry in 30.5s".
  const err = apiError(
    429,
    "You exceeded your current quota. Please retry in 30.5s."
  );
  assert.equal(retryHintMs(err), 30_500);
}

{
  // A plain-object header bag must work too, not just the SDK's Headers.
  const err = { status: 429, message: "", headers: { "retry-after": "7" } };
  assert.equal(retryHintMs(err), 7_000);
}

{
  // Nothing to go on: null, so the caller uses its own backoff rather than
  // inventing a wait.
  assert.equal(retryHintMs(apiError(429, "too many requests")), null);
  assert.equal(retryHintMs(apiError(500, "")), null);
  assert.equal(retryHintMs({}), null);
  assert.equal(retryHintMs(null), null);
  // A malformed header is ignored rather than becoming NaN.
  assert.equal(retryHintMs(apiError(429, "", { "retry-after": "soon" })), null);
  assert.equal(retryHintMs(apiError(429, "", { "retry-after": "-5" })), null);
}

// --- what the user is told -----------------------------------------------

{
  // The distinction that started this: a rate limit is not a balance problem.
  const msg = explainRejection(apiError(429, "You exceeded your current quota. Please retry in 30s."));
  assert.ok(/rate limit/i.test(msg), `a 429 is described as a rate limit: ${msg}`);
  assert.ok(/30s/.test(msg), "and says how long to wait");
  assert.ok(!/billing/i.test(msg), "without implying a billing problem");
}

{
  // ...but if the provider really does say billing, say that instead.
  const msg = explainRejection(
    apiError(429, "Your credit balance is too low to access the API.")
  );
  assert.ok(/quota or billing/i.test(msg), `billing is reported when the provider says so: ${msg}`);
}

{
  // A non-429 passes the provider's message through untouched.
  const msg = explainRejection(apiError(400, "invalid model: gemini-4-carbon"));
  assert.equal(msg, "invalid model: gemini-4-carbon");
}

{
  // No message at all must not produce an empty explanation.
  const msg = explainRejection(apiError(429, ""));
  assert.ok(msg.length > 0, "there is always something to say");
  assert.ok(/rate limit/i.test(msg));
}

// --- the turn actually waits that long ------------------------------------

{
  // The regression this fixes: the backoff was 0.5s then 1s, so a 429 asking for
  // 30s was retried three times in 1.5 seconds and then surfaced raw. This
  // asserts the wait comes from the provider's hint, not the fixed schedule.
  const { Agent } = await import("../src/agent.js");
  const cfg = {
    apiKey: "sk-test-placeholder",
    baseURL: "https://example.invalid",
    model: "m",
    visionModel: "",
    visionBaseURL: "https://example.invalid",
    visionApiKey: "sk-test-placeholder",
    endpoints: [],
    mouse: false,
    parallelTools: true,
    compact: false,
  } as any;
  const a: any = new Agent(cfg);

  // A stub client that always 429s with a 2s hint, recording call times.
  const calls: number[] = [];
  const client = {
    chat: {
      completions: {
        create: async () => {
          calls.push(Date.now());
          const e: any = new Error("rate limited. Please retry in 2s.");
          e.status = 429;
          e.headers = { get: () => null };
          throw e;
        },
      },
    },
  };

  const events: any[] = [];
  await a.createWithRetry(client, "m", (ev: any) => events.push(ev)).catch(() => {});

  assert.ok(calls.length >= 3, `it retried: ${calls.length} attempts`);
  // Each gap should be about the 2s the provider asked for, not 500ms.
  const gap = calls[1] - calls[0];
  assert.ok(gap >= 1800, `waited for the provider's hint, not the fixed backoff (gap ${gap}ms)`);

  const notices = events.filter((e) => e.type === "text").map((e) => e.text).join("");
  assert.ok(/retrying in 2s/.test(notices), `the retry delay is reported: ${notices}`);
}

// --- Gemini's array-shaped errors ----------------------------------------
//
// Google's OpenAI-compatible endpoint returns `[{error: {...}}]`, not
// `{error: {...}}`. The SDK finds no top-level `error`, concludes there is no
// body, and surfaces "429 status code (no body)" -- discarding the message that
// said what was limited and when to retry. Seen live from this endpoint.
{
  const gemini429 = {
    status: 429,
    message: "429 status code (no body)",
    // What the SDK attaches for a body it could not interpret.
    error: [
      {
        error: {
          code: 429,
          message: "You exceeded your current quota. Please retry in 30.5s.",
          status: "RESOURCE_EXHAUSTED",
        },
      },
    ],
  };

  const inner = providerError(gemini429);
  assert.ok(inner, "the provider's error object is recovered");
  assert.equal(inner.status, "RESOURCE_EXHAUSTED");

  const msg = explainRejection(gemini429);
  assert.ok(/rate limit/i.test(msg), `still classified as a rate limit: ${msg}`);
  assert.ok(/RESOURCE_EXHAUSTED/.test(msg), `the provider's own label survives: ${msg}`);
  assert.ok(/retry in 30\.5s/i.test(msg), `and its retry instruction: ${msg}`);
  assert.ok(!/no body/.test(msg), "the SDK's shrug is not passed on as the explanation");

  // And the hint is found in that recovered text, so the wait is right.
  assert.equal(retryHintMs(gemini429), 30_500);
}

{
  // A plain object body -- the shape the SDK does handle -- still works.
  const normal = { status: 429, message: "429", error: { error: { message: "slow down, retry in 5s" } } };
  assert.equal(retryHintMs(normal), 5_000);
  assert.equal(providerError(normal)?.message, "slow down, retry in 5s");
}

{
  // Nothing recoverable: no throw, no invented text.
  assert.equal(providerError({ status: 429, message: "429 status code (no body)" }), null);
  const msg = explainRejection({ status: 429, message: "429 status code (no body)" });
  assert.ok(msg.length > 0);
  assert.ok(!/no body/.test(msg), "a bare SDK message is not presented as the provider's");
}

// --- recovering a body the SDK threw away --------------------------------
//
// Gemini returns `[{error: {...}}]`; the SDK expects `{error: {...}}` and gives
// up, leaving `err.error` undefined and the message "429 status code (no body)".
// `recordingFetch` reads the raw body before that happens.
{
  const realFetch = globalThis.fetch;
  const { recordingFetch } = await import("../src/agent.js");

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([{ error: { code: 429, message: "Please retry in 12s.", status: "RESOURCE_EXHAUSTED" } }]),
      { status: 429 }
    )) as typeof fetch;

  const recording = recordingFetch();
  await recording("https://example.invalid/v1/chat/completions", { method: "POST" });
  globalThis.fetch = realFetch;

  const err = { status: 429, message: "429 status code (no body)" };
  const inner = providerError(err);
  assert.ok(inner, "the discarded body is recovered");
  assert.equal(inner.status, "RESOURCE_EXHAUSTED");
  assert.equal(retryHintMs(err), 12_000, "and its retry hint is usable");

  const msg = explainRejection(err);
  assert.ok(/RESOURCE_EXHAUSTED/.test(msg), `provider label survives: ${msg}`);
  assert.ok(!/no body/.test(msg), "the SDK's shrug is not passed on");
}

{
  // A successful response must not be touched or buffered.
  const realFetch = globalThis.fetch;
  const { recordingFetch } = await import("../src/agent.js");
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
  const recording = recordingFetch();
  const res = await recording("https://example.invalid/v1/chat/completions", {});
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok", "the body is still readable by the caller");
  globalThis.fetch = realFetch;
}

console.log("retry.test.ts: ok");
