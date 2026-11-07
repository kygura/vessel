import type { Adapter, ModelRef, RouterEvent, RunRequest } from "../core/types.ts";
import { runCapture } from "../core/proc.ts";
import { clip, obj, probeCli, streamCli } from "./common.ts";

/** Codex `exec --json` event -> normalized events. Final answer text is filled from the last agent_message by streamCli. */
export function parseCodexLine(json: unknown): RouterEvent[] {
  const e = obj(json);
  const item = obj(e.item);
  switch (e.type) {
    case "thread.started":
      return typeof e.thread_id === "string" ? [{ type: "session", id: e.thread_id }] : [];
    case "item.started":
    case "item.completed": {
      const done = e.type === "item.completed";
      switch (item.type) {
        case "agent_message":
          return done && typeof item.text === "string" ? [{ type: "text", text: item.text }] : [];
        case "command_execution": {
          const failed = done && (item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0));
          return [{
            type: "tool",
            name: "command_execution",
            status: !done ? "started" : failed ? "failed" : "completed",
            input: clip(item.command),
            output: done ? clip(item.aggregated_output) : undefined,
          }];
        }
        case "file_change":
        case "web_search":
          return [{ type: "tool", name: item.type, status: done ? (item.status === "failed" ? "failed" : "completed") : "started", input: clip(item.changes ?? item.query) }];
        case "mcp_tool_call":
          return [{ type: "tool", name: `${item.server ?? "mcp"}.${item.tool ?? "tool"}`, status: !done ? "started" : item.status === "failed" ? "failed" : "completed", input: clip(item.arguments) }];
        case "error":
          return done ? [{ type: "error", message: String(item.message ?? "codex item error") }] : [];
        default:
          return [];
      }
    }
    case "turn.completed":
      return [
        { type: "usage", inputTokens: e.usage?.input_tokens, outputTokens: e.usage?.output_tokens },
        { type: "done", ok: true },
      ];
    case "turn.failed":
      return [{ type: "error", message: String(e.error?.message ?? "turn failed") }, { type: "done", ok: false }];
    case "error":
      return [{ type: "error", message: String(e.message ?? "codex error") }];
    default:
      return [];
  }
}

export function buildArgv(req: RunRequest, resumeId?: string): string[] {
  const argv = ["codex", "exec", "--json", "-C", req.cwd, "--skip-git-repo-check", "-m", req.model, "-c", `model_reasoning_effort="${req.effort}"`];
  if (req.autonomy === "read") argv.push("-s", "read-only");
  else if (req.autonomy === "edit") argv.push("-s", "workspace-write");
  else argv.push("--dangerously-bypass-approvals-and-sandbox");
  // Flags go before `resume`: only some of them are accepted by the subcommand itself.
  if (resumeId) argv.push("resume", resumeId);
  argv.push("--", req.prompt);
  return argv;
}

const stream = (req: RunRequest, signal: AbortSignal, resumeId?: string) =>
  streamCli(buildArgv(req, resumeId), { cwd: req.cwd, signal }, parseCodexLine);

async function listModels(): Promise<ModelRef[]> {
  const r = await runCapture(["codex", "debug", "models"], 5000);
  try {
    const models: any[] = JSON.parse(r.stdout).models ?? [];
    return models
      .filter((m) => typeof m?.slug === "string" && m.visibility !== "hide")
      .map((m) => ({ adapter: "codex" as const, model: m.slug }));
  } catch {
    return [];
  }
}

export const codex: Adapter = {
  id: "codex",
  capabilities: { resume: true, cost: false, listModels: true },
  probe: () => probeCli("codex", ["codex", "login", "status"], (r) => r.exitCode === 0, listModels),
  run: (req, signal) => stream(req, signal),
  resume: (id, req, signal) => stream(req, signal, id),
};
