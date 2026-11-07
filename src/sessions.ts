import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
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

const readJsonl = <T>(path: string, schema: z.ZodType<T>): T[] => {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw.trim()) continue;
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
  const lines = readJsonl(routerPaths().sessionLog(id), Line);
  const record = lines.findLast((l) => l.kind === "record")?.record;
  if (!record) return;
  const native = lines.findLast((l) => l.kind === "event" && l.event.type === "session");
  const outcome = outcomes.find((o) => o.sessionId === id);
  return {
    ...record,
    nativeSessionId: native?.kind === "event" && native.event.type === "session" ? native.event.id : record.nativeSessionId,
    result: outcome?.result ?? record.result,
    costUsd: outcome?.costUsd ?? record.costUsd,
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
