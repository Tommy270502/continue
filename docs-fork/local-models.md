# Local models with llama.cpp (llama-server) and Qwen3

This fork is tuned for running Continue against a local `llama-server`
(llama.cpp) with Qwen3-family models, for example `qwen3.8-27b` (UD-Q4_K_M).
This page covers a working `~/.continue/config.yaml`, the llama-server flags
the code relies on, and what changed compared with upstream Continue v1.3.40.

## How the `llama.cpp` provider talks to llama-server

| Feature                                   | Endpoint                    | Notes                                                                                                                                                             |
| ----------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --- | ---------- | --- | ---------- | ----------- | --------- | ----- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Chat, agent mode, tool calls, edit, apply | `POST /v1/chat/completions` | llama-server applies the model's own chat template. Tool calls are native. Reasoning comes back in `reasoning_content` and shows up as "thinking" in the chat UI. |
| Autocomplete (FIM)                        | `POST /completion`          | Continue builds the FIM prompt (`<                                                                                                                                | fim_prefix | >…< | fim_suffix | >…< | fim_middle | >`, plus `< | repo_name | >`/`< | file_sep | >`context from other files) and sends it raw. llama-server parses the special tokens. Every request sends`cache_prompt: true`. |
| Embeddings (optional)                     | `POST /v1/embeddings`       | Only if you run an instance with `--embeddings`.                                                                                                                  |

`apiBase` can be given with or without `/v1`. The provider adds `/v1` for the
OpenAI-compatible calls and strips it for the native `/completion` endpoint,
so `http://127.0.0.1:8080` and `http://127.0.0.1:8080/v1` behave the same.
The default is `http://127.0.0.1:8080/`.

Autocomplete does not use `/infill`. Continue's `streamFim` interface only
passes a prefix and a suffix, and the Qwen multi-file template puts
repository context into the prefix, so `/infill` would lose that context or
double-wrap it. `/completion` with the template sends llama-server the same
tokens, keeps the multi-file context, and reuses the KV cache.

## Recommended llama-server flags

One server for chat, edit and apply (and autocomplete if you don't run a
second one):

```bash
llama-server \
  -m ~/models/Qwen3.8-27B-UD-Q4_K_M.gguf \
  --alias qwen3.8-27b \
  --host 127.0.0.1 --port 8080 \
  --jinja \
  -c 32768 \
  -ngl 99 \
  -fa on \
  --cache-reuse 256 \
  -np 1 \
  --temp 0.6 --top-p 0.95 --top-k 20 --min-p 0
```

- `--jinja`: required for native tool calling and for the
  `chat_template_kwargs.enable_thinking` switch (see below). Recent builds
  turn it on by default, but passing it is harmless.
- `-c`: total context. With `-np N` the context is split between N slots,
  so `-c 32768 -np 2` gives each request 16k. Set Continue's
  `contextLength` to the per-slot value.
- `--cache-reuse 256`: reuses KV-cache chunks even when the middle of the
  prompt changed. This helps autocomplete, where the prefix shifts as you
  type. It only works when the request sets `cache_prompt: true`, which this
  provider always does.
- `-fa on` (flash attention): optional. It makes long contexts faster and
  lets you use `-ctk q8_0 -ctv q8_0` to shrink the KV cache if VRAM is tight.
  Older builds take a plain `-fa` with no value.
- Sampling flags: these are Qwen3's recommended thinking-mode settings.
  Values set in Continue's `defaultCompletionOptions` override them per
  request.
- `--reasoning-format`: leave it at the default (`auto`/`deepseek`) so
  thinking arrives in `reasoning_content` rather than inline `<think>` tags.
  The GUI can also parse inline tags, but the separate field is cleaner.

## Example `~/.continue/config.yaml`

```yaml
name: Local
version: 1.0.0
schema: v1

models:
  - name: Qwen3.8 27B (local)
    provider: llama.cpp
    # Continue picks templates, tool support and reasoning support from this
    # name, so keep "qwen3" in it. llama-server ignores it.
    model: qwen3.8-27b
    apiBase: http://127.0.0.1:8080
    roles:
      - chat
      - edit
      - apply
      - autocomplete
    contextLength: 32768
    defaultCompletionOptions:
      maxTokens: 8192
      temperature: 0.6
      topP: 0.95
      topK: 20
      minP: 0
    # Optional: tool support is auto-detected for qwen3 on llama.cpp.
    # Set it explicitly if your model name doesn't contain "qwen".
    capabilities:
      - tool_use
    autocompleteOptions:
      debounceDelay: 250
      modelTimeout: 4000
      maxPromptTokens: 2048
```

### A dedicated autocomplete model (recommended)

A 27B model that defaults to thinking is slow for tab completion, and general
Qwen3 models are not trained for fill-in-the-middle as heavily as the coder
variants. If you have the VRAM, run a small coder model on a second port and
give it only the `autocomplete` role:

```bash
llama-server -m ~/models/Qwen2.5-Coder-1.5B-Q8_0.gguf --alias qwen2.5-coder-1.5b \
  --port 8081 -c 8192 -ngl 99 -fa on --cache-reuse 256
```

```yaml
- name: Qwen2.5 Coder 1.5B (autocomplete)
  provider: llama.cpp
  model: qwen2.5-coder-1.5b
  apiBase: http://127.0.0.1:8081
  roles:
    - autocomplete
  defaultCompletionOptions:
    temperature: 0.1
```

Then remove `autocomplete` from the 27B model's roles.

### Thinking on and off

- Chat: Qwen3 hybrid models (any name matching `qwen3`/`qwen-3`, except
  `coder` and `instruct` variants) now get the reasoning toggle (lightbulb)
  in the input toolbar. On is the model default. Off sends
  `chat_template_kwargs: {enable_thinking: false}`, which gives faster
  answers with no thinking.
- To turn thinking off by default, set
  `defaultCompletionOptions.reasoning: false`.
- Edit and apply always request `reasoning: false`. The provider sends
  `enable_thinking: false` and also drops any thinking output that still
  arrives, for models that ignore the flag, so it can't end up in your code.
- Autocomplete sends a raw FIM prompt with no chat template, so the model
  doesn't think. Any stray `<think>…</think>` is still stripped in
  post-processing.

### Legacy client-side templating

To get the old behaviour back (Continue applies a ChatML template itself and
everything goes through `/completion`), set a chat template explicitly:

```yaml
promptTemplates:
  chat: chatml
```

This turns off native tool calling (agent mode falls back to tools described
in the system message) and the separate thinking channel.

## What changed in this fork

Files are under `core/llm/` unless noted.

- `llms/LlamaCpp.ts`
  - Chat now goes through llama-server's OpenAI-compatible
    `/v1/chat/completions` (via `@continuedev/openai-adapters`) instead of
    being templated client-side as ChatML and sent to `/completion`. This
    enables native tool calls and the reasoning/thinking channel, and lets
    the model's own Jinja template apply.
  - Raw prompts (autocomplete) still use `/completion`, now with
    `cache_prompt: true`.
  - `/completion` used to be resolved against `apiBase` as given, so
    `apiBase: …/v1` produced a 404 on `/v1/completion`. The `/v1` is now
    stripped for native endpoints.
  - Non-raw `complete()`/`streamComplete()` calls are sent as a single user
    chat message, so the prompt still gets the chat template.
  - Chat requests also send `cache_prompt`, `top_k`, `min_p`, and
    `chat_template_kwargs.enable_thinking` when reasoning is explicitly
    on or off. The unsupported `prediction` field is removed.
  - Thinking chunks are dropped from `streamChat` when `reasoning: false`
    (edit and apply).
  - No `Authorization: Bearer undefined` header when no API key is set.
  - Embeddings go through `/v1/embeddings`.
- `index.ts`: `modifyChatBody()` now also receives the completion options,
  as an optional second argument. Existing overrides are unaffected.
- `autodetect.ts`: `llama.cpp` was added to the providers that handle
  templating server-side. Qwen3 hybrid thinking models are reported as
  reasoning-capable.
- `toolSupport.ts`: added a `llama.cpp` entry that reuses the LM Studio
  heuristic. It tolerates GGUF-style names like `Qwen3-32B-Q4_K_M` and
  matches `qwen3`, `qwen2.5`, Llama 3.x, gpt-oss, Devstral and others.
- `packages/openai-adapters/src/index.ts`: the `llama.cpp`/`llamafile`
  default base was `http://localhost:8000/`, which is wrong. It is now
  `http://localhost:8080/v1/`, and `/v1` is appended to a configured
  `apiBase` (like the Ollama entry).
- `core/autocomplete/templating/AutocompleteTemplate.ts`: Qwen2/2.5/3
  models without "coder" in the name (e.g. `qwen3.8-27b`) used to get the
  StarCoder-style template (`<fim_prefix>` without pipes). Those are plain
  text to the Qwen tokenizer. They now get the Qwen `<|fim_*|>` template.
  CodeQwen1.5 keeps the StarCoder tokens.
- Tests: `llms/LlamaCpp.vitest.ts` (new), `autodetect.vitest.ts`,
  `toolSupport.test.ts`,
  `core/autocomplete/templating/AutocompleteTemplate.vitest.ts` (new) and
  `packages/openai-adapters/src/test/main.test.ts`.

`llamafile` is unchanged: it still templates client-side and uses
`/completion`. It only gains embeddings support and the corrected adapter
default port.
