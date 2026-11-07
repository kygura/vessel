import { Box, Text } from "ink";
import { colorOf, STATUS, type StatusKind } from "../theme.ts";

/** Glyph + word + color for one status. `label=""` renders the glyph alone. */
export function Status({ kind, label, bold }: { kind: StatusKind; label?: string; bold?: boolean }) {
  const s = STATUS[kind];
  const word = label ?? s.label;
  return (
    <Text color={colorOf(kind)} dimColor={s.dim} bold={bold}>
      {word === "" ? s.glyph : `${s.glyph} ${word}`}
    </Text>
  );
}

/** One short muted sentence centered in its region (DESIGN.md "Empty states"). */
export function Empty({ children }: { children: string }) {
  return (
    <Box flexGrow={1} justifyContent="center" alignItems="center">
      <Text dimColor>{children}</Text>
    </Box>
  );
}
