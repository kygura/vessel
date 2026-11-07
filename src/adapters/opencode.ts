import type { Adapter, ModelRef, RouterEvent, RunRequest } from "../core/types.ts";
import { runCapture } from "../core/proc.ts";
import { z } from "zod";
import { clip, obj, parseJson, probeCli, streamCli } from "./common.ts";

/** `auth list --format json`: an array or an object keyed by provider; non-empty = logged in somewhere. */
const AuthList = z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]);
export function opencodeHasAuth(stdout: string): boolean {
  const t = stdout.trim();
  if (!/^[[{]/.test(t)) return t.length > 0; // older versions print a text table
  const j = parseJson(AuthList, t);
  return j !== undefined && Object.keys(j).length > 0;
}

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
  const argv = ["opencode", "run", "--format", "json", "-m", `${req.model}#${req.effort}`];
  if (req.autonomy === "edit") argv.push("--auto");
  else if (req.autonomy === "full") argv.push("--dangerously-skip-permissions");
  // read: no flag; writes are denied by buildEnv's inline config.
  if (resumeId) argv.push("-s", resumeId);
  argv.push("--", req.prompt);
  return argv;
}

/**
 * PWD follows cwd. `read` injects an explicit deny for edit (covers write/patch) and bash via inline config;
 * shape from opencode packages/web/src/content/docs/permissions.mdx, loaded by packages/core/src/config.ts (OPENCODE_CONFIG_CONTENT).
 */
export function buildEnv(req: RunRequest): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, PWD: req.cwd };
  if (req.autonomy === "read") env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: { edit: "deny", bash: "deny" } });
  return env;
}

const stream = (req: RunRequest, signal: AbortSignal, resumeId?: string) =>
  streamCli(buildArgv(req, resumeId), { cwd: req.cwd, env: buildEnv(req), signal }, parseOpencodeLine);

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
  capabilities: { listModels: true },
  probe: () =>
    probeCli(
      "opencode",
      ["opencode", "auth", "list", "--format", "json"],
      (r) => {
        if (r.exitCode !== 0) return false;
        return opencodeHasAuth(r.stdout);
      },
      listModels,
    ),
  run: (req, signal) => stream(req, signal),
  resume: (id, req, signal) => stream(req, signal, id),
};
