import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { Config } from "./config.js";
import { runTool, toolDefinitions } from "./tools.js";

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
  | { type: "done" }
  | { type: "error"; message: string };

export class Agent {
  private client: OpenAI;
  messages: ChatCompletionMessageParam[];

  constructor(
    private config: Config,
    messages?: ChatCompletionMessageParam[]
  ) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.messages = messages ?? [{ role: "system", content: SYSTEM_PROMPT }];
  }

  /**
   * Send user input and stream the model's response through `emit`.
   * Resolves once the model has finished (no more tool calls).
   */
  async send(
    userInput: string,
    emit: (ev: AgentEvent) => void
  ): Promise<void> {
    this.messages.push({ role: "user", content: userInput });

    // Loop until the model stops requesting tools.
    while (true) {
      const stream = await this.client.chat.completions.create({
        model: this.config.model,
        messages: this.messages,
        tools: toolDefinitions,
        stream: true,
      });

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
}
