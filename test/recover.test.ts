/**
 * A session whose process died mid-turn can be recovered without a restart.
 *
 * #62: a `thinking` row could not be opened or deleted, and refused to
 * reconcile away, so the only way out was to restart coda. The status lived
 * only in memory, so nothing on disk could contradict it.
 *
 * #72 added `turnOpen` to the record, written while a turn runs and cleared
 * when it finishes. A session that loads with it set has no owner left, so it
 * is adopted as idle and marked `recovered` -- and, unlike a genuinely running
 * turn, it must be usable: openable and deletable.
 *
 * The distinction under test is that a turn running *here* is still protected,
 * while a turn whose process is gone is not. Getting this backwards would
 * either strand the user again, or let them delete work in progress.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "coda-recover-"));
process.env.CODA_SESSIONS_DIR = dir;
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { App } = await import("../src/app.js");
const { Session } = await import("../src/session.js");
const { LineBuffer } = await import("../src/linebuffer.js");

const config = {
  apiKey: "sk-test",
  baseURL: "https://text.example/v1",
  model: "deepseek-flash",
  visionModel: "gemini-3.6-flash",
  visionBaseURL: "https://vision.example/v1",
  visionApiKey: "sk-vision",
  mouse: false,
  parallelTools: true,
  compact: false,
} as any;

/** An App with `titles` as its sessions, newest first, and the picker open. */
async function appWith(titles: string[]): Promise<any> {
  const app: any = new App(config);
  const base = Date.now();
  titles.forEach((title, i) => {
    const s = new Session(config);
    s.title = title;
    s.updatedAt = base - i * 1000;
    app.sessions.push(s);
  });
  const active = app.sessions[0];
  app.setActive(active);
  await active.acquire();
  app.requestRender = () => {};
  app.picker = { index: 1, query: new LineBuffer(), help: null, helpTop: 0, notice: null };
  return app;
}

const ctrlX = (app: any) => app.onKey({ type: "ctrl", ch: "x" });

async function main() {
  // --- a recovered row is deletable ------------------------------------
  //
  // The exact case that was stuck before: the owning process is gone, so
  // nothing will ever finish the turn and nothing will ever write the file.
  {
    const app = await appWith(["alpha", "bravo", "charlie"]);
    const bravo = app.pickerSessions()[1];
    bravo.recovered = true; // as a load with turnOpen: true would set it

    assert.equal(bravo.status, "idle", "a recovered session is idle, not thinking");

    ctrlX(app);

    assert.deepEqual(
      app.pickerSessions().map((s: any) => s.title),
      ["alpha", "charlie"],
      "a recovered row is deleted rather than refused"
    );
  }

  // --- a recovered row takes input instead of steering ------------------
  //
  // The bug #62 described: typing into a row that claims to be mid-turn had
  // its text silently handed to `steer`, which queues it for a turn that will
  // never send another request -- so the words vanished. A recovered session
  // is idle, so it must start a real turn instead.
  {
    const app = await appWith(["alpha"]);
    const session = app.current();
    session.recovered = true;

    let steered: string | null = null;
    session.steer = (t: string) => {
      steered = t;
    };
    // Stop the turn at the point it would reach a provider.
    session.run = async () => ({});
    app.requestRender = () => {};

    app.input.set("hello");
    app.submit();

    assert.equal(
      steered,
      null,
      `a recovered session must not steer; text went to ${JSON.stringify(steered)}`
    );
  }

  // --- a turn running HERE is still protected --------------------------
  //
  // The other half of the rule. A live turn must not become deletable just
  // because the recovered case was fixed.
  {
    const app = await appWith(["alpha", "bravo", "charlie"]);
    const bravo = app.pickerSessions()[1];
    bravo.status = "thinking";

    ctrlX(app);

    assert.deepEqual(
      app.pickerSessions().map((s: any) => s.title),
      ["alpha", "bravo", "charlie"],
      "a turn running in this process is still not deletable"
    );
    assert.ok(/mid-turn/.test(app.picker.notice ?? ""), "and still says why");
  }

  // --- the picker labels the three states differently ------------------
  {
    const app = await appWith(["alpha", "bravo", "charlie"]);
    const [a, b, c] = app.pickerSessions();
    a.status = "thinking";
    b.recovered = true;
    // c is plain idle

    // Built through `render`'s own expression, so this tests the real thing.
    const items = pickerItems(app);
    assert.match(items[0].detail, /thinking/, "a live turn reads as thinking");
    assert.match(items[1].detail, /recovered/, "a dead turn reads as recovered");
    assert.match(items[2].detail, /idle/, "an ordinary session reads as idle");
    assert.ok(
      !/thinking/.test(items[1].detail),
      "a recovered session must not also claim to be thinking"
    );
  }

  // --- a record written mid-turn round-trips through load ---------------
  {
    const id = "died-mid-turn";
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
    // `App.start()` needs a TTY (it puts stdin in raw mode), so the load path
    // that matters here -- record -> Session -- is exercised directly.
    const { loadAllWithMtime } = await import("../src/store.js");
    const loaded = (await loadAllWithMtime()).find((l) => l.record.id === id);
    assert.ok(loaded, "the session is loaded");
    const found = new Session(config, loaded!.record, loaded!.mtimeMs);
    assert.equal(found.recovered, true, "and recognised as cut short");
    assert.equal(found.status, "idle", "and adopted as idle");
  }

  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * The picker rows `render` actually builds.
 *
 * Captured by stubbing `screen.render` -- the state `render` passes to it is
 * what the picker draws -- rather than rebuilding the detail string here. A
 * local copy of the label logic would assert against itself and pass whatever
 * `app.ts` did.
 */
function pickerItems(app: any): any[] {
  let captured: any[] = [];
  app.screen.render = (state: any) => {
    captured = state.picker?.items ?? [];
  };
  app.render();
  return captured;
}

await main();
console.log("recover: a session whose turn died can be opened and deleted");
