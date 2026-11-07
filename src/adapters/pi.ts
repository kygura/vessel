import { runCapture, spawnJsonl, which } from "../core/proc.ts";
import type { Adapter, ModelRef, ProbeResult, RouterEvent, RunRequest } from "../core/types.ts";

export const PI_SANDBOX_NOTE = "pi has no sandbox at any autonomy level: tools run with your full user permissions";

const READ_TOOLS = "read,grep,find,ls";
const EDIT_TOOLS = "read,edit,write,bash,grep,find,ls";

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined ? undefined : JSON.stringify(v));
const clip = (s: string | undefined) => (s && s.length > 500 ? `${s.slice(0, 500)}...` : s);

/** Native pi `--mode json` line -> normalized events. Unknown or malformed shapes yield []. */
export function parsePiLine(json: unknown): RouterEvent[] {
  if (!isObj(json)) return [];
  switch (json.type) {
    case "session":
      return typeof json.id === "string" ? [{ type: "session", id: json.id }] : [];
    case "message_end": {
      const m = json.message;
      if (!isObj(m) || m.role !== "assistant") return [];
      const out: RouterEvent[] = [];
      const text = Array.isArray(m.content)
        ? m.content.filter((c) => isObj(c) && c.type === "text" && typeof c.text === "string").map((c) => c.text).join("")
        : "";
      if (text) out.push({ type: "text", text });
      const u = m.usage;
      if (isObj(u)) {
        out.push({
          type: "usage",
          inputTokens: typeof u.input === "number" ? u.input : undefined,
          outputTokens: typeof u.output === "number" ? u.output : undefined,
          costUsd: isObj(u.cost) && typeof u.cost.total === "number" ? u.cost.total : undefined,
        });
      }
      if (m.stopReason === "error") out.push({ type: "error", message: str(m.errorMessage) ?? "pi reported an error" });
      return out;
    }
    case "tool_execution_start":
      return [{ type: "tool", name: str(json.toolName) ?? "tool", status: "started", input: clip(str(json.args)) }];
    case "tool_execution_end":
      return [
        {
          type: "tool",
          name: str(json.toolName) ?? "tool",
          status: json.isError === true ? "failed" : "completed",
          output: clip(str(json.result)),
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

async function* stream(argv: string[], cwd: string, signal: AbortSignal): AsyncGenerator<RouterEvent> {
  let proc: ReturnType<typeof spawnJsonl>;
  try {
    proc = spawnJsonl(argv, { cwd, signal });
  } catch (e) {
    yield { type: "error", message: `failed to spawn pi: ${e}` };
    yield { type: "done", ok: false };
    return;
  }
  let last: string | undefined;
  let failed = false;
  let done = false;
  for await (const l of proc.lines) {
    const evs: RouterEvent[] =
      l.json === undefined ? [{ type: "error", message: `malformed pi output: ${l.raw.slice(0, 200)}` }] : parsePiLine(l.json);
    for (const ev of evs) {
      if (done) continue;
      if (ev.type === "text") last = ev.text;
      if (ev.type === "error") failed = true;
      if (ev.type === "done") {
        done = true;
        yield { type: "done", ok: ev.ok && !failed, finalText: ev.finalText ?? last };
      } else yield ev;
    }
  }
  const exit = await proc.exit;
  if (!done) {
    const ok = exit.exitCode === 0 && !failed;
    if (!ok && !failed) yield { type: "error", message: `pi exited with code ${exit.exitCode}: ${exit.stderrTail.trim()}` };
    yield { type: "done", ok, finalText: last };
  }
}

export function createPiAdapter(bin = "pi"): Adapter {
  return {
    id: "pi",
    capabilities: { resume: true, cost: true, listModels: true },
    async probe(): Promise<ProbeResult> {
      if (!which(bin)) return { available: false, reason: "pi not found on PATH", models: [] };
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
