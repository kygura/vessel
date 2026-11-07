import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { z } from "zod";
import { routerPaths } from "./core/paths.ts";
import { Outcome, RouterEvent, SessionRecord } from "./core/types.ts";

/**
 * One file per session: `sessions/<id>.jsonl`. Lines are either a `record` (last one wins, so the
 * route can be updated after a fallback) or a timestamped `event`. Native session id and outcome
 * are derived on read from the log and from outcomes.jsonl, so there is a single source of truth.
 */
const Line = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("record"), record: SessionRecord }),
  z.object({ kind: z.literal("event"), ts: z.string(), event: RouterEvent }),
]);
type Line = z.infer<typeof Line>;

/** `keep` skips JSON.parse for lines that cannot matter (listing never parses the bulk of a log). */
const readJsonl = <T>(path: string, schema: z.ZodType<T>, keep: (raw: string) => boolean = () => true): T[] => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return []; // missing file
  }
  const out: T[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim() || !keep(raw)) continue;
    try {
      const r = schema.safeParse(JSON.parse(raw));
      if (r.success) out.push(r.data);
    } catch { /* skip torn line */ }
  }
  return out;
};
const append = (path: string, v: unknown) => appendFileSync(path, `${JSON.stringify(v)}\n`);

export function createSession(init: Omit<SessionRecord, "id" | "createdAt">): SessionRecord {
  const record: SessionRecord = { ...init, id: crypto.randomUUID().slice(0, 8), createdAt: new Date().toISOString() };
  saveSession(record);
  return record;
}

export const saveSession = (record: SessionRecord) =>
  append(routerPaths().sessionLog(record.id), { kind: "record", record } satisfies Line);

export const appendEvent = (id: string, event: RouterEvent) =>
  append(routerPaths().sessionLog(id), { kind: "event", ts: new Date().toISOString(), event } satisfies Line);

export function readEvents(id: string): { ts: string; event: RouterEvent }[] {
  return readJsonl(routerPaths().sessionLog(id), Line).flatMap((l) => (l.kind === "event" ? [{ ts: l.ts, event: l.event }] : []));
}

/** All outcomes, one per session: a later line with the same sessionId supersedes earlier ones. */
export function readOutcomes(): Outcome[] {
  const by = new Map<string, Outcome>();
  for (const o of readJsonl(routerPaths().outcomes, Outcome)) {
    by.delete(o.sessionId);
    by.set(o.sessionId, o);
  }
  return [...by.values()];
}

export const appendOutcome = (o: Outcome) => append(routerPaths().outcomes, o);

function load(id: string, outcomes: Outcome[]): SessionRecord | undefined {
  // only record lines and native-session events matter here
  const lines = readJsonl(routerPaths().sessionLog(id), Line, (raw) => raw.startsWith('{"kind":"record"') || raw.includes('"event":{"type":"session"'));
  const at = lines.findLastIndex((l) => l.kind === "record");
  if (at < 0) return;
  // Native id = last `session` event after the final route record, so a failed route's id (or another adapter's) is never reused.
  const native = lines.slice(at + 1).findLast((l) => l.kind === "event" && l.event.type === "session");
  const outcome = outcomes.find((o) => o.sessionId === id);
  return {
    ...(lines[at] as Extract<Line, { kind: "record" }>).record,
    nativeSessionId: native?.kind === "event" && native.event.type === "session" ? native.event.id : undefined,
    result: outcome?.result,
    costUsd: outcome?.costUsd,
  };
}

const ids = () => readdirSync(routerPaths().sessions).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));

/** Exact id, or a unique prefix of one. */
export function getSession(idOrPrefix: string): SessionRecord | undefined {
  const all = ids();
  const id = all.includes(idOrPrefix) ? idOrPrefix : (() => { const m = all.filter((i) => i.startsWith(idOrPrefix)); return m.length === 1 ? m[0]! : undefined; })();
  return id ? load(id, readOutcomes()) : undefined;
}

/** Newest first. */
export function listSessions(): SessionRecord[] {
  const outcomes = readOutcomes();
  return ids().flatMap((id) => load(id, outcomes) ?? []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
