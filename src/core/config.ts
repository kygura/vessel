import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { routerPaths } from "./paths.ts";

export const ProviderConfig = z.object({
  kind: z.enum(["anthropic", "openai"]),
  baseUrl: z.string(),
  apiKeyEnv: z.string(),
  models: z.array(z.string()),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const Config = z.object({
  providers: z.record(z.string(), ProviderConfig).default({}),
});
export type Config = z.infer<typeof Config>;

export const EvidenceEntry = z.object({
  provider: z.string(),
  score: z.number().min(0).max(1),
  costPerTask: z.number().optional(),
  source: z.string(),
  reviewed: z.string(),
});
export type EvidenceEntry = z.infer<typeof EvidenceEntry>;

export const Evidence = z.object({
  aliases: z.record(z.string(), z.string()).default({}),
  models: z.record(z.string(), EvidenceEntry),
});
export type Evidence = z.infer<typeof Evidence>;

export const DEFAULT_EVIDENCE_PATH = fileURLToPath(new URL("../../evidence.default.json", import.meta.url));

/** Missing config.json = no providers. Invalid file throws (user-edited, fail loudly). */
export function loadConfig(): Config {
  const { config } = routerPaths();
  if (!existsSync(config)) return Config.parse({});
  return Config.parse(JSON.parse(readFileSync(config, "utf8")));
}

/** Seeds evidence.json from evidence.default.json on first load. */
export function loadEvidence(): Evidence {
  const { evidence } = routerPaths();
  if (!existsSync(evidence)) copyFileSync(DEFAULT_EVIDENCE_PATH, evidence);
  return Evidence.parse(JSON.parse(readFileSync(evidence, "utf8")));
}
