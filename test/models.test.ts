/**
 * The `/model` catalogue: which models are offered, which one carries images, and
 * what happens when the endpoint cannot be asked.
 *
 * The list is fetched from an OpenAI-compatible `GET /models`, so these tests
 * stand a fake endpoint up with `fetch` stubbed rather than reaching the
 * network. Two properties matter enough to pin:
 *
 *  - a non-chat model (audio, embedding, image-generation) is never offered,
 *    because selecting one would break the session on its next message;
 *  - the configured models are always present and the configured vision model
 *    is always image-capable, because offline or behind a proxy that filters
 *    `/models`, `/model` must still show what the session is running.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import type { Config } from "../src/config.js";
import { bareId, isChatModel, loadCatalog, supportsImages } from "../src/models.js";

const baseConfig = {
  apiKey: "sk-test",
  baseURL: "https://text.example/v1",
  model: "deepseek-flash",
  visionModel: "gemini-3.6-flash",
  visionBaseURL: "https://vision.example/v1",
  visionApiKey: "sk-vision",
  mouse: false,
  parallelTools: true,
  compact: false,
} as unknown as Config;

const realFetch = globalThis.fetch;

/** Stub `fetch` with a per-URL responder; `null` means "unreachable". */
function stubFetch(responses: Record<string, string[] | null>): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    asked.push(url);
    const ids = responses[url];
    if (ids === undefined || ids === null) throw new Error("unreachable");
    return {
      ok: true,
      json: async () => ({ data: ids.map((id) => ({ id })) }),
    } as any;
  }) as typeof fetch;
  return asked;
}

// --- name classification ---------------------------------------------------

assert.equal(isChatModel("deepseek-flash"), true, "an ordinary model is a chat model");
assert.equal(isChatModel("gpt-4o"), true);
assert.equal(isChatModel("models/gemini-2.5-flash"), true);
assert.equal(isChatModel("text-embedding-3-large"), false, "embeddings are not chat models");
assert.equal(isChatModel("whisper-1"), false, "transcription is not a chat model");
assert.equal(isChatModel("models/lyria-realtime-exp"), false, "audio generation is not a chat model");
assert.equal(isChatModel("models/gemini-2.5-flash-native-audio-latest"), false, "audio is not chat");
assert.equal(isChatModel("tts-1"), false);
assert.equal(isChatModel("dall-e-3"), false);
assert.equal(isChatModel("some-unknown-provider-model"), true,
  "an unrecognised model is offered rather than hidden");

// Names taken from the real Gemini list this was built against. Each of these
// answered `GET /models` but cannot serve a chat completion, so offering one
// would hand the user a model that breaks the session on its next message.
for (const id of [
  "gemini-3.1-flash-image",
  "gemini-3-pro-image-preview",
  "gemini-nano-banana-2.1",
  "gemini-3.8-live",
  "gemini-3.8-live-extended-thinking",
  "gemini-3.5-live-translate-preview",
  "deep-research-pro-preview-12-2025",
  "deep-research-max-preview-04-2026",
  "antigravity-preview-latest",
  "aqa",
]) {
  assert.equal(isChatModel(id), false, `${id} is not a chat model and must not be offered`);
}
// ...while ordinary chat models from the same list survive the filter.
for (const id of [
  "gemini-3.6-flash",
  "gemini-flash-latest",
  "gemini-3.1-pro-preview",
  "gemma-4-31b-it",
  "deepseek-chat",
]) {
  assert.equal(isChatModel(id), true, `${id} must be offered`);
}

assert.equal(supportsImages("gemini-2.5-flash"), true);
assert.equal(supportsImages("gpt-4o"), true);
assert.equal(supportsImages("llava-13b"), true);
assert.equal(supportsImages("deepseek-flash"), false, "a text model does not take images");

assert.equal(bareId("models/gemini-2.5-flash"), "gemini-2.5-flash");
assert.equal(bareId("deepseek-flash"), "deepseek-flash", "a bare id is unchanged");

// --- the fetched list ------------------------------------------------------

{
  const asked = stubFetch({
    "https://text.example/v1/models": ["deepseek-flash", "deepseek-v4-pro", "deepseek-embedding"],
    "https://vision.example/v1/models": ["models/gemini-2.5-flash", "models/lyria-realtime-exp"],
  });
  const cat = await loadCatalog(baseConfig);
  globalThis.fetch = realFetch;

  assert.equal(cat.fetched, true, "a reachable endpoint means a fetched list");
  const ids = cat.chat.map((c) => c.id);
  assert.ok(ids.includes("deepseek-flash"), "the text endpoint's models are offered");
  assert.ok(ids.includes("deepseek-v4-pro"));
  assert.ok(ids.includes("gemini-2.5-flash"), "the vision endpoint's models are offered");
  assert.ok(!ids.includes("deepseek-embedding"), "embeddings are filtered out");
  assert.ok(!ids.includes("lyria-realtime-exp"), "audio models are filtered out");
  assert.ok(!ids.some((id) => id.startsWith("models/")), "ids are normalised to bare form");

  // The configured vision model accepts images (it is configured for that),
  // and a Gemini model is recognised by name.
  const visionIds = cat.chat.filter((c) => c.vision).map((c) => c.id);
  assert.ok(visionIds.includes("gemini-3.6-flash"), "the configured vision model takes images");
  assert.ok(visionIds.includes("gemini-2.5-flash"));
  assert.ok(!visionIds.includes("deepseek-flash"), "the text model is not offered for images");

  assert.ok(asked.includes("https://text.example/v1/models"), "the text endpoint is queried");
  assert.ok(asked.includes("https://vision.example/v1/models"), "the vision endpoint is queried");
}

// --- unreachable endpoint falls back to config -----------------------------

{
  stubFetch({
    "https://text.example/v1/models": null,
    "https://vision.example/v1/models": null,
  });
  const cat = await loadCatalog(baseConfig);
  globalThis.fetch = realFetch;

  assert.equal(cat.fetched, false, "nothing could be fetched");
  assert.ok(cat.error, "the reason is reported");
  const ids = cat.chat.map((c) => c.id);
  assert.deepEqual(
    ids.sort(),
    ["deepseek-flash", "gemini-3.6-flash"],
    "config models are offered when the endpoint is unreachable"
  );
  const vision = cat.chat.filter((c) => c.vision).map((c) => c.id);
  assert.ok(vision.includes("gemini-3.6-flash"), "vision is still known from config");
}

// --- a single endpoint is queried once -------------------------------------

{
  const same = {
    ...baseConfig,
    visionBaseURL: baseConfig.baseURL,
    visionApiKey: baseConfig.apiKey,
  } as unknown as Config;
  const asked = stubFetch({ "https://text.example/v1/models": ["deepseek-flash"] });
  const cat = await loadCatalog(same);
  globalThis.fetch = realFetch;

  assert.equal(asked.length, 1, "one endpoint is asked once, not twice");
  assert.equal(cat.fetched, true);
}

// --- the configured model survives a list that omits it --------------------

{
  // An endpoint that does not list the configured alias (a proxy, or a local
  // name): dropping it would hide the model the session is actually using.
  stubFetch({ "https://text.example/v1/models": ["something-else"] });
  const cat = await loadCatalog(baseConfig);
  globalThis.fetch = realFetch;

  const ids = cat.chat.map((c) => c.id);
  assert.ok(ids.includes("deepseek-flash"), "the configured model is always listed");
  assert.ok(ids.includes("something-else"), "the fetched models are listed too");
}

console.log("models.test.ts: ok");
