import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { Config, type Evidence } from "../core/config.ts";
import { routerPaths } from "../core/paths.ts";
import { AdapterId, ModelRef, type Adapter, type ProbeResult } from "../core/types.ts";

export interface Roster { routes: ModelRef[]; unavailable: { adapter: AdapterId; reason: string }[] }

const CACHE_TTL_MS = 10 * 60_000;
/** CLI adapters with no model-list command borrow evidence entries of this provider. Evidence aliases are only name resolution (see evaluate.resolve), never extra routes. */
const PROVIDER_OF: Partial<Record<AdapterId, string>> = { claude: "anthropic" };

const Cache = z.object({
  ts: z.number(),
  key: z.string(),
  routes: z.array(ModelRef),
  unavailable: z.array(z.object({ adapter: AdapterId, reason: z.string() })),
});

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("probe timed out")), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Config content + which provider API keys are set: either changing invalidates the cached loop routes. */
function configKey(configPath: string): string {
  try {
    const text = readFileSync(configPath, "utf8");
    const envs = Object.values(Config.parse(JSON.parse(text)).providers).map((p) => p.apiKeyEnv).filter((e) => process.env[e]).sort();
    return `${Bun.hash(text)}:${envs.join()}`;
  } catch {
    return "none"; // missing or invalid config: loop probe reports it itself
  }
}

function readCache(path: string, key: string, now: number): Roster | undefined {
  try {
    const c = Cache.parse(JSON.parse(readFileSync(path, "utf8")));
    if (now - c.ts < CACHE_TTL_MS && c.key === key) return { routes: c.routes, unavailable: c.unavailable };
  } catch { /* corrupt cache: re-probe */ }
}

export async function buildRoster(
  adapters: Adapter[],
  o: { evidence: Evidence; useCache?: boolean; now?: number; timeoutMs?: number },
): Promise<Roster> {
  const { evidence, useCache = true, now = Date.now(), timeoutMs = 12_000 } = o;
  const cachePath = routerPaths().roster;
  // key: adapter set + evidence ids of the providers used to fill model lists
  const fillProviders = new Set(Object.values(PROVIDER_OF));
  const fillIds = Object.entries(evidence.models).filter(([, m]) => fillProviders.has(m.provider)).map(([id]) => id).sort();
  const key = `${adapters.map((a) => a.id).sort().join()}|${Bun.hash(fillIds.join())}|${configKey(routerPaths().config)}`;
  if (useCache) {
    const hit = readCache(cachePath, key, now);
    if (hit) return hit;
  }

  let failed = false; // a timeout/throw is transient: don't cache it for 10 minutes
  const probed = await Promise.all(adapters.map(async (a): Promise<ProbeResult> => {
    try {
      return await withTimeout(a.probe(), timeoutMs);
    } catch (e) {
      failed = true;
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

  if (!failed) {
    try {
      writeFileSync(cachePath, JSON.stringify({ ts: now, key, ...roster }));
    } catch { /* the cache is optional (read-only home etc.) */ }
  }
  return roster;
}
