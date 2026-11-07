import { z } from "zod";
import type { ProviderConfig } from "../../core/config.ts";
import type { ToolDef } from "./tools.ts";

export type ToolCall = { id: string; name: string; input: unknown };
export type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; calls: ToolCall[] }
  | { role: "tool"; results: { id: string; output: string; isError: boolean }[] };
export type Reply = { text: string; calls: ToolCall[]; inputTokens?: number; outputTokens?: number };
export type CallOpts = { provider: ProviderConfig; apiKey: string; model: string; system?: string; signal?: AbortSignal };

const MAX_TOKENS = 8192;
const SNIPPET = 500;

const AnthropicResponse = z.object({
  content: z.array(
    z.object({ type: z.string(), text: z.string().optional(), id: z.string().optional(), name: z.string().optional(), input: z.unknown().optional() }),
  ),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).partial().optional(),
});

const OpenAIResponse = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z
            .array(z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string() }) }))
            .nullish(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).partial().nullish(),
});

function url(base: string, path: string): string {
  return base.replace(/\/+$/, "") + path;
}

/** POSTs JSON. Non-2xx throws with status + a body snippet; the key is redacted and headers are never included. */
async function post(endpoint: string, headers: Record<string, string>, body: unknown, apiKey: string, signal?: AbortSignal) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    const snippet = (apiKey ? text.split(apiKey).join("[redacted]") : text).slice(0, SNIPPET);
    throw new Error(`HTTP ${res.status} from ${new URL(endpoint).host}: ${snippet}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`invalid JSON response: ${text.slice(0, SNIPPET)}`);
  }
}

async function callAnthropic(o: CallOpts, msgs: Msg[], tools: ToolDef[]): Promise<Reply> {
  const messages = msgs.map((m) => {
    if (m.role === "user") return { role: "user", content: m.text };
    if (m.role === "assistant")
      return {
        role: "assistant",
        content: [
          ...(m.text ? [{ type: "text", text: m.text }] : []),
          ...m.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} })),
        ],
      };
    return {
      role: "user",
      content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.output, is_error: r.isError })),
    };
  });
  const body = {
    model: o.model,
    max_tokens: MAX_TOKENS,
    ...(o.system ? { system: o.system } : {}),
    messages,
    ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
  };
  const headers = { "x-api-key": o.apiKey, "anthropic-version": "2023-06-01" };
  const r = AnthropicResponse.parse(await post(url(o.provider.baseUrl, "/v1/messages"), headers, body, o.apiKey, o.signal));
  return {
    text: r.content.flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join(""),
    calls: r.content.flatMap((b) =>
      b.type === "tool_use" && b.id && b.name ? [{ id: b.id, name: b.name, input: b.input }] : [],
    ),
    inputTokens: r.usage?.input_tokens,
    outputTokens: r.usage?.output_tokens,
  };
}

async function callOpenAI(o: CallOpts, msgs: Msg[], tools: ToolDef[]): Promise<Reply> {
  const messages: unknown[] = o.system ? [{ role: "system", content: o.system }] : [];
  for (const m of msgs) {
    if (m.role === "user") messages.push({ role: "user", content: m.text });
    else if (m.role === "assistant")
      messages.push({
        role: "assistant",
        content: m.text || null,
        ...(m.calls.length
          ? {
              tool_calls: m.calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
    else for (const r of m.results) messages.push({ role: "tool", tool_call_id: r.id, content: r.output });
  }
  const body = {
    model: o.model,
    messages,
    ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: t })) } : {}),
  };
  const headers = { authorization: `Bearer ${o.apiKey}` };
  const r = OpenAIResponse.parse(await post(url(o.provider.baseUrl, "/chat/completions"), headers, body, o.apiKey, o.signal));
  const msg = r.choices[0]!.message;
  return {
    text: msg.content ?? "",
    calls: (msg.tool_calls ?? []).map((c) => {
      let input: unknown;
      try {
        input = JSON.parse(c.function.arguments);
      } catch {
        input = { __invalid_json: c.function.arguments }; // surfaces as a tool argument error to the model
      }
      return { id: c.id, name: c.function.name, input };
    }),
    inputTokens: r.usage?.prompt_tokens,
    outputTokens: r.usage?.completion_tokens,
  };
}

export function callModel(o: CallOpts, msgs: Msg[], tools: ToolDef[]): Promise<Reply> {
  return o.provider.kind === "anthropic" ? callAnthropic(o, msgs, tools) : callOpenAI(o, msgs, tools);
}
