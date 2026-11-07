import type { Adapter, ModelRef, RouterEvent, RunRequest } from "../core/types.ts";
import { runCapture } from "../core/proc.ts";
import { clip, obj, probeCli, streamCli } from "./common.ts";

/** OpenCode `run --format json` event -> normalized events. `session` repeats on every line; streamCli dedupes. */
export function parseOpencodeLine(json: unknown): RouterEvent[] {
  const e = obj(json);
  const part = obj(e.part);
  const out: RouterEvent[] = [];
  if (typeof e.sessionID === "string") out.push({ type: "session", id: e.sessionID });
  switch (e.type) {
    case "text":
      if (typeof part.text === "string") out.push({ type: "text", text: part.text });
      break;
    case "tool_use": {
      const st = obj(part.state);
      out.push({
        type: "tool",
        name: String(part.tool ?? "tool"),
        status: st.status === "completed" ? "completed" : st.status === "error" ? "failed" : "started",
        input: clip(st.input),
        output: clip(st.output ?? st.error),
      });
      break;
    }
    case "step_finish":
      out.push({
        type: "usage",
        inputTokens: part.tokens?.input,
        outputTokens: part.tokens?.output,
        costUsd: part.cost,
      });
      break;
    case "error": {
      const err = obj(e.error);
      out.push({ type: "error", message: String(err.message ?? err.name ?? "opencode error") });
      break;
    }
  }
  return out;
}

/** req.model is `provider/model`; effort becomes the `#variant` suffix. */
export function buildArgv(req: RunRequest, resumeId?: string): string[] {
  const argv = ["opencode", "run", req.prompt, "--format", "json", "-m", `${req.model}#${req.effort}`];
  if (req.autonomy === "edit") argv.push("--auto");
  else if (req.autonomy === "full") argv.push("--dangerously-skip-permissions");
  // read: no flag; permission requests are auto-rejected.
  if (resumeId) argv.push("-s", resumeId);
  return argv;
}

const stream = (req: RunRequest, signal: AbortSignal, resumeId?: string) =>
  streamCli(buildArgv(req, resumeId), { cwd: req.cwd, env: { ...process.env, PWD: req.cwd }, signal }, parseOpencodeLine);

async function listModels(): Promise<ModelRef[]> {
  const r = await runCapture(["opencode", "models"], 5000);
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("/"))
    .map((l) => ({ adapter: "opencode" as const, model: l, provider: l.slice(0, l.indexOf("/")) }));
}

export const opencode: Adapter = {
  id: "opencode",
  capabilities: { resume: true, cost: true, listModels: true },
  probe: () =>
    probeCli(
      "opencode",
      ["opencode", "auth", "list", "--format", "json"],
      (r) => {
        if (r.exitCode !== 0) return false;
        try {
          const j = JSON.parse(r.stdout);
          return Array.isArray(j) ? j.length > 0 : Object.keys(obj(j)).length > 0;
        } catch {
          return r.stdout.trim().length > 0;
        }
      },
      listModels,
    ),
  run: (req, signal) => stream(req, signal),
  resume: (id, req, signal) => stream(req, signal, id),
};
