import { spawnJsonl, runCapture, which, type JsonlLine } from "../core/proc.ts";
import type { ProbeResult, RouterEvent } from "../core/types.ts";

export type ParseLine = (json: unknown) => RouterEvent[];

export const obj = (v: unknown): Record<string, any> =>
  v && typeof v === "object" ? (v as Record<string, any>) : {};

export const clip = (v: unknown, n = 500): string | undefined => {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** Malformed line (no parsed json) becomes one error event; otherwise delegates to the adapter parser. */
export function lineEvents(line: JsonlLine, parse: ParseLine): RouterEvent[] {
  if (line.json === undefined) return [{ type: "error", message: `malformed output line: ${clip(line.raw, 200)}` }];
  return parse(line.json);
}

/**
 * Spawns the CLI and streams normalized events. Dedupes repeated `session` ids, fills a missing
 * `finalText` from the last text event, and guarantees exactly one trailing `done`
 * (synthesized from the exit code when the CLI never sent one).
 */
export async function* streamCli(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal },
  parse: ParseLine,
): AsyncGenerator<RouterEvent> {
  let proc: ReturnType<typeof spawnJsonl>;
  try {
    proc = spawnJsonl(argv, opts);
  } catch (e) {
    yield { type: "error", message: `spawn failed: ${String(e)}` };
    yield { type: "done", ok: false };
    return;
  }
  let lastText: string | undefined;
  let session: string | undefined;
  let done = false;
  for await (const line of proc.lines) {
    for (const ev of lineEvents(line, parse)) {
      if (done) continue;
      if (ev.type === "session") {
        if (ev.id === session) continue;
        session = ev.id;
      } else if (ev.type === "text") {
        lastText = ev.text;
      } else if (ev.type === "done") {
        done = true;
        yield { ...ev, finalText: ev.finalText ?? lastText };
        continue;
      }
      yield ev;
    }
  }
  const exit = await proc.exit;
  if (!done) {
    const ok = exit.exitCode === 0;
    if (!ok) yield { type: "error", message: `exit ${exit.exitCode ?? "signal"}: ${exit.stderrTail.trim()}` };
    yield { type: "done", ok, finalText: lastText };
  }
}

/** `which` + auth check + optional model listing. `loggedIn` decides from a successful auth command. */
export async function probeCli(
  bin: string,
  authArgv: string[],
  loggedIn: (r: { exitCode: number | null; stdout: string }) => boolean,
  listModels?: () => Promise<ProbeResult["models"]>,
): Promise<ProbeResult> {
  if (!which(bin)) return { available: false, reason: "not installed", models: [] };
  const auth = await runCapture(authArgv, 5000);
  if (!loggedIn(auth)) return { available: false, reason: "not logged in", models: [] };
  return { available: true, models: listModels ? await listModels() : [] };
}
