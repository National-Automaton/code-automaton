/**
 * Pasting into the secret prompt.
 *
 * The prompt previously refused paste outright, on the grounds that a pasted
 * credential would sit in the terminal's paste stream and the clipboard. That
 * did not protect anything: the value lands in the same buffer as a typed one,
 * and the clipboard already held it. What it did do was force an 84-character
 * key to be typed blind, which pushes people towards storing it somewhere
 * worse than the vault.
 *
 * What must still hold, and is what this file pins:
 *
 *  - a pasted value is stored exactly, with no echo into the transcript;
 *  - a trailing newline (the shape `cat key` produces) is trimmed, not stored;
 *  - a genuinely multi-line paste is refused rather than flattened, because
 *    the other buffers turn newlines into spaces and for a credential that
 *    would silently store the wrong value.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "coda-secretpaste-"));
// Both must be redirected before the modules that read them are imported.
process.env.CODA_SECRETS_DIR = path.join(dir, "secrets");
process.env.CODA_SESSIONS_DIR = path.join(dir, "sessions");
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { App } = await import("../src/app.js");
const { Session } = await import("../src/session.js");
const { getSecret, resetTracked } = await import("../src/secrets.js");

const config = {
  apiKey: "sk-test",
  baseURL: "https://text.example/v1",
  model: "deepseek-flash",
  visionModel: "gemini-3.6-flash",
  visionBaseURL: "https://vision.example/v1",
  visionApiKey: "sk-vision",
  endpoints: [],
  mouse: false,
  parallelTools: true,
  compact: false,
} as any;

/** An App whose secret prompt is open for `name`. */
function appWithPrompt(name: string): any {
  const app: any = new App(config);
  const session = new Session(config);
  app.sessions.push(session);
  app.setActive(session);
  app.promptSecret(name);
  assert.ok(app.secretPrompt, "the prompt should be open");
  return app;
}

/** Type or paste into the prompt, then press Enter. */
function enter(app: any): void {
  app.onSecretKey({ type: "enter" });
}

/** The transcript text, for checking nothing leaked into it. */
function transcript(app: any): string {
  return app.current()
    .entries.map((e: any) => e.text ?? "")
    .join("\n");
}

// --- a pasted key is stored exactly ---------------------------------------

{
  const KEY = "gsk-0123456789abcdef0123456789abcdef01234567";
  const app = appWithPrompt("grok");
  app.onSecretKey({ type: "paste", text: KEY });
  // Masked on screen: the buffer holds it, but nothing renders it.
  assert.equal(app.secretPrompt.buffer.value, KEY, "the pasted value is in the buffer");
  enter(app);

  assert.equal(getSecret("grok"), KEY, "the pasted key is stored exactly");
  assert.ok(!transcript(app).includes(KEY), "the value never reaches the transcript");
  assert.ok(/secret grok: saved/.test(transcript(app)), "only the fact of the save is noted");
}

// --- a trailing newline is trimmed ---------------------------------------

{
  // What `cat key | pbcopy` or a paste from a file usually yields.
  const app = appWithPrompt("trailing");
  app.onSecretKey({ type: "paste", text: "sk-trailing-newline\n" });
  enter(app);
  assert.equal(getSecret("trailing"), "sk-trailing-newline", "a single trailing newline is not stored");
}

{
  const app = appWithPrompt("trailing-crlf");
  app.onSecretKey({ type: "paste", text: "sk-crlf\r\n" });
  enter(app);
  assert.equal(getSecret("trailing-crlf"), "sk-crlf", "CRLF at the end is trimmed too");
}

// --- a multi-line paste is refused ---------------------------------------

{
  const app = appWithPrompt("multiline");
  app.onSecretKey({ type: "paste", text: "sk-first\nsk-second" });
  assert.equal(app.secretPrompt.buffer.value, "", "nothing is inserted");
  assert.ok(
    /multiple lines/.test(transcript(app)),
    "the refusal is explained rather than silently dropping the paste"
  );
  enter(app);
  assert.equal(getSecret("multiline"), null, "nothing is stored from a refused paste");
}

// --- paste does not bypass the tracked-value masking ---------------------

{
  resetTracked();
  const KEY = "sk-should-be-masked-9f8e7d6c";
  const app = appWithPrompt("masked");
  app.onSecretKey({ type: "paste", text: KEY });
  enter(app);
  // After storing, the value is tracked, so anything echoing it is scrubbed.
  app.systemNote(`the key is ${KEY}`);
  assert.ok(!transcript(app).includes(KEY), "a later echo of the value is redacted");
}

console.log("secret-paste.test.ts: ok");
