import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { Evidence } from "../core/config.ts";
import { routerPaths } from "../core/paths.ts";
import { AdapterId, ModelRef, type Adapter, type ProbeResult } from "../core/types.ts";

export interface Roster { routes: ModelRef[]; unavailable: { adapter: AdapterId; reason: string }[] }

const CACHE_TTL_MS = 10 * 60_000;
/** CLI adapters with no model-list command borrow evidence entries of this provider. */
const PROVIDER_OF: Partial<Record<AdapterId, string>> = { claude: "anthropic", codex: "openai" };

const Cache = z.object({
  ts: z.number(),
  adapters: z.array(AdapterId),
  routes: z.array(ModelRef),
  unavailable: z.array(z.object({ adapter: AdapterId, reason: z.string() })),
});

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("probe timed out")), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function readCache(path: string, ids: string[], now: number): Roster | undefined {
  if (!existsSync(path)) return;
  try {
    const c = Cache.parse(JSON.parse(readFileSync(path, "utf8")));
    if (now - c.ts < CACHE_TTL_MS && [...c.adapters].sort().join() === ids.join()) return { routes: c.routes, unavailable: c.unavailable };
  } catch { /* corrupt cache: re-probe */ }
}

export async function buildRoster(
  adapters: Adapter[],
  o: { evidence: Evidence; useCache?: boolean; now?: number; timeoutMs?: number },
): Promise<Roster> {
  const { evidence, useCache = true, now = Date.now(), timeoutMs = 8000 } = o;
  const cachePath = routerPaths().roster;
  const ids = adapters.map((a) => a.id).sort();
  if (useCache) {
    const hit = readCache(cachePath, ids, now);
    if (hit) return hit;
  }

  const probed = await Promise.all(adapters.map(async (a): Promise<ProbeResult> => {
    try {
      return await withTimeout(a.probe(), timeoutMs);
    } catch (e) {
      return { available: false, reason: e instanceof Error ? e.message : String(e), models: [] };
    }
  }));

  const roster: Roster = { routes: [], unavailable: [] };
  adapters.forEach((a, i) => {
    const p = probed[i]!;
    let models = p.models;
    const provider = PROVIDER_OF[a.id];
    if (p.available && !models.length && !a.capabilities.listModels && provider) {
      models = Object.entries(evidence.models)
        .filter(([, m]) => m.provider === provider)
        .map(([model]) => ({ adapter: a.id, model, provider }));
    }
    if (!p.available) roster.unavailable.push({ adapter: a.id, reason: p.reason ?? "unavailable" });
    else if (!models.length) roster.unavailable.push({ adapter: a.id, reason: p.reason ?? "no models" });
    else roster.routes.push(...models);
  });

  writeFileSync(cachePath, JSON.stringify({ ts: now, adapters: ids, ...roster }));
  return roster;
}
