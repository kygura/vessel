import { Box, Text } from "ink";
import type { Route } from "../../core/types.ts";
import { trunc, usd, type CandidateRow } from "../theme.ts";

const same = (a: Route, b: Route) => a.adapter === b.adapter && a.model === b.model && a.effort === b.effort;
const cell = (s: string, w: number) => trunc(s, w).padEnd(w);
const short = (e: string) => (e === "medium" ? "med" : e);

/** Terminal width at which cost and effort get their own columns (DESIGN: collapsed under 100 columns). */
const FULL_COLS = 100;
/** Panel-width fallback when the caller does not pass the terminal width. */
const FULL_AT = 70;

export interface CandidatesTableProps {
  candidates: CandidateRow[];
  chosen: Route;
  width: number;
  /** Terminal columns; drives the column collapse (falls back to `width`). */
  cols?: number;
  /** Show at most this many rows, then a muted `+N more` footer. */
  maxRows?: number;
  /** Dim every row except the chosen one (run in progress). */
  dimOthers?: boolean;
}

export function CandidatesTable({ candidates, chosen, width, cols, maxRows = Infinity, dimOthers }: CandidatesTableProps) {
  if (candidates.length === 0) return <Text dimColor>No candidates.</Text>;
  const full = cols === undefined ? width >= FULL_AT : cols >= FULL_COLS;
  const shown = candidates.slice(0, maxRows);
  const modelW = Math.min(24, Math.max(8, width - (full ? 2 + 5 + 7 + 8 + 10 + 7 : 2 + 5 + 7 + 10 + 11)));
  const line = (mark: string, rank: string, score: string, c: CandidateRow | undefined) => {
    const adapter = cell(c?.route.adapter ?? "adapter", 9);
    if (full) {
      return `${mark}${rank.padEnd(5)}${score.padEnd(7)}${cell(c ? usd(c.costUsd) : "cost", 7)} ${adapter} ${cell(c?.route.model ?? "model", modelW)} ${c?.route.effort ?? "effort"}`;
    }
    const model = c ? `${c.route.model}  ${usd(c.costUsd)} ${short(c.route.effort)}` : "model";
    return `${mark}${rank.padEnd(5)}${score.padEnd(7)}${adapter} ${model}`;
  };
  return (
    <Box flexDirection="column" width={width}>
      <Text dimColor wrap="truncate-end">{line("  ", "rank", "score", undefined)}</Text>
      {shown.map((c, i) => {
        const on = same(c.route, chosen);
        return (
          <Text key={i} bold={on} dimColor={!!dimOthers && !on} wrap="truncate-end">
            {line(on ? "* " : c.explored ? "~ " : "  ", String(i + 1), c.score.toFixed(2), c)}
          </Text>
        );
      })}
      {shown.length < candidates.length && <Text dimColor>+{candidates.length - shown.length} more</Text>}
    </Box>
  );
}
