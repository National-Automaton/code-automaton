import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { Config } from "./config.js";
import { runTool, toolDefinitions } from "./tools.js";
import {
  AttachedImage,
  hasImagePart,
  imageParts,
} from "./image.js";

const SYSTEM_PROMPT = `You are a coding assistant running in a terminal.
You can read, write, and edit files, list directories, and run shell commands.
Prefer small, focused edits. Explain briefly what you are doing before using tools.
When you are done, give a short summary of what changed.`;

/**
 * Events emitted while the agent works. The UI layer decides how to render
 * them; the agent never writes to stdout directly.
 */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_start"; name: string; args: any }
  | { type: "tool_result"; name: string; ok: boolean; output: string }
  | { type: "steer"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export class Agent {
  private client: OpenAI;
  messages: ChatCompletionMessageParam[];

  private visionClient: OpenAI;

  constructor(
    private config: Config,
    messages?: ChatCompletionMessageParam[]
  ) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.visionClient = new OpenAI({
      apiKey: config.visionApiKey,
      baseURL: config.visionBaseURL,
    });
    this.messages = messages ?? [{ role: "system", content: SYSTEM_PROMPT }];
  }

  /**
   * True if any message so far carries an image. Routing is per request rather
   * than per session so one conversation can mix text and screenshots.
   *
   * Note this stays true for the rest of the session: once an image is in the
   * history it is re-sent with every request, so the vision model must keep
   * handling the conversation or the model would lose that context.
   */
  /**
   * Text the user typed while a turn was running, waiting to be folded into
   * the next request. The whole history is re-sent on every loop iteration, so
   * anything appended here reaches the model at the next checkpoint -- between
   * tool calls -- rather than waiting for the turn to finish.
   */
  private pendingSteers: string[] = [];

  /** Queue a mid-turn message for the running turn. */
  steer(text: string): void {
    const t = text.trim();
    if (t) this.pendingSteers.push(t);
  }

  /** Append queued steers to the history, returning the texts folded in. */
  private flushSteers(): string[] {
    if (!this.pendingSteers.length) return [];
    const queued = this.pendingSteers;
    this.pendingSteers = [];
    for (const text of queued) this.messages.push({ role: "user", content: text });
    return queued;
  }

  private needsVision(): boolean {
    return this.messages.some((m) => hasImagePart((m as any).content));
  }

  /** The client and model to use for the next request. */
  private route(): { client: OpenAI; model: string } {
    return this.needsVision()
      ? { client: this.visionClient, model: this.config.visionModel }
      : { client: this.client, model: this.config.model };
  }

  /**
   * Send user input and stream the model's response through `emit`.
   * Resolves once the model has finished (no more tool calls).
   */
  async send(
    userInput: string,
    emit: (ev: AgentEvent) => void,
    images: AttachedImage[] = []
  ): Promise<void> {
    if (images.length) {
      // Image parts are only accepted in `user` messages; tool results cannot
      // carry them. Annotate each part with its path so the session store can
      // swap the pixels for a placeholder and re-read them on reload.
      const parts: any[] = [{ type: "text", text: userInput }];
      const imgParts = await imageParts(images);
      for (let i = 0; i < imgParts.length; i++) {
        parts.push({ ...imgParts[i], image_path: images[i].path });
      }
      this.messages.push({ role: "user", content: parts });
    } else {
      this.messages.push({ role: "user", content: userInput });
    }

    // Loop until the model stops requesting tools.
    while (true) {
      // Fold in anything typed while the previous request was in flight, so a
      // mid-turn steer lands alongside the tool results rather than after the
      // turn ends.
      for (const text of this.flushSteers()) emit({ type: "steer", text });

      const { client, model } = this.route();
      const stream = await this.createWithRetry(client, model, emit);

      let content = "";
      const toolCalls: ChatCompletionMessageToolCall[] = [];

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          emit({ type: "text", text: delta.content });
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCalls[idx]) {
              toolCalls[idx] = {
                id: tc.id ?? "",
                type: "function",
                function: { name: "", arguments: "" },
              };
            }
            if (tc.id) toolCalls[idx].id = tc.id;
            // Providers may attach opaque data to a tool call that must be
            // echoed back on the next request. Gemini returns a
            // `thought_signature` here and rejects the following turn without
            // it ("Function call is missing a thought_signature"). Preserve
            // whatever the provider sent rather than rebuilding the call from
            // only id/name/arguments.
            const extra = (tc as any).extra_content;
            if (extra) (toolCalls[idx] as any).extra_content = extra;
            if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments)
              toolCalls[idx].function.arguments += tc.function.arguments;
          }
        }
      }

      const assistantMsg: ChatCompletionMessageParam = {
        role: "assistant",
        content: content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      };
      this.messages.push(assistantMsg);

      if (!toolCalls.length) {
        emit({ type: "done" });
        return;
      }

      for (const call of toolCalls) {
        let args: any = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          args = {};
        }
        emit({ type: "tool_start", name: call.function.name, args });
        const result = await runTool(call.function.name, args);
        emit({
          type: "tool_result",
          name: call.function.name,
          ok: result.ok,
          output: result.output,
        });
        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.output,
        });
      }
    }
  }

  /**
   * Start a streaming completion, retrying transient upstream failures.
   *
   * Vision endpoints (notably Gemini's free tier) routinely return 503 "high
   * demand" or 429; without a retry an ordinary screenshot question fails and
   * looks like a bug in coda. Only the initial request is retried -- once the
   * stream has started, a mid-stream failure is surfaced rather than silently
   * re-run, which would duplicate partial output.
   */
  private async createWithRetry(
    client: OpenAI,
    model: string,
    emit: (ev: AgentEvent) => void
  ) {
    const attempts = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await client.chat.completions.create({
          model,
          messages: this.messages,
          tools: toolDefinitions,
          stream: true,
        });
      } catch (err: any) {
        const status = err?.status ?? err?.response?.status;
        const transient = status === 503 || status === 429 || status === 500;
        if (!transient || attempt >= attempts) throw err;
        const waitMs = 500 * 2 ** (attempt - 1);
        emit({
          type: "text",
          text: `\n[${model} returned ${status}, retrying in ${waitMs / 1000}s (${attempt}/${attempts - 1})]\n`,
        });
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
}
