/**
 * `/endpoint`: managing the alternative text endpoints without hand-editing.
 *
 * The file is JSON, which has no comments and no tolerance for a stray comma,
 * so the point of these commands is that the user never types JSON. What is
 * pinned here:
 *
 *  - `add` writes a file that `loadEndpoints` reads back identically, including
 *    through the round trip that a restart performs;
 *  - `add` updates the running config, so `/model` sees the endpoint without a
 *    restart;
 *  - the key is only ever referenced by *name*, and a name with nothing in the
 *    vault is flagged rather than silently accepted as configured;
 *  - bad input (duplicate name, non-http URL, missing arguments) is refused
 *    with a usage line instead of writing something broken.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "coda-endpointcmd-"));
process.env.CODA_SECRETS_DIR = path.join(dir, "secrets");
process.env.CODA_SESSIONS_DIR = path.join(dir, "sessions");
process.env.CODA_ENDPOINTS_FILE = path.join(dir, "endpoints.json");
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { App } = await import("../src/app.js");
const { Session } = await import("../src/session.js");
const { loadEndpoints } = await import("../src/config.js");
const { setSecret } = await import("../src/secrets.js");

const config = {
  apiKey: "sk-test",
  baseURL: "https://api.deepseek.com",
  model: "deepseek-chat",
  visionModel: "gemini-3.6-flash",
  visionBaseURL: "https://vision.example/v1",
  visionApiKey: "sk-vision",
  endpoints: [],
  mouse: false,
  parallelTools: true,
  compact: false,
} as any;

/**
 * A running App with an empty endpoint file.
 *
 * The file is removed first: `loadEndpoints` reads whatever is on disk, so each
 * block must start from nothing rather than inherit the previous block's rows.
 */
function app(): any {
  rmSync(process.env.CODA_ENDPOINTS_FILE!, { force: true });
  config.endpoints = [];
  const a: any = new App(config);
  const s = new Session(config);
  a.sessions.push(s);
  a.setActive(s);
  return a;
}

const lastNote = (a: any): string => {
  const e = a.current().entries;
  return e[e.length - 1]?.text ?? "";
};

// --- add writes a file that reads back -------------------------------------

{
  const a = app();
  assert.ok(!existsSync(process.env.CODA_ENDPOINTS_FILE!), "no file to begin with");

  a.handleEndpointCommand("add grok https://api.x.ai/v1 grok-4 --key grok");
  assert.ok(existsSync(process.env.CODA_ENDPOINTS_FILE!), "add creates the file");
  assert.ok(/grok/.test(lastNote(a)), "the addition is reported");

  const onDisk = loadEndpoints();
  assert.deepEqual(onDisk, [
    { name: "grok", baseURL: "https://api.x.ai/v1", model: "grok-4", apiKey: "grok" },
  ], "the file reads back exactly what was added");

  // The running config is updated too, so /model needs no restart.
  assert.equal(config.endpoints.length, 1, "the live config sees the new endpoint");
  assert.equal(config.endpoints[0].name, "grok");
}

// --- a key name with nothing stored is flagged, not silently accepted -----

{
  const a = app();
  a.handleEndpointCommand("add local http://localhost:8080/v1 qwen2.5-coder --key localkey");
  const note = lastNote(a);
  assert.ok(/not in the vault/.test(note), `an unstored key is flagged: ${note}`);
  assert.ok(/secret add localkey/.test(note), "and says how to fix it");
  // It is still written: refusing would make the order of the two commands matter.
  assert.equal(loadEndpoints().length, 1);

  // `list` distinguishes configured from usable.
  setSecret("localkey", "sk-local");
  a.handleEndpointCommand("list");
  assert.ok(/key: localkey$/.test(lastNote(a).split("\n").filter((l) => l.includes("localkey"))[0] ?? ""),
    "a stored key is reported without a warning");
}

// --- list names the key, never a value ------------------------------------

{
  setSecret("grok", "gsk-SENTINEL-VALUE-123456");
  const a = app();
  a.handleEndpointCommand("add grok https://api.x.ai/v1 grok-4 --key grok");
  a.handleEndpointCommand("list");
  const note = lastNote(a);
  assert.ok(/grok/.test(note), "the endpoint is listed");
  assert.ok(!note.includes("gsk-SENTINEL-VALUE-123456"), "the key value is never printed");
}

// --- an endpoint with no key ----------------------------------------------

{
  const a = app();
  a.handleEndpointCommand("add local http://localhost:8080/v1 qwen2.5-coder");
  const [e] = loadEndpoints();
  assert.equal(e?.apiKey, undefined, "a keyless endpoint stores no apiKey field");
  a.handleEndpointCommand("list");
  assert.ok(/no key/.test(lastNote(a)));
}

// --- bad input is refused, and nothing is written ------------------------

{
  const a = app();
  a.handleEndpointCommand("add grok https://api.x.ai/v1 grok-4");
  // Everything below is a refusal, so the file must not move from here on.
  const before = JSON.stringify(loadEndpoints());

  // duplicate name
  a.handleEndpointCommand("add grok https://other.example/v1 grok-5");
  assert.ok(/already exists/.test(lastNote(a)), "a duplicate name is refused");

  // not a URL
  a.handleEndpointCommand("add bad not-a-url some-model");
  assert.ok(/must start with http/.test(lastNote(a)), "a non-http baseURL is refused");

  // wrong arity
  a.handleEndpointCommand("add onlyone");
  assert.ok(/usage:/.test(lastNote(a)), "missing arguments print usage");

  // invalid name (spaces can't reach here, but punctuation can)
  a.handleEndpointCommand("add bad$name https://x.example/v1 m");
  assert.ok(/one word/.test(lastNote(a)), "an invalid name is refused");

  // `--key` with nothing after it
  a.handleEndpointCommand("add nokey https://x.example/v1 m --key");
  assert.ok(/usage:/.test(lastNote(a)), "a dangling --key prints usage");

  assert.equal(JSON.stringify(loadEndpoints()), before, "refusals write nothing");
}

// --- remove ---------------------------------------------------------------

{
  const a = app();
  a.handleEndpointCommand("add grok https://api.x.ai/v1 grok-4");
  a.handleEndpointCommand("add local http://localhost:8080/v1 qwen");
  assert.equal(loadEndpoints().length, 2);

  a.handleEndpointCommand("remove grok");
  assert.deepEqual(loadEndpoints().map((e: any) => e.name), ["local"], "remove drops just that one");
  assert.equal(config.endpoints.length, 1, "the live config follows");

  a.handleEndpointCommand("remove nosuch");
  assert.ok(/no endpoint named/.test(lastNote(a)), "removing an unknown name says so");

  a.handleEndpointCommand("remove");
  assert.ok(/usage:/.test(lastNote(a)), "remove with no name prints usage");
}

// --- removing the endpoint the session is using ---------------------------

{
  const a = app();
  a.handleEndpointCommand("add grok https://api.x.ai/v1 grok-4");
  a.current().setEndpoint("grok");
  a.handleEndpointCommand("remove grok");
  assert.ok(/falls back to the default endpoint/.test(lastNote(a)),
    "the session is told it has fallen back, rather than being silently rerouted");
  assert.equal(a.current().route.endpointMissing, true, "and the route reports it missing");
}

console.log("endpoint-command.test.ts: ok");
