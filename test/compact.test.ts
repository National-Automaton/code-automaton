/**
 * Compaction: replacing old turns with a summary instead of dropping them.
 *
 * The properties that matter are structural, not cosmetic:
 *
 *  1. A split never lands between an `assistant` turn that carries tool_calls
 *     and its `tool` results -- providers reject an orphaned `tool` message.
 *  2. The system prompt always survives, and the newest turn is always kept.
 *  3. Nothing happens below the threshold, so default-off costs nothing.
 *  4. A failed summary falls back to `trimHistory` rather than breaking the
 *     turn -- compaction must never make a session fail that would otherwise
 *     have worked.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  compactHistory,
  splitForCompaction,
  trimHistory,
  DEFAULT_COMPACT_AT,
} from "../src/agent.js";

const log = (s: string) => process.stderr.write(s + "\n");

const sys: ChatCompletionMessageParam = { role: "system", content: "SYS" };

/** One turn: a user ask, an assistant tool call, and its tool result. */
function turn(n: number, size = 100): ChatCompletionMessageParam[] {
  return [
    { role: "user", content: `ask ${n} ` + "u".repeat(size) },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: `c${n}`, type: "function", function: { name: "read_file", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: `c${n}`, content: `result ${n} ` + "t".repeat(size) },
  ];
}

function history(turns: number, size = 100): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [sys];
  for (let i = 1; i <= turns; i++) out.push(...turn(i, size));
  return out;
}

/** Assert the history never starts (after the system prompt) with a tool msg,
 *  and never contains a tool msg whose assistant call was removed. */
function assertWellFormed(messages: ChatCompletionMessageParam[], where: string) {
  assert.equal(messages[0].role, "system", `${where}: system prompt must survive`);

  const ids = new Set<string>();
  const seen = new Set<string>();
  for (const m of messages) {
    const any = m as any;
    if (m.role === "assistant" && any.tool_calls) {
      for (const c of any.tool_calls) ids.add(c.id);
    }
    if (m.role === "tool") {
      assert.ok(
        ids.has(any.tool_call_id),
        `${where}: orphaned tool message ${any.tool_call_id} has no assistant call`
      );
      seen.add(any.tool_call_id);
    }
  }
  // Every kept assistant call must have its result too.
  for (const id of ids) {
    assert.ok(seen.has(id), `${where}: assistant call ${id} lost its tool result`);
  }
}

async function main() {
  // 1. Below the threshold nothing happens at all.
  {
    const h = history(3);
    const out = await compactHistory(h, async () => "SUM", 1_000_000);
    assert.deepEqual(out, h, "below threshold: history must be untouched");
    log("threshold: below-threshold history is untouched");
  }

  // 2. Above the threshold it summarises, and the result is well formed.
  {
    const h = history(120, 400);
    let summarised = 0;
    const out = await compactHistory(
      h,
      async (older) => {
        summarised = older.length;
        return "the user asked for forty things";
      },
      50_000
    );
    assert.ok(out.length < h.length, "above threshold: history must shrink");
    assert.ok(summarised > 0, "summariser must receive the older messages");
    assert.equal(out[0].role, "system");
    assert.equal(out[1].role, "user");
    assert.match(String(out[1].content), /Summary of earlier work/);
    assert.match(String(out[1].content), /forty things/);
    assertWellFormed(out, "after compaction");
    log(`compaction: 120 turns (${h.length} msgs) -> ${out.length} msgs, well formed`);
  }

  // 3. The split always lands on a user message, never mid-turn.
  {
    const h = history(20);
    for (let cut = 1; cut < h.length; cut++) {
      const { older, keep } = splitForCompaction(h, cut);
      if (older.length === 0) continue;
      assert.equal(keep[0].role, "user", `cut ${cut}: kept tail must start at a user turn`);
      assert.equal(older[older.length - 1].role, "tool",
        `cut ${cut}: summarised span should end on a completed turn`);
    }
    log("split: every cut point lands on a turn boundary");
  }

  // 4. A failed summary falls back to trimHistory instead of throwing.
  {
    const h = history(120, 400);
    const out = await compactHistory(
      h,
      async () => {
        throw new Error("provider down");
      },
      50_000
    );
    const expected = trimHistory(h, 50_000);
    assert.deepEqual(out, expected, "failed summary must fall back to trimHistory");
    assertWellFormed(out, "fallback");
    log("fallback: summariser failure degrades to trimHistory, no throw");
  }

  // 5. An empty summary also falls back rather than splicing a blank message.
  {
    const h = history(120, 400);
    const out = await compactHistory(h, async () => "   ", 50_000);
    assert.deepEqual(out, trimHistory(h, 50_000), "empty summary must fall back");
    log("fallback: blank summary degrades to trimHistory");
  }

  // 6. A tiny history is returned untouched (no system-prompt-only compaction).
  {
    const h: ChatCompletionMessageParam[] = [sys, { role: "user", content: "hi" }];
    const out = await compactHistory(h, async () => "SUM", 10);
    assert.deepEqual(out, h, "tiny history must be untouched");
    log("guard: two-message history is never compacted");
  }

  // 7. The default threshold is a fraction, and 75% by default.
  assert.ok(DEFAULT_COMPACT_AT > 0 && DEFAULT_COMPACT_AT < 1);
  assert.equal(DEFAULT_COMPACT_AT, 0.75);
  log("config: default compaction threshold is 75% of the ceiling");

  log("compaction: all invariants hold");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
