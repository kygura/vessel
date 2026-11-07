import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evidence } from "../core/config.ts";
import type { Adapter, ModelRef, ProbeResult } from "../core/types.ts";
import { buildRoster } from "./roster.ts";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "router-")); process.env.ROUTER_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.ROUTER_HOME; });

const e = (provider: string) => ({ provider, score: 0.5, source: "t", reviewed: "t" });
const evidence: Evidence = { aliases: {}, models: { "claude-x": e("anthropic"), "claude-y": e("anthropic"), "gpt-x": e("openai"), "kimi-x": e("moonshot") } };

function fake(id: Adapter["id"], probe: () => Promise<ProbeResult>, listModels = true): Adapter & { calls: number } {
  const a = {
    id, calls: 0,
    capabilities: { listModels },
    probe: () => { a.calls++; return probe(); },
    run: async function* () {},
  };
  return a;
}
const ok = (...models: ModelRef[]) => async () => ({ available: true, models });
const opts = { evidence, useCache: false };

test("collects routes from available adapters and reasons from unavailable ones", async () => {
  const r = await buildRoster([
    fake("codex", ok({ adapter: "codex", model: "gpt-x" })),
    fake("pi", async () => ({ available: false, reason: "not installed", models: [] })),
    fake("droid", async () => { throw new Error("spawn failed"); }),
    fake("opencode", ok()),
  ], opts);
  expect(r.routes).toEqual([{ adapter: "codex", model: "gpt-x" }]);
  expect(r.unavailable).toEqual([
    { adapter: "pi", reason: "not installed" },
    { adapter: "droid", reason: "spawn failed" },
    { adapter: "opencode", reason: "no models" },
  ]);
});

test("probe timeout marks adapter unavailable without blocking others", async () => {
  const hang = fake("pi", () => new Promise(() => {}));
  const r = await buildRoster([hang, fake("codex", ok({ adapter: "codex", model: "gpt-x" }))], { ...opts, timeoutMs: 20 });
  expect(r.routes).toHaveLength(1);
  expect(r.unavailable).toEqual([{ adapter: "pi", reason: "probe timed out" }]);
});

test("adapters without model listing get evidence models for their provider", async () => {
  const r = await buildRoster([
    fake("claude", ok(), false),
    fake("codex", ok(), false),
    fake("droid", ok(), false),
  ], opts);
  expect(r.routes).toEqual([
    { adapter: "claude", model: "claude-x", provider: "anthropic" },
    { adapter: "claude", model: "claude-y", provider: "anthropic" },
  ]);
  // only claude borrows evidence; codex lists its own models
  expect(r.unavailable).toEqual([{ adapter: "codex", reason: "no models" }, { adapter: "droid", reason: "no models" }]);
});

test("listed models are not replaced by evidence", async () => {
  const r = await buildRoster([fake("claude", ok({ adapter: "claude", model: "sonnet" }), false)], opts);
  expect(r.routes).toEqual([{ adapter: "claude", model: "sonnet" }]);
});

test("cache: hit within 10 minutes, miss after, bypass with useCache=false", async () => {
  const a = fake("codex", ok({ adapter: "codex", model: "gpt-x" }));
  const t0 = 1_000_000;
  const first = await buildRoster([a], { evidence, useCache: true, now: t0 });
  const hit = await buildRoster([a], { evidence, useCache: true, now: t0 + 9 * 60_000 });
  expect(a.calls).toBe(1);
  expect(hit).toEqual(first);
  await buildRoster([a], { evidence, useCache: true, now: t0 + 11 * 60_000 });
  expect(a.calls).toBe(2);
  await buildRoster([a], { evidence, useCache: false, now: t0 + 11 * 60_000 });
  expect(a.calls).toBe(3);
});

test("cache is ignored when the adapter set changes", async () => {
  const a = fake("codex", ok({ adapter: "codex", model: "gpt-x" }));
  await buildRoster([a], { evidence, useCache: true, now: 1 });
  await buildRoster([a, fake("pi", ok())], { evidence, useCache: true, now: 2 });
  expect(a.calls).toBe(2);
});

test("cache is not written when a probe timed out or threw", async () => {
  const bad = fake("pi", () => new Promise(() => {}));
  const good = fake("codex", ok({ adapter: "codex", model: "gpt-x" }));
  await buildRoster([bad, good], { evidence, useCache: true, now: 1, timeoutMs: 10 });
  await buildRoster([bad, good], { evidence, useCache: true, now: 2, timeoutMs: 10 });
  expect(good.calls).toBe(2);
  const boom = fake("droid", async () => { throw new Error("x"); });
  await buildRoster([boom], { evidence, useCache: true, now: 3 });
  await buildRoster([boom], { evidence, useCache: true, now: 4 });
  expect(boom.calls).toBe(2);
});

test("cache is ignored when evidence ids for fill providers change", async () => {
  const a = fake("claude", ok(), false);
  await buildRoster([a], { evidence, useCache: true, now: 1 });
  const more: Evidence = { aliases: {}, models: { ...evidence.models, "claude-z": e("anthropic") } };
  const r = await buildRoster([a], { evidence: more, useCache: true, now: 2 });
  expect(a.calls).toBe(2);
  expect(r.routes.map((x) => x.model)).toContain("claude-z");
  // unrelated providers do not invalidate
  const other: Evidence = { aliases: {}, models: { ...more.models, "kimi-y": e("moonshot") } };
  await buildRoster([a], { evidence: other, useCache: true, now: 3 });
  expect(a.calls).toBe(2);
});

test("cache key covers config.json content and which provider keys are set; unwritable cache is tolerated", async () => {
  const a = fake("codex", ok({ adapter: "codex", model: "gpt-x" }));
  await buildRoster([a], { evidence, useCache: true, now: 1 });
  writeFileSync(join(home, "config.json"), JSON.stringify({ providers: { p: { kind: "openai", baseUrl: "https://x.test", apiKeyEnv: "ROUTER_TEST_KEY", models: ["m"] } } }));
  await buildRoster([a], { evidence, useCache: true, now: 2 });
  expect(a.calls).toBe(2);
  process.env.ROUTER_TEST_KEY = "k";
  try {
    await buildRoster([a], { evidence, useCache: true, now: 3 });
    expect(a.calls).toBe(3);
  } finally { delete process.env.ROUTER_TEST_KEY; }
  rmSync(join(home, "roster.json"));
  mkdirSync(join(home, "roster.json")); // writeFileSync to a directory throws
  expect((await buildRoster([a], { evidence, useCache: true, now: 4 })).routes).toHaveLength(1);
});
