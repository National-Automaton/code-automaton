import type { Config } from "./config.js";

/**
 * The list of models available on an endpoint, and the props of each.
 *
 * `coda` reads exactly two model names from config (see `Config.model` and
 * `Config.visionModel`), so nothing in the app had a notion of "what else could
 * I run". This module answers that question by asking the endpoint -- every
 * OpenAI-compatible provider answers `GET /models` -- and falling back to the
 * configured values when it cannot.
 *
 * The list is never authoritative about *chat* or about *images*: providers
 * return audio, embedding and image-generation models from the same endpoint
 * (Gemini's list includes `lyria-realtime-exp` and native-audio models), so a
 * raw list offered in the UI would let a user select something that cannot
 * answer a chat message. `isChatModel` filters those out and `supportsImages`
 * decides which models may serve the image route.
 */
export interface ModelInfo {
  /** Model id exactly as the provider reports it (Gemini uses a `models/` prefix). */
  id: string;
  /** True when this model can answer a chat completion. */
  chat: boolean;
  /** True when this model accepts image parts in a chat message. */
  vision: boolean;
}

export interface ModelCatalog {
  /** Chat-capable models, in the order the provider listed them. */
  chat: ModelInfo[];
  /** True when the list came from the endpoint rather than from config. */
  fetched: boolean;
  /** Why the fetch did not produce a list, when it did not. */
  error?: string;
}

/**
 * Substrings that mark a model as *not* a chat model.
 *
 * Matched against the id, case-insensitively. These are the families that
 * genuinely cannot answer a chat completion on the providers coda supports;
 * the list is deliberately short and specific so a normal chat model is never
 * filtered out by accident -- an unknown model is assumed to be a chat model,
 * because offering one that fails is recoverable (the request errors visibly)
 * while hiding one that works is not.
 */
const NON_CHAT_MARKERS = [
  "embedding",
  "embed-",
  "-embed",
  "text-embedding",
  "whisper",
  "tts-",
  "-tts",
  "transcribe",
  "audio",
  "realtime",
  "live", // `gemini-3.8-live` and `-live-preview`: streaming-only models
  "image-generation",
  "dall-e",
  "moderation",
  "lyria",
  "veo-",
  "robotics",
  // Image *generation* models. `-image` must not catch a name like
  // `image-captioner`, so it is matched only where it names the model family:
  // Gemini and Imagen spell them `-image`, `-image-preview`, `nano-banana`.
  "-image",
  "nano-banana",
  "imagen",
  // Research / retrieval products that are not chat endpoints.
  "deep-research",
  "antigravity",
  // Gemini's "ask a question about a document" model: a task endpoint, not a
  // general chat model.
  "aqa",
];

/**
 * Substrings that mark a model as accepting images.
 *
 * This is a name-based guess, which is why it only ever *adds* capability: a
 * model is treated as vision-capable when its name says so, and the configured
 * vision model is trusted regardless of its name (it is configured precisely
 * because it is known to work). Getting this wrong in the other direction --
 * hiding a vision model whose name does not advertise it -- is corrected by
 * the config fallback.
 */
const VISION_MARKERS = [
  "vision",
  "gemini", // Gemini chat models are all multimodal
  "gpt-4o",
  "gpt-4.1",
  "gpt-5",
  "claude", // every Claude 3+ model accepts images
  "llava",
  "qwen-vl",
  "pixtral",
  "internvl",
  "molmo",
  "o3",
  "o4-mini",
];

/** True if `id` looks like a chat model (see `NON_CHAT_MARKERS`). */
export function isChatModel(id: string): boolean {
  const lower = id.toLowerCase();
  return !NON_CHAT_MARKERS.some((m) => lower.includes(m));
}

/** True if `id` is believed to accept image input (see `VISION_MARKERS`). */
export function supportsImages(id: string): boolean {
  const lower = id.toLowerCase();
  return VISION_MARKERS.some((m) => lower.includes(m));
}

/**
 * Strip a provider's `models/` prefix from an id.
 *
 * Gemini reports ids as `models/gemini-2.5-flash` but accepts either form in a
 * request, and users configure the bare name. Normalising here means a selected
 * model compares equal to a configured one, so the ✓ and the vision pairing
 * stay right across providers.
 */
export function bareId(id: string): string {
  return id.startsWith("models/") ? id.slice("models/".length) : id;
}

/**
 * How long to wait for `GET /models` before falling back to config.
 *
 * The model list is a convenience, not part of a request: a hung endpoint must
 * not hold the picker shut. Five seconds is well beyond a healthy round trip
 * (both configured endpoints answered in well under a second) and short enough
 * that a dead one is noticeable rather than frozen.
 */
const FETCH_TIMEOUT_MS = 5_000;

/** Ask one endpoint what it serves. Returns null on any failure. */
async function fetchEndpoint(
  baseURL: string,
  apiKey: string
): Promise<string[] | null> {
  const url = baseURL.replace(/\/+$/, "") + "/models";
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ac.signal,
    });
    if (!res.ok) return null;
    const body: any = await res.json();
    const data = Array.isArray(body?.data) ? body.data : null;
    if (!data) return null;
    return data
      .map((m: any) => (typeof m?.id === "string" ? m.id : null))
      .filter((id: string | null): id is string => id !== null);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The models to offer, fetched from the configured endpoints with a fallback to
 * config.
 *
 * Both endpoints are queried: the text endpoint usually serves the chat models
 * and the vision endpoint the image-capable ones, but a single-endpoint setup
 * (the default, where vision falls back to the text endpoint) queries one URL
 * once rather than twice.
 *
 * When an endpoint cannot be reached its configured models are used instead, so
 * the picker always has something to show -- an offline machine must still be
 * able to see and reselect the model it is already running.
 */
export async function loadCatalog(config: Config): Promise<ModelCatalog> {
  const sameEndpoint =
    config.visionBaseURL === config.baseURL &&
    config.visionApiKey === config.apiKey;

  const [textList, visionList] = await Promise.all([
    fetchEndpoint(config.baseURL, config.apiKey),
    sameEndpoint
      ? Promise.resolve<string[] | null>(null)
      : fetchEndpoint(config.visionBaseURL, config.visionApiKey),
  ]);

  const fetched = textList !== null || visionList !== null;
  const ids = new Set<string>();
  for (const id of [...(textList ?? []), ...(visionList ?? [])]) ids.add(bareId(id));

  // Config values are always included, even when a list arrived: the configured
  // model may be an alias the endpoint does not list (or a local name), and
  // dropping it from the picker would hide the model currently in use.
  ids.add(bareId(config.model));
  if (config.visionModel) ids.add(bareId(config.visionModel));

  const chat = [...ids]
    .filter((id) => isChatModel(id))
    .map((id) => ({
      id,
      chat: true,
      // The configured vision model is trusted regardless of its name; every
      // other model is judged by name (see `supportsImages`). Without a
      // configured vision model the text model is the image route by default
      // (that is what `Config`'s fallback does), so it is trusted too.
      vision:
        (id === bareId(config.visionModel) && !!config.visionModel) ||
        (!config.visionModel && id === bareId(config.model)) ||
        supportsImages(id),
    }));

  return {
    chat,
    fetched,
    error: fetched ? undefined : "could not reach the model endpoint",
  };
}
