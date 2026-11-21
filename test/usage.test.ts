/**
 * Token usage recorded per assistant turn.
 *
 * Sessions used to carry no usage at all, so anything reporting on cost had to
 * estimate from character counts -- noisy, and blind to cache hits, which are
 * most of the bill on a long session.
 *
 * Three properties matter and are pinned here:
 *
 *  - **Counts only.** A session file is plain JSON written every turn and
 *    re-sent as history, so a usage object must never hold message text.
 *  - **`unknown` is not zero.** Providers report usage only when asked, and not
 *    all honour the request. A turn with no numbers must read as "not
 *    reported", never as a free turn.
 *  - **A turn can make several requests.** Tool round-trips each report usage,
 *    and the entry's numbers are sums, with `unknown` sticky once any request
 *    went unreported.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";

process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { normaliseUsage } = await import("../src/agent.js");
const { mergeUsage } = await import("../src/session.js");

// --- provider shapes ------------------------------------------------------

{
  // OpenAI-compatible, as Gemini's shim sends it.
  const u = normaliseUsage({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }, "gemini-3.6-flash");
  assert.equal(u.promptTokens, 2);
  assert.equal(u.completionTokens, 1);
  assert.equal(u.totalTokens, 3);
  assert.equal(u.model, "gemini-3.6-flash");
  assert.equal(u.details, undefined, "nothing extra to record");
  assert.ok(!u.unknown, "a reported turn is not unknown");
}

{
  // DeepSeek: the extra counters that make cost accurate.
  const u = normaliseUsage({
    prompt_tokens: 1658,
    completion_tokens: 1,
    total_tokens: 1659,
    prompt_tokens_details: { cached_tokens: 1408 },
    prompt_cache_hit_tokens: 1408,
    prompt_cache_miss_tokens: 250,
    completion_tokens_details: { reasoning_tokens: 5 },
  }, "deepseek-flash");

  assert.equal(u.promptTokens, 1658);
  assert.equal(u.details?.["prompt_tokens_details.cached_tokens"], 1408, "nested counters are flattened");
  assert.equal(u.details?.prompt_cache_hit_tokens, 1408);
  assert.equal(u.details?.["completion_tokens_details.reasoning_tokens"], 5);
  // The headline counters are not repeated inside details.
  assert.equal(u.details?.prompt_tokens, undefined);
  assert.equal(u.details?.total_tokens, undefined);
}

{
  // A malformed or unexpected payload must not throw, and must not invent numbers.
  for (const raw of [null, undefined, {}, { prompt_tokens: "many" }, { prompt_tokens: NaN }]) {
    const u = normaliseUsage(raw as any, "m");
    assert.equal(u.promptTokens, undefined, `${JSON.stringify(raw)} yields no count`);
    assert.ok(!u.unknown, "normaliseUsage reports what arrived; 'unknown' is decided by the caller");
  }
}

{
  // A provider putting a string in `details` must not leak it into a session.
  const u = normaliseUsage({ prompt_tokens: 1, note: "the user asked about project X" } as any);
  assert.equal(u.details?.note, undefined, "non-numeric values are dropped, not stored");
  assert.deepEqual(u.details, undefined);
}

// --- merging across the requests of one turn ------------------------------

{
  const a = normaliseUsage({ prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 }, "m");
  const b = normaliseUsage({ prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 }, "m");
  const m = mergeUsage(a, b);
  assert.equal(m.promptTokens, 150, "sums across requests");
  assert.equal(m.completionTokens, 15);
  assert.equal(m.totalTokens, 165);
  assert.equal(m.model, "m");
  assert.ok(!m.unknown);
}

{
  // One request reported, one did not: the total is a lower bound.
  const reported = normaliseUsage({ prompt_tokens: 100, total_tokens: 100 }, "m");
  const m = mergeUsage(reported, { unknown: true });
  assert.equal(m.promptTokens, 100);
  assert.equal(m.unknown, true, "unknown is sticky, so the total is not read as complete");
}

{
  // Nothing reported at all.
  const m = mergeUsage({ unknown: true }, { unknown: true });
  assert.equal(m.unknown, true);
  assert.equal(m.promptTokens, undefined, "no numbers are invented");
  assert.equal(m.totalTokens, undefined);
}

{
  // Details accumulate too, since a cached prefix is per request.
  const a = normaliseUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 5 });
  const b = normaliseUsage({ prompt_tokens: 10, prompt_cache_hit_tokens: 7 });
  const m = mergeUsage(a, b);
  assert.equal(m.details?.prompt_cache_hit_tokens, 12);
}

// --- no undefined keys in a saved record ----------------------------------

{
  const m = mergeUsage(undefined, { unknown: true });
  for (const k of ["promptTokens", "completionTokens", "totalTokens"] as const) {
    assert.ok(!(k in m), `${k} is omitted rather than written as undefined`);
  }
}

console.log("usage.test.ts: ok");
