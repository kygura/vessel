import { expect, test } from "bun:test";
import type { Evidence } from "../core/config.ts";
import type { ModelRef, Outcome, Tier } from "../core/types.ts";
import { readFileSync } from "node:fs";
import { DEFAULT_EVIDENCE_PATH, Evidence as EvidenceSchema } from "../core/config.ts";
import { rank, resolve } from "./evaluate.ts";

const entry = (score: number, costPerTask?: number) => ({ provider: "x", score, costPerTask, source: "t", reviewed: "t" });
const evidence: Evidence = {
  aliases: { big: "model-a" },
  models: { "model-a": entry(0.9, 10), "model-b": entry(0.8, 5), "model-c": entry(0.7, 1) },
};
const ref = (model: string, adapter: ModelRef["adapter"] = "claude"): ModelRef => ({ adapter, model });
const routes = [ref("model-c"), ref("model-a"), ref("model-b")];
const never = () => 0.99;
const base = { evidence, outcomes: [] as Outcome[], rng: never };

let n = 0;
const outcome = (model: string, result: Outcome["result"], tier: Tier = "standard", sessionId = `s${n++}`, adapter: ModelRef["adapter"] = "claude"): Outcome => ({
  sessionId, ts: "t", route: { adapter, model, effort: "medium" }, tier, result, latencyMs: 1000,
});

test("cold start ranks by prior with hard tier (cost lambda tiny)", () => {
  const r = rank(routes, "hard", base);
  expect(r.map((c) => c.route.model)).toEqual(["model-a", "model-b", "model-c"]);
  expect(r[0]!.route.effort).toBe("high");
  expect(r[0]).toMatchObject({ prior: 0.9, local: 0.5, runs: 0, costNorm: 1 });
  expect(r[2]!.costNorm).toBe(0);
});

test("cost lambda flips trivial vs hard", () => {
  const two = [ref("model-a"), ref("model-b")];
  expect(rank(two, "trivial", base)[0]!.route).toMatchObject({ model: "model-b", effort: "low" });
  expect(rank(two, "hard", base)[0]!.route.model).toBe("model-a");
});

test("score follows the SPEC formula exactly", () => {
  const a = rank([ref("model-a"), ref("model-b")], "standard", base).find((c) => c.route.model === "model-a");
  expect(a!.score).toBeCloseTo(0.9 - 0.15 * 1, 10);
});

test("aliases resolve to evidence entries", () => {
  expect(rank([ref("big")], "hard", base)[0]!.prior).toBe(0.9);
});

test("unknown model gets prior 0.5 and median cost", () => {
  const r = rank([...routes, ref("mystery")], "standard", { ...base, pins: { adapter: "claude" } });
  const m = r.find((c) => c.route.model === "mystery")!;
  expect(m.prior).toBe(0.5);
  // known costs 10,5,1 -> median 5 -> norm (5-1)/(10-1)
  expect(m.costNorm).toBeCloseTo(4 / 9, 10);
});

test("failures push a model down, passes pull it up (shrinkage)", () => {
  const two = [ref("model-a"), ref("model-b")];
  const fails = Array.from({ length: 20 }, () => outcome("model-a", "fail", "hard"));
  const r = rank(two, "hard", { ...base, outcomes: fails });
  expect(r[0]!.route.model).toBe("model-b");
  const a = r.find((c) => c.route.model === "model-a")!;
  expect(a.runs).toBe(20);
  expect(a.local).toBeCloseTo(1 / 22, 10);
  const passes = Array.from({ length: 20 }, () => outcome("model-c", "pass", "hard"));
  const r2 = rank([ref("model-b"), ref("model-c")], "hard", { ...base, outcomes: passes });
  expect(r2[0]!.route.model).toBe("model-c");
});

test("unknown outcomes and other tiers/routes are excluded; later line per session wins", () => {
  const outs = [
    outcome("model-a", "unknown"),
    outcome("model-a", "fail", "hard"),
    outcome("model-a", "fail", "standard", "s-x", "codex"),
    outcome("model-a", "fail", "standard", "dup"),
    outcome("model-a", "pass", "standard", "dup"),
  ];
  const a = rank([ref("model-a")], "standard", { ...base, outcomes: outs })[0]!;
  expect(a.runs).toBe(1);
  expect(a.local).toBeCloseTo(2 / 3, 10);
});

test("ties prefer CLI adapters over loop", () => {
  const r = rank([ref("model-a", "loop"), ref("model-a", "claude")], "hard", base);
  expect(r.map((c) => c.route.adapter)).toEqual(["claude", "loop"]);
});

test("latency is min-max normalized from outcomes and penalized", () => {
  const slow = { ...outcome("model-b", "pass", "trivial"), latencyMs: 100000 };
  const fast = { ...outcome("model-b", "pass", "trivial", "o2", "codex"), latencyMs: 1000 };
  const r = rank([ref("model-b"), ref("model-b", "codex")], "trivial", { ...base, outcomes: [slow, fast] });
  expect(r[0]!.route.adapter).toBe("codex");
  expect(r.find((c) => c.route.adapter === "claude")!.latencyNorm).toBe(1);
});

test("exploration: 5% on non-hard tiers picks fewest-runs route within 0.1 of best", () => {
  const near = { models: { "model-a": entry(0.8, 1), "model-b": entry(0.75, 1) }, aliases: {} };
  const outs = Array.from({ length: 5 }, () => outcome("model-a", "pass"));
  const two = [ref("model-a"), ref("model-b")];
  const opts = { evidence: near, outcomes: outs, pins: { adapter: "claude" as const } };
  expect(rank(two, "standard", { ...opts, rng: never })[0]!.route.model).toBe("model-a");
  const explored = rank(two, "standard", { ...opts, rng: () => 0.01 });
  expect(explored[0]!.route.model).toBe("model-b");
  expect(explored[0]!.explored).toBe(true);
  // explore: false disables it (dry-run)
  expect(rank(two, "standard", { ...opts, rng: () => 0.01, explore: false })[0]!.route.model).toBe("model-a");
  // hard never explores
  expect(rank(two, "hard", { ...opts, rng: () => 0.01 })[0]!.route.model).toBe("model-a");
  // outside the 0.1 band: no exploration
  const wide = { models: { "model-a": entry(0.8, 1), "model-d": entry(0.5, 1) }, aliases: {} };
  const far = rank([ref("model-a"), ref("model-d")], "standard", { ...opts, evidence: wide, rng: () => 0.01 });
  expect(far[0]!.route.model).toBe("model-a");
});

test("pins filter routes and override effort", () => {
  const r = rank(routes, "hard", { ...base, pins: { model: "model-b", effort: "low" } });
  expect(r).toHaveLength(1);
  expect(r[0]!.route).toEqual({ adapter: "claude", model: "model-b", effort: "low" });
  expect(rank([ref("model-a", "loop"), ref("model-a")], "hard", { ...base, pins: { adapter: "loop" } })).toHaveLength(1);
  expect(rank(routes, "hard", { ...base, pins: { model: "big" } })[0]!.route.model).toBe("model-a");
  expect(rank(routes, "hard", { ...base, pins: { model: "nope" } })).toEqual([]);
});

test("numeric score with runs > 0 and latency", () => {
  const as = [..."pppf"].map((c) => outcome("model-a", c === "p" ? "pass" : "fail"));
  const b = { ...outcome("model-b", "pass"), latencyMs: 3000 };
  const r = rank([ref("model-a"), ref("model-b")], "standard", { ...base, outcomes: [...as, b] });
  const a = r.find((c) => c.route.model === "model-a")!;
  const bb = r.find((c) => c.route.model === "model-b")!;
  expect(a.score).toBeCloseTo((5 / 9) * 0.9 + (4 / 9) * (2 / 3) - 0.15 * 1 - 0.05 * 0, 10);
  expect(bb.score).toBeCloseTo((5 / 6) * 0.8 + (1 / 6) * (2 / 3) - 0.15 * 0 - 0.05 * 1, 10);
});

test("provider prefixes are stripped before alias/evidence lookup; bare pin matches prefixed route", () => {
  expect(resolve(evidence, "anthropic/big")).toBe("model-a");
  expect(resolve(evidence, "openrouter/anthropic/model-b")).toBe("model-b");
  expect(resolve(evidence, "mystery")).toBe("mystery");
  const r = rank([ref("anthropic/model-a", "opencode"), ref("model-b")], "hard", { ...base, pins: { model: "model-a" } });
  expect(r.map((c) => c.route.model)).toEqual(["anthropic/model-a"]);
  expect(r[0]!.prior).toBe(0.9);
});

test("Pareto-dominated routes are dropped before normalization; pins bypass pruning", () => {
  const ev: Evidence = { aliases: {}, models: { good: entry(0.8, 1), bad: entry(0.5, 100), mid: entry(0.9, 2) } };
  const r = rank([ref("good"), ref("bad"), ref("mid")], "standard", { evidence: ev, outcomes: [], rng: never });
  expect(r.map((c) => c.route.model).sort()).toEqual(["good", "mid"]);
  expect(r.find((c) => c.route.model === "mid")!.costNorm).toBe(1); // not stretched by "bad"
  expect(rank([ref("good"), ref("bad")], "standard", { evidence: ev, outcomes: [], rng: never, pins: { adapter: "claude" } })).toHaveLength(2);
  // equal prior and cost: neither dominates
  expect(rank([ref("good"), ref("good", "codex")], "standard", { evidence: ev, outcomes: [], rng: never })).toHaveLength(2);
});

test("pinned pick with evidence.default.json numbers (7 claude routes)", () => {
  const def = EvidenceSchema.parse(JSON.parse(readFileSync(DEFAULT_EVIDENCE_PATH, "utf8")));
  const claude = Object.entries(def.models).filter(([, m]) => m.provider === "anthropic").map(([id]) => ref(id));
  expect(claude).toHaveLength(7);
  const pick = (t: Tier) => rank(claude, t, { evidence: def, outcomes: [], rng: never })[0]!.route.model;
  expect(pick("standard")).toBe("claude-sonnet-5-5");
  expect(pick("hard")).toBe("claude-opus-5-5");
  expect(pick("trivial")).toBe("claude-haiku-5-5"); // lambda_c 0.4: haiku ~0.364 beats sonnet ~0.299;
});
