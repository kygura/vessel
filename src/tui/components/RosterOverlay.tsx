import { Box, Text, useInput } from "ink";
import type { Roster } from "../../routing/roster.ts";
import { borderStyle } from "../theme.ts";
import { Status } from "./Status.tsx";

export interface RosterOverlayProps {
  roster: Roster;
  onClose: () => void;
}

/** Every adapter, its state and the unavailable reason. Esc closes. */
export function RosterOverlay({ roster, onClose }: RosterOverlayProps) {
  useInput((_, key) => key.escape && onClose());
  const reachable = [...new Set(roster.routes.map((r) => r.adapter))];
  return (
    <Box flexDirection="column" borderStyle={borderStyle()} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>Roster</Text>
        <Text dimColor>Esc to close</Text>
      </Box>
      {reachable.length + roster.unavailable.length === 0 && <Text dimColor>No adapters probed.</Text>}
      {reachable.map((a) => {
        const n = roster.routes.filter((r) => r.adapter === a).length;
        return <Status key={a} kind="pass" label={`${a}  ${n} model${n === 1 ? "" : "s"}`} />;
      })}
      {roster.unavailable.map((u) => (
        <Status key={u.adapter} kind="unavailable" label={`${u.adapter}  ${u.reason}`} />
      ))}
    </Box>
  );
}
