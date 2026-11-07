import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import type { Adapter } from "../core/types.ts";
import { App } from "./App.tsx";

let home: string;
let cwd: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "router-tui-"));
  cwd = mkdtempSync(join(tmpdir(), "router-tui-cwd-"));
  process.env.ROUTER_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  delete process.env.ROUTER_HOME;
});

const fake: Adapter = {
  id: "claude",
  capabilities: { listModels: true },
  probe: async () => ({ available: true, models: [{ adapter: "claude", model: "sonnet" }, { adapter: "claude", model: "haiku" }] }),
  async *run() { yield { type: "text", text: "hello" }; yield { type: "done", ok: true }; },
};
const opts = () => ({ adapters: [fake], cwd, tier: "standard" as const, llm: false as const, rng: () => 1 });
const size = { columns: 80, rows: 24 };
const wait = (ms = 60) => Bun.sleep(ms);
const until = async (r: { lastFrame(): string | undefined }, re: RegExp) => {
  for (let i = 0; i < 100 && !re.test(r.lastFrame() ?? ""); i++) await wait(20);
  return r.lastFrame() ?? "";
};

test("idle at 80x24 with no sessions", async () => {
  const r = render(<App options={opts()} size={size} />);
  const out = await until(r, /OK claude/);
  expect(out).toContain("Type a task and press Enter");
  expect(out.replace(/\s+/g, " ")).toContain("No sessions yet. Run a");
  expect(out).toContain("[run]");
  expect(out).toContain("[prompt]");
  const lines = out.split("\n");
  expect(lines.length).toBeLessThanOrEqual(24);
  lines.forEach((l) => expect(l.length).toBeLessThanOrEqual(80));
  r.unmount();
});

test("dry-run submit shows tier and ranked candidates, creates no session", async () => {
  const r = render(<App options={opts()} size={size} />);
  await until(r, /OK claude/);
  r.stdin.write("\x04"); // Ctrl+D
  await wait();
  expect(r.lastFrame()).toContain("[dry-run]");
  r.stdin.write("fix the typo");
  await wait();
  r.stdin.write("\r");
  const out = await until(r, /standard\s+\d+%/);
  expect(out).toMatch(/standard\s+\d+%\s+claude\/\w+/);
  expect(out).toContain("* ");
  expect(out).toContain("Enter to run this decision");
  expect(out).toContain("No sessions yet");
  r.unmount();
});

test("focus cycles prompt -> sessions -> log -> prompt and back with shift+tab", async () => {
  const r = render(<App options={opts()} size={size} />);
  await until(r, /OK claude/);
  expect(r.lastFrame()).toContain("[prompt]");
  for (const f of ["sessions", "log", "prompt"]) {
    r.stdin.write("\t");
    await wait();
    expect(r.lastFrame()).toContain(`[${f}]`);
  }
  r.stdin.write("\x1b[Z"); // Shift+Tab
  await wait();
  expect(r.lastFrame()).toContain("[log]");
  r.unmount();
});

test("q types into the prompt; q outside the prompt and Ctrl+C quit", async () => {
  let quits = 0;
  const r = render(<App options={opts()} size={size} onQuit={() => quits++} />);
  await until(r, /OK claude/);
  r.stdin.write("q");
  await wait();
  expect(quits).toBe(0);
  expect(r.lastFrame()).toContain("> q");
  r.stdin.write("\t");
  await wait();
  r.stdin.write("q");
  await wait();
  expect(quits).toBe(1);
  r.unmount();
  const r2 = render(<App options={opts()} size={size} onQuit={() => quits++} />);
  await until(r2, /OK claude/);
  r2.stdin.write("\x03");
  await wait();
  expect(quits).toBe(2);
  r2.unmount();
});

test("run mode streams events and records a session", async () => {
  const r = render(<App options={opts()} size={size} />);
  await until(r, /OK claude/);
  r.stdin.write("add a feature");
  await wait();
  r.stdin.write("\r");
  const out = await until(r, /== done ok/);
  expect(out).toContain("hello");
  expect(out).toMatch(/\?\? [0-9a-f]{8}/); // new row in the sessions list
  r.unmount();
});

const route = { adapter: "claude" as const, model: "sonnet", effort: "high" as const };
const decided = {
  tier: "hard" as const, confidence: 0.91, reasons: ["touches many files"], source: "heuristic" as const,
  candidates: [{ ...route, score: 0.77, costUsd: 0.12 }, { adapter: "claude" as const, model: "haiku", effort: "high" as const, score: 0.4 }],
};

test("sessions rows show outcome word, id, tier and route; recorded decision is real or explicitly absent", async () => {
  const { createSession } = await import("../sessions.ts");
  createSession({ cwd, prompt: "old task without decision", route, tier: "standard" });
  await wait(10);
  createSession({ cwd, prompt: "newer task with decision", route, tier: "hard", decision: decided });
  const r = render(<App options={opts()} size={{ columns: 120, rows: 30 }} />);
  const out = await until(r, /newer task/);
  expect(out).toMatch(/\?\? unknown [0-9a-f]{8}/);
  expect(out).toContain("hard claude/sonnet");
  r.stdin.write("\t");
  await wait();
  r.stdin.write("j"); // newest first: the one with a decision
  const rec = await until(r, /\[recorded\]/);
  expect(rec).toMatch(/hard\s+91%\s+claude\/sonnet high/);
  expect(rec).toContain("touches many files");
  expect(rec).toContain("$0.12");
  expect(rec).toContain("haiku");
  r.stdin.write("j");
  const old = await until(r, /decision not recorded/);
  expect(old).not.toMatch(/\d+%/);
  r.unmount();
});

test("failed verify shows the command while verifying and the last output lines as !! lines", async () => {
  const r = render(<App options={{ ...opts(), verify: "sleep 0.5; echo l1; echo l2; echo l3; echo l4; exit 1" }} size={size} />);
  await until(r, /OK claude/);
  r.stdin.write("do it");
  await wait();
  r.stdin.write("\r");
  const v = await until(r, /verifying: sleep/);
  expect(v).toContain(">> verifying: sleep 0.5");
  const out = await until(r, /!! l4/);
  expect(out).toContain("!! l2");
  expect(out).not.toContain("!! l1");
  r.unmount();
});

test("no reachable routes: submit is blocked with the hint and r on an empty prompt opens the roster", async () => {
  const dead: Adapter = { ...fake, probe: async () => ({ available: false, reason: "not installed", models: [] }) };
  const r = render(<App options={{ ...opts(), adapters: [dead] }} size={size} />);
  const idle = await until(r, /No reachable routes/);
  expect(idle.replace(/\s+/g, " ")).toContain("No reachable routes. Press r to see why.");
  r.stdin.write("fix");
  await wait();
  r.stdin.write("\r");
  await wait(200);
  const blocked = r.lastFrame() ?? "";
  expect(blocked).toContain("No reachable routes.");
  expect(blocked).toContain("No sessions yet");
  expect(blocked).not.toContain("classifying");
  r.stdin.write("\x1b"); // clear the prompt
  await wait();
  r.stdin.write("r");
  const ov = await until(r, /Esc to close/);
  expect(ov).toContain("unavailable: not installed");
  expect(ov).toContain("> ");
  r.unmount();
});
