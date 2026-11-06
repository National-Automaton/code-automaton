/**
 * Per-session model selection, and how it interacts with image routing.
 *
 * Selecting a text model is *not* a global switch: `coda` keeps several
 * sessions open at once, and changing the model in one must not reroute
 * another, possibly mid-turn. These tests pin that, plus the rule that makes
 * `/model` honest: when the history holds an image, the image model answers
 * whatever the text selection says, and `currentRoute()` must report that
 * rather than repeating the text choice back as though it were in force.
 *
 * No request is sent: `currentRoute()` is pure state inspection.
 *
 * Run with `npm test`.
 */
import { strict as assert } from "node:assert";
import type { Config } from "../src/config.js";

process.env.OPENAI_API_KEY ||= "sk-test-placeholder";

const { Agent } = await import("../src/agent.js");

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
} as unknown as Config;

// --- defaults come from config --------------------------------------------

{
  const a = new Agent(config);
  const r = a.currentRoute();
  assert.equal(r.textModel, "deepseek-flash", "text model defaults to config");
  assert.equal(r.visionModel, "gemini-3.6-flash", "image model defaults to config");
  assert.equal(r.usingVision, false, "no image in history");
  assert.equal(r.model, "deepseek-flash", "a text-only session routes to the text model");
  assert.equal(r.textOverride, null);
  assert.equal(r.visionOverride, null);
}

// --- an override changes the route, per session ---------------------------

{
  const a = new Agent(config);
  const b = new Agent(config);

  a.setModels("deepseek-v4-pro", "gemini-2.5-flash");
  assert.equal(a.currentRoute().textModel, "deepseek-v4-pro");
  assert.equal(a.currentRoute().model, "deepseek-v4-pro", "the next request uses the choice");
  assert.equal(a.currentRoute().visionModel, "gemini-2.5-flash");
  assert.equal(a.currentRoute().textOverride, "deepseek-v4-pro");

  // The other session is untouched: this is the whole point of per-session.
  assert.equal(b.currentRoute().textModel, "deepseek-flash", "another session keeps config");
  assert.equal(b.currentRoute().visionModel, "gemini-3.6-flash");
}

// --- an image in history routes to the image model, and says so -----------

{
  const a = new Agent(config);
  a.setModels("deepseek-v4-pro", "gemini-2.5-flash");

  // A user message carrying an image part is what `needsVision()` looks for.
  a.messages.push({
    role: "user",
    content: [
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } } as any,
    ],
  } as any);

  assert.equal(a.hasImages(), true, "the history holds an image");
  const r = a.currentRoute();
  assert.equal(r.usingVision, true, "routing is on the image model");
  assert.equal(r.model, "gemini-2.5-flash", "the image model answers, not the text choice");
  assert.equal(r.textModel, "deepseek-v4-pro", "the text selection is still reported");
}

// --- resetting restores config --------------------------------------------

{
  const a = new Agent(config);
  a.setModels("deepseek-v4-pro", "gemini-2.5-flash");
  a.setModels(null, null);
  const r = a.currentRoute();
  assert.equal(r.textModel, "deepseek-flash", "null restores config");
  assert.equal(r.visionModel, "gemini-3.6-flash");
  assert.equal(r.textOverride, null, "no override is left behind");
}

console.log("model-route.test.ts: ok");
