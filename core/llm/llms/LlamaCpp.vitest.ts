import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { ChatMessage } from "../../index.js";
import LlamaCpp from "./LlamaCpp.js";

function sseResponse(chunks: any[]) {
  // The test setup installs node-fetch's Response, which wants a string or
  // Buffer body rather than a web ReadableStream
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function mockAdapter(llm: LlamaCpp, chunks: any[]) {
  const chatCompletionStream = vi.fn(async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  });
  (llm as any).openaiAdapter = { chatCompletionStream };
  return chatCompletionStream;
}

async function collect<T>(gen: AsyncGenerator<T, any>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) {
    out.push(item);
  }
  return out;
}

const signal = new AbortController().signal;

describe("LlamaCpp", () => {
  beforeAll(() => {
    // This can be removed if https://github.com/nodejs/undici/issues/2888 is resolved
    // @ts-ignore
    const originalFrom = ReadableStream.from;
    // @ts-ignore
    ReadableStream.from = (body) => {
      if (body?.source) {
        return body;
      }
      return originalFrom(body);
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("raw completion (autocomplete) via native /completion", () => {
    test.each([
      ["http://127.0.0.1:8080/", "http://127.0.0.1:8080/completion"],
      ["http://127.0.0.1:8080/v1", "http://127.0.0.1:8080/completion"],
      ["http://gpu-box:9000/v1/", "http://gpu-box:9000/completion"],
    ])("apiBase %s -> %s", async (apiBase, expectedUrl) => {
      const llm = new LlamaCpp({ model: "qwen3.8-27b", apiBase });
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          sseResponse([{ content: "foo" }, { content: "bar", stop: true }]),
        );
      (llm as any).fetch = fetchMock;

      const out = await collect(
        llm.streamComplete(
          "<|fim_prefix|>a<|fim_suffix|>b<|fim_middle|>",
          signal,
          {
            raw: true,
            maxTokens: 64,
            stop: ["<|endoftext|>"],
            temperature: 0.1,
          },
        ),
      );

      expect(out.join("")).toBe("foobar");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url.toString()).toBe(expectedUrl);
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        prompt: "<|fim_prefix|>a<|fim_suffix|>b<|fim_middle|>",
        stream: true,
        n_predict: 64,
        stop: ["<|endoftext|>"],
        temperature: 0.1,
        cache_prompt: true,
      });
      expect(init.headers.Authorization).toBeUndefined();
    });

    test("sends Authorization only when an apiKey is set", async () => {
      const llm = new LlamaCpp({ model: "qwen3.8-27b", apiKey: "secret" });
      const fetchMock = vi.fn().mockResolvedValue(sseResponse([]));
      (llm as any).fetch = fetchMock;
      await collect(llm.streamComplete("x", signal, { raw: true }));
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
        "Bearer secret",
      );
    });
  });

  describe("chat via OpenAI-compatible /v1/chat/completions", () => {
    test.each([
      [undefined, "http://127.0.0.1:8080/v1/"],
      ["http://127.0.0.1:8080", "http://127.0.0.1:8080/v1/"],
      ["http://gpu-box:9000/v1/", "http://gpu-box:9000/v1/"],
    ])("adapter base URL for apiBase %s is %s", (apiBase, expected) => {
      const llm = new LlamaCpp({
        model: "qwen3.8-27b",
        ...(apiBase ? { apiBase } : {}),
      });
      expect((llm as any).openaiAdapter.openai.baseURL).toBe(expected);
    });

    test("routes chat through the adapter with llama-server extras", async () => {
      const llm = new LlamaCpp({
        model: "qwen3.8-27b",
        completionOptions: { model: "qwen3.8-27b", topK: 20, minP: 0 },
      });
      const fetchMock = vi.fn();
      (llm as any).fetch = fetchMock;
      const stream = mockAdapter(llm, [
        { choices: [{ delta: { reasoning_content: "hmm" } }] },
        { choices: [{ delta: { content: "Hello" } }] },
      ]);

      const out = await collect(
        llm.streamChat([{ role: "user", content: "hi" }], signal, {
          reasoning: true,
        }),
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(out).toEqual([
        expect.objectContaining({ role: "thinking", content: "hmm" }),
        { role: "assistant", content: "Hello" },
      ]);
      const body = (stream.mock.calls[0] as any[])[0];
      expect(body).toMatchObject({
        model: "qwen3.8-27b",
        messages: [{ role: "user", content: "hi" }],
        cache_prompt: true,
        top_k: 20,
        min_p: 0,
        chat_template_kwargs: { enable_thinking: true },
      });
      expect(body.prediction).toBeUndefined();
    });

    test("passes native tools to the server", async () => {
      const llm = new LlamaCpp({ model: "qwen3.8-27b" });
      const stream = mockAdapter(llm, [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "read_file", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
      ]);
      const out = await collect(
        llm.streamChat([{ role: "user", content: "hi" }], signal, {
          tools: [
            {
              type: "function",
              displayTitle: "Read",
              readonly: true,
              group: "test",
              function: { name: "read_file", parameters: {} },
            } as any,
          ],
        }),
      );
      const body = (stream.mock.calls[0] as any[])[0];
      expect(body.tools[0].function.name).toBe("read_file");
      expect(body.chat_template_kwargs).toBeUndefined();
      expect((out[0] as any).toolCalls[0].function.name).toBe("read_file");
    });

    test("reasoning: false disables thinking and drops stray thinking output", async () => {
      const llm = new LlamaCpp({ model: "qwen3.8-27b" });
      const stream = mockAdapter(llm, [
        { choices: [{ delta: { reasoning_content: "thinking..." } }] },
        { choices: [{ delta: { content: "const x = 1;" } }] },
      ]);

      const gen = llm.streamChat([{ role: "user", content: "edit" }], signal, {
        reasoning: false,
      });
      const out: ChatMessage[] = [];
      let result = await gen.next();
      while (!result.done) {
        out.push(result.value);
        result = await gen.next();
      }

      expect(out).toEqual([{ role: "assistant", content: "const x = 1;" }]);
      expect(result.value.completion).toContain("const x = 1;");
      expect(result.value.completion).not.toContain("thinking...");
      const body = (stream.mock.calls[0] as any[])[0];
      expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    });

    test("non-raw streamComplete is sent as a chat message", async () => {
      const llm = new LlamaCpp({ model: "qwen3.8-27b" });
      const fetchMock = vi.fn();
      (llm as any).fetch = fetchMock;
      const stream = mockAdapter(llm, [
        { choices: [{ delta: { reasoning_content: "hmm" } }] },
        { choices: [{ delta: { content: "A title" } }] },
      ]);

      const out = await collect(
        llm.streamComplete("Summarize this", signal, {}),
      );

      expect(fetchMock).not.toHaveBeenCalled();
      expect(out.join("")).toBe("A title");
      const body = (stream.mock.calls[0] as any[])[0];
      expect(body.messages).toEqual([
        { role: "user", content: "Summarize this" },
      ]);
    });

    test("an explicit template restores client-side templating over /completion", async () => {
      const llm = new LlamaCpp({ model: "qwen3.8-27b", template: "chatml" });
      const fetchMock = vi
        .fn()
        .mockResolvedValue(sseResponse([{ content: "Hello" }]));
      (llm as any).fetch = fetchMock;
      const stream = mockAdapter(llm, []);

      const out = await collect(
        llm.streamChat([{ role: "user", content: "hi" }], signal),
      );

      expect(stream).not.toHaveBeenCalled();
      expect(out).toEqual([{ role: "assistant", content: "Hello" }]);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url.toString()).toBe("http://127.0.0.1:8080/completion");
      expect(JSON.parse(init.body).prompt).toContain("<|im_start|>user\nhi");
    });
  });
});
