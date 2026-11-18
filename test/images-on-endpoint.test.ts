/**
 * Images on a pinned endpoint.
 *
 * An image anywhere in the history forces the vision route, which is a
 * *different service* from the text endpoint -- it comes from
 * `CODA_VISION_BASE_URL` / `CODA_VISION_API_KEY`. When a session is pinned to
 * an alternative endpoint, taking that route would send the conversation and
 * its images to whichever service those variables name, with that service's
 * key, while the picker showed a different provider. Wrong bill, wrong privacy
 * boundary, and nothing on screen said so.
 *
 * Until vision is configurable per endpoint, the request is refused. What has
 * to hold, and is pinned here:
 *
 *  - a pinned session with an image in its history refuses, and the message
 *    names both the endpoint it is on and the one images need;
 *  - the refusal happens *before* any request, so nothing is sent;
 *  - a pinned session without images is unaffected;
 *  - the default endpoint still routes images to the vision model as before.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "coda-image-endpoint-"));
process.env.CODA_SECRETS_DIR = path.join(dir, "secrets");
process.env.CODA_SESSIONS_DIR = path.join(dir, "sessions");
process.env.CODA_ENDPOINTS_FILE = path.join(dir, "endpoints.json");
process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

writeFileSync(
  process.env.CODA_ENDPOINTS_FILE!,
  JSON.stringify({
    endpoints: [
      { name: "grok", baseURL: "https://api.x.ai/v1", model: "grok-4", apiKey: "grok" },
    ],
  })
);

const { Agent } = await import("../src/agent.js");
const { loadEndpoints } = await import("../src/config.js");
const { setSecret } = await import("../src/secrets.js");

setSecret("grok", "sk-grok-key");

const config = {
  apiKey: "sk-default",
  baseURL: "https://api.deepseek.com",
  model: "deepseek-chat",
  visionModel: "models/gemini-3.6-flash",
  visionBaseURL: "https://gemini.example/v1",
  visionApiKey: "sk-vision",
  endpoints: loadEndpoints(),
  mouse: false,
  parallelTools: true,
  compact: false,
} as any;

/** A message carrying an image, the way the history would hold one. */
const imageMessage = () => ({
  role: "user" as const,
  content: [
    { type: "text" as const, text: "what is this?" },
    {
      type: "image_url" as const,
      image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
    },
  ],
});

let fetched = 0;
const realFetch = globalThis.fetch;

// --- a pinned session with an image refuses, before sending ---------------

{
  fetched = 0;
  (globalThis as any).fetch = async () => {
    fetched++;
    return new Response("{}", { status: 200 });
  };

  const a: any = new Agent(config, [imageMessage()]);
  a.setEndpoint("grok");
  assert.equal(a.currentRoute().usingVision, true, "the history holds an image");

  assert.throws(
    () => a.route(),
    (e: any) => {
      assert.ok(/grok/.test(e.message), `the pinned endpoint is named: ${e.message}`);
      assert.ok(/default endpoint/.test(e.message), "the endpoint images need is named");
      assert.ok(/gemini-3\.6-flash/.test(e.message),
        "the vision model is named without its models/ prefix");
      assert.ok(/\/model/.test(e.message), "and says how to get out of it");
      return true;
    }
  );
  assert.equal(fetched, 0, "nothing is sent -- the refusal is before the request");
  globalThis.fetch = realFetch;
}

// --- the message never leaks a key ---------------------------------------

{
  const a: any = new Agent(config, [imageMessage()]);
  a.setEndpoint("grok");
  try {
    a.route();
    assert.fail("should have refused");
  } catch (e: any) {
    assert.ok(!/sk-vision|sk-default|sk-grok/.test(e.message), "no credential appears in the refusal");
  }
}

// --- a pinned session without images is unaffected -----------------------

{
  const a: any = new Agent(config, [{ role: "user", content: "just text" }]);
  a.setEndpoint("grok");
  assert.equal(a.currentRoute().usingVision, false);
  const r = a.route();
  assert.equal(r.model, "grok-4", "a text-only turn still uses the pinned endpoint");
}

// --- the default endpoint still routes images to the vision model --------

{
  const a: any = new Agent(config, [imageMessage()]);
  assert.equal(a.currentRoute().endpoint, null, "no endpoint pinned");
  const r = a.route();
  // The configured id is used verbatim on the wire; only the *message* strips
  // the provider's `models/` prefix.
  assert.equal(r.model, "models/gemini-3.6-flash", "images use the vision model on the default endpoint");
}

// --- unpinning an endpoint restores image support -----------------------

{
  const a: any = new Agent(config, [imageMessage()]);
  a.setEndpoint("grok");
  assert.throws(() => a.route(), "refused while pinned");
  a.setEndpoint(null);
  const r = a.route();
  assert.equal(r.model, "models/gemini-3.6-flash", "switching back to the default endpoint restores images");
}

console.log("images-on-endpoint.test.ts: ok");
