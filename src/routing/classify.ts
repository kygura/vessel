import type { Tier } from "../core/types.ts";

export interface Classification { tier: Tier; confidence: number; reasons: string[] }
export type LlmClassifier = (prompt: string) => Promise<{ tier: Tier; reasons: string[] }>;

const HARD = /\b(refactor\w*|migrat\w*|design\w*|architect\w*|implement\w*|rewrite|overhaul|redesign|integrat\w*|system|framework|plugin|pipeline|across)\b/gi;
const EASY = /\b(rename|typo|bump|reword|comment|format|lint|tweak|swap|small|tiny|minor|quick|write a file)\b/i;
const WEAK_EASY = /\b(fix|add|create)\b/i;
const TESTS = /\b(tests?|specs?)\b/i;
// a path needs a known extension or a ./ prefix, so "and/or" and "input/output" do not count
const PATH = /\.{1,2}\/[\w./-]+|\b[\w-]+(?:\/[\w.-]+)*\.(?:tsx?|jsx?|py|go|rs|json|md|txt|css|html|ya?ml|toml|sh|java|cpp?|h)\b/g;

/** Additive complexity score: <= -1 trivial, >= 1.5 hard. Confidence grows with distance from the nearest boundary. */
export function classifyHeuristic(rawPrompt: string, opts: { repoFiles?: number } = {}): Classification {
  const prompt = rawPrompt.replace(/```[\s\S]*?```/g, " "); // pasted code/logs carry no scope signal
  const reasons: string[] = [];
  let s = 0;
  const add = (n: number, why: string) => { s += n; reasons.push(why); };

  const words = prompt.trim().split(/\s+/).length;
  if (words < 10) add(-0.5, `short prompt (${words} words)`);
  else if (words > 40) add(0.5, `long prompt (${words} words)`); // capped: length alone never makes a task hard

  const hard = [...new Set((prompt.match(HARD) ?? []).map((w) => w.toLowerCase()))];
  if (hard.length) add(1.5 * Math.min(hard.length, 2), `scope words: ${hard.join(", ")}`);
  const easy = prompt.match(EASY)?.[0];
  if (easy) add(-1.5, `small-change word: ${easy.toLowerCase()}`);
  else if (WEAK_EASY.test(prompt)) add(-0.5, "fix/add/create");

  const paths = new Set(prompt.match(PATH) ?? []).size;
  if (paths === 1) add(-0.5, "single path referenced");
  else if (paths >= 4) add(1.5, `${paths} paths referenced`);
  else if (paths >= 2) add(0.5, `${paths} paths referenced`);

  if (TESTS.test(prompt)) add(0.5, "tests mentioned");
  const files = opts.repoFiles;
  if (files !== undefined && files > 5000) add(1, `large repo (${files} files)`);
  else if (files !== undefined && files > 500) add(0.5, `medium repo (${files} files)`);

  const tier: Tier = s <= -1 ? "trivial" : s >= 1.5 ? "hard" : "standard";
  const margin = tier === "trivial" ? -1 - s : tier === "hard" ? s - 1.5 : Math.min(s + 1, 1.5 - s);
  return { tier, confidence: Math.min(0.95, 0.45 + 0.2 * margin), reasons };
}

/** Heuristic first; the injected LLM is consulted once, only when confidence < 0.6. Any LLM failure keeps the heuristic. */
export async function classify(prompt: string, opts: { repoFiles?: number } = {}, llm?: LlmClassifier): Promise<Classification> {
  const h = classifyHeuristic(prompt, opts);
  if (h.confidence >= 0.6 || !llm) return h;
  try {
    const r = await llm(prompt);
    return { tier: r.tier, confidence: 0.6, reasons: r.reasons };
  } catch {
    return h;
  }
}
