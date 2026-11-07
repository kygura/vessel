import type { z } from "zod";
import { errMsg, runCapture, spawnJsonl, type JsonlLine } from "../core/proc.ts";
import { type ProbeResult, RouterEvent } from "../core/types.ts";

export const IDLE_TIMEOUT_MS = 15 * 60_000;

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
  try {
    return parse(line.json);
  } catch (e) {
    return [{ type: "error", message: `parser failed: ${errMsg(e)}` }];
  }
}

/** JSON.parse + zod; undefined when the text is not JSON or does not match. */
export function parseJson<T>(schema: z.ZodType<T>, text: string): T | undefined {
  try {
    const r = schema.safeParse(JSON.parse(text));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** Invalid adapter output becomes an error event naming the offending field(s), never a crash. */
function validated(ev: RouterEvent): RouterEvent {
  const r = RouterEvent.safeParse(ev);
  if (r.success) return r.data;
  const fields = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
  return { type: "error", message: `invalid ${String((ev as { type?: unknown })?.type)} event: ${fields}` };
}

/**
 * Spawns the CLI and streams normalized events. Dedupes repeated `session` ids, fills a missing
 * `finalText` from the last text event, and guarantees exactly one trailing `done` 
 * (synthesized from the exit code when the CLI never sent one). `done` is held until the process exits and is
 * ok=false if any `error` event was seen or the exit code is non-zero. Every event is validated
 * against RouterEvent. The child is killed if the consumer stops early or no stdout line arrives
 * for `idleMs` (default 15 min).
 */
export async function* streamCli(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; signal?: AbortSignal; idleMs?: number },
  parse: ParseLine,
): AsyncGenerator<RouterEvent> {
  let proc: ReturnType<typeof spawnJsonl>;
  try {
    proc = spawnJsonl(argv, opts);
  } catch (e) {
    yield { type: "error", message: `spawn failed: ${errMsg(e)}` };
    yield { type: "done", ok: false };
    return;
  }
  try {
    yield* consume(proc, parse, opts.idleMs ?? IDLE_TIMEOUT_MS);
  } finally {
    proc.kill(); // no-op after a normal exit; stops the child on early return/throw
  }
}

async function* consume(proc: ReturnType<typeof spawnJsonl>, parse: ParseLine, idleMs: number): AsyncGenerator<RouterEvent> {
  let lastText: string | undefined;
  let session: string | undefined;
  let pendingDone: Extract<RouterEvent, { type: "done" }> | undefined;
  let failed = false;
  let idle = false;
  const it = proc.lines[Symbol.asyncIterator]();
  for (;;) {
    let timer: Timer | undefined;
    const next = await Promise.race([
      it.next(),
      new Promise<"idle">((r) => (timer = setTimeout(() => r("idle"), idleMs))),
    ]).finally(() => clearTimeout(timer));
    if (next === "idle") {
      idle = true;
      proc.kill();
      break;
    }
    if (next.done) break;
    for (const raw of lineEvents(next.value, parse)) {
      const ev = validated(raw);
      if (pendingDone) continue; // events after done are ignored
      if (ev.type === "session") {
        if (ev.id === session) continue;
        session = ev.id;
      } else if (ev.type === "text") {
        lastText = ev.text;
      } else if (ev.type === "error") {
        failed = true;
      } else if (ev.type === "done") {
        pendingDone = { ...ev, finalText: ev.finalText ?? lastText }; // held until the process has exited
        continue;
      }
      yield ev;
    }
  }
  const exit = await proc.exit;
  if (idle) {
    failed = true;
    yield { type: "error", message: `idle timeout: no output for ${Math.round(idleMs / 1000)}s` };
  } else if (exit.exitCode !== 0) {
    failed = true;
    yield { type: "error", message: `exit ${exit.exitCode ?? "signal"}: ${exit.stderrTail.trim()}` };
  }
  const base = pendingDone ?? { type: "done" as const, ok: true, finalText: lastText };
  yield { ...base, ok: base.ok && !failed };
}

/** `which` + auth check + optional model listing. `loggedIn` decides from a successful auth command. */
export async function probeCli(
  bin: string,
  authArgv: string[],
  loggedIn: (r: { exitCode: number | null; stdout: string }) => boolean,
  listModels?: () => Promise<ProbeResult["models"]>,
): Promise<ProbeResult> {
  if (!Bun.which(bin)) return { available: false, reason: "not installed", models: [] };
  const auth = await runCapture(authArgv, 5000);
  if (!loggedIn(auth)) return { available: false, reason: "not logged in", models: [] };
  return { available: true, models: listModels ? await listModels() : [] };
}
