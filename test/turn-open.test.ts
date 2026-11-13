/**
 * A turn cut short must leave a record of itself.
 *
 * `status` is live UI state and cannot be persisted: it says "a turn is running
 * in this process", which is meaningless once the process is gone. But a load
 * then cannot tell a session whose process died mid-turn from one that finished
 * normally -- both are just a saved transcript (#62).
 *
 * So `turnOpen` records the narrower fact: a turn *was* running when the
 * session was last written. Set when `run` starts, cleared in its `finally`. A
 * clean finish always writes it closed; only a process that dies mid-turn
 * leaves it open, which is exactly the case that used to be unknowable.
 *
 * These tests drive a real `Session` against a stubbed `fetch`, so the written
 * flag is the one a killed process would really have left.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { promises as fs } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const dir = mkdtempSync(path.join(tmpdir(), "coda-turnopen-"));
process.env.CODA_SESSIONS_DIR = dir;

const { Session } = await import("../src/session.js");
const { loadAllWithMtime } = await import("../src/store.js");
import type { Config } from "../src/config.js";

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

const textFrame = (t: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
const doneFrame = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`;

function sse(chunks: string[]): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) return c.enqueue(enc.encode(chunks[i++]));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const realFetch = globalThis.fetch;

/** Read the record for `id` straight off disk (no repair, no adoption). */
async function rawRecord(id: string): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), "utf8"));
}

async function main() {
  try {
    // --- a die mid-turn leaves turnOpen true on disk ---------------------
    //
    // The stream throws after the turn has started and after the flag has been
    // written, which is the shape of a process being killed while a tool runs.
    {
      const id = "killed-mid-turn";
      // A stream that hangs after the request is accepted: the turn is open and
      // stays open, which is what a process being killed mid-turn looks like
      // from the outside. `release` lets the test finish it afterwards.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      (globalThis as any).fetch = async () => {
        const body = new ReadableStream<Uint8Array>({
          async pull(c) {
            await held;
            c.error(new TypeError("terminated"));
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      };

      const session = new Session(cfg, {
        id,
        title: "killed",
        cwd: "/tmp",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        entries: [],
      });
      session.entries.push({ role: "user", text: "do some work" });

      // Simulate the kill: start the turn, and abandon it part-way. The write
      // that matters happened before the request, so this throws and the
      // `finally` runs -- so instead check the file as it stands mid-turn.
      let midTurn: any = null;
      const running = session.run("do some work", () => {});
      // Give the flag write a tick to land, then read the file while the turn
      // is (nominally) still open.
      await new Promise((r) => setTimeout(r, 30));
      midTurn = await rawRecord(id).catch(() => null);
      release();
      await running.catch(() => {});
      assert.ok(midTurn, "the session should have been written");
      assert.equal(
        midTurn.turnOpen,
        true,
        "a turn in flight must be recorded on disk, so a later load knows it was cut short"
      );
    }

    // --- a clean finish writes turnOpen closed ---------------------------
    {
      const id = "finished-cleanly";
      (globalThis as any).fetch = async () => sse([textFrame("done"), doneFrame]);
      const session = new Session(cfg, {
        id,
        title: "clean",
        cwd: "/tmp",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        entries: [],
      });
      await session.run("hi", () => {});
      const rec = await rawRecord(id);
      assert.ok(
        !rec.turnOpen,
        `a finished turn must not leave the flag set: ${JSON.stringify(rec.turnOpen)}`
      );
    }

    // --- loading an open turn marks it recovered, and idle --------------
    {
      const id = "loads-recovered";
      const now = Date.now();
      await fs.writeFile(
        path.join(dir, `${id}.json`),
        JSON.stringify({
          id,
          title: "cut short",
          cwd: "/tmp",
          createdAt: now,
          updatedAt: now,
          messages: [{ role: "user", content: "work" }],
          entries: [{ role: "user", text: "work" }],
          turnOpen: true,
        })
      );

      const [loaded] = await loadAllWithMtime();
      const session = new Session(cfg, loaded.record, loaded.mtimeMs);
      assert.equal(session.recovered, true, "the session knows its turn was cut short");
      assert.equal(
        session.status,
        "idle",
        "a recovered session is idle: nothing remains that could finish the turn"
      );
    }

    // --- an ordinary session is not marked recovered --------------------
    {
      const id = "loads-normal";
      const now = Date.now();
      await fs.writeFile(
        path.join(dir, `${id}.json`),
        JSON.stringify({
          id,
          title: "normal",
          cwd: "/tmp",
          createdAt: now,
          updatedAt: now,
          messages: [],
          entries: [],
        })
      );
      const found = (await loadAllWithMtime()).find((l) => l.record.id === id)!;
      const session = new Session(cfg, found.record, found.mtimeMs);
      assert.equal(session.recovered, false, "an absent flag means idle, not suspect");
    }

    // --- a recovered session can be used and saved normally -------------
    {
      const id = "loads-recovered";
      const found = (await loadAllWithMtime()).find((l) => l.record.id === id)!;
      const session = new Session(cfg, found.record, found.mtimeMs);
      session.entries.push({ role: "user", text: "carry on" });
      await session.persist();
      const rec = await rawRecord(id);
      assert.ok(!rec.turnOpen, "saving a recovered session clears the stale flag");
    }
  } finally {
    (globalThis as any).fetch = realFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

await main();
console.log("turn-open: a turn cut short is recorded and recognised on load");
