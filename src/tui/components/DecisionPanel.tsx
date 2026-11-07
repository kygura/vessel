import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { pct, routeLabel, type Decision, type Phase } from "../theme.ts";
import { CandidatesTable } from "./CandidatesTable.tsx";
import { Empty, Status } from "./Status.tsx";

export interface DecisionPanelProps {
  phase: Phase;
  decision?: Decision;
  /** True when showing a past session's recorded decision. */
  recorded: boolean;
  width: number;
  /** Rows available (8 at 24 terminal rows, up to 14). */
  height?: number;
  /** One-line note while classifying: `heuristic...` or `asking <model>...`. */
  note?: string;
  /** Core error shown here only when no decision exists yet. */
  error?: string;
  /** Every adapter unavailable. */
  noRoutes?: boolean;
}

/** Greedy-wrap the comma-joined reasons into at most two lines of `width` columns. */
function reasonLines(reasons: string[], width: number): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const [i, r] of reasons.entries()) {
    const piece = i < reasons.length - 1 ? `${r}, ` : r;
    if (cur && cur.length + piece.length > width && lines.length < 1) {
      lines.push(cur.trimEnd());
      cur = "";
    }
    cur += piece;
  }
  if (cur) lines.push(cur.trimEnd());
  return lines;
}

export function DecisionPanel({ phase, decision, recorded, width, height = 8, note, error, noRoutes }: DecisionPanelProps) {
  const header = (
    <Box>
      <Text bold>Decision</Text>
      {recorded && <Text dimColor> [recorded]</Text>}
      {phase === "classifying" && <Text> <Status kind="running" label="classifying" /></Text>}
    </Box>
  );
  let body: ReactNode;
  if (phase === "classifying") {
    body = <Text dimColor>{note ?? "heuristic..."}</Text>;
  } else if (decision) {
    const reasons = reasonLines(decision.reasons, width);
    const avail = Math.max(1, height - 2 - reasons.length - 1);
    const maxRows = decision.candidates.length > avail ? Math.max(1, avail - 1) : avail;
    const live = phase === "running" || phase === "verifying";
    body = (
      <>
        <Text bold wrap="truncate-end">
          {decision.tier}  {pct(decision.confidence)}  {routeLabel(decision.chosen)} {decision.chosen.effort}
        </Text>
        {reasons.map((l, i) => <Text key={i} dimColor wrap="truncate-end">{l}</Text>)}
        <CandidatesTable candidates={decision.candidates} chosen={decision.chosen} width={width} maxRows={maxRows} dimOthers={live} />
      </>
    );
  } else if (error) {
    body = <Status kind="error" label={error} />;
  } else if (noRoutes) {
    body = <Empty>No reachable routes. Press r to see why.</Empty>;
  } else {
    body = <Text dimColor>Type a task and press Enter</Text>;
  }
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      {header}
      {body}
    </Box>
  );
}
