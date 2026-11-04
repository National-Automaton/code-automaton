/**
 * A session must not be stranded by one truncated tool call.
 *
 * When a provider hits its output-token cap mid-call, the arguments arrive as
 * invalid JSON. Providers validate every tool call in the history on every
 * request, so committing that call makes each later send fail with a bare
 * "400 invalid argument" -- the session can never be used again. These tests
 * pin both halves of the fix: a truncated turn is never committed, and an
 * already-damaged history is repaired on load.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { isValidJson } from "../src/agent.js";
import { repairMalformedToolCalls } from "../src/store.js";

// --- isValidJson ----------------------------------------------------------

assert.equal(isValidJson(undefined), true, "no arguments is valid (call takes none)");
assert.equal(isValidJson(""), true, "empty arguments is valid");
assert.equal(isValidJson("{}"), true, "empty object is valid");
assert.equal(isValidJson('{"a":1}'), true, "complete object is valid");
assert.equal(isValidJson('{"path":"x","content":"# Pla'), false, "truncated JSON is invalid");

// --- repairMalformedToolCalls ---------------------------------------------

/** An assistant turn whose single `write_file` call was cut off mid-string. */
const truncated = {
  role: "assistant",
  content: "Let me write the plan.",
  tool_calls: [
    {
      id: "call_bad",
      type: "function",
      function: { name: "write_file", arguments: '{"path":"/p/PLAN.md","content":"# Podcast Aut' },
    },
  ],
};

const healthy = {
  role: "assistant",
  content: null,
  tool_calls: [
    {
      id: "call_ok",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"/p/README.md"}' },
    },
  ],
};

const replyBad = { role: "tool", tool_call_id: "call_bad", content: "error: truncated" };
const replyOk = { role: "tool", tool_call_id: "call_ok", content: "# README" };

const system = { role: "system", content: "you are coda" };
const user = { role: "user", content: "write the plan" };

{
  const out = repairMalformedToolCalls([
    system,
    user,
    truncated,
    replyBad,
    healthy,
    replyOk,
  ] as any);

  const roles = out.map((m: any) => m.role);
  assert.deepEqual(
    roles,
    ["system", "user", "assistant", "assistant", "tool"],
    "the damaged call and its reply are dropped; healthy ones survive"
  );
  // The prose the model produced is kept: it may be the only record of it.
  assert.equal((out[2] as any).content, "Let me write the plan.");
  assert.equal((out[2] as any).tool_calls, undefined, "no tool_calls left on the repaired turn");
  assert.equal((out[4] as any).tool_call_id, "call_ok", "the healthy reply is untouched");
}

// A healthy history comes back untouched (same reference: no pointless copying).
{
  const msgs = [system, user, healthy, replyOk] as any;
  assert.equal(repairMalformedToolCalls(msgs), msgs, "healthy history is returned as-is");
}

// An assistant turn with no text and only the bad call keeps nothing -- but the
// turn is dropped rather than left as an empty message the provider may reject.
{
  const emptyBad = {
    role: "assistant",
    content: null,
    tool_calls: [truncated.tool_calls[0]],
  };
  const out = repairMalformedToolCalls([system, user, emptyBad, replyBad] as any);
  assert.deepEqual(
    out.map((m: any) => m.role),
    ["system", "user"],
    "a call-only damaged turn is removed entirely"
  );
}

// Multiple calls in one turn: only the malformed one goes, the rest still run.
{
  const multi = {
    role: "assistant",
    content: null,
    tool_calls: [truncated.tool_calls[0], healthy.tool_calls[0]],
  };
  const out = repairMalformedToolCalls([system, user, multi, replyBad, replyOk] as any);
  const kept = (out[2] as any).tool_calls;
  assert.equal(kept.length, 1);
  assert.equal(kept[0].id, "call_ok");
  assert.deepEqual(out.map((m: any) => m.role), ["system", "user", "assistant", "tool"]);
}

console.log("repair: truncated tool calls cannot strand a session");
