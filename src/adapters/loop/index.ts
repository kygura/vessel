import type { z } from "zod";
import { type Config, type ProviderConfig, loadConfig } from "../../core/config.ts";
import { errMsg } from "../../core/proc.ts";
import type { Adapter, ModelRef, ProbeResult, RouterEvent, RunRequest } from "../../core/types.ts";
import { clip } from "../common.ts";
import { redact, runTool, toolsFor } from "./tools.ts";
import { type CallOpts, type Msg, callModel } from "./wire.ts";

export const DEFAULT_MAX_TURNS = 50;

type Resolved = { opts: CallOpts; secrets: string[] };

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Reason the provider config is unsafe, or undefined. Never echoes apiKeyEnv/baseUrl (may hold secrets). */
export function providerProblem(name: string, p: ProviderConfig): string | undefined {
  if (!ENV_NAME.test(p.apiKeyEnv)) return `provider "${name}": apiKeyEnv must be an env var name (A-Z, 0-9, _)`;
  let u: URL;
  try {
    u = new URL(p.baseUrl);
  } catch {
    return `provider "${name}": baseUrl is not a valid URL`;
  }
  if (u.username || u.password) return `provider "${name}": baseUrl must not contain credentials`;
  if (u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname))) return undefined;
  return `provider "${name}": baseUrl must be https or http on localhost/127.0.0.1/[::1]`;
}

/** Values of every validly-named apiKeyEnv that is set: redacted from errors and tool output. */
function secretsOf(config: Config): string[] {
  return Object.values(config.providers).flatMap((p) => (ENV_NAME.test(p.apiKeyEnv) && process.env[p.apiKeyEnv] ? [process.env[p.apiKeyEnv]!] : []));
}

/** Route model id is `<providerName>/<model>`; split on the first slash (models may contain slashes). */
function resolve(config: Config, routeModel: string): Resolved {
  const i = routeModel.indexOf("/");
  if (i <= 0 || i === routeModel.length - 1) throw new Error(`loop model must be "<provider>/<model>", got "${routeModel}"`);
  return resolveParts(config, routeModel.slice(0, i), routeModel.slice(i + 1));
}

function resolveParts(config: Config, providerName: string, model: string): Resolved {
  const provider: ProviderConfig | undefined = config.providers[providerName];
  if (!provider) throw new Error(`unknown loop provider "${providerName}"`);
  const problem = providerProblem(providerName, provider);
  if (problem) throw new Error(problem);
  const apiKey = process.env[provider.apiKeyEnv];
  if (!apiKey) throw new Error(`API key env ${provider.apiKeyEnv} unset`);
  const secrets = secretsOf(config);
  return { opts: { provider, apiKey, model, secrets }, secrets };
}

function systemPrompt(cwd: string, readOnly: boolean): string {
  return [
    "You are a coding agent working in a repository.",
    `Working directory: ${cwd}. All paths must stay inside it.`,
    readOnly ? "You are in read-only mode: you can only read files." : "Use the tools to inspect and change files.",
    "When the task is complete, reply with a short summary and no tool calls.",
  ].join("\n");
}

export function createLoopAdapter(opts: { maxTurns?: number } = {}): Adapter {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  return {
    id: "loop",
    capabilities: { listModels: true },

    async probe(): Promise<ProbeResult> {
      let config: Config;
      try {
        config = loadConfig();
      } catch (e) {
        return { available: false, reason: `invalid config: ${errMsg(e)}`, models: [] };
      }
      const entries = Object.entries(config.providers);
      if (!entries.length) return { available: false, reason: "no providers configured", models: [] };
      const models: ModelRef[] = [];
      const unset: string[] = [];
      for (const [name, p] of entries) {
        const problem = providerProblem(name, p);
        if (problem) unset.push(problem);
        else if (!process.env[p.apiKeyEnv]) unset.push(`API key env ${p.apiKeyEnv} unset`);
        else for (const m of p.models) models.push({ adapter: "loop", model: `${name}/${m}`, provider: name });
      }
      if (models.length) return { available: true, models };
      return { available: false, reason: unset.join("; ") || "no models configured", models };
    },

    async *run(req: RunRequest, signal: AbortSignal): AsyncIterable<RouterEvent> {
      let r: Resolved;
      try {
        r = resolve(loadConfig(), req.model);
      } catch (e) {
        yield { type: "error", message: errMsg(e) };
        yield { type: "done", ok: false };
        return;
      }
      const readOnly = req.autonomy === "read";
      const tools = toolsFor(req.autonomy);
      const call: CallOpts = { ...r.opts, system: systemPrompt(req.cwd, readOnly), signal };
      const msgs: Msg[] = [{ role: "user", text: req.prompt }];
      let lastText = "";

      for (let turn = 0; turn < maxTurns; turn++) {
        if (signal.aborted) break;
        let reply;
        try {
          reply = await callModel(call, msgs, tools);
        } catch (e) {
          yield { type: "error", message: signal.aborted ? "aborted" : errMsg(e) };
          yield { type: "done", ok: false, finalText: lastText || undefined };
          return;
        }
        yield { type: "usage", inputTokens: reply.inputTokens, outputTokens: reply.outputTokens };
        if (reply.text) {
          lastText = redact(reply.text, r.secrets);
          yield { type: "text", text: lastText };
        }
        msgs.push({ role: "assistant", text: reply.text, calls: reply.calls });
        if (!reply.calls.length) {
          yield { type: "done", ok: true, finalText: lastText };
          return;
        }
        const results = [];
        for (const c of reply.calls) {
          if (signal.aborted) break;
          const input = clip(redact(JSON.stringify(c.input) ?? "", r.secrets), 200);
          yield { type: "tool", name: c.name, status: "started", input };
          const res = await runTool(c.name, c.input, req.autonomy, { cwd: req.cwd, signal, secrets: r.secrets });
          yield { type: "tool", name: c.name, status: res.isError ? "failed" : "completed", input, output: clip(res.output) };
          results.push({ id: c.id, ...res });
        }
        msgs.push({ role: "tool", results });
      }
      yield { type: "error", message: signal.aborted ? "aborted" : `turn cap of ${maxTurns} reached` };
      yield { type: "done", ok: false, finalText: lastText || undefined };
    },
  };
}

export const loopAdapter = createLoopAdapter();

/**
 * One-shot, tool-less completion (used by the classifier's LLM fallback). The reply's outermost JSON
 * object is extracted and validated; throws on HTTP, abort, parse, or validation failure.
 */
export async function complete<T>(
  providerName: string,
  model: string,
  prompt: string,
  schema: z.ZodType<T>,
  o: { signal?: AbortSignal } = {},
): Promise<T> {
  const { opts } = resolveParts(loadConfig(), providerName, model);
  const system = "Reply with a single JSON object only, no prose or code fences.";
  const { text } = await callModel({ ...opts, system, signal: o.signal }, [{ role: "user", text: prompt }], []);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object in model reply");
  return schema.parse(JSON.parse(text.slice(start, end + 1)));
}
