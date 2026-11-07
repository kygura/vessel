import { Box, Text } from "ink";
import type { Roster } from "../../routing/roster.ts";
import type { StatusKind } from "../theme.ts";
import { Status } from "./Status.tsx";

export interface StatusBarProps {
  roster?: Roster;
  probing: boolean;
  width: number;
}

/** Roster summary on one row: reachable adapters first, then unavailable ones with reasons, `+N more` when cut. */
export function StatusBar({ roster, probing, width }: StatusBarProps) {
  if (probing || !roster) return <Status kind="running" label="probing adapters..." />;
  const reachable = [...new Set(roster.routes.map((r) => r.adapter))];
  const items: { kind: StatusKind; label: string }[] = [
    ...(reachable.length ? [] : [{ kind: "unavailable" as const, label: "no routes reachable" }]),
    ...reachable.map((a) => ({ kind: "pass" as const, label: a })),
    ...roster.unavailable.map((u) => ({ kind: "unavailable" as const, label: `${u.adapter} (${u.reason})` })),
  ];
  const cost = (i: { label: string }) => 2 + 1 + i.label.length + 2;
  let used = 0;
  let n = 0;
  for (const it of items) {
    const reserve = n < items.length - 1 ? 10 : 0;
    if (used + cost(it) + reserve > width) break;
    used += cost(it);
    n++;
  }
  n = Math.max(n, 1);
  return (
    <Box width={width} overflow="hidden">
      {items.slice(0, n).map((it, i) => (
        <Box key={i} marginRight={2}>
          <Status kind={it.kind === "pass" ? "pass" : "unavailable"} label={it.label} />
        </Box>
      ))}
      {n < items.length && <Text dimColor>+{items.length - n} more</Text>}
    </Box>
  );
}
