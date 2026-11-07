import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ADAPTERS } from "./adapters/index.ts";
import { complete } from "./adapters/loop/index.ts";
import { type Evidence, loadEvidence } from "./core/config.ts";
import { routerPaths } from "./core/paths.ts";
import { errMsg, runCapture } from "./core/proc.ts";
import {
  type Adapter, type Autonomy, type Effort, type Outcome, type OutcomeResult, type RouterEvent, type Route, type SessionRecord, type Tier,
  Tier as TierSchema,
} from "./core/types.ts";
import { type Classification, type LlmClassifier, classify, classifyHeuristic } from "./routing/classify.ts";
import { type Candidate, rank, resolve as resolveModel } from "./routing/evaluate.ts";
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
  | { type: "classification"; classification: Classification; source: "heuristic" | "llm" | "override" }
  | { type: "ranked"; candidates: Candidate[] }
  | { type: "route"; route: Route }
  | { type: "event"; event: RouterEvent }
  | { type: "verify"; command: string; ok: boolean; exitCode: number | null; output: string }
  | { type: "outcome"; outcome: Outcome }
  | { type: "notice"; message: string };

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
const MAX_FALLBACKS = 3;
const ABORTED = { type: "phase", phase: "failed", message: "aborted" } as const satisfies RunUpdate;
const ClassifyReply = z.object({ tier: TierSchema, reasons: z.array(z.string()) });

/** LLM fallback: cheapest loop route (by evidence cost, unknown last) answers once. Undefined when there is no loop route. */
function loopClassifier(roster: Roster, evidence: Evidence, signal?: AbortSignal): { label: string; fn: LlmClassifier } | undefined {
  const cost = (m: string) => evidence.models[resolveModel(evidence, m)]?.costPerTask ?? Infinity;
  const loop = roster.routes.filter((r) => r.adapter === "loop").sort((a, b) => cost(a.model) - cost(b.model))[0];
  if (!loop) return;
  const i = loop.model.indexOf("/");
  return {
    label: loop.model,
    fn: (prompt) =>
      complete(
        loop.model.slice(0, i),
        loop.model.slice(i + 1),
        `Classify the complexity of this coding task as "trivial" (tiny, local edit), "standard" (a normal feature or fix), or "hard" (multi-file, architectural, or ambiguous). Reply with JSON {"tier": "...", "reasons": ["..."]}.\n\nTask:\n${prompt}`,
        ClassifyReply,
        { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(CLASSIFY_TIMEOUT_MS)]) },
      ),
  };
}

async function repoFiles(cwd: string, signal?: AbortSignal): Promise<number | undefined> {
  const r = await runCapture(["git", "-C", cwd, "ls-files"], 5000, { signal });
  return r.exitCode === 0 ? r.stdout.split("\n").filter(Boolean).length : undefined;
}

const ProjectConfig = z.object({ verify: z.string().optional() });
/** `error` is set for a present but unreadable/invalid `.router.json`; a missing file is just no verify. */
function projectVerify(cwd: string): { command?: string; error?: string } {
  try {
    const r = ProjectConfig.safeParse(JSON.parse(readFileSync(join(cwd, ".router.json"), "utf8")));
    return r.success ? { command: r.data.verify } : { error: r.error.issues[0]?.message ?? "invalid" };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? {} : { error: errMsg(e) };
  }
}

const hash = (cmd: string) => new Bun.CryptoHasher("sha256").update(cmd).digest("hex");
const trustFile = () => join(routerPaths().home, "trusted.json");
function trustedHashes(): string[] {
  try {
    return z.array(z.string()).parse(JSON.parse(readFileSync(trustFile(), "utf8")));
  } catch {
    return [];
  }
}

/** Adds the hash of the repo's `.router.json` verify command to trusted.json. Undefined when the repo has none. */
export function trustProject(cwd: string): { command: string } | undefined {
  const { command } = projectVerify(resolve(cwd));
  if (!command) return;
  const all = trustedHashes();
  if (!all.includes(hash(command))) writeFileSync(trustFile(), JSON.stringify([...all, hash(command)], null, 2));
  return { command };
}

/** `--verify` is always honored; a `.router.json` verify runs only when its hash is trusted. */
function resolveVerify(explicit: string | undefined, cwd: string): { command?: string; notice?: string } {
  if (explicit) return { command: explicit };
  const { command, error } = projectVerify(cwd);
  if (error) return { notice: `ignored .router.json: ${error}` };
  if (!command) return {};
  if (trustedHashes().includes(hash(command))) return { command };
  return { notice: `.router.json verify \`${command}\` is not trusted, so it was not run (outcome stays unknown). To allow it: router trust --cwd ${cwd}` };
}

export const editNotice = (adapter: string) => `${adapter} edit mode runs shell commands with your user privileges (no OS sandbox)`;

async function runVerify(cmd: string, cwd: string, signal?: AbortSignal) {
  const r = await runCapture(["sh", "-c", cmd], VERIFY_TIMEOUT_MS, { cwd, signal, keep: "tail" });
  return { ok: r.exitCode === 0, exitCode: r.exitCode, output: (r.stdout + r.stderr).trim().slice(-2000) };
}

interface Try { route: Route; resumeId?: string }

async function* execute(
  s: SessionRecord,
  tries: Try[],
  o: { prompt: string; verify?: string; autonomy: Autonomy; signal?: AbortSignal; adapters: Adapter[]; prev?: Outcome },
): AsyncGenerator<RunUpdate> {
  const signal = o.signal ?? new AbortController().signal;
  const { command: verifyCmd, notice } = resolveVerify(o.verify, s.cwd);
  yield { type: "phase", phase: "running" };
  if (notice) yield { type: "notice", message: notice };

  let ran: { route: Route; costUsd?: number; latencyMs: number } | undefined;
  let lastReason = "no route";
  let lastTried: Route | undefined;
  let spent: number | undefined;
  const t00 = Date.now();
  for (const [i, t] of tries.entries()) {
    yield { type: "route", route: t.route };
    if (o.autonomy === "edit" && t.route.adapter !== "codex") yield { type: "notice", message: editNotice(t.route.adapter) };
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
      yield ABORTED;
      return;
    }
    // exit before any assistant output = start failure, so try the next route; anything else ran.
    if (st.started || st.done === true) {
      ran = { route: t.route, costUsd: st.costUsd, latencyMs: Date.now() - t0 };
      break;
    }
    lastReason = st.reason ?? "no output";
    if (st.costUsd !== undefined) spent = (spent ?? 0) + st.costUsd;
    lastTried = t.route;
    const next = tries[i + 1];
    if (next) {
      yield emit({ type: "error", message: `fallback: ${lastReason} -> ${next.route.adapter}/${next.route.model}` });
      saveSession({ ...s, route: next.route });
    }
  }
  if (!ran) {
    // Start failures are availability, not quality: record one `unknown` outcome only so the session can be listed and rated.
    if (!o.prev && lastTried) {
      appendOutcome({ sessionId: s.id, ts: new Date().toISOString(), route: lastTried, tier: s.tier, result: "unknown", costUsd: spent, latencyMs: Date.now() - t00, startFailed: true });
    }
    yield { type: "phase", phase: "failed", message: `no route started: ${lastReason}` };
    return;
  }

  // Agent exit status alone never counts as a pass: only the verify command (or `router rate`) labels it.
  // On resume, a previously rated/verified result stands unless verify re-ran; cost and latency accumulate.
  let result: OutcomeResult = o.prev?.result ?? "unknown";
  if (verifyCmd) {
    yield { type: "phase", phase: "verifying", message: verifyCmd };
    const v = await runVerify(verifyCmd, s.cwd, signal);
    if (signal.aborted) {
      yield ABORTED;
      return;
    }
    yield { type: "verify", command: verifyCmd, ...v };
    result = v.ok ? "pass" : "fail";
  }
  const costUsd = o.prev?.costUsd === undefined ? ran.costUsd : o.prev.costUsd + (ran.costUsd ?? 0);
  const outcome: Outcome = { sessionId: s.id, ts: new Date().toISOString(), route: ran.route, tier: s.tier, result, costUsd, latencyMs: (o.prev?.latencyMs ?? 0) + ran.latencyMs };
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
  if (opts.signal?.aborted) {
    yield ABORTED;
    return;
  }

  let classification: Classification;
  let source: "heuristic" | "llm" | "override" = "heuristic";
  if (opts.tier) {
    classification = { tier: opts.tier, confidence: 1, reasons: ["--tier override"] };
    source = "override";
  } else {
    const files = await repoFiles(cwd, opts.signal);
    const found = opts.llm === false ? undefined : opts.llm ? { label: "classifier", fn: opts.llm } : loopClassifier(roster, evidence, opts.signal);
    const llm = found && (async (p: string) => { const r = await found.fn(p); source = "llm"; return r; });
    if (found && classifyHeuristic(prompt, { repoFiles: files }).confidence < 0.6) yield { type: "phase", phase: "classifying", message: `asking ${found.label}...` };
    classification = await classify(prompt, { repoFiles: files }, llm);
  }
  if (opts.signal?.aborted) {
    yield ABORTED;
    return;
  }
  yield { type: "classification", classification, source };

  const candidates = rank(roster.routes, classification.tier, {
    evidence,
    outcomes: readOutcomes(),
    rng: opts.rng,
    explore: !opts.dryRun,
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
  if (opts.signal?.aborted) {
    yield ABORTED;
    return;
  }

  const session = createSession({
    cwd, prompt, route: candidates[0]!.route, tier: classification.tier, autonomy,
    decision: {
      tier: classification.tier, confidence: classification.confidence, reasons: classification.reasons, source,
      candidates: candidates.slice(0, 5).map((c) => ({ ...c.route, score: c.score, costUsd: evidence.models[resolveModel(evidence, c.route.model)]?.costPerTask })),
    },
  });
  yield { type: "started", sessionId: session.id };
  yield* execute(session, candidates.slice(0, MAX_FALLBACKS + 1).map((c) => ({ route: c.route })), { prompt, verify: opts.verify, autonomy, signal: opts.signal, adapters });
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
  if (!adapter?.resume) throw new Error(`resume is unsupported for adapter ${s.route.adapter}`);
  if (!s.nativeSessionId) throw new Error(`session ${s.id} has no native session id to resume`);
  yield { type: "started", sessionId: s.id };
  // Reuse the original autonomy, but never silently escalate to full: that needs the explicit flag every run.
  const autonomy = opts.autonomy ?? (s.autonomy === "full" ? "edit" : s.autonomy) ?? "edit";
  yield* execute(s, [{ route: s.route, resumeId: s.nativeSessionId }], {
    prompt, verify: opts.verify, autonomy, signal: opts.signal, adapters, prev: readOutcomes().find((x) => x.sessionId === s.id),
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
  if (!prev) throw new Error(`session ${s.id} has no outcome yet (it never finished); nothing to rate`);
  const outcome: Outcome = { ...prev, ts: new Date().toISOString(), result };
  appendOutcome(outcome);
  return outcome;
}
