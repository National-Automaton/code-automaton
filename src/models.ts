import type { Config } from "./config.js";
import { getSecret } from "./secrets.js";

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
  /**
   * True when this model may answer a *text* request.
   *
   * Separate from `chat` because the two endpoints are separate services: the
   * id `gemini-4-carbon` can answer a chat completion, but only on the vision
   * endpoint, and sending it to the text endpoint fails with the provider's
   * "supported API model names are ..." 400. Selecting it as the text model
   * used to be possible and broke the session on the next message.
   */
  text: boolean;
  /**
   * The alternative endpoint this model belongs to, or null for `CODA_*`.
   *
   * A model id is only meaningful together with the service that serves it, so
   * the picker reports the pair rather than the id alone. Two endpoints can
   * list the same id and mean different things by it.
   */
  endpoint: string | null;
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
export interface ListedModel {
  id: string;
  /**
   * Image support as the endpoint *declares* it, or null when it says nothing.
   *
   * Null is not "no": it means the endpoint did not report capabilities, so the
   * caller must fall back to judging by name. Conflating the two would hide a
   * vision model behind a provider that simply omits metadata.
   */
  vision: boolean | null;
}

/**
 * Read one model entry's declared image support.
 *
 * Three shapes are in use among the providers tested, and each is checked
 * before the next:
 *
 *  - `input_modalities: ["text", "image"]` (DeepSeek, and the OpenAI-compatible
 *    convention). Explicit, and it distinguishes models on the same endpoint --
 *    deepseek-flash takes images, deepseek-v4-pro does not.
 *  - `architecture.input_modalities` / `architecture.modality`, which some
 *    gateways use instead.
 *  - `prompt_image_token_price` (x.ai). A model is priced for image *input*
 *    exactly when it accepts images; every chat model there has it and the
 *    image-*generation* models have no prices at all. A price is not a
 *    statement of capability, so this is only a proxy -- but on the endpoint it
 *    was checked against, no chat model lacked it.
 *
 * Anything else returns null, and the caller falls back to the name heuristics.
 */
export function declaredVision(entry: any): boolean | null {
  const modalities = (v: any): boolean | null => {
    if (!Array.isArray(v)) return null;
    const lc = v.map((m: any) => String(m).toLowerCase());
    if (lc.includes("image") || lc.includes("vision")) return true;
    // A list that mentions only text is a genuine "no"; one that mentions some
    // other input (audio-only, say) says nothing about images.
    return lc.includes("text") ? false : null;
  };

  const direct = modalities(entry?.input_modalities);
  if (direct !== null) return direct;

  const arch =
    modalities(entry?.architecture?.input_modalities) ??
    modalities(entry?.architecture?.modality);
  if (arch !== null) return arch;

  // Image *input* pricing. Zero would be an odd way to say "free", so any
  // numeric value counts as present.
  const price = entry?.prompt_image_token_price;
  if (typeof price === "number") return price >= 0 ? true : null;

  return null;
}

async function fetchEndpoint(
  baseURL: string,
  apiKey: string
): Promise<ListedModel[] | null> {
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
      .filter((m: any) => typeof m?.id === "string")
      .map((m: any) => ({ id: m.id, vision: declaredVision(m) }));
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
 *
 * Each id remembers which endpoint(s) listed it. A model is text-capable when
 * the text endpoint serves it and vision-capable when the vision endpoint
 * does, which is what stops a vision-only id being offered for text (see
 * `ModelInfo.text`). When an endpoint could not be reached, its configured
 * model is assumed to be served there, because that is the model the session
 * is already running on it.
 */
export async function loadCatalog(config: Config): Promise<ModelCatalog> {
  // Defensive: `Config.endpoints` is required, but a caller that builds a
  // partial config object (tests, embedders) would otherwise crash the picker
  // with a TypeError instead of showing the one endpoint it does have.
  const endpoints = config.endpoints ?? [];
  const sameEndpoint =
    config.visionBaseURL === config.baseURL &&
    config.visionApiKey === config.apiKey;

  // One fetch per endpoint. The extra endpoints are queried with the same
  // concurrent style: a slow one must not serialise the picker.
  const [textList, visionList, ...extraLists] = await Promise.all([
    fetchEndpoint(config.baseURL, config.apiKey),
    sameEndpoint
      ? Promise.resolve<ListedModel[] | null>(null)
      : fetchEndpoint(config.visionBaseURL, config.visionApiKey),
    // A key that is not in the vault yet still yields a listable endpoint: the
    // models are known from `endpoints.json` even when the key is missing, so
    // the picker shows the endpoint and the send path reports the real problem.
    ...endpoints.map((e) =>
      fetchEndpoint(e.baseURL, e.apiKey ? (getSecret(e.apiKey) ?? "") : "")
    ),
  ]);

  const fetched = textList !== null || visionList !== null;

  /*
   * Which endpoint serves which id.
   *
   * Keyed by `endpoint + "\u0000" + id` rather than by id alone: two endpoints
   * may legitimately list the same id and mean different services, and pooling
   * them is what made a vision-only model selectable as the text model in the
   * first place (see `ModelInfo.text`).
   */
  const textKeys = new Set<string>();
  const visionKeys = new Set<string>();
  const keyOf = (endpoint: string | null, id: string) => `${endpoint ?? ""}\u0000${id}`;

  const addText = (endpoint: string | null, id: string) => textKeys.add(keyOf(endpoint, bareId(id)));
  const addVision = (endpoint: string | null, id: string) => visionKeys.add(keyOf(endpoint, bareId(id)));

  /*
   * Image support as each endpoint *declared* it, keyed the same way.
   *
   * This is what lets a provider say which of its own models take images,
   * instead of coda guessing from the name -- `grok-4` matched none of
   * `VISION_MARKERS`, so no x.ai model could ever appear in the image column
   * however capable it was (issue #88). A model with no declaration is left
   * out of this set entirely and judged by name, as before.
   */
  const declared = new Map<string, boolean>();
  const declare = (endpoint: string | null, models: ListedModel[] | null) => {
    for (const m of models ?? []) {
      if (m.vision === null) continue;
      declared.set(keyOf(endpoint, bareId(m.id)), m.vision);
    }
  };
  declare(null, textList);
  declare(null, visionList);
  endpoints.forEach((endpoint, i) => declare(endpoint.name, extraLists[i] ?? null));

  for (const m of textList ?? []) addText(null, m.id);
  if (sameEndpoint) {
    // One service serves both roles, so every text id is an image id too.
    for (const m of textList ?? []) addVision(null, m.id);
  }
  for (const m of visionList ?? []) addVision(null, m.id);

  endpoints.forEach((endpoint, i) => {
    for (const m of extraLists[i] ?? []) addText(endpoint.name, m.id);
  });

  // Config values are always included, even when a list arrived: the configured
  // model may be an alias the endpoint does not list (or a local name), and
  // dropping it from the picker would hide the model currently in use. A model
  // is offered for a role when it was listed by that endpoint or is that
  // endpoint's configured model.
  const textModel = bareId(config.model);
  const visionModel = config.visionModel ? bareId(config.visionModel) : "";
  addText(null, textModel);
  if (visionModel) addVision(null, visionModel);
  // Without a configured vision model the text model is the image route (that
  // is what `Config`'s fallback does), so it is offered for images too.
  if (!visionModel) addVision(null, textModel);
  for (const e of endpoints) addText(e.name, e.model);

  // Endpoint order is preserved so the picker's groups read the same way as
  // `endpoints.json`; within a group the provider's own order is kept.
  const chat: ModelInfo[] = [];
  const emit = (endpoint: string | null, ids: Iterable<string>) => {
    const seen = new Set<string>();
    for (const raw of ids) {
      const id = bareId(raw);
      if (seen.has(id)) continue;
      seen.add(id);
      if (!isChatModel(id)) continue;
      const k = keyOf(endpoint, id);
      chat.push({
        id,
        chat: true,
        // The configured vision model is trusted regardless of its name; every
        // other model is judged by name (see `supportsImages`).
        // A declaration from the endpoint outranks the name heuristics: the
        // provider knows its own models. `visionKeys` still gates it, so a
        // model the vision endpoint does not serve cannot leak into the image
        // column from another endpoint's declaration.
        vision:
          visionKeys.has(k) &&
          (endpoint === null && id === visionModel
            ? true
            : (declared.get(k) ?? supportsImages(id))),
        text: textKeys.has(k),
        endpoint,
      });
    }
  };

  emit(null, [...new Set([...(textList ?? []).map((m) => m.id), ...(visionList ?? []).map((m) => m.id), textModel, visionModel].filter(Boolean))]);
  endpoints.forEach((endpoint, i) => emit(endpoint.name, [...(extraLists[i] ?? []).map((m) => m.id), endpoint.model]));

  return {
    chat,
    fetched,
    error: fetched ? undefined : "could not reach the model endpoint",
  };
}
