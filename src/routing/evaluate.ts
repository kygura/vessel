import type { Evidence } from "../core/config.ts";
import type { AdapterId, Effort, ModelRef, Outcome, Route, Tier } from "../core/types.ts";

export interface Candidate {
  route: Route;
  score: number;
  prior: number;
  local: number;
  runs: number;
  costNorm: number;
  latencyNorm: number;
  explored?: boolean;
}
export interface Lambdas { cost: Record<Tier, number>; latency: Record<Tier, number> }
export interface Pins { adapter?: AdapterId; model?: string; effort?: Effort }

export const LAMBDAS: Lambdas = {
  cost: { trivial: 0.4, standard: 0.15, hard: 0.02 },
  latency: { trivial: 0.1, standard: 0.05, hard: 0 },
};
export const EFFORT: Record<Tier, Effort> = { trivial: "low", standard: "medium", hard: "high" };

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
/** Min-max over the candidate set; a flat set normalizes to 0. */
const minMax = (xs: number[]) => {
  const lo = Math.min(...xs), hi = Math.max(...xs);
  return xs.map((x) => (hi === lo ? 0 : (x - lo) / (hi - lo)));
};

export function rank(
  routes: ModelRef[],
  tier: Tier,
  o: { evidence: Evidence; outcomes: Outcome[]; rng?: () => number; pins?: Pins; lambda?: Lambdas },
): Candidate[] {
  const { evidence, pins = {}, lambda = LAMBDAS, rng = Math.random } = o;
  const resolve = (m: string) => evidence.aliases[m] ?? m;
  const effort = pins.effort ?? EFFORT[tier];

  const refs = routes.filter((r) => (!pins.adapter || r.adapter === pins.adapter) && (!pins.model || resolve(r.model) === resolve(pins.model)));
  if (!refs.length) return [];

  // later line with the same sessionId supersedes earlier ones
  const bySession = new Map<string, Outcome>();
  for (const out of o.outcomes) bySession.set(out.sessionId, out);
  const forTier = [...bySession.values()].filter((x) => x.tier === tier);
  const mine = (r: ModelRef) => forTier.filter((x) => x.route.adapter === r.adapter && x.route.model === r.model);

  const costs = refs.map((r) => evidence.models[resolve(r.model)]?.costPerTask);
  const medCost = median(costs.filter((c): c is number => c !== undefined));
  const lats = refs.map((r) => {
    const l = mine(r).map((x) => x.latencyMs);
    return l.length ? l.reduce((a, b) => a + b, 0) / l.length : undefined;
  });
  const medLat = median(lats.filter((l): l is number => l !== undefined));
  const costNorm = minMax(costs.map((c) => c ?? medCost));
  const latNorm = minMax(lats.map((l) => l ?? medLat));

  const ranked: Candidate[] = refs.map((r, i) => {
    const labeled = mine(r).filter((x) => x.result !== "unknown");
    const runs = labeled.length;
    const passes = labeled.filter((x) => x.result === "pass").length;
    const local = (passes + 1) / (runs + 2);
    const w = runs / (runs + 5);
    const prior = evidence.models[resolve(r.model)]?.score ?? 0.5;
    const quality = (1 - w) * prior + w * local;
    const score = quality - lambda.cost[tier] * costNorm[i]! - lambda.latency[tier] * latNorm[i]!;
    return { route: { adapter: r.adapter, model: r.model, effort }, score, prior, local, runs, costNorm: costNorm[i]!, latencyNorm: latNorm[i]! };
  });
  // tie-break: CLI adapters before loop
  ranked.sort((a, b) => (Math.abs(b.score - a.score) > 1e-12 ? b.score - a.score : +(a.route.adapter === "loop") - +(b.route.adapter === "loop")));

  // 5% exploration (non-hard): fewest-runs route within 0.1 of the best
  if (rng() < 0.05 && tier !== "hard") {
    const near = ranked.filter((c) => ranked[0]!.score - c.score <= 0.1);
    const pick = near.reduce((a, b) => (b.runs < a.runs ? b : a));
    if (pick !== ranked[0]) {
      ranked.splice(ranked.indexOf(pick), 1);
      ranked.unshift({ ...pick, explored: true });
    }
  }
  return ranked;
}
