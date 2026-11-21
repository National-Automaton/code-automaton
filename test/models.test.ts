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
import { bareId, declaredVision, isChatModel, loadCatalog, supportsImages } from "../src/models.js";

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
function stubFetch(
  responses: Record<string, Array<string | Record<string, any>> | null>
): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    asked.push(url);
    const entries = responses[url];
    if (entries === undefined || entries === null) throw new Error("unreachable");
    return {
      ok: true,
      // A bare string stands for `{ id }`; an object is passed through, so a
      // test can supply capability metadata the way a real endpoint does.
      json: async () => ({
        data: entries.map((e) => (typeof e === "string" ? { id: e } : e)),
      }),
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

  // A model the vision endpoint serves is *not* offered for text: the text
  // endpoint rejects it (a Gemini id sent to a DeepSeek endpoint fails with
  // "the supported API model names are ..."), which is how /model used to hand
  // the user a session that broke on its next message.
  const byId = new Map(cat.chat.map((c) => [c.id, c]));
  assert.equal(byId.get("gemini-2.5-flash")?.text, false,
    "a vision-only model must not be offered as the text model");
  assert.equal(byId.get("deepseek-flash")?.text, true);
  assert.equal(byId.get("deepseek-v4-pro")?.text, true);
  assert.equal(byId.get("gemini-3.6-flash")?.vision, true,
    "the configured vision model is still offered for images");
  assert.equal(byId.get("deepseek-flash")?.vision, false,
    "the text model is not offered for images");
}

// --- a vision model served on both endpoints is text-capable ---------------

{
  // Shared endpoints are a supported setup, so "served by the vision endpoint"
  // must not on its own mean "cannot answer text".
  const same = {
    ...baseConfig,
    visionBaseURL: baseConfig.baseURL,
    visionApiKey: baseConfig.apiKey,
  } as unknown as Config;
  stubFetch({ "https://text.example/v1/models": ["deepseek-flash", "gemini-4-carbon"] });
  const cat = await loadCatalog(same);
  globalThis.fetch = realFetch;

  const byId = new Map(cat.chat.map((c) => [c.id, c]));
  assert.equal(byId.get("gemini-4-carbon")?.text, true,
    "a model the shared endpoint lists can answer text");
  assert.equal(byId.get("gemini-4-carbon")?.vision, true,
    "and it accepts images too");
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
  const byId = new Map(cat.chat.map((c) => [c.id, c]));
  assert.equal(byId.get("deepseek-flash")?.text, true,
    "the configured text model is offered for text while offline");
  assert.equal(byId.get("gemini-3.6-flash")?.text, false,
    "an unreachable text endpoint does not make the vision model a text choice");
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

// --- a model's image support is taken from the endpoint's own declaration ---
//
// `supportsImages` matched model *names* against a fixed list, so `grok-4`
// matched nothing and no x.ai model could appear in the image column however
// capable it was (issue #88). Providers that report capabilities are now
// believed over the list; those that say nothing still fall back to it.

// The three shapes seen in the wild.
{
  // DeepSeek: input_modalities, and it distinguishes models on one endpoint.
  assert.equal(declaredVision({ id: "a", input_modalities: ["text", "image"] }), true);
  assert.equal(declaredVision({ id: "b", input_modalities: ["text"] }), false);
  // Some gateways nest it.
  assert.equal(declaredVision({ id: "c", architecture: { input_modalities: ["text", "image"] } }), true);
  assert.equal(declaredVision({ id: "d", architecture: { modality: ["text"] } }), false);
  // x.ai: no modalities, but a model is priced for image input only if it takes
  // images. Every chat model there has the price; image-*generation* models
  // have no prices at all.
  assert.equal(declaredVision({ id: "e", prompt_image_token_price: 12500 }), true);
  assert.equal(declaredVision({ id: "e2", prompt_image_token_price: 0 }), true, "zero is still a price");
  // Nothing usable -- the caller must fall back rather than assume "no".
  assert.equal(declaredVision({ id: "f" }), null, "no metadata is not a 'no'");
  assert.equal(declaredVision({ id: "g", input_modalities: ["audio"] }), null,
    "an unrelated modality says nothing about images");
  assert.equal(declaredVision({ id: "h", display_name: "Gemini 2.5 Flash" }), null,
    "Gemini's /models reports only display_name");
}

// A vision-capable model the name list does not know is offered for images.
//
// One endpoint serving both roles, which is where a declaration takes effect
// today: the image route and the text endpoint are the same service, so the
// endpoint's own statement about its models is the last word.
{
  const shared = {
    ...baseConfig,
    visionBaseURL: baseConfig.baseURL,
    visionApiKey: baseConfig.apiKey,
  } as unknown as Config;
  stubFetch({
    "https://text.example/v1/models": [
      // `grok-4` matches no VISION_MARKERS entry.
      { id: "grok-4", input_modalities: ["text", "image"] },
    ],
  });
  const cat = await loadCatalog(shared);
  globalThis.fetch = realFetch;

  const grok = cat.chat.find((c) => c.id === "grok-4")!;
  assert.ok(grok, "the model is listed");
  assert.equal(grok.text, true, "it answers text");
  assert.equal(grok.vision, true,
    "the endpoint says it takes images, so it is offered for them");
  assert.equal(supportsImages("grok-4"), false,
    "without the declaration the name heuristic alone would have refused it");
}

// A model the endpoint says is text-only is not offered for images, even when
// its name would have suggested otherwise.
//
// Not the *configured* vision model: that one is trusted regardless of what the
// endpoint claims, because it is configured precisely because it is known to
// work. Any other name matching the heuristic is judged by the declaration.
{
  const shared = {
    ...baseConfig,
    visionModel: "something-else-entirely",
    visionBaseURL: baseConfig.baseURL,
    visionApiKey: baseConfig.apiKey,
  } as unknown as Config;
  stubFetch({
    "https://text.example/v1/models": [
      { id: "gemini-3.6-flash", input_modalities: ["text"] },
    ],
  });
  const cat = await loadCatalog(shared);
  globalThis.fetch = realFetch;

  assert.equal(supportsImages("gemini-3.6-flash"), true, "the name alone says vision");
  const m = cat.chat.find((c) => c.id === "gemini-3.6-flash")!;
  assert.equal(m.vision, false, "but the endpoint says text-only, and it is believed");
}

// The image route is still the *vision endpoint*. A model the text endpoint
// says takes images is NOT offered for images while the vision route points
// somewhere else: routing it there would send it to a service that does not
// serve it, which is the bug #74 fixed. Per-endpoint vision is what would let
// an endpoint use its own image models, and that is separate work.
{
  stubFetch({
    "https://text.example/v1/models": [{ id: "grok-4", input_modalities: ["text", "image"] }],
    "https://vision.example/v1/models": ["models/gemini-2.5-flash"],
  });
  const cat = await loadCatalog(baseConfig);
  globalThis.fetch = realFetch;

  const grok = cat.chat.find((c) => c.id === "grok-4")!;
  assert.equal(grok.vision, false,
    "the vision route is elsewhere, so this endpoint's declaration is not enough");
  assert.equal(grok.text, true, "it is still a text model");

  // With a single endpoint, the declaration is the last word.
  const shared = {
    ...baseConfig,
    visionBaseURL: baseConfig.baseURL,
    visionApiKey: baseConfig.apiKey,
  } as unknown as Config;
  stubFetch({ "https://text.example/v1/models": [{ id: "grok-4", input_modalities: ["text", "image"] }] });
  const one = await loadCatalog(shared);
  globalThis.fetch = realFetch;
  assert.equal(one.chat.find((c) => c.id === "grok-4")!.vision, true,
    "one endpoint serves both roles, so its own declaration decides");
}

// A configured vision model is trusted even when nothing declares it.
{
  stubFetch({
    "https://text.example/v1/models": ["deepseek-flash"],
    "https://vision.example/v1/models": [{ id: "models/some-odd-name", input_modalities: ["text"] }],
  });
  const cat = await loadCatalog(baseConfig);
  globalThis.fetch = realFetch;

  const configured = cat.chat.find((c) => c.id === "gemini-3.6-flash");
  assert.ok(configured, "the configured vision model is still listed");
  assert.equal(configured!.vision, true, "and is trusted regardless of metadata");
}

console.log("models.test.ts: ok");
