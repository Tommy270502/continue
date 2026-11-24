import { streamSse } from "@continuedev/fetch";
import { ChatCompletionCreateParams } from "@continuedev/openai-adapters";
import {
  ChatMessage,
  CompletionOptions,
  LLMFullCompletionOptions,
  LLMOptions,
  MessageOption,
  PromptLog,
} from "../../index.js";
import { renderChatMessage } from "../../util/messageContent.js";
import { BaseLLM } from "../index.js";
import {
  fromChatCompletionChunk,
  LlmApiRequestType,
  toChatBody,
} from "../openaiTypeConverters.js";

/**
 * llama.cpp server (`llama-server`) provider.
 *
 * Request routing:
 * - Chat (and therefore agent/tool calling, edit, apply) goes through the
 *   OpenAI-compatible `/v1/chat/completions` endpoint via the openai-adapters
 *   package. llama-server applies the model's own (Jinja) chat template, parses
 *   native tool calls and returns reasoning in `reasoning_content`, which is
 *   surfaced as "thinking" messages.
 * - Raw prompts (autocomplete FIM templates, and anything rendered with an
 *   explicit `template:` from config) go to the native `/completion` endpoint,
 *   which tokenizes special tokens such as `<|fim_prefix|>` and supports
 *   `cache_prompt` for KV-cache reuse.
 *
 * Setting `template` explicitly in config restores the legacy behaviour of
 * templating chat messages client-side and sending them to `/completion`.
 */
class LlamaCpp extends BaseLLM {
  static providerName = "llama.cpp";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "http://127.0.0.1:8080/",
  };

  protected useOpenAIAdapterFor: (LlmApiRequestType | "*")[] = [
    "streamChat",
    "embed",
  ];

  /**
   * Base URL for llama-server's native (non-OpenAI) endpoints such as
   * `/completion`. Users commonly configure `apiBase: http://host:8080/v1`
   * for the OpenAI-compatible API; the native endpoints live at the root.
   */
  protected get nativeApiBase(): string {
    const base = this.apiBase ?? LlamaCpp.defaultOptions.apiBase!;
    const url = new URL(base);
    url.pathname = url.pathname.replace(/\/v1\/?$/, "/");
    if (!url.pathname.endsWith("/")) {
      url.pathname += "/";
    }
    return url.toString();
  }

  private _convertArgs(options: CompletionOptions) {
    const finalOptions = {
      n_predict: options.maxTokens,
      frequency_penalty: options.frequencyPenalty,
      presence_penalty: options.presencePenalty,
      min_p: options.minP,
      mirostat: options.mirostat,
      stop: options.stop,
      top_k: options.topK,
      top_p: options.topP,
      temperature: options.temperature,
      // Reuse the KV cache for the common prefix of consecutive requests.
      // This is the default in recent llama-server builds but was opt-in in
      // older ones, and matters a lot for autocomplete latency.
      cache_prompt: true,
    };

    return finalOptions;
  }

  private _getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      ...this.requestOptions?.headers,
    };
  }

  protected modifyChatBody(
    body: ChatCompletionCreateParams,
    options?: CompletionOptions,
  ): ChatCompletionCreateParams {
    const llamaBody = body as ChatCompletionCreateParams & {
      cache_prompt?: boolean;
      top_k?: number;
      min_p?: number;
      chat_template_kwargs?: Record<string, unknown>;
    };

    // OpenAI "predicted outputs" are not supported by llama-server
    delete llamaBody.prediction;

    llamaBody.cache_prompt = true;
    if (options?.topK !== undefined) {
      llamaBody.top_k = options.topK;
    }
    if (options?.minP !== undefined) {
      llamaBody.min_p = options.minP;
    }

    // Hybrid reasoning models (Qwen3, etc.) read `enable_thinking` from the
    // chat template kwargs. Only send it when reasoning was explicitly
    // requested or disabled, so the model's default is kept otherwise.
    // Requires llama-server to run with Jinja templates (--jinja).
    if (options?.reasoning !== undefined) {
      llamaBody.chat_template_kwargs = {
        ...llamaBody.chat_template_kwargs,
        enable_thinking: options.reasoning,
      };
    }

    return llamaBody;
  }

  /**
   * When reasoning is explicitly disabled (e.g. edit/apply always pass
   * `reasoning: false`), drop any thinking output that still comes back,
   * e.g. from thinking-only models that ignore `enable_thinking`. Otherwise
   * it would be rendered into the edited code.
   */
  async *streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    options: LLMFullCompletionOptions = {},
    messageOptions?: MessageOption,
  ): AsyncGenerator<ChatMessage, PromptLog> {
    const dropThinking = options.reasoning === false;
    const gen = super.streamChat(messages, signal, options, messageOptions);
    if (!dropThinking) {
      return yield* gen;
    }
    try {
      while (true) {
        const next = await gen.next();
        if (next.done) {
          return next.value;
        }
        if (next.value.role === "thinking") {
          continue;
        }
        yield next.value;
      }
    } finally {
      await gen.return(undefined as unknown as PromptLog);
    }
  }

  /**
   * Fallback chat implementation through the OpenAI-compatible adapter, used
   * if "streamChat" is removed from `useOpenAIAdapterFor` and for
   * non-raw prompts passed to `streamComplete`/`complete`.
   */
  protected async *_streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    if (this.templateMessages || !this.openaiAdapter) {
      yield* super._streamChat(messages, signal, options);
      return;
    }

    const body = this.modifyChatBody(
      toChatBody(messages, options, {
        includeReasoningField: this.supportsReasoningField,
        includeReasoningDetailsField: this.supportsReasoningDetailsField,
        includeReasoningContentField: this.supportsReasoningContentField,
      }),
      options,
    );

    for await (const chunk of this.openaiAdapter.chatCompletionStream(
      { ...body, stream: true },
      signal,
    )) {
      const message = fromChatCompletionChunk(chunk);
      if (message) {
        yield message;
      }
    }
  }

  protected async *_streamComplete(
    prompt: string,
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    // Without a client-side template, a non-raw prompt is plain text meant
    // for an instruct model: send it as a user message so llama-server
    // applies the model's chat template.
    if (!options.raw && !this.templateMessages && this.openaiAdapter) {
      for await (const chunk of this._streamChat(
        [{ role: "user", content: prompt }],
        signal,
        options,
      )) {
        if (chunk.role === "assistant") {
          yield renderChatMessage(chunk);
        }
      }
      return;
    }

    const resp = await this.fetch(new URL("completion", this.nativeApiBase), {
      method: "POST",
      headers: this._getHeaders(),
      body: JSON.stringify({
        model: this.model,
        prompt,
        stream: true,
        ...this._convertArgs(options),
      }),
      signal,
    });

    for await (const value of streamSse(resp)) {
      if (value.content) {
        yield value.content;
      }
    }
  }
}

export default LlamaCpp;
