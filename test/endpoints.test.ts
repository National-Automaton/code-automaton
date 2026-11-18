/**
 * Multiple text endpoints: loading `endpoints.json`, choosing one per session,
 * and keeping the choice through a save and reload.
 *
 * Three properties are worth pinning, because getting any of them wrong is
 * silent rather than loud:
 *
 *  - a key is read from the vault by *name*, so no credential reaches the
 *    endpoint file, a session dump, or an error message;
 *  - a model is offered only for the endpoint that serves it, so the picker
 *    cannot hand back the "model not supported by this API" 400 again;
 *  - a session remembers its endpoint, and one that names an endpoint which no
 *    longer exists falls back to the default *and says so*, rather than quietly
 *    continuing against a different service.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Config } from "../src/config.js";

// The vault and the endpoint file both live outside the repo and both honour an
// override, so this test never reads or writes the real ones.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "coda-endpoints-"));
process.env.CODA_SECRETS_DIR = path.join(tmp, "secrets");
process.env.CODA_ENDPOINTS_FILE = path.join(tmp, "endpoints.json");
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { loadEndpoints } = await import("../src/config.js");
const { loadCatalog } = await import("../src/models.js");
const { setSecret } = await import("../src/secrets.js");
const { Agent } = await import("../src/agent.js");

const writeEndpoints = (body: unknown) =>
  fs.writeFileSync(process.env.CODA_ENDPOINTS_FILE!, JSON.stringify(body));

const baseConfig = (): Config =>
  ({
    apiKey: "sk-default",
    baseURL: "https://text.example/v1",
    model: "deepseek-flash",
    visionModel: "gemini-3.6-flash",
    visionBaseURL: "https://vision.example/v1",
    visionApiKey: "sk-vision",
    endpoints: loadEndpoints(),
    mouse: false,
    parallelTools: true,
    compact: false,
  }) as unknown as Config;

const realFetch = globalThis.fetch;

/** Stub `fetch` per URL; records which endpoints were asked. */
function stubFetch(responses: Record<string, string[] | null>): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    asked.push(url);
    const ids = responses[url];
    if (ids === undefined || ids === null) throw new Error("unreachable");
    return { ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) } as any;
  }) as typeof fetch;
  return asked;
}

// --- loading the file ------------------------------------------------------

{
  writeEndpoints({
    endpoints: [
      { name: "openrouter", baseURL: "https://openrouter.ai/api/v1", model: "x/y", apiKey: "openrouter" },
      // Missing model: skipped, but must not remove the row above.
      { name: "broken", baseURL: "https://broken.example/v1" },
      // Duplicate name: ambiguous, so the first one wins.
      { name: "openrouter", baseURL: "https://dup.example/v1", model: "dup" },
    ],
  });
  const eps = loadEndpoints();
  assert.equal(eps.length, 1, "an incomplete or duplicate row is skipped, not the file");
  assert.equal(eps[0].name, "openrouter");
  assert.equal(eps[0].apiKey, "openrouter", "apiKey is recorded as a vault name");
}

{
  fs.writeFileSync(process.env.CODA_ENDPOINTS_FILE!, "{not json");
  assert.deepEqual(loadEndpoints(), [], "a malformed file yields no endpoints rather than throwing");
}

{
  fs.rmSync(process.env.CODA_ENDPOINTS_FILE!, { force: true });
  assert.deepEqual(loadEndpoints(), [], "an absent file is not an error");
}

// --- models belong to the endpoint that serves them ------------------------

{
  writeEndpoints({
    endpoints: [
      { name: "openrouter", baseURL: "https://router.example/v1", model: "z/model", apiKey: "openrouter" },
    ],
  });
  setSecret("openrouter", "sk-router-key");
  const cfg = baseConfig();

  stubFetch({
    "https://text.example/v1/models": ["deepseek-flash", "deepseek-v4-pro"],
    "https://router.example/v1/models": ["gemini-4-carbon", "z/model", "text-embedding-3-large"],
  });
  const cat = await loadCatalog(cfg);
  globalThis.fetch = realFetch;

  const pairs = cat.chat.map((c) => `${c.endpoint ?? "default"}:${c.id}`);
  assert.ok(pairs.includes("openrouter:gemini-4-carbon"), "the second endpoint's models are listed");
  assert.ok(pairs.includes("default:deepseek-v4-pro"), "the default endpoint's models are listed");
  assert.ok(!pairs.some((k) => k.endsWith("text-embedding-3-large")), "embeddings are still filtered");

  // The same id on two endpoints must stay two rows: they are two services.
  const byPair = new Map(cat.chat.map((c) => [`${c.endpoint ?? "default"}:${c.id}`, c]));
  assert.equal(byPair.get("openrouter:gemini-4-carbon")?.text, true);
  assert.equal(byPair.get("openrouter:gemini-4-carbon")?.endpoint, "openrouter");
  assert.equal(byPair.get("default:deepseek-flash")?.endpoint, null,
    "endpoint zero is reported as null, not a name");
}

// --- the key is read from the vault, never from the endpoint file ---------

{
  fs.rmSync(process.env.CODA_ENDPOINTS_FILE!, { force: true });
  writeEndpoints({
    endpoints: [{ name: "nokey", baseURL: "https://nokey.example/v1", model: "m", apiKey: "missing-entry" }],
  });
  const agent: any = new Agent(baseConfig());
  agent.setEndpoint("nokey");
  assert.throws(
    () => agent.endpointClient({ name: "nokey", baseURL: "https://nokey.example/v1", model: "m", apiKey: "missing-entry" }),
    /missing-entry/,
    "a missing vault entry is named, so the user knows what to store"
  );
  // The message names the entry, never a value.
  try {
    agent.endpointClient({ name: "nokey", baseURL: "https://nokey.example/v1", model: "m", apiKey: "missing-entry" });
  } catch (e: any) {
    assert.ok(!/sk-/.test(e.message), "no key material appears in the error");
  }
}

// --- a session remembers its endpoint -------------------------------------

{
  writeEndpoints({
    endpoints: [{ name: "openrouter", baseURL: "https://router.example/v1", model: "z/model", apiKey: "openrouter" }],
  });
  const cfg = baseConfig();

  const a: any = new Agent(cfg);
  a.setEndpoint("openrouter");
  assert.equal(a.currentRoute().endpoint, "openrouter");
  assert.equal(a.currentRoute().textModel, "z/model", "the endpoint's own model is used");

  // Endpoint zero is reached by clearing the choice.
  a.setEndpoint(null);
  assert.equal(a.currentRoute().endpoint, null);
  assert.equal(a.currentRoute().textModel, "deepseek-flash");
}

// --- a removed endpoint falls back, flagging that it did ------------------

{
  writeEndpoints({ endpoints: [] });
  const cfg = baseConfig();
  const a: any = new Agent(cfg);
  a.setEndpoint("gone"); // as restored from a session file
  const route = a.currentRoute();
  assert.equal(route.endpointMissing, true, "the app is told the endpoint is gone");
  assert.equal(route.textModel, "deepseek-flash", "it falls back to the default endpoint");
  // It still routes rather than throwing: the transcript stays readable.
  assert.ok(a.textRoute().client, "a request can still be made");
}

console.log("endpoints.test.ts: ok");
