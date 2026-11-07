import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadEvidence } from "./config.ts";
import { routerPaths } from "./paths.ts";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "vessel-")); process.env.VESSEL_HOME = home; });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.VESSEL_HOME; });

test("paths live under VESSEL_HOME and sessions dir is created", () => {
  const p = routerPaths();
  expect(p.config).toBe(join(home, "config.json"));
  expect(existsSync(p.sessions)).toBe(true);
});

test("missing config.json yields empty providers", () => {
  expect(loadConfig()).toEqual({ providers: {} });
});

test("config.json is validated", () => {
  writeFileSync(join(home, "config.json"), JSON.stringify({ providers: { x: { kind: "openai", baseUrl: "http://h/v1", apiKeyEnv: "K", models: ["m"] } } }));
  expect(loadConfig().providers.x?.kind).toBe("openai");
  writeFileSync(join(home, "config.json"), JSON.stringify({ providers: { x: { kind: "bad" } } }));
  expect(() => loadConfig()).toThrow();
});

test("evidence is seeded from evidence.default.json on first load", () => {
  const ev = loadEvidence();
  expect(existsSync(join(home, "evidence.json"))).toBe(true);
  expect(ev.models["claude-opus-5-5"]?.provider).toBe("anthropic");
  expect(ev.aliases.opus).toBe("claude-opus-5-5");
});
