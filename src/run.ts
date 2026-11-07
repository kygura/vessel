import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ADAPTERS } from "./adapters/index.ts";
import { complete } from "./adapters/loop/index.ts";
import { loadEvidence } from "./core/config.ts";
import { runCapture } from "./core/proc.ts";
import {
  type Adapter, type Autonomy, type Effort, type Outcome, type OutcomeResult, type RouterEvent, type Route, type Tier,
  Tier as TierSchema,
} from "./core/types.ts";
import { type Classification, type LlmClassifier, classify } from "./routing/classify.ts";
import { type Candidate, rank } from "./routing/evaluate.ts";
import { type Roster, buildRoster } from "./routing/roster.ts";
import { appendEvent, appendOutcome, createSession, getSession, readOutcomes, saveSession } from "./sessions.ts";

/**
 * Phases, in order: classifying (roster + classify) -> ranked -> running -> verifying (only when a
 * verify command exists) -> done | failed. `failed` = no route could start, aborted, or verify failed;
 * the `outcome` update still carries the recorded result when one exists.
 */
export type Phase = "classifying" | "ranked" | "running" | "verifying" | "done" | "failed";

export type RunUpdate =
  | { type: "phase"; phase: Phase; message?: string }
  | { type: "started"; sessionId: string }
  | { type: "roster"; roster: Roster }
  | { type: "classification"; classification: Classification; source: "heuristic" | "llm" | "override" }
  | { type: "ranked"; candidates: Candidate[] }
  | { type: "route"; route: Route; index: number }
  | { type: "fallback"; from: Route; to: Route; reason: string }
  | { type: "event"; event: RouterEvent }
  | { type: "verify"; command: string; ok: boolean; exitCode: number | null; output: string }
  | { type: "outcome"; outcome: Outcome };

export interface RunOptions {
  cwd?: string;
  dryRun?: boolean;
  verify?: string;
  tier?: Tier;
  adapter?: Adapter["id"];
  model?: string;
  effort?: Effort;
  autonomy?: Autonomy;
  signal?: AbortSignal;
  /** Test seams. */
  adapters?: Adapter[];
  rng?: () => number;
  llm?: LlmClassifier | false;
}

const CLASSIFY_TIMEOUT_MS = 15_000;
const VERIFY_TIMEOUT_MS = 600_000;
const ClassifyReply = z.object({ tier: TierSchema, reasons: z.array(z.string()) });

function timeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("timed out")), ms); });
  return Promise.race([p, limit]).finally(() => clearTimeout(t));
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** LLM fallback: cheapest loop route (by evidence cost, unknown last) answers once. Undefined when there is no loop route. */
function loopClassifier(roster: Roster, evidence: ReturnType<typeof loadEvidence>): LlmClassifier | undefined {
  const bare = (m: string) => { const id = m.slice(m.indexOf("/") + 1); return evidence.aliases[id] ?? id; };
  const cost = (m: string) => evidence.models[bare(m)]?.costPerTask ?? Infinity;
  const loop = roster.routes.filter((r) => r.adapter === "loop").sort((a, b) => cost(a.model) - cost(b.model))[0];
  if (!loop) return;
  const i = loop.model.indexOf("/");
  return (prompt) =>
    timeout(
      complete(
        loop.model.slice(0, i),
        loop.model.slice(i + 1),
        `Classify the complexity of this coding task as "trivial" (tiny, local edit), "standard" (a normal feature or fix), or "hard" (multi-file, architectural, or ambiguous). Reply with JSON {"tier": "...", "reasons": ["..."]}.\n\nTask:\n${prompt}`,
        ClassifyReply,
      ),
      CLASSIFY_TIMEOUT_MS,
    );
}

async function repoFiles(cwd: string): Promise<number | undefined> {
  const r = await runCapture(["git", "-C", cwd, "ls-files"], 5000);
  return r.exitCode === 0 ? r.stdout.split("\n").filter(Boolean).length : undefined;
}

const ProjectConfig = z.object({ verify: z.string().optional() });
function projectVerify(cwd: string): string | undefined {
  const p = join(cwd, ".router.json");
  if (!existsSync(p)) return;
  try {
    return ProjectConfig.parse(JSON.parse(readFileSync(p, "utf8"))).verify;
  } catch {
    return; // ponytail: a malformed .router.json silently means no verify; surface it if this bites
  }
}

async function runVerify(cmd: string, cwd: string, signal?: AbortSignal) {
  try {
    const proc = Bun.spawn(["sh", "-c", cmd], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", signal, timeout: VERIFY_TIMEOUT_MS });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const exitCode = proc.signalCode ? null : code;
    return { ok: exitCode === 0, exitCode, output: (out + err).trim().slice(-2000) };
  } catch (e) {
    return { ok: false, exitCode: null, output: errMsg(e) };
  }
}

interface Try { route: Route; resumeId?: string }

async function* execute(
  s: { id: string; cwd: string; tier: Tier },
  tries: Try[],
  o: { prompt: string; verify?: string; autonomy: Autonomy; signal?: AbortSignal; adapters: Adapter[] },
): AsyncGenerator<RunUpdate> {
  const signal = o.signal ?? new AbortController().signal;
  const verifyCmd = o.verify ?? projectVerify(s.cwd);
  yield { type: "phase", phase: "running" };

  let ran: { route: Route; costUsd?: number; latencyMs: number } | undefined;
  let lastReason = "no route";
  for (const [i, t] of tries.entries()) {
    yield { type: "route", route: t.route, index: i };
    const adapter = o.adapters.find((a) => a.id === t.route.adapter);
    const req = { prompt: o.prompt, cwd: s.cwd, model: t.route.model, effort: t.route.effort, autonomy: o.autonomy };
    const t0 = Date.now();
    const st: { started: boolean; done?: boolean; costUsd?: number; reason?: string } = { started: false };
    const emit = (event: RouterEvent) => {
      appendEvent(s.id, event);
      if (event.type === "text" || event.type === "tool") st.started = true;
      else if (event.type === "usage" && event.costUsd !== undefined) st.costUsd = (st.costUsd ?? 0) + event.costUsd;
      else if (event.type === "error") st.reason = event.message;
      else if (event.type === "done") st.done = event.ok;
      return { type: "event", event } satisfies RunUpdate;
    };
    try {
      if (!adapter) throw new Error(`adapter ${t.route.adapter} not registered`);
      const it = t.resumeId ? adapter.resume!(t.resumeId, req, signal) : adapter.run(req, signal);
      for await (const event of it) yield emit(event);
    } catch (e) {
      yield emit({ type: "error", message: errMsg(e) });
    }
    if (signal.aborted) {
      yield { type: "phase", phase: "failed", message: "aborted" };
      return;
    }
    // exit before any assistant output = start failure, so try the next route; anything else ran.
    if (st.started || st.done === true) {
      ran = { route: t.route, costUsd: st.costUsd, latencyMs: Date.now() - t0 };
      break;
    }
    lastReason = st.reason ?? "no output";
    const next = tries[i + 1];
    if (next) {
      appendEvent(s.id, { type: "error", message: `${t.route.adapter}/${t.route.model} failed to start (${lastReason}); falling back to ${next.route.adapter}/${next.route.model}` });
      yield { type: "fallback", from: t.route, to: next.route, reason: lastReason };
      saveSession({ ...getSession(s.id)!, route: next.route });
    }
  }
  if (!ran) {
    yield { type: "phase", phase: "failed", message: `no route started: ${lastReason}` };
    return;
  }

  // Agent exit status alone never counts as a pass: only the verify command (or `router rate`) labels it.
  let result: OutcomeResult = "unknown";
  if (verifyCmd) {
    yield { type: "phase", phase: "verifying" };
    const v = await runVerify(verifyCmd, s.cwd, signal);
    yield { type: "verify", command: verifyCmd, ...v };
    result = v.ok ? "pass" : "fail";
  }
  const outcome: Outcome = { sessionId: s.id, ts: new Date().toISOString(), route: ran.route, tier: s.tier, result, costUsd: ran.costUsd, latencyMs: ran.latencyMs };
  appendOutcome(outcome);
  yield { type: "outcome", outcome };
  yield { type: "phase", phase: result === "fail" ? "failed" : "done" };
}

async function* plan(prompt: string, opts: RunOptions): AsyncGenerator<RunUpdate> {
  const adapters = opts.adapters ?? ADAPTERS;
  const cwd = resolve(opts.cwd ?? process.cwd());
  const autonomy = opts.autonomy ?? "edit";
  yield { type: "phase", phase: "classifying" };

  const evidence = loadEvidence();
  const roster = await buildRoster(adapters, { evidence });
  yield { type: "roster", roster };

  let classification: Classification;
  let source: "heuristic" | "llm" | "override" = "heuristic";
  if (opts.tier) {
    classification = { tier: opts.tier, confidence: 1, reasons: ["--tier override"] };
    source = "override";
  } else {
    const base = opts.llm === false ? undefined : (opts.llm ?? loopClassifier(roster, evidence));
    const llm = base && (async (p: string) => { const r = await base(p); source = "llm"; return r; });
    classification = await classify(prompt, { repoFiles: await repoFiles(cwd) }, llm);
  }
  yield { type: "classification", classification, source };

  const candidates = rank(roster.routes, classification.tier, {
    evidence,
    outcomes: readOutcomes(),
    rng: opts.rng,
    pins: { adapter: opts.adapter, model: opts.model, effort: opts.effort },
  });
  if (!candidates.length) {
    yield { type: "phase", phase: "failed", message: roster.routes.length ? "no reachable route matches --adapter/--model" : "no reachable routes (run `router roster`)" };
    return;
  }
  yield { type: "phase", phase: "ranked" };
  yield { type: "ranked", candidates };
  if (opts.dryRun) {
    yield { type: "phase", phase: "done", message: "dry run" };
    return;
  }

  const session = createSession({ cwd, prompt, route: candidates[0]!.route, tier: classification.tier });
  yield { type: "started", sessionId: session.id };
  yield* execute(session, candidates.map((c) => ({ route: c.route })), { prompt, verify: opts.verify, autonomy, signal: opts.signal, adapters });
}

/** Never throws: unexpected errors surface as a `failed` phase so a TUI can keep rendering. */
async function* guarded(inner: AsyncGenerator<RunUpdate>): AsyncGenerator<RunUpdate> {
  try {
    yield* inner;
  } catch (e) {
    yield { type: "phase", phase: "failed", message: errMsg(e) };
  }
}

export function runTask(prompt: string, opts: RunOptions = {}): AsyncIterable<RunUpdate> {
  return guarded(plan(prompt, opts));
}

async function* resume(id: string, prompt: string, opts: RunOptions): AsyncGenerator<RunUpdate> {
  const adapters = opts.adapters ?? ADAPTERS;
  const s = getSession(id);
  if (!s) throw new Error(`no such session: ${id}`);
  const adapter = adapters.find((a) => a.id === s.route.adapter);
  if (!adapter?.capabilities.resume || !adapter.resume) throw new Error(`resume is unsupported for adapter ${s.route.adapter}`);
  if (!s.nativeSessionId) throw new Error(`session ${s.id} has no native session id to resume`);
  yield { type: "started", sessionId: s.id };
  yield* execute(s, [{ route: s.route, resumeId: s.nativeSessionId }], {
    prompt, verify: opts.verify, autonomy: opts.autonomy ?? "edit", signal: opts.signal, adapters,
  });
}

/** Continues a session on the same route via the adapter's native resume; `opts` uses verify/autonomy/signal/adapters. */
export function resumeTask(id: string, prompt: string, opts: RunOptions = {}): AsyncIterable<RunUpdate> {
  return guarded(resume(id, prompt, opts));
}

/** Labels a session's outcome. Appends a superseding outcome line (route/cost/latency kept from the previous one). */
export function rateSession(id: string, result: "pass" | "fail"): Outcome {
  const s = getSession(id);
  if (!s) throw new Error(`no such session: ${id}`);
  const prev = readOutcomes().find((o) => o.sessionId === s.id);
  const outcome: Outcome = {
    sessionId: s.id, ts: new Date().toISOString(), route: prev?.route ?? s.route, tier: s.tier, result,
    costUsd: prev?.costUsd, latencyMs: prev?.latencyMs ?? 0,
  };
  appendOutcome(outcome);
  return outcome;
}
