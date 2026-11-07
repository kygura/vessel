import { runCapture } from "../core/proc.ts";
import type { Adapter, ModelRef, ProbeResult, RouterEvent, RunRequest } from "../core/types.ts";
import { clip, obj, streamCli } from "./common.ts";

export const PI_SANDBOX_NOTE = "pi has no sandbox at any autonomy level: tools run with your full user permissions";

const READ_TOOLS = "read,grep,find,ls";
const EDIT_TOOLS = "read,edit,write,bash,grep,find,ls";

const name = (v: unknown) => (typeof v === "string" ? v : "tool");

/** Native pi `--mode json` line -> normalized events. Unknown or malformed shapes yield []. */
export function parsePiLine(raw: unknown): RouterEvent[] {
  const json = obj(raw);
  switch (json.type) {
    case "session":
      return typeof json.id === "string" ? [{ type: "session", id: json.id }] : [];
    case "message_end": {
      const m = json.message;
      if (m?.role !== "assistant") return [];
      const out: RouterEvent[] = [];
      const text = Array.isArray(m.content)
        ? m.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("")
        : "";
      if (text) out.push({ type: "text", text });
      const u = m.usage;
      if (u && typeof u === "object") {
        out.push({
          type: "usage",
          inputTokens: typeof u.input === "number" ? u.input : undefined,
          outputTokens: typeof u.output === "number" ? u.output : undefined,
          costUsd: typeof u.cost?.total === "number" ? u.cost.total : undefined,
        });
      }
      if (m.stopReason === "error") out.push({ type: "error", message: clip(m.errorMessage) ?? "pi reported an error" });
      return out;
    }
    case "tool_execution_start":
      return [{ type: "tool", name: name(json.toolName), status: "started", input: clip(json.args) }];
    case "tool_execution_end":
      return [
        {
          type: "tool",
          name: name(json.toolName),
          status: json.isError === true ? "failed" : "completed",
          output: clip(json.result),
        },
      ];
    case "agent_settled":
      return [{ type: "done", ok: json.aborted !== true }];
    default:
      return [];
  }
}

export function buildPiArgv(req: RunRequest, bin = "pi", sessionId?: string): string[] {
  return [
    bin,
    "-p",
    "--mode",
    "json",
    "--model",
    req.model,
    "--thinking",
    req.effort,
    "--tools",
    req.autonomy === "read" ? READ_TOOLS : EDIT_TOOLS,
    ...(sessionId ? ["--session", sessionId] : []),
    "--",
    req.prompt,
  ];
}

/** Parses `pi --list-models` table (header: provider model ...). Empty or "No models" text -> []. */
export function parsePiModels(text: string): ModelRef[] {
  const rows = text.split("\n").map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 2);
  const header = rows.findIndex((c) => c[0] === "provider" && c[1] === "model");
  if (header < 0) return [];
  return rows.slice(header + 1).map(([provider, id]) => ({ adapter: "pi" as const, model: `${provider}/${id}`, provider }));
}

const stream = (argv: string[], cwd: string, signal: AbortSignal) => streamCli(argv, { cwd, signal }, parsePiLine);

export function createPiAdapter(bin = "pi"): Adapter {
  return {
    id: "pi",
    capabilities: { listModels: true },
    async probe(): Promise<ProbeResult> {
      if (!Bun.which(bin)) return { available: false, reason: "not installed", models: [] };
      const r = await runCapture([bin, "--list-models"], 5000);
      const models = parsePiModels(r.stdout);
      if (models.length === 0)
        return { available: false, reason: r.timedOut ? "pi --list-models timed out" : "no models available (run pi and /login)", models };
      return { available: true, models };
    },
    run: (req, signal) => stream(buildPiArgv(req, bin), req.cwd, signal),
    resume: (id, req, signal) => stream(buildPiArgv(req, bin, id), req.cwd, signal),
  };
}

export const piAdapter = createPiAdapter();
