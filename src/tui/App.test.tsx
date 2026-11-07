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
  capabilities: { resume: false, cost: true, listModels: true },
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
