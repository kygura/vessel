import { expect, test } from "bun:test";
import { classify, classifyHeuristic } from "./classify.ts";

test("SPEC Done #4: rename is trivial, plugin-system design is hard", () => {
  expect(classifyHeuristic("rename foo to bar in utils.ts", {}).tier).toBe("trivial");
  expect(classifyHeuristic("design and implement a plugin system with migrations", {}).tier).toBe("hard");
});

test("heuristic cases", () => {
  expect(classifyHeuristic("fix typo in README.md", {}).tier).toBe("trivial");
  expect(classifyHeuristic("add a --verbose flag to the cli that prints timing info", {}).tier).toBe("standard");
  const many = "refactor the auth module across src/a.ts src/b.ts src/c.ts src/d.ts and update the tests";
  expect(classifyHeuristic(many, {}).tier).toBe("hard");
});

test("confident results carry reasons and confidence >= 0.6", () => {
  const r = classifyHeuristic("rename foo to bar in utils.ts", {});
  expect(r.confidence).toBeGreaterThanOrEqual(0.6);
  expect(r.reasons.length).toBeGreaterThan(0);
});

test("repo size bucket can tip a borderline prompt", () => {
  expect(classifyHeuristic("refactor the cache", {}).tier).toBe("standard");
  expect(classifyHeuristic("refactor the cache", { repoFiles: 10000 }).tier).toBe("hard");
});

test("vague prompt has low confidence", () => {
  expect(classifyHeuristic("make the thing better", {}).confidence).toBeLessThan(0.6);
});

test("llm is called only below 0.6 confidence", async () => {
  let calls = 0;
  const llm = async () => { calls++; return { tier: "hard" as const, reasons: ["llm says so"] }; };
  expect((await classify("rename foo to bar in utils.ts", {}, llm)).tier).toBe("trivial");
  expect(calls).toBe(0);
  const r = await classify("make the thing better", {}, llm);
  expect(calls).toBe(1);
  expect(r.tier).toBe("hard");
  expect(r.reasons).toContain("llm says so");
});

test("llm failure keeps the heuristic result", async () => {
  const llm = async () => { throw new Error("boom"); };
  const r = await classify("make the thing better", {}, llm);
  expect(r).toEqual(classifyHeuristic("make the thing better", {}));
});
