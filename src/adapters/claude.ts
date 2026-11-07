import type { Adapter, RouterEvent, RunRequest } from "../core/types.ts";
import { z } from "zod";
import { clip, obj, parseJson, probeCli, streamCli } from "./common.ts";

const AuthStatus = z.object({ loggedIn: z.boolean() });
export const claudeLoggedIn = (stdout: string) => parseJson(AuthStatus, stdout)?.loggedIn === true;

const READ_DENY = "Edit Write Bash NotebookEdit";
const EDIT_TOOLS = "Read Edit Write Bash Glob Grep";

/** Claude Code `stream-json` event -> normalized events. Unknown types yield []. */
export function parseClaudeLine(json: unknown): RouterEvent[] {
  const e = obj(json);
  // session_id rides on every event; streamCli dedupes.
  const out: RouterEvent[] = typeof e.session_id === "string" ? [{ type: "session", id: e.session_id }] : [];
  switch (e.type) {
    case "assistant":
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b?.type === "text" && typeof b.text === "string") out.push({ type: "text", text: b.text });
        else if (b?.type === "tool_use")
          out.push({ type: "tool", name: String(b.name ?? "tool"), status: "started", input: clip(b.input) });
      }
      break;
    case "user":
      // tool_result blocks carry only tool_use_id, so the original tool name is not available here.
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b?.type === "tool_result")
          out.push({ type: "tool", name: "tool_result", status: b.is_error ? "failed" : "completed", output: clip(b.content) });
      }
      break;
    case "result": {
      const ok = e.is_error !== true && e.subtype === "success";
      out.push({
        type: "usage",
        inputTokens: e.usage?.input_tokens,
        outputTokens: e.usage?.output_tokens,
        costUsd: e.total_cost_usd,
      });
      if (!ok) out.push({ type: "error", message: String(e.result ?? e.subtype ?? "claude run failed") });
      out.push({ type: "done", ok, finalText: typeof e.result === "string" ? e.result : undefined });
      break;
    }
  }
  return out;
}

export function buildArgv(req: RunRequest, resumeId?: string): string[] {
  const argv = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--model", req.model, "--effort", req.effort];
  if (req.autonomy === "read") argv.push("--permission-mode", "plan", "--disallowedTools", READ_DENY);
  else if (req.autonomy === "edit") argv.push("--permission-mode", "acceptEdits", "--allowedTools", EDIT_TOOLS);
  else argv.push("--dangerously-skip-permissions");
  if (resumeId) argv.push("-r", resumeId);
  argv.push("--", req.prompt); // after `--` the prompt can never parse as a flag
  return argv;
}

const stream = (req: RunRequest, signal: AbortSignal, resumeId?: string) =>
  streamCli(buildArgv(req, resumeId), { cwd: req.cwd, signal }, parseClaudeLine);

export const claude: Adapter = {
  id: "claude",
  capabilities: { listModels: false },
  // The CLI has no model listing: models stay [] and the roster fills them from evidence aliases.
  probe: () =>
    probeCli("claude", ["claude", "auth", "status"], (r) => r.exitCode === 0 && claudeLoggedIn(r.stdout)),
  run: (req, signal) => stream(req, signal),
  resume: (id, req, signal) => stream(req, signal, id),
};
