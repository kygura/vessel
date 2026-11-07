import { z } from "zod";

export const AdapterId = z.enum(["claude", "codex", "opencode", "pi", "droid", "loop"]);
export type AdapterId = z.infer<typeof AdapterId>;

export const Effort = z.enum(["low", "medium", "high"]);
export type Effort = z.infer<typeof Effort>;

export const Tier = z.enum(["trivial", "standard", "hard"]);
export type Tier = z.infer<typeof Tier>;

export const Autonomy = z.enum(["read", "edit", "full"]);
export type Autonomy = z.infer<typeof Autonomy>;

export const ModelRef = z.object({
  adapter: AdapterId,
  model: z.string(),
  provider: z.string().optional(),
});
export type ModelRef = z.infer<typeof ModelRef>;

export const Route = z.object({ adapter: AdapterId, model: z.string(), effort: Effort });
export type Route = z.infer<typeof Route>;

export const RunRequest = z.object({
  prompt: z.string(),
  cwd: z.string(),
  model: z.string(),
  effort: Effort,
  autonomy: Autonomy,
});
export type RunRequest = z.infer<typeof RunRequest>;

export const RouterEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session"), id: z.string() }),
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("tool"),
    name: z.string(),
    status: z.enum(["started", "completed", "failed"]),
    input: z.string().optional(),
    output: z.string().optional(),
  }),
  z.object({
    type: z.literal("usage"),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    costUsd: z.number().optional(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
  z.object({ type: z.literal("done"), ok: z.boolean(), finalText: z.string().optional() }),
]);
export type RouterEvent = z.infer<typeof RouterEvent>;

export const ProbeResult = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  models: z.array(ModelRef),
});
export type ProbeResult = z.infer<typeof ProbeResult>;

export interface Adapter {
  id: AdapterId;
  /** Resume support = presence of `resume`. */
  capabilities: { listModels: boolean };
  probe(): Promise<ProbeResult>;
  run(req: RunRequest, signal: AbortSignal): AsyncIterable<RouterEvent>;
  resume?(nativeSessionId: string, req: RunRequest, signal: AbortSignal): AsyncIterable<RouterEvent>;
}

export const OutcomeResult = z.enum(["pass", "fail", "unknown"]);
export type OutcomeResult = z.infer<typeof OutcomeResult>;

/** One line of outcomes.jsonl. A later line with the same sessionId (e.g. from `vessel rate`) supersedes earlier ones. */
export const Outcome = z.object({
  sessionId: z.string(),
  ts: z.string(),
  route: Route,
  tier: Tier,
  result: OutcomeResult,
  costUsd: z.number().optional(),
  latencyMs: z.number(),
  /** Every route failed to start: the route never ran, so it earns no quality or latency credit. */
  startFailed: z.literal(true).optional(),
});
export type Outcome = z.infer<typeof Outcome>;

/** Why a route was picked; candidates holds the top 5 ranked routes. */
export const RoutingDecision = z.object({
  tier: Tier,
  confidence: z.number(),
  reasons: z.array(z.string()),
  source: z.enum(["heuristic", "llm", "override"]),
  candidates: z
    .array(z.object({ adapter: AdapterId, model: z.string(), effort: Effort, score: z.number(), costUsd: z.number().optional() }))
    .max(5),
});
export type RoutingDecision = z.infer<typeof RoutingDecision>;

export const SessionRecord = z.object({
  id: z.string(),
  createdAt: z.string(),
  cwd: z.string(),
  prompt: z.string(),
  route: Route,
  tier: Tier,
  autonomy: Autonomy.optional(),
  nativeSessionId: z.string().optional(),
  result: OutcomeResult.optional(),
  costUsd: z.number().optional(),
  decision: RoutingDecision.optional(),
});
export type SessionRecord = z.infer<typeof SessionRecord>;
