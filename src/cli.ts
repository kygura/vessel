#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ADAPTERS } from "./adapters/index.ts";
import { PI_SANDBOX_NOTE } from "./adapters/pi.ts";
import { loadEvidence } from "./core/config.ts";
import { errMsg } from "./core/proc.ts";
import { Autonomy, Effort, Tier, type RouterEvent, type SessionRecord } from "./core/types.ts";
import { duration, trunc, usd } from "./format.ts";
import { type RunUpdate, editNotice, rateSession, resumeTask, runTask, trustProject } from "./run.ts";
import { buildRoster } from "./routing/roster.ts";
import { getSession, listSessions, readEvents } from "./sessions.ts";

const USAGE: Record<string, string> = {
  run: `vessel run "<task>" [--dry-run] [--verify CMD] [--tier trivial|standard|hard]
           [--adapter ID] [--model M] [--effort low|medium|high]
           [--autonomy read|edit|full] [--cwd DIR]
  Route the task to the best reachable agent CLI + model and run it. --dry-run stops after the ranked table.`,
  roster: "vessel roster\n  Reachable routes, and why each unavailable adapter is unavailable.",
  sessions: "vessel sessions\n  List sessions: id, time, task, route, tier, outcome, cost.",
  logs: "vessel logs <id>\n  Print a session's event log (id or unique prefix).",
  resume: `vessel resume <id> "<prompt>" [--verify CMD] [--autonomy read|edit|full]
  Continue a session on the same route via the adapter's native resume.`,
  rate: "vessel rate <id> pass|fail\n  Label a finished session's outcome.",
  trust: "vessel trust [--cwd DIR]\n  Trust the verify command in DIR/.vessel.json so runs execute it.",
  tui: "vessel [tui]\n  Open the TUI.",
};
const HELP = `vessel - route coding tasks to the best reachable agent CLI + model\n\n${Object.values(USAGE).join("\n\n")}\n\nvessel help <command> shows one command.`;

/** Single-line, truncated view of free text. */
const line = (s: string, n: number) => trunc(s.replace(/\s+/g, " ").trim(), n);
const table = (rows: string[][]) => {
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => r.map((c, i) => c.padEnd(w[i]!)).join("  ").trimEnd()).join("\n");
};
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};

function formatEvent(e: RouterEvent): string | undefined {
  switch (e.type) {
    case "session": return `session ${e.id}`;
    case "text": return `  ${line(e.text, 160)}`;
    case "tool": return `  [${e.name}] ${e.status}${e.input ? ` ${line(e.input, 100)}` : ""}${e.output ? ` -> ${line(e.output, 100)}` : ""}`;
    case "usage": return `usage in=${e.inputTokens ?? "?"} out=${e.outputTokens ?? "?"}${e.costUsd !== undefined ? ` cost=${usd(e.costUsd)}` : ""}`;
    case "error": return `! ${line(e.message, 200)}`;
    case "done": return `done ok=${e.ok}`;
  }
}

/** Prints updates as they stream; returns the process exit code. */
async function print(updates: AsyncIterable<RunUpdate>): Promise<number> {
  let code = 0;
  for await (const u of updates) {
    switch (u.type) {
      case "started": console.log(`session ${u.sessionId}`); break;
      case "classification":
        console.log(`tier: ${u.classification.tier} (${u.source}, confidence ${u.classification.confidence.toFixed(2)})`);
        for (const r of u.classification.reasons) console.log(`  - ${r}`);
        break;
      case "ranked":
        console.log(table([
          ["", "adapter", "model", "effort", "score", "prior", "local", "runs"],
          ...u.candidates.map((c, i) => [i === 0 ? "*" : c.explored ? "~" : "", c.route.adapter, c.route.model, c.route.effort, c.score.toFixed(3), c.prior.toFixed(2), c.local.toFixed(2), String(c.runs)]),
        ]));
        break;
      case "route": console.log(`running on ${u.route.adapter}/${u.route.model} (${u.route.effort})`); break;
      case "event": { const l = formatEvent(u.event); if (l) console.log(l); break; }
      case "verify":
        console.log(`verify: ${u.command} -> exit ${u.exitCode ?? "signal"}`);
        if (!u.ok && u.output) console.log(u.output.split("\n").map((l) => `  ${l}`).join("\n"));
        break;
      case "outcome": {
        const o = u.outcome;
        console.log(`outcome: ${o.result}  cost ${usd(o.costUsd)}  ${duration(o.latencyMs)}  route ${o.route.adapter}/${o.route.model}`);
        break;
      }
      case "phase":
        if (u.phase === "failed") { console.error(`failed${u.message ? `: ${u.message}` : ""}`); code = 1; }
        break;
      case "notice": console.log(`note: ${u.message}`); break;
    }
  }
  return code;
}

const RUN_OPTIONS = {
  "dry-run": { type: "boolean" }, verify: { type: "string" }, tier: { type: "string" }, adapter: { type: "string" },
  model: { type: "string" }, effort: { type: "string" }, autonomy: { type: "string" }, cwd: { type: "string" },
} as const;

function dirOrFail(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  const abs = resolve(cwd);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) fail(`--cwd is not a directory: ${cwd}`);
  return abs;
}

function parseRun(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: RUN_OPTIONS });
  const pick = <T,>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, v: string | undefined, flag: string) => {
    if (v === undefined) return undefined;
    const r = schema.safeParse(v);
    return r.success ? r.data : fail(`invalid --${flag}: ${v}`);
  };
  return {
    positionals,
    opts: {
      dryRun: values["dry-run"], verify: values.verify, cwd: dirOrFail(values.cwd), model: values.model,
      tier: pick(Tier, values.tier, "tier"), effort: pick(Effort, values.effort, "effort"),
      autonomy: pick(Autonomy, values.autonomy, "autonomy"),
      adapter: pick(ADAPTER_ID, values.adapter, "adapter"),
    },
  };
}
const ADAPTER_ID = { safeParse: (v: unknown) => { const a = ADAPTERS.find((x) => x.id === v); return a ? { success: true as const, data: a.id } : { success: false as const }; } };

function sigint() {
  const ac = new AbortController();
  process.once("SIGINT", () => ac.abort());
  return ac.signal;
}

async function cmdRoster() {
  const roster = await buildRoster(ADAPTERS, { evidence: loadEvidence(), useCache: false });
  console.log(table([["adapter", "model"], ...roster.routes.map((r) => [r.adapter, r.model])]));
  if (roster.unavailable.length) console.log(`\nunavailable:\n${table(roster.unavailable.map((u) => [u.adapter, u.reason]))}`);
  for (const a of new Set(roster.routes.map((r) => r.adapter))) if (a !== "codex") console.log(`\nnote: ${editNotice(a)}`);
  if (roster.routes.some((r) => r.adapter === "pi")) console.log(`\nnote: ${PI_SANDBOX_NOTE}`);
}

function cmdSessions() {
  const rows = listSessions().map((s: SessionRecord) => [
    s.id, s.createdAt.slice(0, 16).replace("T", " "), line(s.prompt, 40), `${s.route.adapter}/${s.route.model}`, s.tier, s.result ?? "-", usd(s.costUsd),
  ]);
  if (!rows.length) return console.log("no sessions");
  console.log(table([["id", "time", "task", "route", "tier", "outcome", "cost"], ...rows]));
}

function cmdLogs(id: string | undefined) {
  const s = id ? getSession(id) : undefined;
  if (!s) return fail(`no such session: ${id ?? ""}`);
  console.log(`${s.id}  ${s.route.adapter}/${s.route.model}  ${s.tier}  ${s.cwd}\n  ${line(s.prompt, 200)}`);
  for (const { ts, event } of readEvents(s.id)) {
    const l = formatEvent(event);
    if (l) console.log(`${ts.slice(11, 19)} ${l}`);
  }
}

async function cmdTui() {
  const path = "./tui/index.tsx";
  if (!existsSync(new URL(path, import.meta.url))) return console.log(HELP);
  const m = await import(path);
  if (typeof m.default === "function") await m.default();
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "help" || cmd === "--help" || cmd === "-h" || rest.includes("--help") || rest.includes("-h")) {
  const topic = cmd === "help" ? rest[0] : cmd;
  console.log((topic && USAGE[topic]) || HELP);
  process.exit(0);
}
try {
  switch (cmd) {
    case undefined: case "tui": await cmdTui(); break;
    case "roster": await cmdRoster(); break;
    case "sessions": cmdSessions(); break;
    case "logs": cmdLogs(rest[0]); break;
    case "run": {
      const { positionals, opts } = parseRun(rest);
      const prompt = positionals.join(" ").trim();
      if (!prompt) fail('usage: vessel run "<task>" [flags]');
      process.exitCode = await print(runTask(prompt, { ...opts, signal: sigint() }));
      break;
    }
    case "resume": {
      const { positionals: [id, ...p], values } = parseArgs({ args: rest, allowPositionals: true, options: { verify: { type: "string" }, autonomy: { type: "string" } } });
      if (!id || !p.length) fail('usage: vessel resume <id> "<prompt>" [--verify CMD] [--autonomy read|edit|full]');
      const autonomy = values.autonomy === undefined ? undefined : (Autonomy.safeParse(values.autonomy).data ?? fail(`invalid --autonomy: ${values.autonomy}`));
      process.exitCode = await print(resumeTask(id!, p.join(" "), { verify: values.verify, autonomy, signal: sigint() }));
      break;
    }
    case "trust": {
      const cwd = dirOrFail(parseArgs({ args: rest, options: { cwd: { type: "string" } } }).values.cwd) ?? process.cwd();
      const r = trustProject(cwd);
      if (!r) fail(`no verify command in ${cwd}/.vessel.json`);
      console.log(`trusted verify command for ${cwd}:\n  ${r!.command}`);
      break;
    }
    case "rate": {
      const [id, v] = rest;
      if (!id || (v !== "pass" && v !== "fail")) fail("usage: vessel rate <id> pass|fail");
      const o = rateSession(id!, v as "pass" | "fail");
      console.log(`${o.sessionId}: ${o.result}`);
      break;
    }
    default: console.error(`unknown command: ${cmd}\n\n${HELP}`); process.exitCode = 2;
  }
} catch (e) {
  console.error(errMsg(e));
  process.exitCode = 1;
}
