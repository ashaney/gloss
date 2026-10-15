/**
 * Meta Model API (Muse Spark) client. Server-side only. Raw fetch,
 * OpenAI-compatible SSE against https://api.meta.ai/v1.
 *
 * Things learned the hard way, kept on purpose:
 * 1. A named User-Agent.
 * 2. stream_options.include_usage, so the cost receipt is real, not a guess.
 * 3. Errors come back as JSON: surface error.message, not the raw body.
 * 4. Muse Spark always reasons, and its reasoning spends from the same
 *    max_tokens budget as the answer (verified 2026-10-15: max_tokens 200
 *    returned an empty answer). Every call therefore adds REASONING_TOKENS
 *    of headroom and pins reasoning_effort, which is the only control Meta
 *    offers ("none" is a 400). Together's chat_template_kwargs is rejected
 *    as an unknown parameter, and tool_choice only accepts "auto": a
 *    follow-up call that must not search again simply sends no tools.
 */

export const MUSE_URL = "https://api.meta.ai/v1/chat/completions";
export const MUSE_BASE = "https://api.meta.ai/v1";
export const APP_UA = "Gloss/0.1";

/** Reasoning headroom added to every completion budget; see note 4 above. */
const REASONING_TOKENS = 1200;

import { DEFAULT_MODEL, MODELS, costFor, type ModelEntry, type ModelKey, type StreamEvent, type Usage } from "./models";

export { MODELS, DEFAULT_MODEL, isModelKey, costFor } from "./models";
export type { ModelKey, StreamEvent, Usage } from "./models";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

type Chunk = {
  choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
};

function errorMessage(status: number, body: string): string {
  let msg = body.slice(0, 280);
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    if (typeof j.error === "string") msg = j.error;
    else if (j.error?.message) msg = j.error.message;
    else if (j.message) msg = j.message;
  } catch {
    /* not JSON */
  }
  if (status === 401) return "Meta rejected the server API key. Check MODEL_API_KEY on the server.";
  if (status === 429) return "Meta is rate limiting this key. Wait a moment and try again.";
  return `Muse API ${status}: ${msg}`;
}

function serverKey(): string | undefined {
  return process.env.MODEL_API_KEY?.trim() || undefined;
}

export async function* streamChat(req: {
  messages: ChatMessage[];
  model: ModelKey;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Reasoning effort for this call. Defaults to "low": margin answers should be quick. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  /** Tools the model may call; a call ends the stream with a "tool" event instead of an answer. */
  tools?: readonly unknown[];
}): AsyncGenerator<StreamEvent> {
  const model: ModelEntry = MODELS[req.model];
  const apiKey = serverKey();
  if (!apiKey) {
    yield { type: "error", text: "No Muse API key on the server. Set MODEL_API_KEY in .env.local." };
    return;
  }

  yield { type: "meta", model: model.label };

  let res: Response;
  try {
    res = await fetch(MUSE_URL, {
      method: "POST",
      signal: req.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": APP_UA,
      },
      body: JSON.stringify({
        model: model.id,
        stream: true,
        stream_options: { include_usage: true },
        temperature: req.temperature ?? 0.4,
        max_tokens: (req.maxTokens ?? 900) + REASONING_TOKENS,
        reasoning_effort: req.reasoningEffort ?? "low",
        messages: req.messages,
        ...(req.tools ? { tools: req.tools, tool_choice: "auto" } : {}),
      }),
    });
  } catch (e) {
    if (req.signal?.aborted) return;
    yield { type: "error", text: `Could not reach Muse: ${String(e)}` };
    return;
  }

  if (!res.ok || !res.body) {
    yield { type: "error", text: errorMessage(res.status, await res.text().catch(() => "")) };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawContent = false;
  // A tool call arrives in pieces, by index: its id and name once, its arguments in fragments.
  const calls: { id: string; name: string; args: string }[] = [];

  const finish = (): StreamEvent => {
    if (calls[0]?.name) return { type: "tool", id: calls[0].id || "call_0", name: calls[0].name, args: calls[0].args };
    return !sawContent ? { type: "error", text: `${model.label} returned an empty answer. Try again.` } : { type: "done" };
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const line = frame.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        yield finish();
        return;
      }
      let chunk: Chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      for (const tc of delta?.tool_calls ?? []) {
        const c = (calls[tc.index] ??= { id: "", name: "", args: "" });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.args += tc.function.arguments;
      }
      if (delta?.content) {
        sawContent = true;
        yield { type: "content", text: delta.content };
      }
      if (chunk.usage && typeof chunk.usage.completion_tokens === "number") {
        const pt = chunk.usage.prompt_tokens ?? 0;
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
        const ct = chunk.usage.completion_tokens ?? 0;
        yield {
          type: "usage",
          usage: { promptTokens: pt, cachedTokens: cached, completionTokens: ct, costUsd: costFor(req.model, pt, cached, ct) },
        };
      }
    }
  }
  yield finish();
}

/** Non-streaming JSON completion, for structured output like the brief. */
export async function completeJSON<T>(req: {
  messages: ChatMessage[];
  model: ModelKey;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Let the model reason harder before it answers, for checking a text against itself. */
  thinking?: boolean;
}): Promise<{ ok: true; data: T; usage: Usage } | { ok: false; error: string }> {
  const model: ModelEntry = MODELS[req.model];
  const apiKey = serverKey();
  if (!apiKey) return { ok: false, error: "No Muse API key on the server. Set MODEL_API_KEY in .env.local." };

  let res: Response;
  try {
    res = await fetch(MUSE_URL, {
      method: "POST",
      signal: req.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "User-Agent": APP_UA },
      body: JSON.stringify({
        model: model.id,
        temperature: 0.3,
        max_tokens: (req.maxTokens ?? 1400) + REASONING_TOKENS,
        reasoning_effort: req.thinking ? "medium" : "low",
        response_format: { type: "json_object" },
        messages: req.messages,
      }),
    });
  } catch (e) {
    return { ok: false, error: `Could not reach Muse: ${String(e)}` };
  }
  const body = await res.text();
  if (!res.ok) return { ok: false, error: errorMessage(res.status, body) };

  try {
    const j = JSON.parse(body) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    };
    const raw = j.choices?.[0]?.message?.content ?? "";
    const jsonText = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const data = JSON.parse(jsonText) as T;
    const pt = j.usage?.prompt_tokens ?? 0;
    const cached = j.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const ct = j.usage?.completion_tokens ?? 0;
    return { ok: true, data, usage: { promptTokens: pt, cachedTokens: cached, completionTokens: ct, costUsd: costFor(req.model, pt, cached, ct) } };
  } catch {
    return { ok: false, error: "The model returned something that was not valid JSON. Try again." };
  }
}

/** One non-streaming chat call with arbitrary (e.g. vision) message content. Server-side only. */
export async function completeChat(req: {
  messages: unknown[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  signal?: AbortSignal;
}): Promise<{ ok: true; text: string; usage: { promptTokens: number; completionTokens: number } } | { ok: false; error: string }> {
  const apiKey = serverKey();
  if (!apiKey) return { ok: false, error: "No Muse API key on the server. Set MODEL_API_KEY in .env.local." };
  let res: Response;
  try {
    res = await fetch(MUSE_URL, {
      method: "POST",
      signal: req.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "User-Agent": APP_UA },
      body: JSON.stringify({
        model: req.model ?? MODELS[DEFAULT_MODEL].id,
        temperature: req.temperature ?? 0,
        max_tokens: (req.maxTokens ?? 4096) + REASONING_TOKENS,
        reasoning_effort: req.reasoningEffort ?? "low",
        messages: req.messages,
      }),
    });
  } catch (e) {
    return { ok: false, error: `Could not reach Muse: ${String(e)}` };
  }
  const body = await res.text();
  if (!res.ok) return { ok: false, error: errorMessage(res.status, body) };
  try {
    const j = JSON.parse(body) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      ok: true,
      text: j.choices?.[0]?.message?.content ?? "",
      usage: { promptTokens: j.usage?.prompt_tokens ?? 0, completionTokens: j.usage?.completion_tokens ?? 0 },
    };
  } catch {
    return { ok: false, error: "The model returned an unreadable response. Try again." };
  }
}
