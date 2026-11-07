/**
 * Redaction at the transcript boundary.
 *
 * `applyEvent` is every path by which agent output reaches a session's entry
 * list. That list is saved as plain JSON in `~/.coda/sessions/` on every turn
 * and re-sent to the model as history, so a credential that reached it would be
 * durable and would leave the machine on the next request. Each event type is
 * checked, not just the obvious one: a subprocess echoes a secret in tool
 * output, a model repeats one in its reply, and a mid-turn steer can carry one
 * too.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";

process.env.CODA_SECRETS_DIR = `${process.env.TMPDIR ?? "/tmp"}/coda-redact-test-${process.pid}`;
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { trackSecret, resetTracked } = await import("../src/secrets.js");
const { applyEvent } = await import("../src/session.js");
type Entry = import("../src/store.js").Entry;

const SECRET = "ghp_REDACT-ME-1234567890";
const expectHidden = (entries: Entry[], where: string) => {
  const joined = entries.map((e) => e.text).join("\n");
  assert.ok(!joined.includes(SECRET), `${where}: the secret reached the transcript:\n${joined}`);
  assert.ok(!joined.includes("ghp_REDACT"), `${where}: a fragment of the secret survived:\n${joined}`);
};

// --- text streamed by the model -------------------------------------------

{
  resetTracked();
  trackSecret(SECRET);
  const entries: Entry[] = [];
  let buf = applyEvent(entries, { type: "text", text: "your token is " }, null);
  buf = applyEvent(entries, { type: "text", text: SECRET }, buf);
  assert.equal(entries.length, 1, "consecutive text appends to one bubble");
  expectHidden(entries, "text");
  assert.ok(entries[0].text.includes("[redacted]"), "the marker replaces the value");
  assert.ok(entries[0].text.includes("your token is"), "surrounding text is kept");
  assert.equal(buf, entries[0], "the buffer keeps accumulating into the same entry");
}

// --- a tool's own arguments -----------------------------------------------

{
  resetTracked();
  trackSecret(SECRET);
  const entries: Entry[] = [];
  applyEvent(
    entries,
    { type: "tool_start", name: "bash", args: { command: `curl -H "Auth: ${SECRET}" x` } } as any,
    null
  );
  expectHidden(entries, "tool_start");
  assert.equal(entries[0].name, "bash");
}

// --- tool output: what a subprocess printed -------------------------------

{
  resetTracked();
  trackSecret(SECRET);
  const entries: Entry[] = [];
  applyEvent(entries, { type: "tool_start", name: "bash", args: { command: "env" } } as any, null);
  applyEvent(
    entries,
    { type: "tool_result", name: "bash", ok: true, output: `GITHUB_TOKEN=${SECRET}\nHOME=/home/x` } as any,
    null
  );
  expectHidden(entries, "tool_result");
  assert.equal(entries[0].ok, true);
  assert.ok(entries[0].text.includes("HOME=/home/x"), "ordinary output is untouched");
}

// --- a mid-turn steer ------------------------------------------------------

{
  resetTracked();
  trackSecret(SECRET);
  const entries: Entry[] = [];
  applyEvent(entries, { type: "steer", text: `use ${SECRET} please` } as any, null);
  expectHidden(entries, "steer");
}

// --- a value typed but never stored ---------------------------------------

{
  resetTracked();
  trackSecret(SECRET); // as the prompt does before writing
  const entries: Entry[] = [];
  applyEvent(entries, { type: "text", text: `I saved ${SECRET}` }, null);
  expectHidden(entries, "unstored value");
}

// --- done/error end the bubble --------------------------------------------

{
  resetTracked();
  const entries: Entry[] = [];
  const buf = applyEvent(entries, { type: "text", text: "hi" }, null);
  assert.equal(applyEvent(entries, { type: "done" } as any, buf), null, "done clears the buffer");
  const buf2 = applyEvent(entries, { type: "text", text: "again" }, null);
  assert.equal(applyEvent(entries, { type: "error", message: "x" } as any, buf2), null);
  assert.equal(entries.length, 2, "each run of text is its own bubble");
}

// --- with nothing tracked, text passes through unchanged -------------------

{
  resetTracked();
  const entries: Entry[] = [];
  applyEvent(entries, { type: "text", text: "perfectly ordinary output" }, null);
  assert.equal(
    entries[0].text,
    "perfectly ordinary output",
    "redaction must not alter text when no secret is involved"
  );
}

console.log("redact.test.ts: ok");
