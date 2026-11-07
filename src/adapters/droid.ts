import { runCapture, which } from "../core/proc.ts";
import type { Adapter, ModelRef, ProbeResult, RouterEvent, RunRequest } from "../core/types.ts";
import { clip, obj, streamCli } from "./common.ts";

const first = (...vs: unknown[]) => vs.find((v) => v !== undefined && v !== null);

/**
 * Native `droid exec -o stream-json` line -> normalized events.
 * Field names are unverified (see docs/cli-contracts.md), so every field is optional.
 * `session_id` on any line yields a `session` event; callers dedupe.
 */
export function parseDroidLine(raw: unknown): RouterEvent[] {
  const json = obj(raw);
  const out: RouterEvent[] = [];
  if (typeof json.session_id === "string") out.push({ type: "session", id: json.session_id });
  switch (json.type) {
    case "message": {
      const text = first(json.text, typeof json.content === "string" ? json.content : undefined);
      if (json.role === "assistant" && typeof text === "string" && text) out.push({ type: "text", text });
      break;
    }
    case "tool_call":
      out.push({
        type: "tool",
        name: clip(first(json.toolName, json.tool_name, json.name)) ?? "tool",
        status: "started",
        input: clip(first(json.parameters, json.input, json.args)),
      });
      break;
    case "tool_result":
      out.push({
        type: "tool",
        name: clip(first(json.toolName, json.tool_name, json.name)) ?? "tool",
        status: json.isError === true ? "failed" : "completed",
        output: clip(first(json.content, json.value, json.result)),
      });
      break;
    case "error": {
      const e = json.error;
      out.push({ type: "error", message: clip(e?.message ?? e ?? json.message) ?? "droid reported an error" });
      break;
    }
    case "completion": {
      const u = json.usage;
      if (u && typeof u === "object") {
        const n = (v: unknown) => (typeof v === "number" ? v : undefined);
        out.push({ type: "usage", inputTokens: n(first(u.input_tokens, u.inputTokens)), outputTokens: n(first(u.output_tokens, u.outputTokens)) });
      }
      const finalText = first(json.finalText, json.final_text, json.result);
      out.push({ type: "done", ok: json.isError !== true && json.is_error !== true, finalText: typeof finalText === "string" ? finalText : undefined });
      break;
    }
  }
  return out;
}

export function buildDroidArgv(req: RunRequest, bin = "droid", sessionId?: string): string[] {
  const autonomy = req.autonomy === "full" ? ["--skip-permissions-unsafe"] : req.autonomy === "edit" ? ["--auto", "medium"] : [];
  return [
    bin, "exec", "-o", "stream-json", "-m", req.model, "-r", req.effort, "--cwd", req.cwd,
    ...autonomy,
    ...(sessionId ? ["-s", sessionId] : []),
    "--", req.prompt,
  ];
}

/** Parses the "Available built-in models:" block (comma list, possibly on the next line) printed for an invalid model. */
export function parseDroidModels(text: string): ModelRef[] {
  const m = text.match(/available built-in models:?([^\n]*(?:\n[ \t]+[^\n]+)?)/i);
  return (m?.[1] ?? "")
    .split(/[,\s]+/)
    .map((x) => x.replace(/[.;]+$/, ""))
    .filter(Boolean)
    .map((model) => ({ adapter: "droid" as const, model }));
}

const stream = (argv: string[], cwd: string, signal: AbortSignal) => streamCli(argv, { cwd, signal }, parseDroidLine);

export function createDroidAdapter(bin = "droid", env: Record<string, string | undefined> = process.env): Adapter {
  return {
    id: "droid",
    capabilities: { resume: true, cost: false, listModels: true },
    async probe(): Promise<ProbeResult> {
      if (!which(bin)) return { available: false, reason: "droid not found on PATH", models: [] };
      // An invalid model makes droid print its built-in model list and exit before auth.
      const r = await runCapture([bin, "exec", "-m", "__router_probe__", "x"], 5000);
      const models = parseDroidModels(`${r.stdout}\n${r.stderr}`);
      // Auth state is not queryable; FACTORY_API_KEY is the only signal we have.
      if (!env.FACTORY_API_KEY) return { available: false, reason: "not logged in (FACTORY_API_KEY unset)", models };
      return { available: true, models };
    },
    run: (req, signal) => stream(buildDroidArgv(req, bin), req.cwd, signal),
    resume: (id, req, signal) => stream(buildDroidArgv(req, bin, id), req.cwd, signal),
  };
}

export const droidAdapter = createDroidAdapter();
